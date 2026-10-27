import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {assert} from '../common.js';
import {directory, softwareInventory} from '../providers/steamcmd/files.js';
import {syncDirectory} from './storage/files.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const budget = {maxFiles: 20000, maxBytes: 64 * 1024 ** 3};

async function dataInventory(root) {
  const content = await softwareInventory(root, budget),
    directories = [];
  let metadata = 0;
  async function walk(relative = '', depth = 0) {
    assert(
      depth <= 32,
      'Recovery data directories are too deeply nested.',
      413,
    );
    for await (const entry of await fs.opendir(path.join(root, relative))) {
      if (!entry.isDirectory()) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      metadata += Buffer.byteLength(name) + 4;
      assert(
        directories.length < 40000 && metadata <= 32 * 1024 ** 2,
        'Recovery directory metadata exceeds its budget.',
        413,
      );
      await directory(path.join(root, name));
      directories.push(name);
      await walk(name, depth + 1);
    }
  }
  await walk();
  directories.sort();
  return {
    ...content,
    directories,
    inventory: {
      ...content.inventory,
      directories: directories.length,
      sha256: createHash('sha256')
        .update(JSON.stringify({files: content.inventory, directories}))
        .digest('hex'),
    },
  };
}

// This helper has no lifecycle or selection authority. Its caller must own a
// stopped barrier for all application writers and retain any partial directory
// for explicit recovery. Publication/restoration belongs to the paired journal.
export async function copyStoppedData({
  source,
  destination,
  assertStopped,
  expected,
  fault = async () => {},
}) {
  assert(
    typeof assertStopped === 'function',
    'Data copying needs an owned stopped barrier.',
  );
  assert(
    path.isAbsolute(source) &&
      path.resolve(source) === source &&
      path.isAbsolute(destination) &&
      path.resolve(destination) === destination &&
      source !== '/' &&
      destination !== '/' &&
      source !== destination &&
      !destination.startsWith(source + path.sep) &&
      !source.startsWith(destination + path.sep),
    'Use separate canonical data and private recovery paths.',
  );
  await assertStopped();
  await directory(source);
  await directory(path.dirname(destination));
  const parent = await fs.lstat(path.dirname(destination));
  assert(
    parent.uid === process.getuid() && !(parent.mode & 0o022),
    'Recovery copies need controller-owned private storage.',
    409,
  );
  const original = await dataInventory(source);
  assert(
    !expected || same(original.inventory, expected),
    'Recovery data changed before copying.',
    409,
  );
  const free = await fs.statfs(path.dirname(destination));
  assert(
    free.bavail * free.bsize >= original.inventory.bytes + 128 * 1024 ** 2,
    'Insufficient space for paired data recovery.',
    507,
  );
  // Exclusive creation refuses even an empty retained partial copy. A caller
  // must select a fresh reviewed recovery path instead of deleting evidence.
  await fs.mkdir(destination, {mode: 0o700});
  const parents = new Set([destination]);
  for (const relative of original.directories) {
    await assertStopped();
    const parent = path.join(destination, relative);
    await fs.mkdir(parent, {recursive: true, mode: 0o700});
    parents.add(parent);
  }
  for (const file of original.files) {
    await assertStopped();
    await fault('before-data-file', file.name);
    const target = path.join(destination, file.name),
      parent = path.dirname(target);
    await fs.mkdir(parent, {recursive: true, mode: 0o700});
    for (
      let current = parent;
      current.startsWith(destination + path.sep);
      current = path.dirname(current)
    )
      parents.add(current);
    const input = await fs.open(
      path.join(source, file.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let output;
    try {
      const before = await input.stat();
      assert(
        before.isFile() && before.nlink === 1 && before.size === file.size,
        'Paired data must remain ordinary single-link files.',
        409,
      );
      output = await fs.open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        file.executable ? 0o700 : 0o600,
      );
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(1024 ** 2);
      let length = 0;
      for (;;) {
        const read = await input.read(
          buffer,
          0,
          Math.min(buffer.length, file.size - length + 1),
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
        assert(length <= file.size, 'Data grew while preparing recovery.', 409);
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      const after = await input.stat();
      assert(
        length === file.size &&
          hash.digest('hex') === file.sha256 &&
          after.nlink === 1 &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Paired data changed while preparing recovery.',
        409,
      );
      await output.sync();
    } finally {
      await output?.close();
      await input.close();
    }
    await fault('data-file', file.name);
  }
  await assertStopped();
  const copied = await dataInventory(destination);
  assert(
    same(copied.inventory, original.inventory) &&
      same((await dataInventory(source)).inventory, original.inventory),
    'Paired data changed before recovery publication.',
    409,
  );
  for (const parent of [...parents].sort((a, b) => b.length - a.length))
    await syncDirectory(parent);
  await syncDirectory(path.dirname(destination));
  return copied.inventory;
}

export async function verifyStoppedData(root, expected, assertStopped) {
  await assertStopped();
  const current = await dataInventory(root);
  assert(
    same(current.inventory, expected),
    'Paired recovery copy failed verification.',
    409,
  );
  await assertStopped();
  return current.inventory;
}
