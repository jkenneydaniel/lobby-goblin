import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  JobsRepository,
  RegistryRepository,
  HostSetupRepository,
  ConfigurationRepository,
} from '../core/storage/state-repositories.js';
import {commitDocuments} from '../core/storage/document-repository.js';
import {
  planStorageMigration,
  applyStorageMigration,
} from '../core/storage/migrations.js';
import {closeStorage} from '../core/storage/selection.js';
import {Operations} from '../core/operations.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-operation-invariants-')),
  );
  t.after(async () => {
    await closeStorage(root);
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}
const job = (id) => ({
  id,
  action: 'save',
  actor: 'administrator',
  state: 'succeeded',
});
for (const sqlite of [false, true])
  for (const [Repository, profile, registry] of [
    [JobsRepository, 'controller', false],
    [RegistryRepository, 'host', true],
    [HostSetupRepository, 'host', false],
  ]) {
    test(`${Repository.name} rejects duplicate IDs before publishing ${sqlite ? 'SQLite' : 'JSON'} history`, async (t) => {
      const root = await fixture(t),
        repo = new Repository(root),
        value = (jobs) =>
          registry ? {version: 1, servers: [], snapshots: [], jobs} : jobs;
      await repo.save(await repo.read(), value([job('original')]));
      if (sqlite)
        await applyStorageMigration(await planStorageMigration(root, profile), {
          offline: true,
          confirm: true,
        });
      const snapshot = await repo.read(),
        before = structuredClone(snapshot.value),
        revision = snapshot.revision;
      await assert.rejects(
        repo.save(snapshot, value([job('repeated'), job('repeated')])),
        /duplicate operation IDs/,
      );
      assert.deepEqual((await repo.read()).value, before);
      assert.equal((await repo.read()).revision, revision);
      await assert.rejects(
        repo.save(snapshot, value([job('')])),
        /invalid identity/,
      );
      await repo.save(snapshot, value([job('original'), job('different')]));
    });
  }
test('legacy collisions remain readable for evidence-based repair but cannot be resaved', async (t) => {
  const root = await fixture(t),
    file = path.join(root, 'jobs.json'),
    bytes = JSON.stringify([job('old'), job('old')]);
  await fs.writeFile(file, bytes);
  const repo = new JobsRepository(root),
    snapshot = await repo.read();
  assert.equal(snapshot.value.length, 2);
  await assert.rejects(
    repo.save(snapshot, snapshot.value),
    /duplicate operation IDs/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});
test('related document transactions validate history before committing any document', async (t) => {
  const root = await fixture(t),
    jobs = new JobsRepository(root),
    settings = new ConfigurationRepository(root, 'schedule', {});
  await jobs.save(await jobs.read(), [job('original')]);
  await settings.save(await settings.read(), {version: 1, enabled: false});
  await applyStorageMigration(await planStorageMigration(root, 'controller'), {
    offline: true,
    confirm: true,
  });
  const schedule = await settings.read(),
    history = await jobs.read();
  await assert.rejects(
    commitDocuments([
      {
        repository: settings,
        snapshot: schedule,
        value: {version: 1, enabled: true},
      },
      {
        repository: jobs,
        snapshot: history,
        value: [job('duplicate'), job('duplicate')],
      },
    ]),
    /duplicate operation IDs/,
  );
  assert.equal((await settings.read()).value.enabled, false);
});
test('a duplicate generated attempt ID is refused before audit reservation or side effects', async () => {
  let jobs = [job('existing')],
    active = null;
  const effects = [];
  const operations = new Operations({
    id: () => 'existing',
    getJobs: () => jobs,
    setJobs: (value) => {
      jobs = value;
    },
    getActive: () => active,
    setActive: (value) => {
      active = value;
    },
    persist: async () => effects.push('persist'),
    record: async () => effects.push('audit'),
  });
  await assert.rejects(
    operations.reserve({action: 'save', actor: 'administrator', input: {}}),
    /duplicate operation IDs/,
  );
  assert.equal(active, null);
  assert.deepEqual(jobs, [job('existing')]);
  assert.deepEqual(effects, []);
});
