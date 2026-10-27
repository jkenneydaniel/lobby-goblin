import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, inside, writeJSON, readJSON} from '../common.js';
import {
  hashFile,
  snapshotInventory as inventory,
} from '../core/snapshot-files.js';
import {validateManagedGame,creationSeedRange} from '../core/managed-game.js';
import {validId} from '../core/instance.js';
import {selectedApplication} from '../applications/index.js';
export {hashFile} from '../core/snapshot-files.js';
// Historical import retained for callers of the original fleet snapshot helper.
export {extractRust} from '../applications/rust/snapshots.js';

export async function publishSnapshot({
  library,
  record,
  backup,
  module = selectedApplication(record.game),
}) {
  assert(
    validId(record.id) && validId(record.sourceId) && module.id === record.game,
    'Invalid snapshot identity.',
  );
  const adapter = validateManagedGame(module).snapshots;
  const temporary = inside(library, '.pending-' + record.id),
    destination = inside(library, record.id);
  await fs.mkdir(temporary, {recursive: false});
  const content = path.join(temporary, 'content');
  await fs.mkdir(content);
  try {
    const metadata=await adapter.collect({backup, content, temporary, record})||{};
    const seedRange=creationSeedRange(module.managed.catalog.creation);
    assert(
      metadata && Object.keys(metadata).every(key => ['software', 'seed'].includes(key)) &&
        (metadata.seed === undefined || Number.isInteger(metadata.seed) &&
          metadata.seed >= seedRange.min && metadata.seed <= seedRange.max),
      'Invalid snapshot metadata.',
    );
    const files = await inventory(content);
    assert(
      files.length > 0 && files.length <= 20000,
      'Snapshot is empty or too large.',
    );
    const manifest = {
      format: 'lobby-goblin-snapshot',
      version: 1,
      ...record,
      ...metadata,
      created: new Date().toISOString(),
      files,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      includesPlayerData: adapter.includesPlayerData,
      credentialsIncluded: false,
    };
    await writeJSON(path.join(temporary, 'manifest.json'), manifest);
    await fs.rename(temporary, destination);
    return {
      id: record.id,
      manifestSha256: await hashFile(path.join(destination, 'manifest.json')),
      files: files.length,
      bytes: manifest.bytes,
    };
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}
export async function verifySnapshot(library, id, expectedHash) {
  assert(validId(id), 'Invalid snapshot.');
  const root = inside(library, id);
  assert(
    (await fs.realpath(root)) === root,
    'Snapshot links are not supported.',
  );
  assert(
    (await hashFile(path.join(root, 'manifest.json'))) === expectedHash,
    'Snapshot manifest has changed.',
    409,
  );
  const manifest = await readJSON(path.join(root, 'manifest.json'), null);
  assert(
    manifest?.format === 'lobby-goblin-snapshot' &&
      manifest.version === 1 &&
      manifest.id === id,
    'Invalid snapshot manifest.',
  );
  const files = await inventory(path.join(root, 'content'));
  assert(
    JSON.stringify(files) === JSON.stringify(manifest.files),
    'Snapshot files no longer match their hashes.',
    409,
  );
  return manifest;
}

export async function cloneSnapshot({
  library,
  id,
  hash,
  data,
  game,
  image,
  module = selectedApplication(game),
}) {
  const adapter = validateManagedGame(module).snapshots;
  const manifest = await verifySnapshot(library, id, hash);
  assert(
    module.id === game &&
      manifest.game === game &&
      adapter.compatible(manifest.image, image),
    'Snapshot game or image is incompatible.',
    409,
  );
  await adapter.restore({
    root: path.join(library, id, 'content'),
    data,
    manifest,
    id,
  });
  return manifest;
}
