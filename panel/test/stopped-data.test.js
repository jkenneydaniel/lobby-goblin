import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {copyStoppedData, verifyStoppedData} from '../core/stopped-data.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'paired-stopped-data-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'world'),
    destination = path.join(root, 'recovery/world');
  await fs.mkdir(path.join(source, 'mods/oxide/data'), {recursive: true});
  await fs.mkdir(path.dirname(destination), {mode: 0o700});
  await fs.mkdir(path.join(source, 'mods/oxide/data/empty-preserved'));
  await fs.writeFile(path.join(source, 'world.sav'), 'OLD WORLD');
  await fs.writeFile(
    path.join(source, 'mods/oxide/data/coins.json'),
    '{"balance":17}',
  );
  return {source, destination, assertStopped: async () => {}};
}
test('a stopped recovery copy is independent and binds complete world plus mod data', async (t) => {
  const f = await fixture(t),
    inventory = await copyStoppedData(f);
  assert.equal(inventory.files, 2);
  assert.ok(
    (
      await fs.stat(path.join(f.destination, 'mods/oxide/data/empty-preserved'))
    ).isDirectory(),
  );
  assert.deepEqual(
    await verifyStoppedData(f.destination, inventory, f.assertStopped),
    inventory,
  );
  assert.notEqual(
    (await fs.stat(path.join(f.source, 'world.sav'))).ino,
    (await fs.stat(path.join(f.destination, 'world.sav'))).ino,
  );
  assert.equal(
    (await fs.stat(path.join(f.destination, 'world.sav'))).mode & 0o777,
    0o600,
  );
  await fs.writeFile(path.join(f.source, 'world.sav'), 'NEWER WORLD');
  assert.equal(
    await fs.readFile(path.join(f.destination, 'world.sav'), 'utf8'),
    'OLD WORLD',
  );
  await fs.writeFile(
    path.join(f.destination, 'mods/oxide/data/coins.json'),
    '{}',
  );
  await assert.rejects(
    verifyStoppedData(f.destination, inventory, f.assertStopped),
    /verification/,
  );
});
test('copying refuses running games, changed receipts and retained destinations without overwriting evidence', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    copyStoppedData({
      ...f,
      assertStopped: async () => {
        throw Error('application running');
      },
    }),
    /running/,
  );
  await assert.rejects(fs.access(f.destination));
  await assert.rejects(
    copyStoppedData({
      ...f,
      expected: {sha256: 'a'.repeat(64), files: 2, bytes: 1},
    }),
    /changed before/,
  );
  await assert.rejects(fs.access(f.destination));
  await fs.mkdir(f.destination);
  await fs.writeFile(path.join(f.destination, 'evidence.txt'), 'RETAIN');
  await assert.rejects(copyStoppedData(f), {code: 'EEXIST'});
  assert.equal(
    await fs.readFile(path.join(f.destination, 'evidence.txt'), 'utf8'),
    'RETAIN',
  );
});
test('unsafe data and an interrupted barrier fail closed with partial recovery retained', async (t) => {
  const f = await fixture(t);
  await fs.symlink(
    path.join(f.source, 'world.sav'),
    path.join(f.source, 'alias'),
  );
  await assert.rejects(copyStoppedData(f), /links/);
  await fs.unlink(path.join(f.source, 'alias'));
  await fs.link(path.join(f.source, 'world.sav'), path.join(f.source, 'hard'));
  await assert.rejects(copyStoppedData(f), /unsafe/);
  await fs.unlink(path.join(f.source, 'hard'));
  let stopped = true;
  await assert.rejects(
    copyStoppedData({
      ...f,
      assertStopped: async () => assert(stopped, 'application resumed'),
      fault: async (phase) => {
        if (phase === 'data-file') stopped = false;
      },
    }),
    /resumed/,
  );
  assert.ok((await fs.readdir(f.destination)).length);
  assert.equal(
    await fs.readFile(path.join(f.source, 'world.sav'), 'utf8'),
    'OLD WORLD',
  );
});
test('data altered between inspection and copy is preserved as an incomplete candidate', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    copyStoppedData({
      ...f,
      fault: async (phase, name) => {
        if (phase === 'before-data-file')
          await fs.writeFile(path.join(f.source, name), 'ALTERED');
      },
    }),
    /ordinary|changed/,
  );
  assert.ok(await fs.stat(f.destination));
});
