import crypto from 'node:crypto';
import {executionProjection} from '../core/software-execution.js';
import {softwareInventory} from '../providers/steamcmd/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runWorker} from '../fleet/worker.js';
import {runRetainedWorker} from '../fleet/retained-worker.js';
import {retainedInventory} from '../fleet/retained-files.js';
import {RetainedStorage} from '../fleet/retained-manager.js';
import {selectedApplication} from '../applications/index.js';
import {resources, labels} from '../core/instance.js';
import {writeJSON, readJSON} from '../common.js';
import {remoteRoute} from '../fleet/hosts.js';
const fleet = 'a'.repeat(32),
  sourceId = 'b'.repeat(32),
  id = 'c'.repeat(32),
  nonce = 'd'.repeat(64);
async function fixture(t, game = 'factorio', extra = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'goblin-retained-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'),
    instance = path.join(root, 'target'),
    library = path.join(root, 'library');
  for (const directory of [source, instance, library])
    await fs.mkdir(directory);
  const config = {
    fleet,
    game,
    name: 'Original',
    seed: 456,
    worldSize: 2000,
    maxPlayers: 8,
    controllerToken: 'old-controller',
    rconPassword: 'old-rcon',
    image: selectedApplication(game).managed.catalog.image,
    ...extra,
  };
  await runWorker(
    {...config, action: 'provision', id: sourceId},
    {instance: source, library},
  );
  const next = {
    ...config,
    name: 'Recovered',
    controllerToken: 'new-controller',
    rconPassword: 'new-rcon',
    id,
    retainedRecovery: {sourceId, nonce},
  };
  await runWorker({...next, action: 'provision'}, {instance, library});
  return {
    root,
    source,
    instance,
    library,
    config,
    next,
    request: {...config, action: 'inspect', sourceId},
    options: {source, instance},
  };
}
async function put(root, name, data) {
  await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true});
  await fs.writeFile(path.join(root, name), data, {mode: 0o600});
}
test('Factorio recovery copies worlds, mods, backups and presets with fresh control state and credentials', async (t) => {
  const f = await fixture(t);
  for (const [name, data] of Object.entries({
    'data/saves/world.zip': 'synthetic world',
    'data/mods/custom.zip': 'synthetic mod',
    'backups/panel-backups/old.zip': 'synthetic backup',
    'library/preset.json': '{}',
    'state/mod-library/installed.json': '{}',
    'state/jobs.json': 'old jobs',
    'state/factorio-mod-account.json': 'private account',
    'data/config/rconpw': 'old-rcon',
  }))
    await put(f.source, name, data);
  const inspected = await runRetainedWorker(f.request, f.options),
    before = (await retainedInventory(f.source)).fingerprint;
  assert.equal(inspected.recovery.ready, true);
  await runRetainedWorker(
    {
      ...f.request,
      ...f.next,
      sourceId,
      action: 'copy',
      nonce,
      fingerprint: inspected.fingerprint,
    },
    f.options,
  );
  for (const name of [
    'data/saves/world.zip',
    'data/mods/custom.zip',
    'backups/panel-backups/old.zip',
    'library/preset.json',
  ])
    assert.deepEqual(
      await fs.readFile(path.join(f.instance, name)),
      await fs.readFile(path.join(f.source, name)),
    );
  assert.equal(
    await fs.readFile(
      path.join(f.instance, 'control/controller-token'),
      'utf8',
    ),
    'new-controller',
  );
  assert.equal(
    await fs.readFile(path.join(f.instance, 'data/config/rconpw'), 'utf8'),
    'new-rcon',
  );
  for (const name of [
    'state/jobs.json',
    'state/factorio-mod-account.json',
    'control/retained-recovery.json',
  ])
    await assert.rejects(fs.stat(path.join(f.instance, name)), {
      code: 'ENOENT',
    });
  assert.equal(
    (await readJSON(path.join(f.instance, 'state/map-refresh.json'))).enabled,
    false,
  );
  assert.equal((await retainedInventory(f.source)).fingerprint, before);
  await fs.writeFile(
    path.join(f.instance, 'data/saves/world.zip'),
    'independent edit',
  );
  assert.equal(
    await fs.readFile(path.join(f.source, 'data/saves/world.zip'), 'utf8'),
    'synthetic world',
  );
});
test('Rust recovery keeps player progress, frameworks and backups, normalizes legacy seeds, and rotates identity', async (t) => {
  const f = await fixture(t, 'rust', {seed: 3532793187});
  for (const [name, data] of Object.entries({
    'data/server/lobby-goblin-rust/proceduralmap.2000.2147483647.289.sav':
      'world',
    'data/server/lobby-goblin-rust/player.blueprints.5.db': 'players',
    'data/server/lobby-goblin-rust/oxide/plugins/Custom.cs': 'plugin',
    'state/mods/installed.json': '{"framework":"oxide"}',
    'backups/archives/old.tar.gz': 'backup',
  }))
    await put(f.source, name, data);
  await fs.appendFile(
    path.join(f.source, 'data/server/lobby-goblin-rust/cfg/server.cfg'),
    'rcon.password old-rcon\nrcon.port 1234\nserver.description "Keep this"\n',
  );
  const inspected = await runRetainedWorker(f.request, f.options);
  assert.equal(inspected.recovery.ready, true);
  assert.equal(inspected.recovery.seed, 2147483647);
  const before = (await retainedInventory(f.source)).fingerprint;
  await runRetainedWorker(
    {
      ...f.request,
      ...f.next,
      sourceId,
      action: 'copy',
      nonce,
      fingerprint: inspected.fingerprint,
    },
    f.options,
  );
  assert.equal(
    (
      await readJSON(
        path.join(f.instance, 'data/server/.lobby-goblin-rust.json'),
      )
    ).instance,
    id,
  );
  assert.equal(
    await fs.readFile(path.join(f.instance, 'control/rcon-password'), 'utf8'),
    'new-rcon',
  );
  const cfg = await fs.readFile(
    path.join(f.instance, 'data/server/lobby-goblin-rust/cfg/server.cfg'),
    'utf8',
  );
  assert.doesNotMatch(cfg, /old-rcon|rcon\.port/);
  assert.match(cfg, /Keep this/);
  assert.equal(
    await fs.readFile(
      path.join(
        f.instance,
        'data/server/lobby-goblin-rust/oxide/plugins/Custom.cs',
      ),
      'utf8',
    ),
    'plugin',
  );
  assert.equal((await retainedInventory(f.source)).fingerprint, before);
});
test('recovery blocks interrupted changes, mismatched Rust worlds, links, stale inventory, and non-fresh targets', async (t) => {
  const f = await fixture(t);
  await put(
    f.source,
    'state/mod-library/transaction.json',
    '{"phase":"applying"}',
  );
  assert.equal(
    (await runRetainedWorker(f.request, f.options)).recovery.ready,
    false,
  );
  await fs.rm(path.join(f.source, 'state/mod-library/transaction.json'));
  if (process.platform !== 'win32') {
    await fs.symlink('/outside', path.join(f.source, 'data/escape'));
    const review = await runRetainedWorker(f.request, f.options);
    assert.equal(review.recovery.ready, false);
    await fs.unlink(path.join(f.source, 'data/escape'));
  }
  const review = await runRetainedWorker(f.request, f.options);
  await put(f.source, 'data/changed', 'new');
  const copy = {
    ...f.request,
    ...f.next,
    action: 'copy',
    sourceId,
    nonce,
    fingerprint: review.fingerprint,
  };
  await assert.rejects(runRetainedWorker(copy, f.options), /changed/);
  copy.fingerprint = (
    await runRetainedWorker(f.request, f.options)
  ).fingerprint;
  await fs.rm(path.join(f.instance, 'control/retained-recovery.json'));
  await assert.rejects(runRetainedWorker(copy, f.options));
  const rust = await fixture(t, 'rust');
  await put(
    rust.source,
    'data/server/lobby-goblin-rust/proceduralmap.2000.999.289.sav',
    'wrong world',
  );
  assert.equal(
    (await runRetainedWorker(rust.request, rust.options)).recovery.ready,
    false,
  );
});
test('inspection is bounded and never follows external links', async (t) => {
  const f = await fixture(t);
  await assert.rejects(retainedInventory(f.source, {maxEntries: 1}), /limit/);
  if (process.platform !== 'win32') {
    await fs.symlink('/unreadable/outside', path.join(f.source, 'link'));
    const value = await retainedInventory(f.source);
    assert.equal(value.summary.unsupported, 1);
    assert.equal(
      value.entries.find((e) => e.name === 'link').link,
      '/unreadable/outside',
    );
  }
});
function managerFixture() {
  const item = {
    id: sourceId,
    game: 'factorio',
    name: 'Removed',
    state: 'removed',
    seed: 456,
    cpu: 1,
    memoryGiB: 2,
    maxPlayers: 8,
    image: selectedApplication('factorio').managed.catalog.image,
    ...resources(fleet, sourceId, 'factorio'),
  };
  const calls = [],
    volume = {
      Name: item.volume,
      Driver: 'local',
      Scope: 'local',
      Options: null,
      Labels: labels(fleet, sourceId, 'factorio'),
      CreatedAt: '2026-10-27T12:00:00Z',
    };
  let refs = [],
    container = false;
  const manager = {
    fleet,
    state: {servers: [item]},
    modules: new Map([['factorio', selectedApplication('factorio')]]),
    server: () => item,
    persist: async () => {},
    stage: async () => {},
    ownedVolume: async () => volume,
    ownedContainer: async () => {
      if (container) return {};
      throw Object.assign(Error('absent'), {status: 404});
    },
    docker: async (method, route) => {
      calls.push({method, route});
      if (method === 'GET') return refs;
      return null;
    },
    create: async (input, _job, options) => ({input, options}),
  };
  const service = new RetainedStorage(manager);
  service.helper = async () => ({
    fingerprint: 'original',
    summary: {files: 1, bytes: 10},
    recovery: {ready: true},
  });
  const review = () => {
    item.storageReview = {
      identity: null,
      token: 'review-token',
      inspectedAt: new Date().toISOString(),
      fingerprint: 'original',
      recovery: {ready: true},
    };
  };
  const input = {
    serverId: sourceId,
    name: item.name,
    confirm: true,
    reviewToken: 'review-token',
    newName: 'Recovered',
  };
  return {
    service,
    item,
    calls,
    volume,
    input,
    review,
    setRefs: (value) => (refs = value),
    setContainer: (value) => (container = value),
  };
}
test('permanent deletion requires fresh review, stable identity and zero container references, and keeps snapshots', async () => {
  const f = managerFixture();
  await assert.rejects(f.service.remove(f.input, {}), /Inspect/);
  f.review();
  f.item.storageReview.identity = await f.service.available(f.item);
  f.setRefs([{Id: 'foreign-stopped-container'}]);
  await assert.rejects(f.service.remove(f.input, {}), /still uses/);
  f.setRefs([]);
  f.setContainer(true);
  await assert.rejects(f.service.remove(f.input, {}), /still exists/);
  f.setContainer(false);
  f.volume.CreatedAt = 'replacement';
  await assert.rejects(f.service.remove(f.input, {}), /ownership changed/);
  f.item.storageReview.identity = await f.service.available(f.item);
  f.service.helper = async () => ({fingerprint: 'modified'});
  await assert.rejects(f.service.remove(f.input, {}), /contents changed/);
  f.service.helper = async () => ({fingerprint: 'original'});
  await f.service.remove(f.input, {});
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'DELETE'),
    [{method: 'DELETE', route: '/volumes/' + f.item.volume}],
  );
  assert.ok(f.item.storageDeletedAt);
});
test('recovery chooses registered source image and software, forces a stopped independent server and ignores resource overrides', async () => {
  const f = managerFixture();
  f.review();
  f.item.storageReview.identity = await f.service.available(f.item);
  const result = await f.service.recover(
    {...f.input, image: 'attacker/image', game: 'rust', volume: 'another'},
    {},
  );
  assert.equal(result.input.autoStart, false);
  assert.equal(result.input.game, 'factorio');
  assert.equal(result.options.source, f.item);
  assert.equal(result.options.source.image, f.item.image);
  assert.equal(result.input.name, 'Recovered');
  assert.match(result.options.nonce, /^[a-f0-9]{64}$/);
});
test('paired hosts accept only explicit storage operations and no arbitrary volume API', () => {
  for (const action of ['inspect', 'recover', 'remove']) {
    assert.equal(remoteRoute('POST', `/removed-servers/${id}/${action}`), true);
    assert.equal(remoteRoute('GET', `/removed-servers/${id}/${action}`), false);
  }
  assert.equal(remoteRoute('DELETE', '/volumes/' + id), false);
  assert.equal(remoteRoute('POST', '/removed-servers/' + id + '/prune'), false);
});

