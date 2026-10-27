// Prepare a fresh, source-only build context. This command never contacts Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

assert.equal(
  process.argv.length,
  4,
  'Use: node panel/test/prepare-runtime-acceptance.mjs --out /absolute/new-directory',
);
assert.equal(process.argv[2], '--out');
const source = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[3];
assert.ok(
  path.isAbsolute(output) && path.resolve(output) === output && output !== '/',
);
assert.equal(await fs.realpath(path.dirname(output)), path.dirname(output));
const checkout = path.resolve(source, '..');
assert.ok(
  output !== checkout && !output.startsWith(checkout + '/'),
  'The acceptance context must be outside the source checkout.',
);
await fs.mkdir(output, {mode: 0o700});
const destination = path.join(output, 'panel');
await fs.mkdir(destination);
async function copy(relative) {
  await fs.cp(path.join(source, relative), path.join(destination, relative), {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (file) => {
      if (
        ['node_modules', '__pycache__'].includes(path.basename(file)) ||
        path.basename(file).startsWith('._')
      )
        return false;
      assert.equal(
        (await fs.lstat(file)).isSymbolicLink(),
        false,
        'Acceptance sources cannot be links.',
      );
      return true;
    },
  });
}
for (const directory of ['core', 'applications', 'providers', 'fleet', 'public'])
  await copy(directory);
for (const entry of await fs.readdir(source, {withFileTypes: true}))
  if (
    entry.isFile() &&
    (/\.(?:js|json|lua)$/.test(entry.name) ||
      ['LICENSE', 'Dockerfile', '.dockerignore'].includes(entry.name))
  )
    await copy(entry.name);
await fs.mkdir(path.join(destination, 'test/fixtures'), {recursive: true});
for (const name of [
  'arena-game.js',
  'arena-definition.json',
  'arena-presentation.json',
  'arena-server.js',
  'helper-runtime.mjs',
])
  await copy('test/fixtures/' + name);
for (const name of [
  'docker-runtime-acceptance.mjs',
  'runtime-image-smoke.mjs',
  'runtime-storage-smoke.mjs',
  'runtime-maintenance-smoke.mjs',
  'runtime-management-storage-smoke.mjs',
  'management-update-runtime.mjs',
  'helper-workspace-runtime.mjs',
])
  await copy('test/' + name);
const recipe = JSON.parse(
  await fs.readFile(
    path.join(source, 'test/fixtures/arena-definition.json'),
    'utf8',
  ),
);
const config = recipe.services[0].configuration;
config.imagePolicy = {
  version: 1,
  defaultImage: 'node:24-alpine',
  referencePattern: '^node:24-alpine$',
  architecture: 'amd64',
  labels: {},
  captureLabels: {},
};
config.environment.server.NODE_OPTIONS = [
  {literal: '--require /arena/bootstrap.cjs'},
];
const packageRoot = path.join(destination, 'applications/arena');
await fs.mkdir(packageRoot);
await fs.writeFile(
  path.join(packageRoot, 'definition.json'),
  JSON.stringify(recipe, null, 2) + '\n',
);
await fs.copyFile(
  path.join(destination, 'test/fixtures/arena-presentation.json'),
  path.join(packageRoot, 'presentation.json'),
);
await fs.writeFile(
  path.join(packageRoot, 'index.js'),
  "import {arena} from '../../test/fixtures/arena-game.js';\nimport {definitionFor} from '../registry.js';\nexport default arena('/instance',{runtimeDefinition:definitionFor('arena')});\n",
);
const catalogue = path.join(destination, 'applications/registry.json'),
  registered = JSON.parse(await fs.readFile(catalogue, 'utf8'));
assert.ok(
  !registered.includes('arena'),
  'The disposable fixture must not be in the production registry.',
);
await fs.writeFile(
  catalogue,
  JSON.stringify([...registered, 'arena'], null, 2) + '\n',
);
const dockerfile = path.join(destination, 'Dockerfile'),
  dockerSource = await fs.readFile(dockerfile, 'utf8');
assert.equal(dockerSource.split('USER node\n').length, 2);
await fs.writeFile(
  dockerfile,
  dockerSource.replace(
    'USER node\n',
    'COPY --chown=node:node test ./test\nUSER node\n',
  ),
);
const ignored = path.join(destination, '.dockerignore');
await fs.writeFile(
  ignored,
  (await fs.readFile(ignored, 'utf8'))
    .split('\n')
    .filter((line) => line !== 'test')
    .join('\n'),
);
const hash = crypto.createHash('sha256');
let count = 0;
async function digest(directory, relative = '') {
  for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = path.posix.join(relative, entry.name),
      file = path.join(directory, entry.name);
    if (entry.isDirectory()) await digest(file, name);
    else {
      assert.ok(entry.isFile());
      hash.update(name + '\0');
      hash.update(await fs.readFile(file));
      hash.update('\0');
      count++;
    }
  }
}
await digest(destination);
await fs.writeFile(
  path.join(output, 'acceptance-source.json'),
  JSON.stringify(
    {
      version: 1,
      files: count,
      sha256: hash.digest('hex'),
      testOnlyModule: 'arena',
      productionCatalogChanged: false,
    },
    null,
    2,
  ) + '\n',
  {mode: 0o600},
);
console.log(
  'Prepared a fresh acceptance context with a test-only Arena registration:',
  output,
);
