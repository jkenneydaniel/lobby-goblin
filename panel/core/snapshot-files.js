import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {assert} from '../common.js';

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export const safeSnapshotPath = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  !name.includes('\\') &&
  !name.includes(':') &&
  !name.startsWith('/') &&
  !name.split('/').some((part) => ['', '.', '..'].includes(part));

// Opt-in metadata-only traversal for bounded application backups. Do not change
// snapshotInventory's established hash/size contract for Factorio/Rust snapshots.
export async function boundedFileInventory(root, limits) {
  const {maxFiles, maxBytes, maxEntries, maxDepth} = limits;
  assert(
    [maxFiles, maxBytes, maxEntries, maxDepth].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
    'File inventory requires finite positive limits.',
  );
  assert(
    (await fs.lstat(root)).isDirectory() &&
      (await fs.realpath(root)) === path.resolve(root),
    'Snapshot root cannot be a link.',
  );
  const files = [];
  let entries = 0,
    bytes = 0;
  async function walk(relative, depth) {
    const directory = await fs.opendir(path.join(root, relative));
    for await (const item of directory) {
      assert(
        ++entries <= maxEntries,
        'Application backup has too many entries.',
      );
      const name = relative ? relative + '/' + item.name : item.name;
      assert(safeSnapshotPath(name), 'Unsafe snapshot path.');
      const stat = await fs.lstat(path.join(root, name));
      assert(!stat.isSymbolicLink(), 'Snapshot links are not supported.');
      if (stat.isDirectory()) {
        assert(depth < maxDepth, 'Application backup is nested too deeply.');
        await walk(name, depth + 1);
      } else {
        assert(stat.isFile(), 'Unsupported snapshot file.');
        assert(
          files.length < maxFiles,
          'Application backup has too many files.',
        );
        assert(
          stat.size <= maxBytes - bytes,
          'Application backup exceeds its byte limit.',
        );
        bytes += stat.size;
        files.push({name, size: stat.size});
      }
    }
  }
  await walk('', 0);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
export async function snapshotInventory(root, relative = '') {
  assert(
    (await fs.lstat(root)).isDirectory() &&
      (await fs.realpath(root)) === path.resolve(root),
    'Snapshot root cannot be a link.',
  );
  const files = [];
  for (const item of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? relative + '/' + item.name : item.name;
    assert(safeSnapshotPath(name), 'Unsafe snapshot path.');
    const stat = await fs.lstat(path.join(root, name));
    assert(!stat.isSymbolicLink(), 'Snapshot links are not supported.');
    if (stat.isDirectory())
      files.push(...(await snapshotInventory(root, name)));
    else {
      assert(stat.isFile(), 'Unsupported snapshot file.');
      files.push({
        name,
        size: stat.size,
        sha256: await hashFile(path.join(root, name)),
      });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