const unix = process.platform === 'win32' ? test.skip : test;
unix(
  'managed Rust recovery preserves sealed software, private cache permissions and declared framework links',
  async (t) => {
    const f = await fixture(t, 'rust', {softwareMode: 'managed'}),
      engine = path.join(f.source, 'data/engine');
    await put(f.source, 'data/engine/RustDedicated', 'synthetic binary');
    await fs.chmod(path.join(engine, 'RustDedicated'), 0o755);
    const receipt = {
        format: 1,
        selection: {
          format: 1,
          provider: 'steamcmd',
          application: 'rust',
          platform: 'linux/amd64',
          softwareVersion: '123',
          source: {
            kind: 'steam',
            appId: '258550',
            branch: 'public',
            buildId: '123',
            depots: [{id: '258551', manifest: '12345678901234567890'}],
          },
        },
        inventory: (await softwareInventory(engine)).inventory,
      },
      binary = {
        name: 'RustDedicated',
        executable: true,
        sha256: crypto
          .createHash('sha256')
          .update('synthetic binary')
          .digest('hex'),
      },
      initialId = crypto.randomUUID();
    await put(
      f.source,
      'data/server/lobby-goblin-rust/proceduralmap.2000.456.289.sav',
      'managed world',
    );
    await put(f.source, 'state/mods/installed.json', '{"framework":"oxide"}');
    await writeJSON(
      path.join(f.source, 'state/software/rust/installation.json'),
      {
        format: 1,
        id: initialId,
        instance: sourceId,
        phase: 'complete',
        prepared: {receipt},
        binary,
      },
    );
    await writeJSON(path.join(f.source, 'state/software/rust/current.json'), {
      format: 1,
      initialId,
      transactionId: crypto.randomUUID(),
      receipt,
      binary,
    });
    await writeJSON(
      path.join(f.source, 'data/.lobby-goblin-runtime.json'),
      executionProjection(receipt, binary, 'rust'),
    );
    await put(f.source, 'software/steamcmd/private-cache', 'pristine cache');
    await put(f.source, 'state/software/steamcmd/cache.json', '{}');
    await put(
      f.source,
      'data/server/lobby-goblin-rust/mods/oxide/plugins/Custom.cs',
      'plugin',
    );
    await fs.symlink('../server', path.join(engine, 'server'));
    await fs.symlink(
      '../server/lobby-goblin-rust/mods/oxide',
      path.join(engine, 'oxide'),
    );
    const inspected = await runRetainedWorker(f.request, f.options);
    assert.equal(inspected.recovery.ready, true, inspected.recovery.reason);
    const before = inspected.fingerprint;
    await runRetainedWorker(
      {
        ...f.request,
        ...f.next,
        action: 'copy',
        sourceId,
        nonce,
        fingerprint: before,
      },
      f.options,
    );
    assert.equal(
      (
        await readJSON(
          path.join(f.instance, 'state/software/rust/installation.json'),
        )
      ).instance,
      id,
    );
    assert.equal(
      await fs.readlink(path.join(f.instance, 'data/engine/server')),
      '../server',
    );
    assert.equal(
      await fs.readlink(path.join(f.instance, 'data/engine/oxide')),
      '../server/lobby-goblin-rust/mods/oxide',
    );
    assert.deepEqual(
      await readJSON(path.join(f.instance, 'state/software/rust/current.json')),
      await readJSON(path.join(f.source, 'state/software/rust/current.json')),
    );
    assert.equal(
      (await fs.stat(path.join(f.instance, 'software/steamcmd/private-cache')))
        .mode & 0o777,
      0o600,
    );
    assert.equal((await retainedInventory(f.source)).fingerprint, before);
    await fs.unlink(path.join(engine, 'server'));
    await fs.symlink('/outside', path.join(engine, 'server'));
    assert.equal(
      (await runRetainedWorker(f.request, f.options)).recovery.ready,
      false,
    );
  },
);

unix(
  'recovery metadata refuses linked parent directories before reading outside the retained volume',
  async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'outside'));
    await writeJSON(path.join(f.root, 'outside/transaction.json'), {
      phase: 'complete',
    });
    await fs.symlink(
      path.join(f.root, 'outside'),
      path.join(f.source, 'state/mod-library'),
    );
    const result = await runRetainedWorker(f.request, f.options);
    assert.equal(result.recovery.ready, false);
    assert.match(result.recovery.reason, /cannot traverse/);
  },
);

test('an interrupted recovery destination cannot be treated as a completed source copy', async (t) => {
  const f = await fixture(t);
  await writeJSON(path.join(f.source, 'control/retained-recovery.json'), {
    sourceId: id,
    targetId: sourceId,
    nonce,
  });
  const result = await runRetainedWorker(f.request, f.options);
  assert.equal(result.recovery.ready, false);
  assert.match(
    result.recovery.reason,
    /earlier recovery copy did not complete/,
  );
});
