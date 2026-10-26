import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function files(directory) {
  const found = [];
  for (const entry of await fs.readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(relative)));
    else if (/\.(?:m?js|css|ts)$/.test(entry.name)) found.push(relative);
  }
  return found;
}
const source = [...(await files('panel')), ...(await files('tools'))];
const javascript = source.filter((file) => /\.m?js$/.test(file));
const formatted = source.filter(
  (file) =>
    file.startsWith('panel/public/') ||
    /^panel\/applications\/[^/]+\/public\//.test(file) ||
    file.startsWith('panel/quality/'),
);
const mode = process.argv[2] || 'all';
if (!['all', 'lint', 'format', 'types', 'assets'].includes(mode))
  throw Error('Unknown quality check: ' + mode);
function run(binary, args) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(binary, import.meta.url)), ...args],
    {cwd: root, stdio: 'inherit'},
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!javascript.length || !formatted.length)
  throw Error('Quality checks found no source files.');
if (mode === 'all' || mode === 'lint')
  run('node_modules/eslint/bin/eslint.js', [
    '--config',
    'panel/quality/eslint.config.mjs',
    '--max-warnings',
    '0',
    ...javascript,
  ]);
if (mode === 'all' || mode === 'format')
  run('node_modules/prettier/bin/prettier.cjs', [
    '--config',
    'panel/quality/prettier.json',
    '--check',
    ...formatted,
  ]);
if (mode === 'all' || mode === 'types')
  run('node_modules/typescript/bin/tsc', [
    '--project',
    'panel/quality/tsconfig.json',
  ]);
if (mode === 'all' || mode === 'assets') {
  run('tests.mjs', []);
  run('assets.mjs', []);
}
