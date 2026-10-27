import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRust} from '../applications/rust/controller.js';
import {readSettings} from '../applications/rust/settings.js';
import {createRustSoftware} from '../applications/rust/software.js';
import {createSteamProvider} from '../providers/steamcmd/provider.js';
import {softwareWorkerPaths} from '../core/software-worker-policy.js';
import {
  atomicRecord,
  readRecord,
  softwareInventory,
} from '../providers/steamcmd/files.js';
import {softwareSelectionKey} from '../core/software-installation.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-rust-software-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const instance = 'a'.repeat(32),
    image = 'reviewed-managed-image';
  for (const name of [
    'data',
    'data/engine',
    'data/server',
    'data/server/lobby-goblin-rust',
    'data/server/lobby-goblin-rust/cfg',
    'state',
    'control',
    'state/software-workers',
  ])
    await fs.mkdir(path.join(root, name), {recursive: true, mode: 0o755});
  await atomicRecord(path.join(root, 'data/server/.lobby-goblin-rust.json'), {
    game: 'rust',
    instance,
  });
  await fs.writeFile(
    path.join(root, 'data/server/lobby-goblin-rust/cfg/server.cfg'),
    'server.hostname "Synthetic"\n',
    {mode: 0o600},
  );
  await atomicRecord(path.join(root, 'control/managed-rust-bootstrap.json'), {
    format: 1,
    instance,
    game: 'rust',
    inventory: (await softwareInventory(path.join(root, 'data/server')))
      .inventory,
  });
  const source = {
      application: 'rust',
      appId: '258550',
      platform: 'linux/amd64',
      branches: ['public'],
    },
    requiredFiles = [{path: 'RustDedicated', executable: true}];
  const runtime = {
    build: '123',
    running: false,
    foreign: false,
    workers: [],
    calls: [],
    fault: null,
  };
  const paths = Object.fromEntries(
    Object.entries(softwareWorkerPaths).map(([key, value]) => [
      key,
      path.join(root, value),
    ]),
  );
  const command = async (args) => {
    runtime.calls.push(args);
    if (args.includes('+app_info_print'))
      return (
        '"258550" {"depots" {"258552" {"config" {"oslist" "linux"} "manifests" {"public" {"gid" "' +
        runtime.build +
        '" "size" "500"}}} "branches" {"public" {"buildid" "' +
        runtime.build +
        '"}}}}'
      );
    const target = args[args.indexOf('+force_install_dir') + 1];
    await fs.mkdir(path.join(target, 'steamapps'), {recursive: true});
    await fs.writeFile(
      path.join(target, 'RustDedicated'),
      'synthetic Rust executable',
      {mode: 0o755},
    );
    await fs.writeFile(
      path.join(target, 'steamapps/appmanifest_258550.acf'),
      '"AppState" {"appid" "258550" "buildid" "' +
        runtime.build +
        '" "StateFlags" "4" "UserConfig" {"BetaKey" "public"} "InstalledDepots" {"258552" {"manifest" "' +
        runtime.build +
        '"}}}',
    );
    return 'Success';
  };
  const privateProvider = createSteamProvider({
    source,
    requiredFiles,
    software: paths.software,
    control: paths.control,
    command,
  });
  const retained = new Map();
  const workers = {
    root,
    paths,
    scope: {
      instance,
      volume: 'fixture-volume',
      declaration: {source, requiredFiles},
    },
    workers: async () => runtime.workers,
    async run(action, input, options) {
      const result =
        action === 'resolve'
          ? await privateProvider.resolve(input)
          : await privateProvider.prepare(input, {
              operationId: options.id,
              confirm: true,
            });
      retained.set(options.id, {
        record: {id: options.id, action, phase: 'complete'},
        response: {ok: true, action, result},
        worker: null,
        lease: null,
      });
      return result;
    },
    acknowledge: async (id) => retained.delete(id),
    history: async () => [...retained.values()].map((value) => value.record),
    inspect: async (id) => retained.get(id),
    close: async () =>
      assert.fail('Known completed synthetic requests do not need closure'),
  };
  const ctx = {
    config: {
      softwareManaged: true,
      restartPolicy: 'no',
      identity: 'lobby-goblin-rust',
      managedVolume: 'fixture-volume',
      instance,
      image,
      data: path.join(root, 'data/server'),
      installRoot: path.join(root, 'data/engine'),
      state: path.join(root, 'state'),
    },
    env: {},
    softwareWorkers: workers,
    host: {
      info: async () => ({
        Mounts: [
          {
            Type: 'volume',
            Name: 'fixture-volume',
            Destination: '/steamcmd/rust',
            RW: true,
          },
        ],
        HostConfig: {
          RestartPolicy: {Name: 'no'},
          Mounts: [
            {
              Source: 'fixture-volume',
              Target: '/steamcmd/rust',
              VolumeOptions: {Subpath: 'data', NoCopy: true},
            },
          ],
        },
        Config: {
          Image: image,
          Labels: {
            'io.lobby-goblin.instance': runtime.foreign
              ? 'b'.repeat(32)
              : instance,
            'io.lobby-goblin.game': 'rust',
          },
        },
        State: {Running: runtime.running, Restarting: false},
      }),
    },
    stageMessage: async () => {},
  };
  const create = () =>
    createRustSoftware(ctx, {
      fault: (phase) => {
        if (runtime.fault === phase) {
          runtime.fault = null;
          throw Error('Injected ' + phase);
        }
      },
    });
  return {
    root,
    ctx,
    create,
    runtime,
    software: create(),
    paths,
    privateProvider,
  };
}

