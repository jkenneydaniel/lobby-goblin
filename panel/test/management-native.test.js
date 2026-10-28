import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {localDockerSocket, nativeDocker, operatorManagement} from '../core/management-native.js';
import {main as cli} from '../management-update.js';
import {ManagementEngine} from '../fleet/management-engine.js';
import {acquireV014} from './fixtures/management-lock-v014.js';
import {managementAnchor, managementVolume, ensureManagementVolume} from '../core/management-volume.js';

const fleet = 'a'.repeat(32), image = 'sha256:' + 'b'.repeat(64), engine = 'fixture-engine';
test('local contexts resolve Unix sockets and Windows named pipes without accepting remote engines', async () => {
  assert.equal(localDockerSocket('unix:///Users/player/.docker/run/docker.sock', 'darwin'), '/Users/player/.docker/run/docker.sock');
  assert.equal(localDockerSocket('npipe:////./pipe/dockerDesktopLinuxEngine', 'win32'), '\\\\.\\pipe\\dockerDesktopLinuxEngine');
  for (const endpoint of ['tcp://localhost:2375', 'ssh://host', 'npipe:////remote/pipe/docker', 'unix://remote/socket'])
    assert.throws(() => localDockerSocket(endpoint, 'win32'), /local/);
  let called = false;
  await assert.rejects(nativeDocker({env: {DOCKER_BROKER_SOCKET: '/broker'}, execute: async () => {called = true;}}), /outside/);
  assert.equal(called, false);
  const docker = await nativeDocker({env: {DOCKER_HOST: 'tcp://unselected.example:2375', DOCKER_CONTEXT: 'desktop-linux'},
    execute: async (_file, args) => {assert.deepEqual(args.slice(-2), ['--', 'desktop-linux']); return 'unix:///selected-local.sock';},
    api: async (_method, _route, _body, options) => options.socketPath});
  assert.equal(await docker('GET', '/info'), '/selected-local.sock');
});
test('native Docker API really uses the current OS local IPC transport', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-ipc-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\lgb-test-' + crypto.randomUUID() : path.join(dir, 'engine.sock');
  const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/' + socket.split('\\').at(-1) : 'unix://' + socket;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/info');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ID: engine, OSType: 'linux'}));
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(socket, resolve);});
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const docker = await nativeDocker({env: {}, execute: async (file, args) => {
    assert.equal(file, 'docker'); assert.deepEqual(args, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']); return endpoint;
  }});
  assert.deepEqual(await docker('GET', '/info'), {ID: engine, OSType: 'linux'});
});
function fixture() {
  const containers = new Map(), volumes = new Map(), calls = [];
  const host = {Id: 'd'.repeat(64), Name: '/lobby-goblin-host-' + fleet, Image: image,
    Config: {Env: [], Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': 'host-controller', 'com.docker.compose.project': 'lobby-goblin-fleet-' + fleet,
      'com.docker.compose.project.working_dir': 'C:\\Users\\Player\\Lobby Goblin'}}, Mounts: [{Type: 'bind', Destination: '/var/run/docker.sock', Source: '/var/run/docker.sock'}]};
  containers.set(host.Name.slice(1), host);
  let result = {id: 'c'.repeat(32), pending: null};
  const docker = async (method, route, data) => {
    calls.push({method, route, data}); const url = new URL(route, 'http://engine');
    if (route === '/info') return {ID: engine, OSType: 'linux'};
    if (url.pathname.startsWith('/images/')) return {Id: image, Config: {Labels: {'io.lobby-goblin.runtime': '1', 'org.opencontainers.image.source': 'https://github.com/jkenneydaniel/lobby-goblin'}}};
    if (route === '/volumes/create') {volumes.set(data.Name, {...data, Options: {}}); return volumes.get(data.Name);}
    if (url.pathname.startsWith('/volumes/')) {const value = volumes.get(url.pathname.split('/')[2]); if (value) return structuredClone(value);}
    else if (url.pathname === '/containers/create') {
      const name = url.searchParams.get('name'), value = {Id: crypto.createHash('sha256').update(name).digest('hex'), Name: '/' + name, Image: data.Image,
        Config: structuredClone(data), HostConfig: structuredClone(data.HostConfig), Mounts: [], State: {Running: false, Status: 'created'}};
      containers.set(name, value); containers.set(value.Id, value); return {Id: value.Id};
    } else {
      const [, , id, action] = url.pathname.split('/'), value = containers.get(decodeURIComponent(id));
      if (value) {
        if (method === 'DELETE') {containers.delete(id); containers.delete(value.Name.slice(1)); return;}
        if (action === 'start') {value.State.Running = true; return;}
        if (action === 'wait') {value.State.Running = false; return {StatusCode: 0};}
        if (action === 'logs') {
          const body = Buffer.from(JSON.stringify(result)), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]);
        }
        return structuredClone(value);
      }
    }
    throw Object.assign(Error('absent'), {status: 404});
  };
  return {docker, containers, volumes, calls, setResult: value => {result = value;}};
}
test('operator bootstrap and recovery use the exact fixed helper without native host-folder mounts', async () => {
  const f = fixture(), reviewed = await operatorManagement('plan', {fleet, image}, f);
  assert.equal(reviewed.pending, null);
  const created = f.calls.filter(v => v.route.startsWith('/containers/create')).at(-1).data;
  assert.equal(created.Image, image); assert.deepEqual(created.Entrypoint, ['node', '/app/management-volume-worker.js']);
  assert.deepEqual(created.HostConfig.CapAdd, []);
  assert.deepEqual(created.HostConfig.Mounts.map(v => [v.Type, v.Target]), [['bind', '/var/run/docker.sock'], ['volume', '/management']]);
  assert.equal(JSON.stringify(created.HostConfig).includes('C:'), false);
  const context = JSON.parse(created.Env.find(v => v.startsWith('MANAGEMENT_REQUEST=')).slice(19)).context;
  assert.equal(context.profile, 'legacy'); assert.equal(context.sourceDirectory, 'C:\\Users\\Player\\Lobby Goblin');
  assert.equal(f.containers.has(managementAnchor(fleet)), true);
  f.containers.delete('lobby-goblin-host-' + fleet);
  f.setResult({id: reviewed.id, pending: null, commit: true});
  assert.equal((await operatorManagement('resume', {fleet, id: reviewed.id, confirm: true}, f)).commit, true);
  assert.equal(f.calls.some(v => v.method === 'DELETE' && v.route.includes(context.anchor)), false);
  const before = f.calls.length;
  await assert.rejects(operatorManagement('apply', {fleet, id: reviewed.id}, f), /Confirm/);
  await assert.rejects(operatorManagement('status', {fleet, id: '../../world'}, f), /retained/);
  await assert.rejects(operatorManagement('status', {fleet, id: reviewed.id, engine: 'wrong'}, f), /changed/);
  assert.equal(f.calls.length, before + 1);
});
test('foreign recovery storage and altered anchors are retained, never adopted', async () => {
  const f = fixture(); await operatorManagement('plan', {fleet, image}, f);
  f.volumes.get(managementVolume(fleet)).Options = {device: '/worlds', type: 'none', o: 'bind'};
  const inspect = async name => f.containers.get(name);
  await assert.rejects(ensureManagementVolume({docker: f.docker, inspect, fleet, engine, image}), /another/);
  f.volumes.get(managementVolume(fleet)).Options = {};
  f.containers.get(managementAnchor(fleet)).HostConfig.Privileged = true;
  await assert.rejects(operatorManagement('status', {fleet, id: 'c'.repeat(32)}, f), /anchor changed/);
});
test('fleet CLI retains original directory mode and rejects mixed recovery scopes', async () => {
  const calls = [], operator = async (...args) => {calls.push(args); return {id: 'c'.repeat(32)};}, log = () => {};
  await cli(['plan', '--fleet', fleet, '--image', image], {operator, log});
  assert.equal(calls[0][0], 'plan'); assert.equal(calls[0][1].fleet, fleet);
  for (const args of [['plan', '--fleet', fleet, '--image', image, '--directory', '/worlds'], ['resume', '--fleet', fleet, '--image', image, '--id', 'c'.repeat(32)]])
    await assert.rejects(cli(args, {operator, log}), /Choose either/);
});

