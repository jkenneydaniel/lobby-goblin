import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  managementMaintenance,
  writeManagementActivation,
  assertManagementIdle,
} from '../core/management-maintenance.js';
import {startController} from '../core/controller.js';
import {startFleetController} from '../fleet/controller.js';
import {startWeb} from '../core/web.js';
import {validateContract} from '../core/game-contract.js';
import {serviceApp} from './fixtures/service-app.js';
import {fixtureContract} from './fixtures.js';
import {closeStorage} from '../core/storage/selection.js';
import {startHostAgentWeb} from '../fleet/agent-web.js';
import {RemoteHosts} from '../fleet/hosts.js';
import {writeJSON} from '../common.js';

const id = 'a'.repeat(32),
  other = 'b'.repeat(32);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function directory(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-management-hold-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

test('activation requires an exact identity, persists privately, and the same receipt permits normal restart', async (t) => {
  const root = await directory(t),
    guard = await managementMaintenance(root, {PANEL_MAINTENANCE_ID: id});
  let prepared = 0;
  assert.equal(guard.held, true);
  assert.throws(() => guard.assertAvailable(), {status: 503});
  await assert.rejects(() =>
    guard.activate({id: other, confirm: true}, async () => prepared++),
  );
  await assert.rejects(() =>
    guard.activate(
      {id, confirm: true, command: 'arbitrary'},
      async () => prepared++,
    ),
  );
  assert.equal(prepared, 0);
  await guard.activate({id, confirm: true}, async () => prepared++);
  assert.equal(guard.held, false);
  guard.assertAvailable();
  assert.equal(prepared, 1);
  await guard.activate({id, confirm: true}, async () => prepared++);
  assert.equal(prepared, 1);
  assert.equal(
    (await managementMaintenance(root, {PANEL_MAINTENANCE_ID: id})).held,
    false,
  );
  assert.equal(
    (await managementMaintenance(root, {PANEL_MAINTENANCE_ID: other})).held,
    true,
  );
  if (process.platform !== 'win32')
    assert.equal(
      (await fs.stat(path.join(root, 'management-activation.json'))).mode &
        0o777,
      0o600,
    );
  assert.equal(
    (await managementMaintenance('/not-accessed', {})).held,
    false,
    'Unconfigured installations do not adopt a hold or access its receipt.',
  );
});

test('a failed receipt write keeps the hold and retries persistence without preparing the service again', async (t) => {
  const root = await directory(t);
  let failed = true,
    prepared = 0;
  const guard = await managementMaintenance(
    root,
    {PANEL_MAINTENANCE_ID: id},
    {
      save: async () => {
        if (failed) throw Error('Private storage unavailable');
      },
    },
  );
  await assert.rejects(
    () => guard.activate({id, confirm: true}, async () => prepared++),
    /unavailable/,
  );
  assert.equal(guard.held, true);
  assert.equal(guard.status().busy, false);
  assert.equal(prepared, 1);
  failed = false;
  await guard.activate({id, confirm: true}, async () => prepared++);
  assert.equal(guard.held, false);
  assert.equal(prepared, 1);
});

test('activation errors, malformed receipts and linked storage remain held without leaking payloads', async (t) => {
  const root = await directory(t),
    guard = await managementMaintenance(root, {PANEL_MAINTENANCE_ID: id});
  await assert.rejects(
    () =>
      guard.activate({id, confirm: true}, async () => {
        throw Error('Preparation failed');
      }),
    /Preparation failed/,
  );
  assert.equal(guard.held, true);
  await fs.writeFile(
    path.join(root, 'management-activation.json'),
    'private-broken-payload',
  );
  await assert.rejects(
    () => managementMaintenance(root, {PANEL_MAINTENANCE_ID: id}),
    (error) =>
      error.status === 503 && !error.message.includes('private-broken-payload'),
  );
  await fs.rm(path.join(root, 'management-activation.json'));
  await fs.writeFile(path.join(root, 'foreign'), '{}');
  await fs.symlink(
    path.join(root, 'foreign'),
    path.join(root, 'management-activation.json'),
  );
  await assert.rejects(
    () => managementMaintenance(root, {PANEL_MAINTENANCE_ID: id}),
    /regular files/,
  );
  await assert.rejects(
    () => managementMaintenance(root, {PANEL_MAINTENANCE_ID: 'unreviewed'}),
    /identity/,
  );
});

test('read-only agent storage accepts only a matching operator-published receipt', async (t) => {
  const root = await directory(t),
    guard = await managementMaintenance(
      root,
      {PANEL_MAINTENANCE_ID: id},
      {readOnly: true},
    );
  await assert.rejects(
    () =>
      guard.activate({id, confirm: true}, async () =>
        assert.fail('Read-only agent activation cannot prepare mutable work.'),
      ),
    {status: 409},
  );
  await writeManagementActivation(root, other);
  await guard.refresh();
  assert.equal(guard.held, true);
  await writeManagementActivation(root, id);
  await guard.refresh();
  assert.equal(guard.held, false);
});

test('held controller/web instances expose only local authenticated maintenance and health until activation', async (t) => {
  const root = await directory(t),
    fixture = await serviceApp(root),
    token = path.join(root, 'token'),
    auth = path.join(root, 'auth');
  await fs.writeFile(token, 'disposable-maintenance-controller-token');
  await fs.mkdir(auth);
  let initialized = 0,
    started = 0,
    ticks = 0;
  const module = {
    ...fixture.module,
    createController: async (ctx) => {
      const game = await fixture.module.createController(ctx);
      ctx.every(() => ticks++, 5);
      return {
        ...game,
        init: async () => initialized++,
        start: async () => started++,
      };
    },
  };
  const env = {
    PANEL_MAINTENANCE_ID: id,
    CONTROLLER_TOKEN_FILE: token,
    AUTH_DIR: auth,
    RELEASE_CHECKS: 'false',
    PANEL_HOSTS: '127.0.0.1',
  };
  let controller = await startController(module, {
    env,
    hostname: '127.0.0.1',
    port: 0,
    docker: () => assert.fail('Maintenance cannot contact Docker.'),
  });
  const web = await startWeb(module, {
    env: {
      ...env,
      CONTROLLER_URL: 'http://127.0.0.1:' + controller.address().port,
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await close(web);
    await close(controller);
    await closeStorage(fixture.config.state);
    await closeStorage(auth);
  });
  const headers = {
    authorization: 'Bearer disposable-maintenance-controller-token',
    'content-type': 'application/json',
  };
  async function request(
    server,
    route,
    {method = 'GET', body, authorized = true} = {},
  ) {
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + route,
      {
        method,
        headers: authorized ? headers : {},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      },
    );
    return {status: response.status, body: await response.json()};
  }
  await pause(30);
  assert.equal(initialized, 0);
  assert.equal(started, 0);
  assert.equal(ticks, 0);
  const navigation = await fetch('http://127.0.0.1:' + web.address().port + '/', {headers:{accept:'text/html'}});
  assert.equal(navigation.status, 503);
  assert.match(await navigation.text(), /A little goblin upkeep/);
  assert.deepEqual(fixture.events, [], 'Rendering maintenance cannot contact Docker or start a game.');
  for (const server of [controller, web]) {
    assert.equal(
      (await request(server, '/health', {authorized: false})).status,
      200,
    );
    assert.equal(
      (await request(server, '/management/status', {authorized: false})).status,
      401,
    );
    assert.equal((await request(server, '/management/status')).body.held, true);
    assert.equal(
      (
        await request(server, '/management/activate', {
          method: 'POST',
          body: {id: other, confirm: true},
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await request(controller, '/jobs', {
        method: 'POST',
        body: {action: 'start', params: {}},
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await request(web, '/api/login', {
        method: 'POST',
        body: {username: 'Owner', password: 'unused'},
        authorized: false,
      })
    ).status,
    503,
  );
  assert.deepEqual(fixture.events, []);
  assert.equal(
    (
      await request(controller, '/management/activate', {
        method: 'POST',
        body: {id, confirm: true},
      })
    ).body.held,
    false,
  );
  assert.equal(initialized, 1);
  assert.equal(started, 1);
  assert.deepEqual(
    fixture.events,
    [],
    'Management activation does not start application services.',
  );
  await pause(20);
  assert.ok(ticks > 0);
  assert.equal((await request(controller, '/status')).status, 200);
  assert.equal(
    (
      await request(web, '/management/activate', {
        method: 'POST',
        body: {id, confirm: true},
      })
    ).body.held,
    false,
  );
  assert.equal(
    (await request(web, '/api/session', {authorized: false})).status,
    401,
  );
  await close(controller);
  controller = await startController(module, {
    env,
    hostname: '127.0.0.1',
    port: 0,
    docker: () => assert.fail('No Docker on restart.'),
  });
  assert.equal(
    (await request(controller, '/management/status')).body.held,
    false,
  );
  assert.equal(initialized, 2);
  assert.equal(started, 2);
});

test('modules cannot publish the operator-only maintenance route namespace', () => {
  assert.throws(
    () =>
      validateContract(
        fixtureContract([], {'/management/activate': {POST: 'admin'}}),
      ),
    /private to the local operator/,
  );
});

test('unavailable histories and unreviewed work block management activation; reviewed interrupted history stays usable', () => {
  const snapshot = {version: 1, sources: [{available: true}], operations: []};
  assertManagementIdle(snapshot);
  for (const next of [
    {...snapshot, sources: [{available: false}]},
    {...snapshot, operations: [{state: 'running'}]},
    {...snapshot, operations: [{state: 'queued'}]},
    {...snapshot, operations: [{state: 'interrupted'}]},
    {...snapshot, operations: [{state: 'failed', recovery: {required: true}}]},
  ])
    assert.throws(() => assertManagementIdle(next), {status: 409});
  assertManagementIdle({
    ...snapshot,
    operations: [
      {state: 'interrupted', recovery: {required: false}},
      {state: 'succeeded'},
    ],
  });
});

test('operator endpoints require a loopback connection even with the private bearer token', async (t) => {
  const root = await directory(t),
    guard = await managementMaintenance(root, {PANEL_MAINTENANCE_ID: id});
  await assert.rejects(
    () =>
      guard.handle(
        {
          method: 'GET',
          headers: {authorization: 'Bearer private-token'},
          socket: {remoteAddress: '192.0.2.10'},
        },
        {},
        new URL('http://fixture/management/status'),
        {token: 'private-token'},
      ),
    {status: 403},
  );
  assert.equal(guard.held, true);
});

test('held controller activation exposes and preserves an interrupted operation without initializing the module', async (t) => {
  const root = await directory(t),
    fixture = await serviceApp(root),
    token = path.join(root, 'token');
  let initialized = 0;
  await fs.writeFile(token, 'disposable-held-token');
  await writeJSON(path.join(fixture.config.state, 'jobs.json'), [
    {
      id: crypto.randomUUID(),
      action: 'start',
      actor: 'Fixture',
      state: 'running',
      phase: 'executing',
      started: new Date().toISOString(),
      message: 'Unfinished fixture operation',
    },
  ]);
  const module = {
    ...fixture.module,
    createController: async (ctx) => ({
      ...(await fixture.module.createController(ctx)),
      init: async () => initialized++,
    }),
  };
  const server = await startController(module, {
    env: {
      PANEL_MAINTENANCE_ID: id,
      CONTROLLER_TOKEN_FILE: token,
      RELEASE_CHECKS: 'false',
    },
    hostname: '127.0.0.1',
    port: 0,
    docker: () => assert.fail('No Docker while held.'),
  });
  t.after(async () => {
    await close(server);
    await closeStorage(fixture.config.state);
  });
  const origin = 'http://127.0.0.1:' + server.address().port,
    headers = {
      authorization: 'Bearer disposable-held-token',
      'content-type': 'application/json',
    };
  const status = await (
    await fetch(origin + '/management/status', {headers})
  ).json();
  assert.equal(status.held, true);
  assert.equal(status.workflow.operations[0].state, 'interrupted');
  assert.equal(status.workflow.operations[0].recovery.required, true);
  const response = await fetch(origin + '/management/activate', {
    method: 'POST',
    headers,
    body: JSON.stringify({id, confirm: true}),
  });
  assert.equal(response.status, 409);
  assert.equal(initialized, 0);
  assert.deepEqual(fixture.events, []);
  assert.equal(
    (await (await fetch(origin + '/management/status', {headers})).json()).held,
    true,
  );
});

test('the actual read-only host agent remains held until an operator publishes its receipt', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'token');
  await fs.writeFile(file, 'disposable-agent-token');
  const server = await startHostAgentWeb({
    env: {
      PANEL_MAINTENANCE_ID: id,
      FLEET_WEB_ROOT: root,
      CONTROLLER_TOKEN_FILE: file,
      PANEL_ORIGIN: 'https://agent.example.test',
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  t.after(() => close(server));
  const origin = 'http://127.0.0.1:' + server.address().port,
    headers = {
      authorization: 'Bearer disposable-agent-token',
      'content-type': 'application/json',
    };
  assert.equal((await fetch(origin + '/health')).status, 200);
  assert.equal((await fetch(origin + '/remote/v1/status')).status, 503);
  assert.equal(
    (
      await fetch(origin + '/management/activate', {
        method: 'POST',
        headers,
        body: JSON.stringify({id, confirm: true}),
      })
    ).status,
    409,
  );
  await writeManagementActivation(root, id);
  assert.equal(
    (await (await fetch(origin + '/management/status', {headers})).json()).held,
    false,
  );
});

test('held host initialization loads pairing state without starting background agent connections', async (t) => {
  const root = await directory(t);
  await writeJSON(path.join(root, 'remote-hosts.json'), {
    version: 1,
    outgoing: [
      {
        id: 'c'.repeat(32),
        pairId: 'd'.repeat(32),
        name: 'Fixture host',
        origin: 'https://agent.example.test',
        token: 'a'.repeat(43),
        fingerprint: 'e'.repeat(64),
      },
    ],
    incoming: [],
    pending: [],
  });
  const hosts = new RemoteHosts({root, fleet: 'f'.repeat(32)});
  let connections = 0;
  hosts.connection = () => ({
    start() {
      connections++;
    },
  });
  await hosts.init({connect: false});
  assert.equal(connections, 0);
  hosts.startConnections();
  assert.equal(connections, 1);
  hosts.close();
  await closeStorage(root);
});

test('held fleet startup defers missing management network connections until operator activation', async (t) => {
  const root = await directory(t), fleet = 'f'.repeat(32), server = 'e'.repeat(32),
    network = `lobby-goblin-${fleet}-${server}`, calls = [];
  await writeJSON(path.join(root, 'registry.json'), {
    version: 1, servers: [{id: server, game: 'factorio', state: 'installed', network}], snapshots: [], jobs: [],
  });
  const result = await startFleetController({
    env: {PANEL_MAINTENANCE_ID: id, FLEET_ROOT: root, FLEET_LIBRARY: path.join(root, 'library'),
      FLEET_WEB_ROOT: path.join(root, 'web'), FLEET_ID: fleet,
      FLEET_STATE_VOLUME: `lobby-goblin-fleet-${fleet}-state`, FLEET_LIBRARY_VOLUME: `lobby-goblin-fleet-${fleet}-library`,
      FLEET_IMAGE: 'fixture:held', FLEET_HOST_CONTAINER: 'fixture-host', FLEET_AGENT_ONLY: 'true'},
    hostname: '127.0.0.1', port: 0,
    docker: async (method, route, body) => {
      calls.push({method, route, body});
      if (method === 'GET' && route === '/containers/fixture-host/json')
        return {Id: 'fixture-host-id', Config: {Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': 'host-controller'}}};
      if (method === 'GET' && route === '/networks/' + network)
        return {Containers: {}, Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.instance': server}};
      assert.equal(method, 'POST');
      assert.equal(route, '/networks/' + network + '/connect');
      assert.equal(body.Container, 'fixture-host');
      return {};
    },
  });
  t.after(async () => {await close(result.server); await closeStorage(root);});
  const origin = 'http://127.0.0.1:' + result.server.address().port,
    token = (await fs.readFile(path.join(root, 'web/secrets/controller-token'), 'utf8')).trim(),
    headers = {authorization: 'Bearer ' + token, 'content-type': 'application/json'};
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal((await fetch(origin + '/management/status', {headers})).status, 200);
  assert.equal((await fetch(origin + '/servers', {method: 'POST', headers, body: '{}'})).status, 503);
  assert.ok(calls.every(call => call.method === 'GET'));
  const response = await fetch(origin + '/management/activate', {method: 'POST', headers, body: JSON.stringify({id, confirm: true})});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).held, false);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 1);
});

test('held controller construction cannot issue Docker changes before operator activation', async (t) => {
  const root = await directory(t),
    fixture = await serviceApp(root),
    token = path.join(root, 'token');
  await fs.writeFile(token, 'disposable-constructor-token');
  let commands = 0;
  const module = {
    ...fixture.module,
    createController: async (ctx) => {
      await ctx.host.control('stop');
      return fixture.module.createController(ctx);
    },
  };
  await assert.rejects(
    () =>
      startController(module, {
        env: {
          PANEL_MAINTENANCE_ID: id,
          CONTROLLER_TOKEN_FILE: token,
          RELEASE_CHECKS: 'false',
        },
        hostname: '127.0.0.1',
        port: 0,
        docker: () => commands++,
      }),
    /startup is held/,
  );
  assert.equal(commands, 0);
  await closeStorage(fixture.config.state);
});

test('held web startup validates private account and audit storage before reporting health', async (t) => {
  const root = await directory(t),
    fixture = await serviceApp(root),
    auth = path.join(root, 'auth'),
    token = path.join(root, 'token');
  await fs.mkdir(auth);
  await fs.writeFile(token, 'disposable-held-web-token');
  await fs.writeFile(path.join(auth, 'users.json'), 'private-invalid-payload');
  const env = {
    PANEL_MAINTENANCE_ID: id,
    AUTH_DIR: auth,
    CONTROLLER_TOKEN_FILE: token,
    RELEASE_CHECKS: 'false',
  };
  await assert.rejects(
    () => startWeb(fixture.module, {env, hostname: '127.0.0.1', port: 0}),
    (error) =>
      error.status === 503 &&
      !error.message.includes('private-invalid-payload'),
  );
  await writeJSON(path.join(auth, 'users.json'), {});
  await fs.writeFile(path.join(auth, 'audit.json'), 'private-invalid-ledger');
  await assert.rejects(
    () => startWeb(fixture.module, {env, hostname: '127.0.0.1', port: 0}),
    (error) =>
      error.status === 503 && !error.message.includes('private-invalid-ledger'),
  );
  await closeStorage(auth);
});
