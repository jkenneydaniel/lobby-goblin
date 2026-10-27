import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSteamProvider} from './provider.js';
import {runSteamCommand} from './command.js';
import {softwareInventory, directory} from './files.js';

const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public'],
};
const metadata = (build) =>
  '"258550" {"depots" {"258552" {"config" {"oslist" "linux"} "manifests" {"public" {"gid" "' +
  build +
  '" "size" "500"}}} "branches" {"public" {"buildid" "' +
  build +
  '"}}}}';
const manifest = (build) =>
  '"AppState" {"appid" "258550" "buildid" "' +
  build +
  '" "StateFlags" "4" "UserConfig" {"BetaKey" "public"} "InstalledDepots" {"258552" {"manifest" "' +
  build +
  '"}}}';
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-steam-provider-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const software = path.join(root, 'software'),
    control = path.join(root, 'private');
  const runtime = {
    build: '12345',
    installedBuild: null,
    failDownload: false,
    fault: null,
    empty: true,
    pause: null,
    payload: null,
    calls: [],
  };
  const command = async (args, {onProgress} = {}) => {
    runtime.calls.push(args);
    if (args.includes('+app_info_print')) return metadata(runtime.build);
    const target = args[args.indexOf('+force_install_dir') + 1];
    if (runtime.pause) await runtime.pause;
    if (runtime.failDownload) {
      await fs.writeFile(path.join(target, 'partial'), 'resumable');
      throw Error('Synthetic download failure');
    }
    await fs.rm(path.join(target, 'partial'), {force: true});
    await fs.mkdir(path.join(target, 'steamapps'), {recursive: true});
    await fs.writeFile(
      path.join(target, 'RustDedicated'),
      'synthetic executable\n',
      {mode: 0o755},
    );
    await fs.writeFile(
      path.join(target, 'steamapps/appmanifest_258550.acf'),
      manifest(runtime.installedBuild || runtime.build),
    );
    if (runtime.payload) await runtime.payload(target);
    await onProgress?.({receivedBytes: 25, totalBytes: 100});
    await onProgress?.({receivedBytes: 100, totalBytes: 100});
    return 'Success';
  };
  const options = {
    source,
    software,
    control,
    command,
    requiredFiles: [{path: 'RustDedicated', executable: true}],
    isApplicationEmpty: async () => runtime.empty,
    isApplicationStopped: async () => runtime.stopped !== false,
    fault: async (phase) => {
      if (runtime.fault === phase) throw Error('Injected ' + phase);
    },
  };
  return {
    root,
    software,
    control,
    runtime,
    options,
    provider: createSteamProvider(options),
    installs: () =>
      runtime.calls.filter((args) => args.includes('+app_update')).length,
  };
}

test('new Steam installs validate, publish and reconstruct offline without resolving the channel again', async (t) => {
  const f = await fixture(t),
    selected = await f.provider.resolve({channel: 'public'});
  assert.equal(
    await fs.stat(f.software).catch(() => null),
    null,
    'Discovery cannot create application storage',
  );
  const receipt = await f.provider.install(selected);
  assert.equal(await f.provider.installed(receipt), true);
  assert.equal(f.installs(), 1);
  const reconstructed = createSteamProvider({
    ...f.options,
    command: async () => assert.fail('Offline restart cannot run SteamCMD'),
  });
  assert.deepEqual(await reconstructed.install(selected), receipt);
  assert.equal(await reconstructed.installed(receipt), true);
  assert.equal((await reconstructed.read()).state, 'installed');
  assert.ok(
    (await reconstructed.activeDirectory()).startsWith(
      f.software + '/releases/',
    ),
  );
});

test('legacy data without a receipt is never adopted, downloaded over or changed', async (t) => {
  const f = await fixture(t);
  const world = path.join(f.root, 'existing-world');
  await fs.writeFile(world, 'retain exactly');
  f.runtime.empty = false;
  const selected = await f.provider.resolve({channel: 'public'});
  await assert.rejects(f.provider.install(selected), /adoption or recovery/);
  assert.equal(f.installs(), 0);
  assert.equal(await fs.readFile(world, 'utf8'), 'retain exactly');
  assert.equal(await fs.stat(f.software).catch(() => null), null);
});

