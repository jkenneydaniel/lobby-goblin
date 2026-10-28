import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {repairMigrationHistory} from '../core/migration-history.js';
import {RegistryRepository} from '../core/storage/state-repositories.js';
import {closeStorage} from '../core/storage/selection.js';
import {
  planStorageMigration,
  applyStorageMigration,
} from '../core/storage/migrations.js';
import {Operations} from '../core/operations.js';
import {OperationFeed, jobOperationSource} from '../core/operation-feed.js';
import {recordOperation} from '../core/operation-record.js';
import {assertManagementIdle} from '../core/management-maintenance.js';
import {migrateFleet} from '../fleet/migrations.js';
import {storageMain} from '../storage.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-migration-history-')),
  );
  t.after(async () => {
    await closeStorage(root);
    await fs.rm(root, {recursive: true, force: true});
  });
  const interrupted = {
    id: 'migration-034',
    action: 'image-migration',
    actor: 'system',
    state: 'interrupted',
    phase: 'interrupted',
    started: '2026-10-20T00:00:00Z',
    recovery: {required: true},
  };
  recordOperation(interrupted, {
    source: 'jobs',
    action: 'image-migration',
    kind: 'application',
  });
  const registry = {
    version: 1,
    servers: [],
    snapshots: [],
    settings: {memoryBudgetGiB: 16, revision: 1},
    jobs: [
      {
        id: 'migration-034',
        action: 'image-migration',
        actor: 'system',
        state: 'succeeded',
        started: '2026-10-21T00:00:00Z',
      },
      interrupted,
      {
        id: 'unrelated',
        action: 'create',
        state: 'succeeded',
        actor: 'administrator',
        started: '2026-10-19T00:00:00Z',
      },
    ],
  };
  await fs.writeFile(
    path.join(root, 'registry.json'),
    JSON.stringify(registry),
  );
  return {root, registry};
}
test('each automatic migration retry has its own ID and retains migration correlation', async () => {
  const manager = {
    state: {
      servers: [
        {
          id: 'a'.repeat(32),
          game: 'rust',
          state: 'installed',
          image: 'didstopia/rust-server:latest',
        },
      ],
      jobs: [],
    },
    active: null,
    persist: async () => {},
    ownedVolume: async () => {
      throw Error('fixture: no game actions permitted');
    },
  };
  await migrateFleet(manager);
  await migrateFleet(manager);
  assert.equal(manager.state.jobs.length, 2);
  assert.notEqual(manager.state.jobs[0].id, manager.state.jobs[1].id);
  assert.ok(
    manager.state.jobs.every(
      (job) =>
        /^[a-f0-9]{32}$/.test(job.id) && job.migrationId === 'migration-034',
    ),
  );
});
for (const sqlite of [false, true])
  test(`legacy duplicate repair preserves every record and recovery guard (${sqlite ? 'sqlite' : 'JSON'})`, async (t) => {
    const {root, registry} = await fixture(t),
      legacy = await fs.readFile(path.join(root, 'registry.json'));
    if (sqlite)
      await applyStorageMigration(await planStorageMigration(root, 'host'), {
        offline: true,
        confirm: true,
      });
    const result = await repairMigrationHistory(root),
      repository = new RegistryRepository(root),
      snapshot = await repository.read();
    assert.equal(result.repaired, 2);
    assert.equal(new Set(snapshot.value.jobs.map((job) => job.id)).size, 3);
    assert.deepEqual(
      JSON.parse(await fs.readFile(result.backup, 'utf8')).registry,
      registry,
    );
    if (process.platform !== 'win32')
      assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
    assert.deepEqual(snapshot.value.servers, registry.servers);
    assert.deepEqual(snapshot.value.settings, registry.settings);
    assert.deepEqual(snapshot.value.jobs[2], registry.jobs[2]);
    assert.equal(
      snapshot.value.jobs[1].operationRecord.sourceId,
      snapshot.value.jobs[1].id,
    );
    const operations = new Operations({
      getJobs: () => snapshot.value.jobs,
      setJobs: (value) => {
        snapshot.value.jobs = value;
      },
      getActive: () => null,
      setActive: () => {},
      persist: () => repository.save(snapshot, snapshot.value),
    });
    await operations.init();
    const feed = await new OperationFeed({
      scope: 'fixture',
      sources: [jobOperationSource(operations)],
    }).snapshot();
    assert.equal(feed.sources[0].available, true);
    assert.throws(
      () => assertManagementIdle(feed),
      /active or still needs review/,
    );
    assert.equal(snapshot.value.jobs[1].recovery.required, true);
    const before = structuredClone((await repository.read()).value);
    assert.deepEqual(await repairMigrationHistory(root), {repaired: 0});
    assert.deepEqual((await repository.read()).value, before);
    if (sqlite)
      assert.deepEqual(
        await fs.readFile(path.join(root, 'registry.json')),
        legacy,
      );
  });
test('ambiguous legacy references and foreign collisions are never silently repaired', async (t) => {
  for (const mode of ['foreign', 'reference', 'envelope']) {
    const {root, registry} = await fixture(t);
    if (mode === 'foreign') registry.jobs[1].actor = 'operator';
    if (mode === 'reference') registry.jobs[2].retryOf = 'migration-034';
    if (mode === 'envelope')
      registry.jobs[1].operationRecord.sourceId = 'different';
    const file = path.join(root, 'registry.json');
    await fs.writeFile(file, JSON.stringify(registry));
    const original = await fs.readFile(file);
    await assert.rejects(repairMigrationHistory(root), /ambiguous/);
    assert.deepEqual(await fs.readFile(file), original);
  }
});
test('offline maintenance requires explicit confirmation and produces the same durable repair without Docker', async (t) => {
  const {root} = await fixture(t);
  await assert.rejects(
    storageMain(['repair-migration-history', '--root', root], {
      write: () => {},
    }),
    /offline/,
  );
  const result = await storageMain(
    ['repair-migration-history', '--root', root, '--offline', '--confirm'],
    {write: () => {}},
  );
  assert.equal(result.repaired, 2);
});

test('startup repairs known identities before building operation history without calling Docker', async (t) => {
  const {FleetManager} = await import('../fleet/manager.js');
  const {root} = await fixture(t),
    fleet = 'a'.repeat(32),
    prefix = 'lobby-goblin-fleet-' + fleet;
  const manager = new FleetManager({
    root,
    library: path.join(root, 'library'),
    fleet,
    stateVolume: prefix + '-state',
    libraryVolume: prefix + '-library',
    image: 'fixture',
    docker: () => assert.fail('startup history repair must not call Docker'),
  });
  await manager.init();
  assert.equal(new Set(manager.state.jobs.map((job) => job.id)).size, 3);
  assert.equal(manager.operations.pending.length, 1);
});
test('a durable backup survives interruption before publication and is reused on retry', async (t) => {
  const {root} = await fixture(t),
    file = path.join(root, 'registry.json'),
    before = await fs.readFile(file);
  const first = await repairMigrationHistory(root),
    backup = await fs.readFile(first.backup);
  // Simulate process loss after durable backup but before publishing the registry.
  await fs.writeFile(file, before);
  const repeated = await repairMigrationHistory(root);
  assert.deepEqual(repeated.changes, first.changes);
  assert.deepEqual(await fs.readFile(first.backup), backup);
  assert.equal((await fs.readdir(path.dirname(first.backup))).length, 1);
});
