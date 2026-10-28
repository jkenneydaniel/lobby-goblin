import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ManagementEngine} from '../fleet/management-engine.js';

const fleet = 'a'.repeat(32),
  id = 'b'.repeat(32),
  image = 'sha256:' + 'c'.repeat(64),
  engineId = 'd'.repeat(8) + '-1234-4567-8910-' + 'e'.repeat(12);

test('operator inspection preserves the plain loopback transport of older gateway-backed agents', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lobby-agent-inspection-'),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const token = path.join(root, 'token');
  await fs.writeFile(token, 'fixture-private-token', {mode: 0o600});
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/management/status');
    assert.equal(req.headers.authorization, 'Bearer fixture-private-token');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({id, held: true}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const driver = new ManagementEngine({
    socket: '/unused-fixture.sock',
    engine: engineId,
  });
  driver.exec = async (target, script, args) => {
    assert.equal(target, 'owned-agent');
    const {stdout} = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script, ...args],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
          ...process.env,
          PORT: String(server.address().port),
          CONTROLLER_TOKEN_FILE: token,
        },
        timeout: 15000,
      },
    );
    return JSON.parse(stdout);
  };
  assert.deepEqual(
    await driver.maintenance(
      {id: 'owned-agent', role: 'host-agent-web', info: {Config: {Env: []}}},
      'status',
    ),
    {id, held: true},
  );
});

test('the Docker ownership claim excludes operators using copied installation directories and never starts or mounts a container', async () => {
  const records = new Map(),
    calls = [];
  const request = async (method, route, body) => {
    calls.push({method, route, body});
    if (method === 'GET') {
      const key = decodeURIComponent(route.split('/')[2]),
        value = [...records.values()].find(
          (item) => item.Id === key || item.Name === '/' + key,
        );
      if (!value) throw Object.assign(Error('absent'), {status: 404});
      return structuredClone(value);
    }
    if (method === 'POST') {
      const name = new URL('http://fixture' + route).searchParams.get('name');
      if (records.has(name))
        throw Object.assign(Error('name conflict'), {status: 409});
      const value = {
        Id: 'claim-' + records.size,
        Name: '/' + name,
        Config: {Labels: body.Labels},
        HostConfig: body.HostConfig,
        Mounts: [],
        State: {Running: false},
      };
      records.set(name, value);
      return {Id: value.Id};
    }
    if (method === 'DELETE') {
      for (const [name, value] of records)
        if (route.endsWith('/' + value.Id)) records.delete(name);
      return;
    }
    assert.fail('Unexpected engine operation');
  };
  const first = new ManagementEngine({
      socket: '/unused-fixture.sock',
      engine: engineId,
      request,
    }),
    second = new ManagementEngine({
      socket: '/unused-fixture.sock',
      engine: engineId,
      request,
    });
  const plan = {fleet, id, imageId: image},
    other = {...plan, id: 'f'.repeat(32)};
  const result = await Promise.allSettled([
    first.acquire(plan),
    second.acquire(other),
  ]);
  assert.equal(
    result.filter((value) => value.status === 'fulfilled').length,
    1,
  );
  await first.acquire(plan);
  await second.release(other);
  assert.equal(records.size, 1);
  await first.release(plan);
  assert.equal(records.size, 0);
  assert.ok(
    calls
      .filter((call) => call.method === 'POST')
      .every(
        (call) =>
          call.route.startsWith('/containers/create?') &&
          call.body.HostConfig.NetworkMode === 'none' &&
          call.body.HostConfig.Mounts === undefined,
      ),
  );
  assert.ok(!calls.some((call) => /\/(start|stop|exec)/.test(call.route)));
});

test('replacement configuration keeps application-specific values while adopting the new image defaults', async () => {
  const engine = new ManagementEngine({
    socket: '/unused-fixture.sock',
    engine: engineId,
    request: () => assert.fail('No engine in configuration comparison'),
  });
  const service = {
    role: 'host-controller',
    imageDefaults: {
      Env: ['NODE_VERSION=old', 'PATH=/bin'],
      Labels: {version: 'old'},
    },
    info: {
      Id: '0'.repeat(64),
      Config: {
        Image: 'old-image',
        Env: [
          'NODE_VERSION=old',
          'PATH=/bin',
          'FLEET_IMAGE=old-image',
          'PRIVATE_TOKEN=not-public',
        ],
        Labels: {
          version: 'old',
          'io.lobby-goblin.fleet': fleet,
          'io.lobby-goblin.role': 'host-controller',
        },
      },
      HostConfig: {RestartPolicy: {Name: 'unless-stopped'}, Mounts: []},
      NetworkSettings: {
        Networks: {management: {Aliases: ['fleet-controller', '0'.repeat(12)]}},
      },
    },
  };
  const plan = {
    id,
    fleet,
    imageId: image,
    image,
    imageDefaults: {
      Env: ['NODE_VERSION=new', 'PATH=/bin'],
      Labels: {version: 'new', 'new-default': 'present'},
    },
  };
  const replacement = engine.replacement(service, plan);
  assert.ok(replacement.Env.includes('NODE_VERSION=new'));
  assert.ok(replacement.Env.includes('PRIVATE_TOKEN=not-public'));
  assert.ok(replacement.Env.includes('FLEET_IMAGE=' + image));
  assert.equal(replacement.Labels.version, 'new');
  assert.equal(replacement.Labels['new-default'], 'present');
  assert.equal(replacement.Labels['io.lobby-goblin.fleet'], fleet);
  assert.deepEqual(
    replacement.NetworkingConfig.EndpointsConfig.management.Aliases,
    ['fleet-controller'],
  );
  const {HostConfig, NetworkingConfig: _network, ...Config} = replacement;
  const inspected = {
    Id: 'new-management-container',
    Image: image,
    Config,
    HostConfig: {...HostConfig, OomKillDisable: false},
  };
  engine.inspect = async () => inspected;
  assert.equal((await engine.replacementInfo(service, plan)).Id, inspected.Id);
  inspected.HostConfig.Memory = 123;
  await assert.rejects(
    engine.replacementInfo(service, plan),
    /service changed/,
  );
});

test('pre-cutover mount verification ignores Docker inspect order while rejecting changed mounts',async()=>{
  const {managementHash}=await import('../core/management-installation.js');
  const info={Id:'owned-host',Name:'/owned-host',Config:{Env:[],Labels:{}},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},State:{Running:true},Mounts:[
    {Type:'volume',Name:'state',Destination:'/fleet'},{Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'},
  ]};
  const service={id:info.Id,name:'owned-host',info:structuredClone(info),hash:managementHash({config:info.Config,host:{...info.HostConfig,RestartPolicy:null}})};
  const driver=new ManagementEngine({socket:'/unused-fixture.sock',engine:engineId,request:async(method,route)=>{
    assert.equal(method,'GET');if(route==='/info')return {ID:engineId,OSType:'linux'};return info;
  }});
  info.Mounts.reverse();await driver.verifyOriginals({services:[service]});
  info.Mounts[0].Source='/tmp/foreign.sock';
  await assert.rejects(driver.verifyOriginals({services:[service]}),/mounts changed after review/);
});
