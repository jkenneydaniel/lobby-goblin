import {rustSnapshotSeed} from './seed.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {assert, inside, writeJSON} from '../../common.js';
import {safeSnapshotPath as safe} from '../../core/snapshot-files.js';
import {verifyArchive, rustSoftwareReceipt} from './archive.js';
import {readRecord} from '../../providers/steamcmd/files.js';

// Verify the complete archive before extracting its regular-file-only TAR.
export async function extractRust(file, target) {
  await verifyArchive(file);
  await fs.mkdir(target, {recursive: true});
  const input = createReadStream(file),
    unzip = createGunzip(),
    finished = pipeline(input, unzip);
  void finished.catch(() => {});
  const iterator = unzip[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function take(n) {
    while (buffered.length < n) {
      const next = await iterator.next();
      assert(!next.done, 'Truncated archive.');
      buffered = Buffer.concat([buffered, next.value]);
    }
    const v = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return v;
  }
  try {
    while (true) {
      const block = await take(512);
      if (block.every((n) => n === 0)) break;
      const prefix = block.subarray(345, 500).toString().replace(/\0.*$/, ''),
        name =
          (prefix ? prefix + '/' : '') +
          block.subarray(0, 100).toString().replace(/\0.*$/, ''),
        size = parseInt(
          block.subarray(124, 136).toString().replace(/\0.*$/, '').trim(),
          8,
        );
      assert(safe(name) && block[156] === 48, 'Unsafe snapshot archive.');
      const dest = inside(target, name);
      await fs.mkdir(path.dirname(dest), {recursive: true});
      const out = await fs.open(dest, 'wx', 0o600);
      try {
        for (let left = size; left > 0;) {
          const b = await take(Math.min(left, 65536));
          left -= b.length;
          await out.write(b);
        }
      } finally {
        await out.close();
      }
      await take((512 - (size % 512)) % 512);
    }
    for await (const _chunk of {[Symbol.asyncIterator]: () => iterator}) {
      // Drain the remaining stream before accepting archive verification.
    }
    await finished;
  } finally {
    input.destroy();
    unzip.destroy();
    await finished.catch(() => {});
  }
}

export async function collectSnapshot({backup, content, temporary, record}) {
  const seed = rustSnapshotSeed(record.seed),
    verified = await verifyArchive(backup);
  assert(
    !/:managed-lg\./.test(record.image || '') || verified.software,
    'Managed Rust snapshots require their exact software identity.',
    409,
  );
  assert(
    !verified.modded,
    'Modded Rust backups must be recovered as a complete installation; world-only snapshot cloning would omit framework and plugin state.',
    409,
  );
  await extractRust(backup, path.join(temporary, 'extracted'));
  const identity = path.join(temporary, 'extracted/identity');
  await fs.mkdir(path.join(content, 'identity'));
  assert(
    (await fs.readdir(identity)).some(
      (name) =>
        name.startsWith(`proceduralmap.${record.worldSize}.${seed}.`) &&
        name.endsWith('.sav'),
    ),
    'Rust save does not match the source server seed and size.',
  );
  for (const entry of await fs.readdir(identity)) {
    if (entry === 'cfg') continue;
    assert(safe(entry), 'Unsafe identity file.');
    await fs.cp(
      path.join(identity, entry),
      path.join(content, 'identity', entry),
      {recursive: true, dereference: false},
    );
  }
  await fs.rm(path.join(temporary, 'extracted'), {recursive: true});
  if (verified.software) {
    await writeJSON(path.join(content, 'software.json'), verified.software);
    return {seed, software: verified.software};
  }
  return {seed};
}
export async function restoreSnapshot({root, data, manifest, id}) {
  assert(
    manifest.files.every(
      (file) =>
        (file.name === 'software.json' && manifest.software) ||
        (file.name.startsWith('identity/') &&
          !file.name.startsWith('identity/cfg/')),
    ),
    'Unexpected Rust snapshot file.',
  );
  if (manifest.software) {
    const expected = rustSoftwareReceipt(manifest.software),
      stored = rustSoftwareReceipt(
        await readRecord(path.join(root, 'software.json'), {max: 65536}),
      );
    assert(
      JSON.stringify(expected) === JSON.stringify(stored),
      'Copied Rust software identity changed.',
      409,
    );
  }
  await fs.cp(
    path.join(root, 'identity'),
    path.join(data, 'server/lobby-goblin-rust'),
    {recursive: true},
  );
  // Only a new independent copy may authorize Steam installation.
  if (!manifest.software)
    await writeJSON(path.join(data, '.lobby-goblin-clone.json'), {
      game: 'rust',
      identity: 'lobby-goblin-rust',
      snapshot: id,
    });
}