test('initial Rust publication keeps configuration stable, seals independent software and restarts offline', async (t) => {
  const f = await fixture(t),
    config = await fs.readFile(
      path.join(f.ctx.config.data, 'lobby-goblin-rust/cfg/server.cfg'),
    );
  await f.software.ensure({id: 'new-start'});
  const status = await f.software.status();
  assert.equal(status.version, '123');
  assert.equal(status.phase, 'complete');
  const projected = await readRecord(
    path.join(f.root, 'data/.lobby-goblin-runtime.json'),
  );
  assert.equal(projected.buildId, '123');
  assert.deepEqual(
    await fs.readFile(
      path.join(f.ctx.config.data, 'lobby-goblin-rust/cfg/server.cfg'),
    ),
    config,
  );
  const calls = f.runtime.calls.length;
  f.runtime.build = '456';
  await f.create().ensure();
  assert.equal(f.runtime.calls.length, calls);
  const installed = (await f.privateProvider.read()).installed;
  const pristine = path.join(
    f.paths.software,
    'releases',
    softwareSelectionKey(installed.selection) +
      '-' +
      installed.inventory.sha256,
    'RustDedicated',
  );
  assert.notEqual(
    (await fs.stat(pristine)).ino,
    (await fs.stat(path.join(f.ctx.config.installRoot, 'RustDedicated'))).ino,
  );
  await fs.writeFile(
    path.join(f.ctx.config.installRoot, 'RustDedicated'),
    'changed',
  );
  await assert.rejects(f.create().ensure(), /binary changed/);
  assert.equal(f.runtime.calls.length, calls);
});

test('running, foreign and existing-world installations refuse discovery before data changes', async (t) => {
  for (const change of ['running', 'foreign', 'world']) {
    const f = await fixture(t);
    if (change === 'world')
      await fs.writeFile(
        path.join(f.ctx.config.data, 'lobby-goblin-rust/old.sav'),
        'preserve existing world',
      );
    else f.runtime[change] = true;
    await assert.rejects(f.software.ensure());
    assert.equal(f.runtime.calls.length, 0);
    assert.equal(
      await fs
        .lstat(path.join(f.root, 'data/.lobby-goblin-runtime.json'))
        .catch(() => null),
      null,
    );
    if (change === 'world')
      assert.equal(
        await fs.readFile(
          path.join(f.ctx.config.data, 'lobby-goblin-rust/old.sav'),
          'utf8',
        ),
        'preserve existing world',
      );
  }
});

for (const phase of [
  'resolving',
  'selected',
  'preparing',
  'prepared',
  'copying',
  'execution-file',
  'holding-data',
  'activating',
  'publishing',
  'restoring-data',
  'publishing-receipt',
])
  test(
    'interrupted ' +
      phase +
      ' fences ordinary start and recovers only after bound inspection',
    async (t) => {
      const f = await fixture(t);
      f.runtime.fault = phase;
      await assert.rejects(
        f.software.ensure({id: 'new-start'}),
        new RegExp('Injected ' + phase),
      );
      const restored = f.create();
      await assert.rejects(restored.ensure(), /Inspect and recover/);
      const review = await restored.inspect();
      assert.equal(review.recoveryRequired, true);
      await assert.rejects(
        restored.recover({confirm: true, review: 'a'.repeat(64)}),
        /observations changed/,
      );
      await restored.recover(
        {confirm: true, review: review.review},
        {id: 'recovery'},
      );
      assert.equal((await restored.status()).phase, 'complete');
      assert.equal(
        (await readRecord(path.join(f.root, 'data/.lobby-goblin-runtime.json')))
          .buildId,
        '123',
      );
      assert.match(
        await fs.readFile(
          path.join(f.ctx.config.data, 'lobby-goblin-rust/cfg/server.cfg'),
          'utf8',
        ),
        /Synthetic/,
      );
      assert.equal(f.runtime.running, false);
    },
  );

