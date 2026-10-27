import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile),
  directory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = ['../../../..', '../..']
  .map((relative) => path.resolve(directory, relative))
  .find((candidate) => existsSync(path.join(candidate, 'panel/package.json')));
const root = projectRoot;
if (!root)
  throw Error(
    'Run the Rust image builder from a complete checkout or source release.',
  );
const {sourceFile} = await import(
  pathToFileURL(path.join(root, 'panel/source-layout.js'))
);
export async function imageDefinition() {
  const value = JSON.parse(
    await fs.readFile(
      await sourceFile(root, 'panel/games/rust/image/image.json'),
      'utf8',
    ),
  );
  if (
    value.format !== 1 ||
    value.platform !== 'linux/amd64' ||
    value.repository !== 'ghcr.io/jkenneydaniel/rust-server' ||
    !/^steam-lg\.[1-9]\d*$/.test(value.tag) ||
    !/^ghcr\.io\/jkenneydaniel\/lobby-goblin-steamcmd@sha256:[a-f0-9]{64}$/.test(
      value.baseImage,
    )
  )
    throw Error('Invalid Rust image definition');
  return {...value, image: value.repository + ':' + value.tag};
}
export async function build({
  run = async (args) =>
    execute('docker', args, {timeout: 1200000, maxBuffer: 8 * 1024 ** 2}),
} = {}) {
  const {applicationImages, buildApplicationImage} = await import(
    pathToFileURL(path.join(root, 'panel/core/application-image-build.js'))
  );
  const recipe = (await applicationImages(root)).find(
    (value) => value.key === 'rust/server',
  );
  return buildApplicationImage(recipe, {run: (_program, args) => run(args)});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'build') await build();
  else
    throw Error(
      'Use build. Native runtime acceptance: panel/test/image-acceptance.mjs rust',
    );
}
