import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {assert} from '../../common.js';
import {syncDirectory} from '../../core/storage/files.js';

export async function directory(location, {create = false} = {}) {
  const absolute = path.resolve(location);
  if (create) {
    let parent = path.parse(absolute).root;
    for (const component of absolute.slice(parent.length).split(path.sep)) {
      parent = path.join(parent, component);
      const existing = await fs.lstat(parent).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!existing) break;
      assert(
        existing.isDirectory() && !existing.isSymbolicLink(),
        'Software storage cannot use linked parents.',
        409,
      );
    }
    await fs.mkdir(absolute, {recursive: true, mode: 0o700});
  }
  const stat = await fs.lstat(absolute);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await fs.realpath(absolute)) === absolute,
    'Software storage cannot use linked directories.',
    409,
  );
  return absolute;
}
async function readRecordOnce(file, {optional = false, max = 1024 ** 2} = {}) {
  const stat = await fs.lstat(file).catch((error) => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= max,
    'Software records must be bounded files without links.',
    409,
  );
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await handle.stat();
    assert(
      opened.isFile() &&
        opened.nlink === 1 &&
        opened.dev === stat.dev &&
        opened.ino === stat.ino &&
        opened.size <= max,
      'Software record changed while opening it.',
      409,
    );
    const buffer = Buffer.alloc(Math.min(opened.size + 1, max + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    assert(
      length === opened.size &&
        after.mtimeMs === opened.mtimeMs &&
        after.ctimeMs === opened.ctimeMs &&
        after.nlink === 1,
      'Software record changed while reading it.',
      409,
    );
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes);
  } catch {
    throw Error('Invalid software record. Preserve it for inspection.');
  }
}
export async function readRecord(file, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readRecordOnce(file, options);
    } catch (error) {
      // Atomic replacement is normal while progress is being published. Retry
      // bounded reads, retaining the same inode, hard-link and size guards.
      if (
        attempt >= 3 ||
        error.status !== 409 ||
        !/^Software record changed while (opening|reading) it\.$/.test(
          error.message,
        )
      )
        throw error;
    }
  }
}
export async function atomicRecord(file, value) {
  await directory(path.dirname(file));
  const current = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert(
    !current ||
      (current.isFile() && !current.isSymbolicLink() && current.nlink === 1),
    'Software record cannot be linked.',
    409,
  );
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function softwareInventory(
  root,
  {
    maxFiles = 100000,
    maxBytes = 128 * 1024 ** 3,
    hash = true,
    sync = false,
  } = {},
) {
  assert(
    Number.isSafeInteger(maxFiles) &&
      maxFiles > 0 &&
      maxFiles <= 1000000 &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 1024 ** 4,
    'Invalid software inventory budget.',
  );
  await directory(root);
  let bytes = 0,
    entries = 0,
    metadataBytes = 0;
  const files = [],
    directories = [];
  async function walk(relative, depth) {
    assert(depth <= 32, 'Software inventory is too deeply nested.', 413);
    const location = path.join(root, relative);
    await directory(location);
    const children = [];
    for await (const item of await fs.opendir(location)) {
      assert(
        ++entries <= maxFiles * 2 &&
          item.name !== '.' &&
          item.name !== '..' &&
          item.name.length <= 255 &&
          !/[\x00-\x1f\\]/.test(item.name),
        'Software inventory exceeds its metadata budget.',
        413,
      );
      children.push(item);
    }
    for (const item of children.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const name = relative ? relative + '/' + item.name : item.name,
        file = path.join(root, name);
      const stat = await fs.lstat(file);
      assert(
        !stat.isSymbolicLink(),
        'Software inventory cannot contain links.',
        409,
      );
      if (stat.isDirectory()) {
        await walk(name, depth + 1);
        continue;
      }
      assert(
        stat.isFile() &&
          stat.nlink === 1 &&
          files.length < maxFiles &&
          Number.isSafeInteger(stat.size) &&
          stat.size >= 0 &&
          (bytes += stat.size) <= maxBytes,
        'Software inventory exceeds its file/byte budget or contains unsafe entries.',
        413,
      );
      metadataBytes +=
        Buffer.byteLength(
          JSON.stringify({
            name,
            size: stat.size,
            executable: true,
            sha256: 'a'.repeat(64),
          }),
        ) + 1;
      assert(
        metadataBytes <= 32 * 1024 ** 2,
        'Software inventory path metadata exceeds 32 MiB.',
        413,
      );
      files.push({
        name,
        size: stat.size,
        executable: !!(stat.mode & 0o111),
        stat,
      });
    }
    directories.push(location);
  }
  // Count and bound all metadata before opening any payload for hashing.
  await walk('', 0);
  for (const file of files) {
    if (!hash) {
      delete file.stat;
      continue;
    }
    const handle = await fs.open(
      path.join(root, file.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat(),
        original = file.stat;
      assert(
        before.isFile() &&
          before.nlink === 1 &&
          before.dev === original.dev &&
          before.ino === original.ino &&
          before.size === file.size &&
          before.mtimeMs === original.mtimeMs &&
          before.ctimeMs === original.ctimeMs,
        'Software changed while opening it.',
        409,
      );
      const digest = crypto.createHash('sha256'),
        buffer = Buffer.alloc(1024 ** 2);
      let read = 0;
      for (;;) {
        const count = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, file.size - read + 1),
          null,
        );
        if (!count.bytesRead) break;
        read += count.bytesRead;
        assert(read <= file.size, 'Software grew while hashing it.', 409);
        digest.update(buffer.subarray(0, count.bytesRead));
      }
      const after = await handle.stat();
      assert(
        read === file.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Software changed while hashing it.',
        409,
      );
      file.sha256 = digest.digest('hex');
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
    delete file.stat;
  }
  if (sync) for (const location of directories) await syncDirectory(location);
  const inventory = {
    sha256: crypto
      .createHash('sha256')
      .update(JSON.stringify(files))
      .digest('hex'),
    files: files.length,
    bytes,
  };
  return {inventory, files};
}
