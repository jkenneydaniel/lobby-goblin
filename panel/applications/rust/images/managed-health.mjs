import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function liveProcess(record, stat) {
  if (
    !Number.isSafeInteger(record?.pid) ||
    record.pid < 2 ||
    typeof stat !== 'string' ||
    !stat.startsWith(record.pid + ' (')
  )
    return false;
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  return /^[A-Za-z]$/.test(state) && !['Z', 'X', 'x'].includes(state);
}
export function healthy() {
  try {
    const file = '/tmp/lobby-goblin-rust-ready.json',
      metadata = fs.lstatSync(file);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid() ||
      metadata.size > 256 ||
      metadata.mode & 0o077
    )
      return false;
    const record = JSON.parse(
      fs.readFileSync(file, {
        encoding: 'utf8',
        flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      }),
    );
    if (!Number.isSafeInteger(record.pid) || record.pid < 2) return false;
    // /proc existence/state checks need no CAP_KILL across supervisor/game UIDs.
    return liveProcess(
      record,
      fs.readFileSync('/proc/' + record.pid + '/stat', 'utf8'),
    );
  } catch {
    return false;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = healthy() ? 0 : 1;
