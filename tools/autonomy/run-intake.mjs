import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {maxInputBytes} from './feedback-intake.mjs';

// Fixed local parser with no inherited secrets or supplied commands.
// Node permissions restrict filesystem/child-process APIs; not an OS sandbox.
export function runIntake(source) {
  const input = JSON.stringify(source);
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) throw new Error('Input too large.');
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const cli = fileURLToPath(new URL('./intake-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${directory}`, cli], {
    input, encoding: 'utf8', env: {}, timeout: 5000, maxBuffer: 65536, cwd: directory,
  });
  if (result.error || result.status !== 0) throw new Error('Restricted feedback intake failed.');
  return JSON.parse(result.stdout);
}
