import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert, writeJSON, readJSON} from '../common.js';
import {storageWorkerFailure} from './storage-worker.js';
import {validId} from '../core/instance.js';
import {validateManagedGame} from '../core/managed-game.js';
import {selectedApplication} from '../applications/index.js';
import {cloneSnapshot, publishSnapshot} from './snapshots.js';

export async function runWorker(
  config,
  {
    instance = '/instance',
    library = '/library',
    resolveGame = selectedApplication,
  } = {},
) {
  assert(
    validId(config.fleet) && validId(config.id),
    'Invalid worker ownership.',
  );
  const module = resolveGame(config.game),
    managed = validateManagedGame(module);
  assert(module.id === config.game, 'Invalid worker game.');
  const marker = path.join(instance, '.fleet-owner.json'),
    owner = await readJSON(marker, null);
  if (config.action === 'provision') {
    assert(
      !owner && (await fs.readdir(instance)).length === 0,
      'A new server requires an empty, unowned volume.',
    );
    await writeJSON(marker, {
      fleet: config.fleet,
      id: config.id,
      game: config.game,
    });
    for (const directory of ['data', 'state', 'backups', 'updates', 'control'])
      await fs.mkdir(path.join(instance, directory));
    const data = path.join(instance, 'data'),
      context = {instance, data, config};
    await managed.prepareStorage(context);
    if (config.snapshotId)
      await cloneSnapshot({
        library,
        id: config.snapshotId,
        hash: config.snapshotHash,
        data,
        game: config.game,
        image: config.image,
        module,
      });
    await fs.writeFile(
      path.join(instance, 'control/controller-token'),
      config.controllerToken,
      {mode: 0o600, flag: 'wx'},
    );
    await managed.configureStorage(context);
    if(config.retainedRecovery) {
      assert(validId(config.retainedRecovery.sourceId)&&/^[a-f0-9]{64}$/.test(config.retainedRecovery.nonce),'Invalid recovery marker.');
      await writeJSON(path.join(instance,'control/retained-recovery.json'),{...config.retainedRecovery,targetId:config.id});
    }
    return {initialized: true};
  }
  assert(
    owner?.fleet === config.fleet &&
      owner.id === config.id &&
      owner.game === config.game,
    'Worker storage belongs to another server.',
    409,
  );
  assert(config.action === 'snapshot', 'Unsupported worker operation.');
  assert(
    typeof config.backup === 'string' &&
      /^[A-Za-z0-9_.-]+$/.test(config.backup),
    'Invalid backup filename.',
  );
  return publishSnapshot({
    library,
    module,
    backup: path.join(
      instance,
      'backups',
      managed.backupDirectory,
      config.backup,
    ),
    record: {
      id: config.snapshotId,
      sourceId: config.id,
      sourceName: config.name,
      title: config.title,
      game: config.game,
      image: config.image,
      seed: config.seed,
      worldSize: config.worldSize,
    },
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = await readJSON('/setup/request.json', null);
    const result = await runWorker(config);
    await writeJSON('/setup/result.json', result);
  } catch (error) {
    const failure = storageWorkerFailure(error);
    await writeJSON('/setup/failure.json', failure).catch(() => {});
    console.error(failure.error);
    process.exitCode = 1;
  }
}