test('failed downloads remain incomplete and a new explicit attempt safely reuses private partial data', async (t) => {
  const f = await fixture(t),
    selected = await f.provider.resolve({channel: 'public'});
  f.runtime.failDownload = true;
  await assert.rejects(f.provider.install(selected));
  const failed = await f.provider.read();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.installed, undefined);
  const partial = path.join(
    f.software,
    'staging',
    failed.operationId,
    'partial',
  );
  assert.equal(await fs.readFile(partial, 'utf8'), 'resumable');
  f.runtime.failDownload = false;
  const receipt = await f.provider.install(selected);
  assert.equal(f.installs(), 2);
  assert.notEqual((await f.provider.read()).revision, failed.revision);
  assert.equal(await f.provider.installed(receipt), true);
  assert.equal(await fs.stat(path.dirname(partial)).catch(() => null), null);
});

test('changed branch metadata, moved download builds and insufficient space cannot publish an installation', async (t) => {
  const f = await fixture(t),
    selected = await f.provider.resolve({channel: 'public'});
  f.runtime.build = '12346';
  await assert.rejects(f.provider.install(selected), /branch moved/);
  assert.equal(f.installs(), 0);
  const newTarget = await f.provider.resolve({channel: 'public'});
  f.runtime.installedBuild = '12347';
  await assert.rejects(f.provider.install(newTarget), /different build/);
  assert.equal((await f.provider.read()).state, 'failed');
  assert.equal(
    await fs.stat(path.join(f.control, 'active.json')).catch(() => null),
    null,
  );
  const other = await fixture(t),
    limited = createSteamProvider({...other.options, disk: async () => 0});
  await assert.rejects(
    limited.install(await limited.resolve({channel: 'public'})),
    /insufficient space/,
  );
  assert.equal((await limited.read()).error, 'insufficient-space');
  assert.equal(other.installs(), 0);
});

for (const phase of [
  'before-candidate',
  'staged',
  'activation-intent',
  'activation-pointer',
])
  test(
    'interruption at ' +
      phase +
      ' requires inspection and never automatically repeats installation',
    async (t) => {
      const f = await fixture(t),
        selected = await f.provider.resolve({channel: 'public'});
      f.runtime.fault = phase;
      await assert.rejects(f.provider.install(selected), /Injected/);
      const before = await f.provider.read();
      assert.ok(['failed', 'recovery-required'].includes(before.state));
      const calls = f.installs(),
        inspected = await f.provider.inspect();
      assert.deepEqual(
        await f.provider.read(),
        before,
        'Inspection must be read-only',
      );
      await assert.rejects(
        f.provider.recover(inspected),
        /workers are stopped/,
      );
      f.runtime.fault = null;
      const recovered = await f.provider.recover(inspected, {
        confirm: true,
        offline: true,
      });
      let receipt;
      if (recovered.state === 'validating') {
        receipt = await f.provider.activate(
          {
            operationId: recovered.operationId,
            revision: recovered.revision,
            receipt: inspected.observation.receipt,
          },
          {confirm: true},
        );
      } else {
        assert.equal(recovered.state, 'installed');
        receipt = recovered.installed;
      }
      assert.equal(f.installs(), calls);
      assert.equal(await f.provider.installed(receipt), true);
    },
  );

