import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream, constants} from 'node:fs';
import crypto from 'node:crypto';
import {assert} from '../common.js';
import {
  softwareReceipt,
  softwareSelectionKey,
} from './software-installation.js';
import {
  directory,
  readRecord,
  atomicRecord,
  softwareInventory,
} from '../providers/steamcmd/files.js';
import {syncDirectory} from './storage/files.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function executionProjection(value, binary, application) {
  const receipt = softwareReceipt(value);
  assert(
    receipt.selection.provider === 'steamcmd' &&
      receipt.selection.application === application &&
      /^[a-f0-9]{64}$/.test(binary.sha256),
    'Invalid execution receipt.',
    409,
  );
  return {
    format: 1,
    application,
    provider: 'steamcmd',
    platform: receipt.selection.platform,
    buildId: receipt.selection.softwareVersion,
    inventorySha256: receipt.inventory.sha256,
    binarySha256: binary.sha256,
  };
}

export async function executionBinary(root, relative, expected) {
  await directory(root);
  const stat = await fs.lstat(root);
  assert(
    stat.uid === process.getuid() && !(stat.mode & 0o022),
    'Execution storage must be controller-owned.',
    409,
  );
  let current = root;
  const parts = relative.split('/');
  assert(
    parts.every((part) => part && part !== '.' && part !== '..') &&
      !relative.includes('\\'),
    'Invalid execution path.',
  );
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    await directory(current);
    const parent = await fs.lstat(current);
    assert(
      parent.uid === process.getuid() && !(parent.mode & 0o022),
      'Execution parents must be controller-owned.',
      409,
    );
  }
  const handle = await fs.open(
    path.join(root, relative),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    assert(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022) &&
        stat.mode & 0o111 &&
        stat.size <= 256 * 1024 ** 2,
      'Execution binary is unsafe.',
      409,
    );
    const hash = crypto.createHash('sha256');
    for await (const bytes of createReadStream(null, {
      fd: handle.fd,
      autoClose: false,
    }))
      hash.update(bytes);
    const after = await handle.stat();
    assert(
      after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs &&
        after.ctimeMs === stat.ctimeMs &&
        after.nlink === 1 &&
        hash.digest('hex') === expected,
      'Execution binary changed.',
      409,
    );
  } finally {
    await handle.close();
  }
}

// Copy verified pristine software into a controller-private execution tree.
// Never hard-link it to a game-writable mount. The caller publishes only while
// stopped; this helper has no lifecycle, download, activation or world authority.
export async function stageExecution({
  software,
  staging,
  receipt: value,
  executable,
  discardPartial = false,
  fault = async () => {},
}) {
  const receipt = softwareReceipt(value),
    source = path.join(
      software,
      'releases',
      softwareSelectionKey(receipt.selection) + '-' + receipt.inventory.sha256,
    );
  await directory(software);
  await directory(path.dirname(staging));
  const original = await softwareInventory(source);
  assert(
    same(original.inventory, receipt.inventory),
    'Pristine software changed.',
    409,
  );
  const binary = original.files.find(
    (file) => file.name === executable && file.executable,
  );
  assert(
    binary &&
      !original.files.some(
        (file) => file.name === 'server' || file.name.startsWith('server/'),
      ),
    'Software contains application data or lacks its executable.',
    409,
  );
  const existing = await fs.lstat(staging).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    // Explicit recovery can reuse a fully verified copy, but never silently
    // delete a partial or unexpected tree. Preserve it for offline inspection.
    assert(
      existing.isDirectory() &&
        !existing.isSymbolicLink() &&
        existing.uid === process.getuid() &&
        !(existing.mode & 0o022),
      'Execution copy is unsafe.',
      409,
    );
    const copy = await softwareInventory(staging);
    if (same(copy.inventory, receipt.inventory)) {
      await executionBinary(staging, executable, binary.sha256);
      return binary;
    }
    assert(
      discardPartial === true &&
        copy.files.every((file) =>
          original.files.some(
            (source) => source.name === file.name && file.size <= source.size,
          ),
        ),
      'Partial execution copy needs offline recovery.',
      409,
    );
    await fs.rm(staging, {recursive: true});
    await syncDirectory(path.dirname(staging));
  }
  const free = await fs.statfs(path.dirname(staging));
  assert(
    free.bavail * free.bsize >= receipt.inventory.bytes + 512 * 1024 ** 2,
    'Insufficient space for the independent execution copy.',
    507,
  );
  await fs.mkdir(staging, {mode: 0o755});
  const parents = new Set([staging]);
  for (const file of original.files) {
    const target = path.join(staging, file.name),
      parent = path.dirname(target);
    await fs.mkdir(parent, {recursive: true, mode: 0o755});
    let current = parent;
    while (current.startsWith(staging + path.sep)) {
      parents.add(current);
      current = path.dirname(current);
    }
    await fs.copyFile(
      path.join(source, file.name),
      target,
      constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    );
    await fs.chmod(target, file.executable ? 0o755 : 0o644);
    const handle = await fs.open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fault('execution-file');
  }
  assert(
    same((await softwareInventory(staging)).inventory, receipt.inventory),
    'Execution copy differs from its pristine receipt.',
    409,
  );
  for (const parent of [...parents].sort((a, b) => b.length - a.length))
    await syncDirectory(parent);
  await syncDirectory(path.dirname(staging));
  return binary;
}

export async function publishExecutionReceipt(root, receipt) {
  await directory(root);
  await atomicRecord(path.join(root, '.lobby-goblin-runtime.json'), receipt);
}
export const readExecutionReceipt = (root) =>
  readRecord(path.join(root, '.lobby-goblin-runtime.json'), {
    optional: true,
    max: 16384,
  });
