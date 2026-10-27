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

// Application-owned ABI links are compared as inert strings, never followed.
// This permits inventorying a retained sealed execution tree after it has been
// renamed into private recovery storage without traversing mutable world data.
export async function executionInventory(root, links = {}) {
  await directory(root);
  const files = [];
  let bytes = 0,
    entries = 0;
  async function walk(relative = '', depth = 0) {
    assert(depth <= 32, 'Execution tree is too deeply nested.', 413);
    const parent = path.join(root, relative),
      stat = await fs.lstat(parent);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022),
      'Execution directories must remain sealed.',
      409,
    );
    const names = await fs.readdir(parent);
    assert(
      (entries += names.length) <= 200000,
      'Execution metadata exceeds its budget.',
      413,
    );
    for (const leaf of names.sort()) {
      const name = relative ? relative + '/' + leaf : leaf;
      assert(!/[\x00-\x1f\\]/.test(name), 'Invalid execution path.', 409);
      const location = path.join(root, name),
        before = await fs.lstat(location);
      if (before.isSymbolicLink()) {
        const target = await fs.readlink(location);
        assert(
          Object.hasOwn(links, name) &&
            target === links[name] &&
            before.uid === process.getuid(),
          'Execution link differs from its declared data target.',
          409,
        );
        files.push({name, link: target});
      } else if (before.isDirectory()) await walk(name, depth + 1);
      else {
        assert(
          before.isFile() &&
            before.nlink === 1 &&
            before.uid === process.getuid() &&
            !(before.mode & 0o022) &&
            (bytes += before.size) <= 128 * 1024 ** 3 &&
            files.length < 100000,
          'Execution files must remain bounded sealed ordinary files.',
          409,
        );
        const input = await fs.open(
          location,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = await input.stat();
          assert(
            opened.isFile() &&
              opened.nlink === 1 &&
              opened.dev === before.dev &&
              opened.ino === before.ino &&
              opened.size === before.size,
            'Execution changed while opening it.',
            409,
          );
          const hash = crypto.createHash('sha256'),
            buffer = Buffer.alloc(1024 ** 2);
          let size = 0;
          for (;;) {
            const count = await input.read(
              buffer,
              0,
              Math.min(buffer.length, before.size - size + 1),
              null,
            );
            if (!count.bytesRead) break;
            size += count.bytesRead;
            assert(
              size <= before.size,
              'Execution grew during inventory.',
              409,
            );
            hash.update(buffer.subarray(0, count.bytesRead));
          }
          const after = await input.stat();
          assert(
            size === before.size &&
              after.nlink === 1 &&
              after.size === opened.size &&
              after.mtimeMs === opened.mtimeMs &&
              after.ctimeMs === opened.ctimeMs,
            'Execution changed during inventory.',
            409,
          );
          files.push({
            name,
            size,
            sha256: hash.digest('hex'),
            executable: !!(before.mode & 0o111),
          });
        } finally {
          await input.close();
        }
      }
    }
  }
  await walk();
  assert(
    Buffer.byteLength(JSON.stringify(files)) <= 32 * 1024 ** 2,
    'Execution inventory exceeds its metadata budget.',
    413,
  );
  return {
    sha256: crypto
      .createHash('sha256')
      .update(JSON.stringify(files))
      .digest('hex'),
    files: files.length,
    bytes,
  };
}