test('updates keep prior software active while staging, and a pre-activation failure preserves it', async (t) => {
  const f = await fixture(t),
    first = await f.provider.install(
      await f.provider.resolve({channel: 'public'}),
    );
  const original = await fs.readFile(path.join(f.control, 'active.json'));
  f.runtime.build = '12346';
  const target = await f.provider.resolve({channel: 'public'});
  await assert.rejects(f.provider.stage(target), /Explicit software staging/);
  const staged = await f.provider.stage(target, {confirm: true});
  assert.deepEqual(
    await fs.readFile(path.join(f.control, 'active.json')),
    original,
  );
  assert.deepEqual((await f.provider.read()).installed, first);
  await assert.rejects(
    f.provider.activate(
      {...staged, revision: staged.revision - 1},
      {confirm: true},
    ),
    /changed/,
  );
  const second = await f.provider.activate(staged, {confirm: true});
  assert.equal(second.selection.softwareVersion, '12346');
  assert.equal(await f.provider.installed(second), true);
  assert.ok((await fs.readdir(path.join(f.software, 'releases'))).length === 2);
});

test('an interrupted activation can restore the known previous receipt without downloading or touching data', async (t) => {
  const f = await fixture(t),
    first = await f.provider.install(
      await f.provider.resolve({channel: 'public'}),
    );
  const world = path.join(f.root, 'world-copy');
  await fs.writeFile(world, 'world fixture unchanged');
  f.runtime.build = '12346';
  const next = await f.provider.stage(
    await f.provider.resolve({channel: 'public'}),
    {confirm: true},
  );
  f.runtime.fault = 'activation-intent';
  await assert.rejects(f.provider.activate(next, {confirm: true}));
  f.runtime.fault = null;
  const observed = await f.provider.inspect(),
    calls = f.installs();
  const recovered = await f.provider.recover(observed, {
    confirm: true,
    offline: true,
  });
  assert.deepEqual(recovered.installed, first);
  assert.equal(f.installs(), calls);
  assert.equal(await fs.readFile(world, 'utf8'), 'world fixture unchanged');
});

test('corrupt installed files fail closed without a newer download or a silent repair', async (t) => {
  const f = await fixture(t),
    target = await f.provider.resolve({channel: 'public'}),
    receipt = await f.provider.install(target);
  const root = await f.provider.activeDirectory();
  await fs.writeFile(path.join(root, 'RustDedicated'), 'changed locally');
  const count = f.runtime.calls.length;
  assert.equal(await f.provider.installed(receipt), false);
  await assert.rejects(
    f.provider.install(target),
    /explicit update or recovery/,
  );
  assert.equal(f.runtime.calls.length, count);
  assert.equal((await f.provider.inspect()).observation.state, 'unknown');
});

test('a completed Steam manifest cannot substitute for required binaries or their executable mode', async (t) => {
  const f = await fixture(t),
    target = await f.provider.resolve({channel: 'public'});
  f.runtime.payload = async (root) =>
    fs.unlink(path.join(root, 'RustDedicated'));
  await assert.rejects(f.provider.install(target), /Required Steam software/);
  f.runtime.payload = async (root) =>
    fs.chmod(path.join(root, 'RustDedicated'), 0o644);
  await assert.rejects(f.provider.install(target), /Required Steam software/);
  assert.throws(
    () => createSteamProvider({...f.options, requiredFiles: []}),
    /required software files/,
  );
});

test('a locally verified staged release can be reused after recovery without downloading another copy', async (t) => {
  const f = await fixture(t),
    first = await f.provider.install(
      await f.provider.resolve({channel: 'public'}),
    );
  f.runtime.build = '12346';
  const target = await f.provider.resolve({channel: 'public'});
  const staged = await f.provider.stage(target, {confirm: true});
  f.runtime.fault = 'activation-intent';
  await assert.rejects(f.provider.activate(staged, {confirm: true}));
  f.runtime.fault = null;
  assert.deepEqual(
    (
      await f.provider.recover(await f.provider.inspect(), {
        confirm: true,
        offline: true,
      })
    ).installed,
    first,
  );
  const count = f.installs(),
    retry = await f.provider.stage(target, {confirm: true});
  await f.provider.activate(retry, {confirm: true});
  assert.equal(f.installs(), count);
});

