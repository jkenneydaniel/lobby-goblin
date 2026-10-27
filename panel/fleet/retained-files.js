import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {assert} from '../common.js';
import {regularFile, parseStorageJSON} from '../core/storage/files.js';

export async function retainedRecord(root, name, {optional = true} = {}) {
  const bytes = await regularFile(path.join(root, name), {
    optional,
    max: 4 * 1024 ** 2,
  });
  return bytes ? parseStorageJSON(bytes) : null;
}
// Metadata only: inspection never opens save files, follows links or exposes
// configuration contents. Bounds also apply to files outside the copied roots.
export async function retainedInventory(
  root,
  {maxEntries = 250000, maxBytes = 1024 ** 4} = {},
) {
  const entries = [],
    summary = {
      files: 0,
      directories: 0,
      bytes: 0,
      unsupported: 0,
      sections: Object.create(null),
    };
  async function visit(relative = '', depth = 0) {
    assert(
      depth <= 64,
      'Storage has too many nested directories to inspect safely.',
      409,
    );
    const names = (await fs.readdir(path.join(root, relative))).sort();
    for (const name of names) {
      const relativeName = relative ? relative + '/' + name : name;
      assert(
        relativeName.length <= 4096 && entries.length < maxEntries,
        'Storage exceeds the inspection file limit.',
        409,
      );
      const stat = await fs.lstat(path.join(root, relativeName));
      const type = stat.isSymbolicLink()
        ? 'link'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'special';
      entries.push({
        name: relativeName,
        type,
        size: stat.size,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        ino: stat.ino,
        dev: stat.dev,
        ...(type === 'link'
          ? {link: await fs.readlink(path.join(root, relativeName))}
          : {}),
      });
      const section = relativeName.split('/')[0];
      summary.sections[section] ??= {files: 0, bytes: 0};
      if (type === 'file') {
        summary.files++;
        summary.bytes += stat.size;
        summary.sections[section].files++;
        summary.sections[section].bytes += stat.size;
      } else if (type === 'directory') summary.directories++;
      else summary.unsupported++;
      assert(
        summary.bytes <= maxBytes,
        'Storage exceeds the inspection size limit.',
        409,
      );
      if (type === 'directory') await visit(relativeName, depth + 1);
    }
  }
  const stat = await fs.lstat(root);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Storage must be an ordinary directory.',
    409,
  );
  await visit();
  return {
    entries,
    summary,
    fingerprint: crypto
      .createHash('sha256')
      .update(JSON.stringify(entries))
      .digest('hex'),
  };
}
export async function copyRetainedFiles(
  source,
  target,
  inventory,
  roots,
  links = {},
) {
  for (const root of roots)
    assert(
      /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(root) &&
        !root.split('/').some((p) => p === '.' || p === '..'),
      'Invalid application recovery root.',
    );
  const selected = inventory.entries.filter((e) =>
    roots.some((root) => e.name === root || e.name.startsWith(root + '/')),
  );
  assert(
    selected.every(
      (e) =>
        e.type === 'file' ||
        e.type === 'directory' ||
        (e.type === 'link' && links[e.name] === e.link),
    ),
    'Recovery encountered an undeclared link or special file.',
    409,
  );
  const space = await fs.statfs(target);
  assert(
    Number(space.bavail) * Number(space.bsize) >=
      selected
        .filter((e) => e.type === 'file')
        .reduce((sum, e) => sum + e.size, 0) +
        64 * 1024 ** 2,
    'There is not enough free space for an independent recovery copy. Original storage was kept.',
    409,
  );
  const dirs = selected.filter((e) => e.type === 'directory');
  for (const entry of dirs)
    await fs.mkdir(path.join(target, entry.name), {
      recursive: true,
      mode: 0o700,
    });
  for (const entry of selected.filter((e) => e.type === 'file')) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    await fs.mkdir(path.dirname(to), {recursive: true, mode: 0o700});
    const input = await fs.open(
      from,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await input.stat();
      assert(
        before.isFile() &&
          before.ino === entry.ino &&
          before.dev === entry.dev &&
          before.size === entry.size &&
          before.mtimeMs === entry.mtime,
        'Source storage changed. Inspect it again.',
        409,
      );
      const hash = crypto.createHash('sha256');
      const output = await fs.open(
        to,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        for await (const chunk of input.createReadStream({autoClose: false})) {
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        await output.sync();
      } finally {
        await output.close();
      }
      const written = crypto.createHash('sha256');
      for await (const chunk of (
        await fs.open(to, constants.O_RDONLY | constants.O_NOFOLLOW)
      ).createReadStream())
        written.update(chunk);
      assert(
        hash.digest('hex') === written.digest('hex'),
        'Recovered file failed integrity verification.',
        409,
      );
      const after = await input.stat();
      assert(
        after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Source storage changed during recovery.',
        409,
      );
      await fs.chown(to, entry.uid, entry.gid);
      await fs.chmod(to, entry.mode);
      await fs.utimes(to, new Date(entry.mtime), new Date(entry.mtime));
    } finally {
      await input.close();
    }
  }
  for (const entry of selected.filter((e) => e.type === 'link')) {
    const to = path.join(target, entry.name);
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.symlink(links[entry.name], to);
    await fs.lchown(to, entry.uid, entry.gid);
  }
  for (const entry of dirs.toReversed()) {
    const to = path.join(target, entry.name);
    await fs.chown(to, entry.uid, entry.gid);
    await fs.chmod(to, entry.mode);
  }
}