test('enrollment excludes queued old operator plans while portable claims preserve the permanent barrier', async () => {
  const f = fixture(); await operatorManagement('plan', {fleet, image}, f);
  const anchor = f.containers.get(managementAnchor(fleet)), id = 'f'.repeat(32);
  const driver = new ManagementEngine({socket: '/unused-test.sock', engine, request: f.docker});
  const oldPlan = {fleet, id, engine, imageId: image};
  await assert.rejects(acquireV014.call(driver, oldPlan), /Another operator/);
  await assert.rejects(driver.acquire(oldPlan), /enrolled portable/);
  const plan = {...oldPlan, authority: anchor.Id}; await driver.acquire(plan);
  assert.equal(f.containers.get('lobby-goblin-management-active-' + fleet).Config.Labels['io.lobby-goblin.management-update'], id);
  await driver.release(plan);
  assert.equal(f.containers.has('lobby-goblin-management-active-' + fleet), false);
  assert.equal(f.containers.get(managementAnchor(fleet)).Id, anchor.Id);
});
test('an unfinished original-directory claim blocks enrollment before any storage creation', async () => {
  const f = fixture();
  f.containers.set(managementAnchor(fleet), {Config: {Labels: {'io.lobby-goblin.role': 'management-lock'}}});
  await assert.rejects(operatorManagement('plan', {fleet, image}, f), /anchor changed/);
  assert.equal(f.calls.some(call => call.route === '/volumes/create'), false);
});