test('concurrent writers and recovery cannot bypass an active worker lease', async (t) => {
  const f = await fixture(t),
    target = await f.provider.resolve({channel: 'public'});
  let release;
  f.runtime.pause = new Promise((resolve) => {
    release = resolve;
  });
  const running = f.provider.install(target);
  try {
    for (let i = 0; (await f.provider.read()).state !== 'downloading'; i++) {
      assert.ok(i < 100);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const other = createSteamProvider(f.options);
    await assert.rejects(other.stage(target, {confirm: true}), /busy|active/);
    await assert.rejects(
      other.recover(await other.inspect(), {confirm: true, offline: true}),
      /worker remains active/,
    );
  } finally {
    release();
    await running;
  }
});

test('linked roots, payloads and oversized files cannot escape software storage or become verified', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  const link = path.join(f.root, 'linked');
  await fs.symlink(outside, link);
  await assert.rejects(
    directory(path.join(link, 'created'), {create: true}),
    /linked/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
  const world = path.join(outside, 'world-copy');
  await fs.writeFile(world, 'untouched fixture');
  f.runtime.payload = async (target) =>
    fs.link(world, path.join(target, 'hard-linked'));
  await assert.rejects(
    f.provider.install(await f.provider.resolve({channel: 'public'})),
    /unsafe entries/,
  );
  assert.equal(await fs.readFile(world, 'utf8'), 'untouched fixture');
  const bounded = await fixture(t);
  const limited = createSteamProvider({...bounded.options, maxFiles: 1});
  await assert.rejects(
    limited.install(await limited.resolve({channel: 'public'})),
    /budget/,
  );
});

test('inventory metadata limits are enforced before payload reads and receipts detect content changes', async (t) => {
  const f = await fixture(t),
    root = path.join(f.root, 'inventory');
  await fs.mkdir(root);
  const file = await fs.open(path.join(root, 'large'), 'w');
  await file.truncate(1024 * 1024);
  await file.close();
  await assert.rejects(softwareInventory(root, {maxBytes: 100}), /budget/);
  await fs.writeFile(path.join(root, 'large'), 'same size');
  const first = await softwareInventory(root);
  await fs.writeFile(path.join(root, 'large'), 'new bytes');
  const second = await softwareInventory(root);
  assert.notEqual(first.inventory.sha256, second.inventory.sha256);
});

test('Steam workers use a clean environment, bounded output and complete cancellation before rejecting', async () => {
  process.env.LOBBY_STEAM_FIXTURE_SECRET = 'must-not-inherit';
  try {
    const output = await runSteamCommand(
      [
        '-e',
        'console.log(process.env.LOBBY_STEAM_FIXTURE_SECRET || "clean");process.stdout.write("x".repeat(9*1024*1024));',
      ],
      {program: process.execPath, timeout: 10000},
    );
    assert.ok(output.length <= 8 * 1024 ** 2);
    assert.ok(!output.includes('must-not-inherit'));
    const controller = new AbortController();
    const code =
      'console.log("PID="+process.pid);console.log("Update state (0x61) downloading, progress: 1 (1 / 100)");setInterval(()=>{},1000);';
    let failed;
    try {
      await runSteamCommand(['-e', code], {
        program: process.execPath,
        signal: controller.signal,
        timeout: 10000,
        onProgress: async () => controller.abort(),
      });
    } catch (error) {
      failed = error;
    }
    assert.equal(failed.status, 409);
    const pid = Number(failed.diagnostic.match(/PID=(\d+)/)[1]);
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    await assert.rejects(
      runSteamCommand(['-e', 'setInterval(()=>{},1000)'], {
        program: process.execPath,
        timeout: 50,
      }),
      (error) => error.status === 504,
    );
  } finally {
    delete process.env.LOBBY_STEAM_FIXTURE_SECRET;
  }
});

test('an interrupted partial download can be reviewed and resumed without claiming an empty installation', async (t) => {
  const f = await fixture(t),
    selected = await f.provider.resolve({channel: 'public'});
  f.runtime.failDownload = true;
  await assert.rejects(f.provider.install(selected));
  const record = {
    ...(await f.provider.read()),
    state: 'downloading',
    progress: {receivedBytes: 0},
  };
  delete record.error;
  await fs.writeFile(
    path.join(f.control, 'installation.json'),
    JSON.stringify(record),
  );
  const inspected = await f.provider.inspect();
  assert.equal(inspected.observation.state, 'partial');
  const recovered = await f.provider.recover(inspected, {
    confirm: true,
    offline: true,
  });
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.error, 'interrupted');
  f.runtime.failDownload = false;
  assert.equal(
    await f.provider.installed(await f.provider.install(selected)),
    true,
  );
});

