import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert, readJSON, writeJSON} from '../common.js';
import {validId} from '../core/instance.js';
import {selectedApplication} from '../applications/index.js';
import {
  retainedInventory,
  retainedRecord,
  copyRetainedFiles,
} from './retained-files.js';
import {storageWorkerFailure} from './storage-worker.js';

export async function runRetainedWorker(
  config,
  {
    source = '/source',
    instance = '/instance',
    resolveGame = selectedApplication,
  } = {},
) {
  assert(
    config &&
      validId(config.fleet) &&
      validId(config.sourceId) &&
      ['inspect', 'copy'].includes(config.action),
    'Invalid retained storage operation.',
  );
  const inventory = await retainedInventory(source),
    owner = await retainedRecord(source, '.fleet-owner.json', {
      optional: false,
    });
  assert(
    owner?.fleet === config.fleet &&
      owner.id === config.sourceId &&
      owner.game === config.game,
    'Retained storage belongs to another server.',
    409,
  );
  const managed = resolveGame(config.game).managed;
  let recovery;
  try {
    assert(
      !inventory.entries.some(
        (e) =>
          e.name.split('/').includes('.panel-storage-lock') ||
          e.name === 'data/runtime/request.json',
      ),
      'An interrupted storage writer needs manual recovery review before copying.',
      409,
    );
    assert(
      managed.retained,
      'This application does not yet declare retained-storage recovery.',
      409,
    );
    // Interrupted updates retain their original recovery evidence. Copying a
    // half-published installation into fresh control state would bypass its gate.
    for (const entry of inventory.entries.filter(
      (e) => e.type === 'file' && /^updates\/[a-f0-9-]{36}\.json$/.test(e.name),
    )) {
      const job = await retainedRecord(source, entry.name, {optional: false});
      assert(
        !['preparing', 'running', 'recovering'].includes(job.state) &&
          !job.recovery?.requiresWorldRestore &&
          !(job.recovery?.interrupted && !job.recovery.acknowledged),
        'An interrupted image update needs manual recovery review before copying.',
        409,
      );
    }
    recovery = {
      ready: true,
      ...(await managed.retained.inspect({
        source,
        config,
        read: (name) => retainedRecord(source, name),
      })),
    };
    const roots = [
      'data',
      'backups',
      'software',
      'library',
      ...managed.retained.state,
    ];
    assert(
      inventory.entries
        .filter((e) =>
          roots.some(
            (root) => e.name === root || e.name.startsWith(root + '/'),
          ),
        )
        .every(
          (e) =>
            e.type === 'file' ||
            e.type === 'directory' ||
            (e.type === 'link' && recovery.links?.[e.name] === e.link),
        ),
      'Links or special files require manual recovery review.',
      409,
    );
  } catch (error) {
    recovery = {
      ready: false,
      reason:
        error.status === 409
          ? error.message
          : 'Application recovery metadata needs manual review.',
    };
  }
  if (config.action === 'inspect')
    return {
      summary: inventory.summary,
      fingerprint: inventory.fingerprint,
      recovery,
    };
  assert(recovery.ready, recovery.reason, 409);
  assert(
    inventory.fingerprint === config.fingerprint,
    'Retained storage changed. Inspect it again before recovering.',
    409,
  );
  assert(
    validId(config.id) &&
      config.id !== config.sourceId &&
      /^[a-f0-9]{64}$/.test(config.nonce),
    'Invalid recovery destination.',
  );
  const targetOwner = await retainedRecord(instance, '.fleet-owner.json', {
      optional: false,
    }),
    marker = await retainedRecord(instance, 'control/retained-recovery.json', {
      optional: false,
    });
  assert(
    targetOwner?.fleet === config.fleet &&
      targetOwner.id === config.id &&
      targetOwner.game === config.game &&
      marker?.sourceId === config.sourceId &&
      marker.targetId === config.id &&
      marker.nonce === config.nonce,
    'Recovery requires a newly provisioned destination.',
    409,
  );
  // Only application data and declared stable application state are copied.
  // Management tokens, job history and worker requests stay freshly provisioned.
  await copyRetainedFiles(
    source,
    instance,
    inventory,
    ['data', 'backups', 'software', 'library', ...managed.retained.state],
    recovery.links,
  );
  await managed.retained.rebind({
    instance,
    config,
    recovery,
    read: (name) => retainedRecord(instance, name),
  });
  assert(
    (await retainedInventory(source)).fingerprint === inventory.fingerprint,
    'Source storage changed during recovery. The new server remains stopped.',
    409,
  );
  await fs.rm(path.join(instance, 'control/retained-recovery.json'));
  return {
    copied: true,
    summary: inventory.summary,
    fingerprint: inventory.fingerprint,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await writeJSON(
      '/setup/result.json',
      await runRetainedWorker(await readJSON('/setup/request.json', null)),
    );
  } catch (error) {
    const failures = {
      ENOSPC:
        'There is not enough free space for recovery. Original storage was kept.',
      EDQUOT:
        'The recovery storage quota was reached. Original storage was kept.',
      EACCES: 'Retained storage access was denied. Review volume permissions.',
      EPERM: 'Retained storage access was denied. Review volume permissions.',
      EROFS:
        'Recovery destination storage is read-only. Original storage was kept.',
      ENOENT:
        'Retained storage or recovery metadata is missing. Inspect storage again.',
    };
    const failure = failures[error?.code]
      ? {version: 1, error: failures[error.code]}
      : storageWorkerFailure(error);
    await writeJSON('/setup/failure.json', failure).catch(() => {});
    console.error(failure.error);
    process.exitCode = 1;
  }
}
