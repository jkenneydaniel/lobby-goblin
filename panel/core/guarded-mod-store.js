import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {assert} from '../common.js';
import {safeModFile} from './mod-store.js';

// A trusted application supplies its controller-owned data anchor and fixed
// relative directories. Requests can choose only a validated leaf filename.
// Linux directory descriptors pin each component: a game-owned directory rename
// or symlink swap cannot redirect privileged reads/writes into private state.
export function createGuardedModStore(
  anchor,
  relative,
  {
    accept = () => true,
    maxFileBytes = 64 * 1024 ** 2,
    fault = async () => {},
  } = {},
) {
  assert(
    typeof anchor === 'string' &&
      path.isAbsolute(anchor) &&
      path.resolve(anchor) === anchor &&
      anchor !== '/',
    'Choose a canonical mod data anchor.',
  );
  assert(
    typeof relative === 'string' &&
      relative.length <= 1024 &&
      relative.split('/').length <= 32 &&
      relative
        .split('/')
        .every(
          (part) =>
            /^[A-Za-z0-9_.-]{1,128}$/.test(part) &&
            part !== '.' &&
            part !== '..',
        ),
    'Choose fixed mod data directories.',
  );
  assert(
    Number.isSafeInteger(maxFileBytes) &&
      maxFileBytes > 0 &&
      maxFileBytes <= 64 * 1024 ** 2,
    'Invalid mod file budget.',
  );
  const root = path.join(anchor, ...relative.split('/'));
  const at = (handle, name = '') =>
    '/proc/self/fd/' + handle.fd + (name ? '/' + name : '');
  const close = async (handles) => {
    for (const handle of handles.toReversed()) await handle.close();
  };
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  async function openDirectories(create) {
    assert(
      process.platform === 'linux',
      'Guarded mod data operations require the Linux controller.',
      409,
    );
    const handles = [];
    try {
      const parent = await fs.open(anchor, directoryFlags);
      handles.push(parent);
      const stat = await parent.stat();
      assert(
        stat.isDirectory() &&
          stat.uid === process.getuid() &&
          !(stat.mode & 0o022) &&
          (await fs.realpath(anchor)) === anchor,
        'Mod data requires a controller-owned anchor.',
        409,
      );
      for (const part of relative.split('/')) {
        const location = at(handles.at(-1), part);
        if (create)
          try {
            await fs.mkdir(location, {mode: 0o755});
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        handles.push(await fs.open(location, directoryFlags));
      }
      return handles;
    } catch (error) {
      await close(handles);
      if (['ELOOP', 'ENOTDIR'].includes(error.code))
        assert(false, 'Mod directories cannot contain links.', 409);
      throw error;
    }
  }
  async function scope(create, action) {
    let handles;
    try {
      handles = await openDirectories(create);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parent = handles.at(-1),
        before = await parent.stat();
      const current = async () => {
        const observed = await openDirectories(false);
        try {
          const after = await observed.at(-1).stat();
          assert(
            before.dev === after.dev && before.ino === after.ino,
            'Mod storage changed. Refresh before retrying.',
            409,
          );
        } finally {
          await close(observed);
        }
      };
      await fault('directory-open');
      return await action(parent, current);
    } finally {
      await close(handles);
    }
  }
  async function readAt(parent, name) {
    safeModFile(name);
    await fault('before-read');
    let handle;
    try {
      handle = await fs.open(
        at(parent, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP')
        assert(false, 'Mod files cannot be links.', 409);
      throw error;
    }
    try {
      const before = await handle.stat();
      assert(
        before.isFile() && before.nlink === 1 && before.size <= maxFileBytes,
        'Mod files must be bounded ordinary files without hardlinks.',
        409,
      );
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      assert(
        length === before.size &&
          after.size === before.size &&
          after.nlink === 1 &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Mod file changed. Refresh before retrying.',
        409,
      );
      return {data: buffer.subarray(0, length), mode: before.mode & 0o777};
    } finally {
      await handle.close();
    }
  }
  async function read(name) {
    safeModFile(name);
    return scope(false, async (parent, current) => {
      const value = await readAt(parent, name);
      await current();
      return value;
    });
  }
  async function list() {
    return (
      (await scope(false, async (parent, current) => {
        const files = new Map();
        let count = 0,
          bytes = 0;
        for await (const entry of await fs.opendir(at(parent))) {
          assert(++count <= 10000, 'Too many mod directory entries.', 409);
          if (!accept(entry.name)) continue;
          assert(files.size < 1000, 'Too many installed mod files.', 409);
          const value = await readAt(parent, entry.name);
          assert(value, 'Mod files changed. Refresh the library.', 409);
          bytes += value.data.length;
          assert(
            bytes <= 256 * 1024 ** 2,
            'Installed mods exceed their review limit.',
            409,
          );
          files.set(entry.name, value);
        }
        await current();
        return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
      })) ?? new Map()
    );
  }
  async function write(name, data, mode = 0o644) {
    safeModFile(name);
    assert(
      data === null || (Buffer.isBuffer(data) && data.length <= maxFileBytes),
      'Invalid mod file data.',
    );
    assert(
      Number.isInteger(mode) && mode >= 0 && mode <= 0o777,
      'Invalid mod file permissions.',
    );
    return scope(true, async (parent, current) => {
      await readAt(parent, name);
      await current();
      await fault('before-write');
      if (data === null) {
        await fs.unlink(at(parent, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await parent.sync();
        await current();
        return;
      }
      const temporary = '.lg-mod-' + randomUUID();
      let handle;
      try {
        handle = await fs.open(
          at(parent, temporary),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          mode,
        );
        await handle.writeFile(data);
        await handle.chmod(mode);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(at(parent, temporary), at(parent, name));
        await parent.sync();
        await current();
      } finally {
        await handle?.close();
        await fs.unlink(at(parent, temporary)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
  }
  return {root, read, list, write};
}