test('required software declarations are copied and cannot be weakened after registration', async (t) => {
  const f = await fixture(t),
    provider = createSteamProvider(f.options);
  f.options.requiredFiles.splice(0);
  f.runtime.payload = async (root) =>
    fs.unlink(path.join(root, 'RustDedicated'));
  await assert.rejects(
    provider.install(await provider.resolve({channel: 'public'})),
    /Required Steam software/,
  );
});

test('retained staging from an older failed target cannot be reported as empty after a new preflight failure', async (t) => {
  const f = await fixture(t),
    first = await f.provider.resolve({channel: 'public'});
  f.runtime.failDownload = true;
  await assert.rejects(f.provider.install(first));
  const failedA = await f.provider.read();
  f.runtime.build = '12346';
  const limited = createSteamProvider({...f.options, disk: async () => 0});
  const second = await limited.resolve({channel: 'public'});
  await assert.rejects(limited.install(second), /insufficient space/);
  const failedB = await limited.read();
  assert.notEqual(failedA.operationId, failedB.operationId);
  assert.equal(
    await fs
      .stat(path.join(f.software, 'staging', failedB.operationId))
      .catch(() => null),
    null,
  );
  const review = await limited.inspect();
  assert.equal(review.observation.state, 'partial');
  const recovered = await limited.recover(review, {
    confirm: true,
    offline: true,
  });
  assert.equal(recovered.state, 'failed');
  f.runtime.failDownload = false;
  assert.equal(
    await f.provider.installed(await f.provider.install(second)),
    true,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.software, 'staging', failedA.operationId, 'partial'),
      'utf8',
    ),
    'resumable',
  );
});

test('unknown inspector observations cannot satisfy empty or stopped-state requirements', async (t) => {
  const f = await fixture(t),
    target = await f.provider.resolve({channel: 'public'});
  const unknownEmpty = createSteamProvider({
    ...f.options,
    isApplicationEmpty: async () => ({state: 'unknown'}),
  });
  assert.equal(await unknownEmpty.empty(), false);
  await assert.rejects(unknownEmpty.install(target), /adoption or recovery/);
  const staged = await f.provider.stage(target, {confirm: true});
  const unknownStopped = createSteamProvider({
    ...f.options,
    isApplicationStopped: async () => 'unknown',
  });
  await assert.rejects(
    unknownStopped.activate(staged, {confirm: true}),
    /Stop the application/,
  );
  assert.equal(
    await fs.stat(path.join(f.control, 'active.json')).catch(() => null),
    null,
  );
});

test('activation requires a stopped application and leaves staged software and the prior pointer intact', async (t) => {
  const f = await fixture(t),
    receipt = await f.provider.install(
      await f.provider.resolve({channel: 'public'}),
    );
  f.runtime.build = '12346';
  const staged = await f.provider.stage(
    await f.provider.resolve({channel: 'public'}),
    {confirm: true},
  );
  f.runtime.stopped = false;
  await assert.rejects(
    f.provider.activate(staged, {confirm: true}),
    /Stop the application/,
  );
  assert.equal((await f.provider.read()).state, 'validating');
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.control, 'active.json'))),
    receipt,
  );
  f.runtime.stopped = true;
  assert.equal(
    (await f.provider.activate(staged, {confirm: true})).selection
      .softwareVersion,
    '12346',
  );
});
