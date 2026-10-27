import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {softwareInventory} from '../providers/steamcmd/files.js';
import {softwareSelectionKey} from '../core/software-installation.js';
import {
  stageExecution,
  executionBinary,
  executionProjection,
} from '../core/software-execution.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-execution-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const software = path.join(root, 'software'),
    temporary = path.join(root, 'source'),
    staging = path.join(root, 'execution');
  await fs.mkdir(software);
  await fs.mkdir(path.join(software, 'releases'));
  await fs.mkdir(temporary);
  await fs.writeFile(
    path.join(temporary, 'RustDedicated'),
    'synthetic executable',
    {mode: 0o755},
  );
  await fs.mkdir(path.join(temporary, 'nested'));
  await fs.writeFile(
    path.join(temporary, 'nested/library.so'),
    'synthetic library',
    {mode: 0o644},
  );
  const selection = {
    format: 1,
    provider: 'steamcmd',
    application: 'rust',
    platform: 'linux/amd64',
    softwareVersion: '123',
    source: {
      kind: 'steam',
      appId: '258550',
      branch: 'public',
      buildId: '123',
      depots: [{id: '258551', manifest: '12345678901234567890'}],
    },
  };
  const receipt = {
    format: 1,
    selection,
    inventory: (await softwareInventory(temporary)).inventory,
  };
  const source = path.join(
    software,
    'releases',
    softwareSelectionKey(selection) + '-' + receipt.inventory.sha256,
  );
  await fs.rename(temporary, source);
  return {
    root,
    software,
    staging,
    source,
    receipt,
    executable: 'RustDedicated',
  };
}

test('execution staging verifies an independent sealed copy and projects the exact image receipt', async (t) => {
  const f = await fixture(t),
    binary = await stageExecution(f);
  assert.deepEqual(
    (await softwareInventory(f.staging)).inventory,
    f.receipt.inventory,
  );
  assert.notEqual(
    (await fs.stat(path.join(f.source, f.executable))).ino,
    (await fs.stat(path.join(f.staging, f.executable))).ino,
  );
  assert.equal((await fs.stat(path.join(f.staging, f.executable))).nlink, 1);
  const projection = executionProjection(f.receipt, binary, 'rust');
  assert.equal(projection.buildId, '123');
  assert.equal(
    projection.binarySha256,
    crypto.createHash('sha256').update('synthetic executable').digest('hex'),
  );
  await stageExecution(f);
  await fs.writeFile(path.join(f.staging, f.executable), 'changed execution');
  await assert.rejects(
    executionBinary(f.staging, f.executable, binary.sha256),
    /changed/,
  );
  assert.equal(
    await fs.readFile(path.join(f.source, f.executable), 'utf8'),
    'synthetic executable',
  );
});

test('a failed copy preserves source and partial files until explicit bounded discard', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageExecution({
      ...f,
      fault: () => {
        throw Error('copy interrupted');
      },
    }),
    /interrupted/,
  );
  assert.ok((await fs.readdir(f.staging)).length > 0);
  await assert.rejects(stageExecution(f), /offline recovery/);
  await stageExecution({...f, discardPartial: true});
  assert.deepEqual(
    (await softwareInventory(f.staging)).inventory,
    f.receipt.inventory,
  );
});

test('staging refuses changed pristine bytes, links, unsafe partial contents and application data', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, f.executable), 'tampered source');
  await assert.rejects(stageExecution(f), /Pristine/);
  assert.equal(await fs.lstat(f.staging).catch(() => null), null);
  await fs.writeFile(path.join(f.source, f.executable), 'synthetic executable');
  await fs.mkdir(f.staging);
  await fs.writeFile(path.join(f.staging, 'foreign-world.sav'), 'preserve');
  await assert.rejects(
    stageExecution({...f, discardPartial: true}),
    /offline recovery/,
  );
  assert.equal(
    await fs.readFile(path.join(f.staging, 'foreign-world.sav'), 'utf8'),
    'preserve',
  );
  await fs.unlink(path.join(f.staging, 'foreign-world.sav'));
  await fs.symlink(f.source, path.join(f.staging, 'escape'));
  await assert.rejects(stageExecution({...f, discardPartial: true}), /links/);
  await fs.rm(f.staging, {recursive: true});
  await fs.mkdir(path.join(f.source, 'server'));
  await fs.writeFile(
    path.join(f.source, 'server/world.sav'),
    'untrusted world',
  );
  const receipt = {
    ...f.receipt,
    inventory: (await softwareInventory(f.source)).inventory,
  };
  const newSource = path.join(
    f.software,
    'releases',
    softwareSelectionKey(receipt.selection) + '-' + receipt.inventory.sha256,
  );
  await fs.rename(f.source, newSource);
  await assert.rejects(stageExecution({...f, receipt}), /application data/);
});
