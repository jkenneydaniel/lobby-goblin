// Runs as the game user, without loader overrides or management privileges.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const check = (value, message) => {
  if (!value) throw Error(message);
};
export async function prepareSdk(source, root = '/home/node/.steam/sdk64') {
  check(
    path.isAbsolute(root) &&
      (await fs.realpath(root)) === root &&
      (await fs.realpath(source)) === path.resolve(source),
    'Steam SDK paths cannot be linked',
  );
  const input = await fs.lstat(source);
  check(
    input.isFile() &&
      input.nlink === 1 &&
      input.size > 0 &&
      input.size <= 256 * 1024 ** 2,
    'Invalid Steam SDK source',
  );
  const target = path.join(root, 'steamclient.so'),
    existing = await fs.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  check(
    !existing ||
      (existing.isFile() && existing.nlink === 1 && !existing.isSymbolicLink()),
    'Steam SDK destination cannot be linked',
  );
  const temporary = target + '.' + randomUUID();
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, {force: true});
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === 'sdk') await prepareSdk(process.argv[3]);
  else if (process.argv[2] === 'signal') {
    const pid = Number(process.argv[3]);
    check(Number.isSafeInteger(pid) && pid > 1, 'Invalid game signal identity');
    try {
      process.kill(pid, 'SIGINT');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  } else throw Error('Unknown managed Rust helper');
}
