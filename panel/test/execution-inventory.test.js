import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {executionInventory} from '../core/software-execution.js';

test('sealed execution inventories compare only declared link strings and never follow mutable data', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-inventory-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const engine = path.join(root, 'engine'),
    world = path.join(root, 'server');
  await fs.mkdir(engine);
  await fs.mkdir(world);
  await fs.writeFile(path.join(engine, 'server-binary'), 'SEALED CODE', {
    mode: 0o755,
  });
  await fs.writeFile(path.join(world, 'world.sav'), 'MUTABLE WORLD');
  await fs.symlink('../server', path.join(engine, 'server'));
  const expected = await executionInventory(engine, {server: '../server'});
  assert.equal(expected.bytes, Buffer.byteLength('SEALED CODE'));
  await fs.writeFile(path.join(world, 'world.sav'), 'NEW WORLD CONTENTS');
  assert.deepEqual(
    await executionInventory(engine, {server: '../server'}),
    expected,
  );
  const held = path.join(root, 'retained-engine');
  await fs.rename(engine, held);
  assert.deepEqual(
    await executionInventory(held, {server: '../server'}),
    expected,
  );
  await assert.rejects(executionInventory(held), /declared data target/);
  await fs.symlink(world, path.join(held, 'outside'));
  await assert.rejects(
    executionInventory(held, {server: '../server'}),
    /declared data target/,
  );
  await fs.unlink(path.join(held, 'outside'));
  await fs.link(path.join(held, 'server-binary'), path.join(held, 'hardlink'));
  await assert.rejects(
    executionInventory(held, {server: '../server'}),
    /sealed ordinary/,
  );
  await fs.unlink(path.join(held, 'hardlink'));
  await fs.chmod(path.join(held, 'server-binary'), 0o775);
  await assert.rejects(
    executionInventory(held, {server: '../server'}),
    /sealed ordinary/,
  );
});
