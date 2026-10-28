import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assert} from '../common.js';
import {jobOperation} from './operation-record.js';
import {RegistryRepository} from './storage/state-repositories.js';
import {withStorageLock} from './storage/coordination.js';
import {regularFile, parseStorageJSON, publishJSON} from './storage/files.js';

export const imageMigrationId = 'migration-034';
export const imageMigrationAttempt = () => ({
  id: crypto.randomBytes(16).toString('hex'),
  migrationId: imageMigrationId,
});
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Repair only the known historical system migration. No attempt is discarded,
// settled, acknowledged or replayed. Unknown collisions and ambiguous external
// references remain blocked for operator review.
export async function repairMigrationHistory(root) {
  assert(
    (await fs.realpath(root)) === path.resolve(root),
    'Migration history needs canonical management storage.',
  );
  return withStorageLock(root, 'write', async () => {
    const repository = new RegistryRepository(root),
      snapshot = await repository.read();
    const original = snapshot.value,
      state = structuredClone(original);
    const matches = state.jobs
      .map((job, index) => ({job, index}))
      .filter(({job}) => job.id === imageMigrationId);
    if (matches.length < 2) return {repaired: 0};
    assert(
      matches.every(
        ({job}) =>
          job.action === 'image-migration' &&
          job.actor === 'system' &&
          !job.requestId &&
          !job.retryOf &&
          !job.legacyMigrationIdentity &&
          (!job.operationRecord ||
            (job.operationRecord.version === 1 &&
              job.operationRecord.source === 'jobs' &&
              job.operationRecord.sourceId === imageMigrationId &&
              job.operationRecord.action === 'image-migration' &&
              !job.operationRecord.parentId)),
      ) &&
        !state.jobs.some(
          (job) =>
            job.retryOf === imageMigrationId ||
            job.operationRecord?.parentId === imageMigrationId,
        ),
      'Legacy migration identities have ambiguous references. Preserve the registry for operator review.',
      409,
    );
    for (const {job} of matches) jobOperation(job);
    const digest = hash(original),
      ids = new Set(state.jobs.map((job) => job.id));
    const changes = matches.map(({job, index}) => {
      const id = 'migration-' + hash({digest, index}).slice(0, 32);
      assert(
        !ids.has(id),
        'Repaired migration identity collides with existing history.',
        409,
      );
      ids.add(id);
      job.id = id;
      job.migrationId = imageMigrationId;
      job.legacyMigrationIdentity = {
        id: imageMigrationId,
        index,
        registryHash: digest,
      };
      if (job.operationRecord) job.operationRecord.sourceId = id;
      return {index, previousId: imageMigrationId, id};
    });
    const directory = path.join(root, 'migration-history-repairs');
    await fs.mkdir(directory, {mode: 0o700, recursive: true});
    const stat = await fs.lstat(directory);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await fs.realpath(directory)) === directory &&
        (process.platform === 'win32' || (stat.mode & 0o077) === 0),
      'Migration history backups cannot be links.',
    );
    const backup = path.join(directory, digest + '.json'),
      receipt = {version: 1, registryHash: digest, changes, registry: original};
    const existing = await regularFile(backup, {optional: true});
    if (existing)
      assert(
        hash(parseStorageJSON(existing)) === hash(receipt),
        'Migration history backup changed. Preserve it for review.',
        409,
      );
    else await publishJSON(backup, receipt);
    // Repository revision checks and the shared writer lease prevent overwriting
    // concurrent state. The durable original exists before publishing new IDs.
    await repository.saveLocked(snapshot, state);
    return {repaired: changes.length, backup, registryHash: digest, changes};
  });
}