test('recovery retains the selected build when the public branch moves', async (t) => {
  const f = await fixture(t);
  f.runtime.fault = 'selected';
  await assert.rejects(f.software.ensure());
  f.runtime.build = '456';
  const restored = f.create(),
    review = await restored.inspect();
  await assert.rejects(
    restored.recover({confirm: true, review: review.review}),
    /Steam branch moved/,
  );
  assert.equal((await restored.status()).buildId, undefined);
  assert.equal((await restored.inspect()).buildId, '123');
  assert.equal((await fs.readdir(path.join(f.root, 'data/engine'))).length, 0);
  assert.match(
    await fs.readFile(
      path.join(f.ctx.config.data, 'lobby-goblin-rust/cfg/server.cfg'),
      'utf8',
    ),
    /Synthetic/,
  );
});

test('a verified new clone installs its retained selection and preserves copied world and player bytes', async (t) => {
  const f = await fixture(t),
    selection = await f.privateProvider.resolve({channel: 'public'});
  const save = path.join(
      f.ctx.config.data,
      'lobby-goblin-rust/proceduralmap.1000.456.289.sav',
    ),
    players = path.join(
      f.ctx.config.data,
      'lobby-goblin-rust/player.blueprints.5.db',
    );
  await fs.writeFile(save, 'new independent copied save');
  await fs.writeFile(players, 'new independent copied players');
  await atomicRecord(path.join(f.root, 'control/managed-rust-bootstrap.json'), {
    format: 1,
    instance: f.ctx.config.instance,
    game: 'rust',
    inventory: (await softwareInventory(f.ctx.config.data)).inventory,
    selection,
  });
  const actions = [],
    run = f.ctx.softwareWorkers.run;
  f.ctx.softwareWorkers.run = (action, ...args) => {
    actions.push(action);
    return run(action, ...args);
  };
  await f.software.ensure();
  assert.deepEqual(actions, ['prepare']);
  assert.equal(await fs.readFile(save, 'utf8'), 'new independent copied save');
  assert.equal(
    await fs.readFile(players, 'utf8'),
    'new independent copied players',
  );
  assert.equal((await f.software.status()).version, '123');
});

test('completed publication with orphan coordination needs explicit metadata recovery before startup', async (t) => {
  const f = await fixture(t);
  await f.software.ensure();
  for (const root of [
    path.join(f.ctx.config.state, 'software/rust'),
    f.paths.control,
    f.paths.requests,
  ])
    await fs.mkdir(path.join(root, '.panel-storage-lock'));
  const restored = f.create();
  await assert.rejects(restored.ensure(), /coordination/);
  const inspected = await restored.inspect();
  assert.equal(inspected.installed, true);
  assert.equal(inspected.recoveryRequired, true);
  await restored.recover({confirm: true, review: inspected.review});
  await restored.ensure();
  assert.equal((await restored.status()).recoveryRequired, false);
});

test('settings stay locked after interrupted setup and become editable after reviewed publication', async (t) => {
  const f = await fixture(t);
  f.runtime.fault = 'selected';
  await assert.rejects(f.software.ensure());
  const game = await createRust(f.ctx, {
    rcon: async () => assert.fail('Settings must not contact the game'),
  });
  let settings;
  const response = {
    writeHead() {},
    end(value) {
      settings = JSON.parse(value);
    },
  };
  await game.handle(
    {method: 'GET'},
    response,
    new URL('http://fixture/settings'),
  );
  assert.equal(settings.editable, false);
  assert.match(settings.message, /initial software setup/);
  const file = path.join(f.ctx.config.data, 'lobby-goblin-rust/cfg/server.cfg'),
    before = await fs.readFile(file, 'utf8');
  const input = {
    values: {...settings.values, 'server.hostname': 'Authorized new name'},
    revision: settings.revision,
  };
  await assert.rejects(
    game.actions['save-settings'](input),
    /initial software setup/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const review = await f.software.inspect();
  await f.software.recover({confirm: true, review: review.review});
  await game.handle(
    {method: 'GET'},
    response,
    new URL('http://fixture/settings'),
  );
  assert.equal(settings.editable, true);
  await game.actions['save-settings']({...input, revision: settings.revision});
  assert.equal(
    (await readSettings(file)).values['server.hostname'],
    'Authorized new name',
  );
  await f.software.ensure();
});
