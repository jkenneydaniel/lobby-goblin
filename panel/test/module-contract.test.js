import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registeredApplications, selectedApplication} from '../applications/index.js';
import {validateApplicationModule} from '../core/application-module.js';
import {
  validateContract,
  validateConfiguration,
  validateController,
  validateUpdater,
  validateActionRequest,
  normalizeStatus,
  publicContract,
} from '../core/game-contract.js';
import {controllerAccess, sharedControllerEndpoints} from '../core/routes.js';

for (const module of registeredApplications()) {
  test(`${module.name} implements the same checked lifecycle, backup, action and updater contracts`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-contract-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const instance = 'a'.repeat(32),
      env = {
        RELEASE_CHECKS: 'false',
        [module.id.replaceAll('-', '_').toUpperCase()+'_CONTAINER']: 'lobby-goblin-'+module.id+'-'+instance,
        [module.id.replaceAll('-', '_').toUpperCase()+'_ROOT']: root,
        STATE_DIR: path.join(root, 'state'),
        BACKUPS_DIR: path.join(root, 'backups'),
        FACTORIO_DATA: path.join(root, 'factorio'),
        RUST_INSTANCE_ID: instance,
        RUST_CONTAINER: 'lobby-goblin-rust-' + instance,
        RUST_IMAGE: 'ghcr.io/jkenneydaniel/rust-server:steam-lg.2',
        RUST_HOST_DATA: path.join(root, 'host'),
        RUST_DATA: path.join(root, 'rust'),
        RUST_STATE_DIR: path.join(root, 'rust-state'),
        RUST_BACKUPS_DIR: path.join(root, 'rust-backups'),
      };
    const config = validateConfiguration(module.configuration(env));
    const blocked = () =>
      assert.fail('Conformance initialization cannot contact a host or game');
    const ctx = {
      config,
      env,
      host: {},
      docker: blocked,
      every: blocked,
      runJob: blocked,
      stageMessage: blocked,
      jobs: [],
      active: null,
      schedule: {enabled: false},
      backups: {},
      updater: {busy: false},
    };
    const game = validateController(module, await module.createController(ctx));
    assert.deepEqual(
      Object.keys({
        ...game.actions,
        backup() {},
        'verify-backup'() {},
        'cleanup-backups'() {},
      }).sort(),
      Object.keys(module.contract.actions).sort(),
    );
    assert.equal(game.backupExtension, module.contract.backup.extension);
    validateUpdater(
      module.createUpdater({
        config,
        env,
        docker: blocked,
        backup: blocked,
        current: 'fixture',
        canInstall: () => false,
        waitIdle: async () => {},
      }),
    );
    const publicValue = JSON.parse(JSON.stringify(publicContract(module)));
    assert.equal(publicValue.version, 2);
    assert.equal(publicValue.id, module.id);
    assert.equal(publicValue.features.backups, true);
  });

  test(`${module.name} routes preserve permissions and reject undeclared methods`, () => {
    validateApplicationModule(module);
    for (const [route, methods] of Object.entries({
      ...sharedControllerEndpoints,
      ...module.contract.routes,
    })) {
      for (const method of ['GET', 'POST'])
        assert.equal(
          controllerAccess(module, method, route),
          methods[method] || null,
          method + ' ' + route,
        );
      assert.equal(controllerAccess(module, 'DELETE', route), null);
    }
    assert.equal(controllerAccess(module, 'GET', '/not-declared'), null);
    assert.equal(controllerAccess(module, 'POST', '/jobs/recovery'), 'admin');
    for (const [name, policy] of Object.entries(module.contract.actions)) {
      assert.throws(
        () => validateActionRequest(module, {action: name, params: []}),
        /parameters/,
      );
      if (policy.confirmation)
        assert.throws(
          () => validateActionRequest(module, {action: name, params: {}}),
          /confirmation/,
        );
      validateActionRequest(module, {
        action: name,
        params: {confirm: true},
      });
    }
  });
}

test('common status summaries preserve legacy players and represent unknown counts explicitly', () => {
  const factorio = selectedApplication('factorio'),
    rust = selectedApplication('rust'),
    players = ['Builder', 'Engineer'];
  const first = normalizeStatus(factorio, {
    running: true,
    ready: true,
    paused: true,
    players,
  });
  const second = normalizeStatus(rust, {
    running: true,
    ready: true,
    players: 2,
    maxPlayers: 50,
  });
  assert.equal(first.players, players);
  assert.equal(second.players, 2);
  assert.equal(first.summary.players.online, second.summary.players.online);
  assert.equal(first.summary.state, 'paused');
  assert.equal(second.summary.players.limit, 50);
  assert.deepEqual(
    normalizeStatus(rust, {ready: false, players: null}).summary.players,
    {online: null, limit: null},
  );
  for (const value of [
    {ready: 'true'},
    {ready: true, running: false},
    {ready: false, players: -1},
    {ready: false, players: '2'},
  ])
    assert.throws(() => normalizeStatus(rust, value), /Invalid|cannot report/);
});

test('invalid module boundaries fail before a caller can reach a game operation', () => {
  const module = selectedApplication('factorio');
  assert.throws(
    () =>
      validateApplicationModule({
        ...module,
        web: {...module.web, accountExtensions: true},
      }),
    /accountExtensions hook/,
  );
  assert.throws(
    () =>
      validateApplicationModule({
        ...module,
        contract: {...module.contract, version: 99},
      }),
    /Unsupported/,
  );
  assert.throws(
    () => validateApplicationModule({...module, routes: module.routes.slice(1)}),
    /differ/,
  );
  assert.throws(
    () =>
      validateApplicationModule({
        ...module,
        web: {...module.web, adminReadRoutes: []},
      }),
    /permissions/,
  );
  assert.throws(
    () =>
      validateApplicationModule({
        ...module,
        web: {...module.web, assets: {'/': ['../secret', 'text/plain']}},
      }),
    /web asset/,
  );
  assert.throws(
    () =>
      validateApplicationModule({
        ...module,
        routes: [...module.routes, '/status'],
        contract: {
          ...module.contract,
          routes: {...module.contract.routes, '/status': {POST: 'admin'}},
        },
      }),
    /override/,
  );
  assert.throws(
    () =>
      validateContract({
        ...module.contract,
        actions: {
          ...module.contract.actions,
          restart: {
            label: 'Restart',
            confirmation: true,
            retry: 'convergent',
          },
        },
      }),
    /Only start and stop/,
  );
  assert.throws(() => validateConfiguration({state: '/tmp'}), /library/);
  assert.throws(() => validateController(module, {actions: {}}), /status/);
  assert.throws(() => validateUpdater({init() {}}), /refresh/);
});
