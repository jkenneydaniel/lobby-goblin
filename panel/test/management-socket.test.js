import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
  verifyManagementSocket,
  managementSocketKind,
  managementSocketProbe,
} from '../core/management-socket.js';
import {managementFailure} from '../core/management-errors.js';
const canonical = {
  Type: 'bind',
  Source: '/var/run/docker.sock',
  Destination: '/var/run/docker.sock',
};
const alias = {...canonical, Source: '/run/host-services/docker.proxy.sock'};
const engine = {
  ID: 'reviewed-engine',
  OSType: 'linux',
  OperatingSystem: 'Docker Desktop',
};
test('the exact Windows Docker Desktop proxy requires the same verified local engine', async () => {
  let calls = 0;
  await verifyManagementSocket(
    {Id: 'owned-controller', Mounts: [alias]},
    engine,
    async (id, script) => {
      calls++;
      assert.equal(id, 'owned-controller');
      assert.equal(script, managementSocketProbe);
      return {ID: engine.ID, OSType: 'linux'};
    },
  );
  assert.equal(calls, 1);
  await verifyManagementSocket(
    {Id: 'owned-controller', Mounts: [canonical]},
    {...engine, OperatingSystem: 'Ubuntu'},
    () => assert.fail('canonical mount has no alias probe'),
  );
  assert.equal(managementSocketKind(alias), 'desktop-proxy');
});
test('Desktop aliases cannot admit other engines, arbitrary paths, extra mounts or changed destinations', async () => {
  for (const mounts of [
    [{...alias, Source: '/tmp/docker.sock'}],
    [{...alias, Source: alias.Source + '/child'}],
    [{...alias, Destination: '/other'}],
    [alias, canonical],
  ])
    await assert.rejects(
      verifyManagementSocket({Mounts: mounts}, engine, () =>
        assert.fail('no probe for invalid mounts'),
      ),
      /could not be verified/,
    );
  for (const other of [
    {...engine, OperatingSystem: 'Ubuntu'},
    {...engine, OSType: 'windows'},
  ])
    await assert.rejects(
      verifyManagementSocket({Mounts: [alias]}, other, () =>
        assert.fail('no probe on unsupported engine'),
      ),
      /could not be verified/,
    );
  for (const probe of [
    async () => ({ID: 'foreign', OSType: 'linux'}),
    async () => ({ID: engine.ID, OSType: 'windows'}),
    async () => {
      throw Error('token=private /operator/private');
    },
  ]) {
    await assert.rejects(
      verifyManagementSocket({Id: 'owned', Mounts: [alias]}, engine, probe),
      (error) => {
        assert.equal(managementFailure(error).code, 'docker-socket-unverified');
        assert.doesNotMatch(
          JSON.stringify(managementFailure(error)),
          /token=|operator\/private/,
        );
        return true;
      },
    );
  }
});
test(
  'the fixed probe reads only a Unix socket and returns only the engine identity',
  {skip: process.platform === 'win32'},
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-socket-probe-')),
      socket = path.join(root, 'engine.sock');
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/info');
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({...engine, Private: 'must not be published'}));
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, {recursive: true, force: true});
    });
    // Replace the fixed path only in this isolated test script, never in production.
    const run = (source) =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        source,
      ]);
    const {stdout} = await run(
      managementSocketProbe.replaceAll('/var/run/docker.sock', socket),
    );
    assert.deepEqual(JSON.parse(stdout), {ID: engine.ID, OSType: 'linux'});
    await assert.rejects(
      run(managementSocketProbe.replaceAll('/var/run/docker.sock', root)),
      /not a socket/,
    );
  },
);
