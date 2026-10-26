import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  boundedFileInventory,
  snapshotInventory,
} from '../core/snapshot-files.js';
import {selectedApplication} from '../applications/index.js';
const limits = {maxFiles: 4, maxBytes: 8, maxEntries: 8, maxDepth: 2};
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-backup-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
test('bounded metadata traversal preserves hidden, nested and empty files and the existing hash contract', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, '.hidden'), '1234');
  await fs.writeFile(path.join(root, 'nested/data'), '5678');
  await fs.writeFile(path.join(root, 'empty'), '');
  const items = await boundedFileInventory(root, limits);
  assert.equal(items.length, 3);
  assert.equal(
    items.reduce((sum, item) => sum + item.size, 0),
    8,
  );
  const old = await snapshotInventory(root);
  assert.deepEqual(
    old.map(({sha256, ...item}) => item),
    items,
  );
  assert.ok(old.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
});
test('global traversal budgets reject aggregate bytes, sibling files, empty directories and nesting', async (t) => {
  const root = await fixture(t);
  for (const name of ['a', 'b', 'c']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'value'), '123');
  }
  await assert.rejects(boundedFileInventory(root, limits), /byte limit/);
  await assert.rejects(
    boundedFileInventory(root, {...limits, maxBytes: 100, maxFiles: 2}),
    /too many files/,
  );
  await assert.rejects(
    boundedFileInventory(root, {...limits, maxBytes: 100, maxEntries: 4}),
    /too many entries/,
  );
  await fs.rm(path.join(root, 'a'), {recursive: true});
  await fs.mkdir(path.join(root, 'a/deep/deeper'), {recursive: true});
  await assert.rejects(
    boundedFileInventory(root, {...limits, maxBytes: 100}),
    /nested too deeply/,
  );
});
test('bounded inventories reject symbolic links at the root and within directories', async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'secret'), 'secret');
  await fs.symlink(outside, path.join(root, 'linked'));
  await assert.rejects(boundedFileInventory(root, limits), /links/);
  await assert.rejects(
    boundedFileInventory(path.join(root, 'linked'), limits),
    /link/,
  );
});
test('the stopped application backup rejects the original sparse-file trigger before any content read', async (t) => {
  const root = await fixture(t),
    file = path.join(root, 'oversized');
  const handle = await fs.open(file, 'w');
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  const module = selectedApplication('status-page');
  const controller = await module.createController({
    config: {data: root},
    host: {info: async () => ({State: {Running: false}})},
    docker: () => {},
    env: {},
  });
  const original = fs.open,
    originalStream = nativeFs.createReadStream;
  let reads = 0;
  fs.open = async (...args) => {
    reads++;
    return original(...args);
  };
  nativeFs.createReadStream = (...args) => {
    reads++;
    return originalStream(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(controller.backupFiles(), /byte limit/);
    assert.equal(reads, 0);
  } finally {
    fs.open = original;
    nativeFs.createReadStream = originalStream;
    syncBuiltinESMExports();
  }
  await fs.writeFile(file, 'normal');
  assert.equal((await controller.backupFiles())[0].data.toString(), 'normal');
});
test('inventoried file sizes constrain reads if the stopped data grows before opening', async (t) => {
  const root = await fixture(t),
    file = path.join(root, 'data');
  await fs.writeFile(file, 'a');
  const module = selectedApplication('status-page');
  const controller = await module.createController({
    config: {data: root},
    host: {info: async () => ({State: {Running: false}})},
    docker: () => {},
    env: {},
  });
  const original = fs.lstat;
  let calls = 0;
  fs.lstat = async (...args) => {
    if (args[0] === file && ++calls === 2) await fs.writeFile(file, 'grew');
    return original(...args);
  };
  try {
    await assert.rejects(controller.backupFiles(), /bounded regular files/);
  } finally {
    fs.lstat = original;
  }
});
