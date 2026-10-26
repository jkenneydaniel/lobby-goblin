import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectedApplication} from '../applications/index.js';
import {createBackups} from '../core/backups.js';
import {makeZip} from '../core/archive.js';
import {publishSnapshot, cloneSnapshot, hashFile} from '../fleet/snapshots.js';
const MiB = 1024 * 1024;
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'container-backup-limit-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = Object.fromEntries(
    ['data', 'state', 'backupDir', 'library'].map((name) => [
      name,
      path.join(root, name),
    ]),
  );
  for (const directory of Object.values(config)) await fs.mkdir(directory);
  const module = selectedApplication('status-page');
  const controller = await module.createController({
    config,
    host: {info: async () => ({State: {Running: false}})},
    docker: () => {},
    env: {},
  });
  return {root, config, module, controller};
}
async function sparse(file, size) {
  const handle = await fs.open(file, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}
test('64 MiB of data survives verified backup, snapshot publication and cloning with UTF-8 ZIP overhead', async (t) => {
  const {root, config, module, controller} = await fixture(t),
    relative = 'nested/資料.bin';
  await fs.mkdir(path.join(config.data, 'nested'));
  const file = path.join(config.data, relative);
  await sparse(file, 64 * MiB);
  const backups = await createBackups({
    root: config.backupDir,
    state: config.state,
    game: controller,
    getJobs: () => [],
    getSchedule: () => ({enabled: false}),
  });
  const name = await backups.create('boundary');
  const backup = path.join(config.backupDir, name),
    bytes = await fs.readFile(backup);
  assert.equal(
    bytes.length,
    64 * MiB + 22 + 76 + 2 * Buffer.byteLength(relative),
  );
  assert.deepEqual(controller.validateBackup(bytes), {files: 1});
  assert.equal(backups.validations()[name].ok, true);
  const id = 'c'.repeat(32),
    image = module.imagePolicy.defaultImage;
  const published = await publishSnapshot({
    library: config.library,
    backup,
    record: {id, sourceId: 'b'.repeat(32), game: module.id, image},
    module,
  });
  assert.equal(published.bytes, 64 * MiB);
  const destination = path.join(root, 'clone');
  await fs.mkdir(destination);
  await cloneSnapshot({
    library: config.library,
    id,
    hash: published.manifestSha256,
    data: destination,
    game: module.id,
    image,
    module,
  });
  assert.equal(
    await hashFile(path.join(destination, relative)),
    await hashFile(file),
  );
});
test('maximum file count fits ZIP overhead and excessive path metadata is rejected before content reads', async (t) => {
  const {config, controller} = await fixture(t),
    directory = path.join(config.data, 'd');
  await fs.mkdir(directory);
  for (let offset = 0; offset < 4096; offset += 64)
    await Promise.all(
      Array.from({length: 64}, (_, index) =>
        fs.writeFile(
          path.join(directory, '資料-' + (offset + index) + '.bin'),
          '',
        ),
      ),
    );
  await sparse(path.join(directory, '資料-0.bin'), 64 * MiB);
  const bytes = makeZip(await controller.backupFiles());
  assert.ok(bytes.length > 64 * MiB && bytes.length <= 65 * MiB);
  assert.deepEqual(controller.validateBackup(bytes), {files: 4096});
  await fs.rename(directory, path.join(config.data, 'd'.repeat(100)));
  const original = fs.open;
  let reads = 0;
  fs.open = async (...args) => {
    reads++;
    return original(...args);
  };
  try {
    await assert.rejects(controller.backupFiles(), /including ZIP metadata/);
    assert.equal(reads, 0);
  } finally {
    fs.open = original;
  }
});
test('archive allowance preserves the data limit and rejects oversized ZIPs in validation and collection', async (t) => {
  const {config, module, controller} = await fixture(t);
  const dataArchive = makeZip([
    {name: 'data.bin', data: Buffer.alloc(64 * MiB + 1)},
  ]);
  assert.ok(dataArchive.length < 65 * MiB);
  assert.throws(
    () => controller.validateBackup(dataArchive),
    /Unsupported application archive/,
  );
  assert.throws(
    () => controller.validateBackup(Buffer.alloc(65 * MiB + 1)),
    /archive is too large/,
  );
  const backup = path.join(config.backupDir, 'oversized.zip');
  await sparse(backup, 65 * MiB + 1);
  await assert.rejects(
    publishSnapshot({
      library: config.library,
      backup,
      record: {
        id: 'e'.repeat(32),
        sourceId: 'b'.repeat(32),
        game: module.id,
        image: module.imagePolicy.defaultImage,
      },
      module,
    }),
    /bounded regular files/,
  );
  assert.deepEqual(await fs.readdir(config.library), []);
});
