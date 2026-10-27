import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  applicationImages,
  imageContext,
  buildApplicationImage,
  sharedImages,
  imageCatalogue,
  imageBuildOrder,
  selectImageRecipes,
} from '../core/application-image-build.js';
const project = fileURLToPath(new URL('../../', import.meta.url));
test('all registered package images build from isolated declarations and clean up after failures', async () => {
  const recipes = await applicationImages(project);
  assert.deepEqual(
    recipes.map((recipe) => recipe.key),
    [
      'factorio/server',
      'factorio/runtime',
      'rust/server',
      'status-page/server',
    ],
  );
  for (const recipe of recipes) {
    let context;
    await assert.rejects(
      buildApplicationImage(recipe, {
        run: async (program, args) => {
          assert.equal(program, 'docker');
          context = args.at(-1);
          const files = (await fs.readdir(context, {recursive: true})).filter(
            (file) => !file.includes('/'),
          );
          assert.ok(files.includes('Dockerfile') || recipe.id === 'runtime');
          assert.ok(!files.includes('.env'));
          assert.ok(!files.includes('node_modules'));
          throw Error('simulated build failure');
        },
      }),
      /simulated build/,
    );
    assert.equal(await fs.stat(context).catch(() => null), null);
  }
});

test('shared provider images have a separate catalogue and retain isolated build contexts', async () => {
  const shared = await sharedImages(project);
  assert.deepEqual(
    shared.map((recipe) => recipe.key),
    ['shared/steamcmd/runtime'],
  );
  assert.equal((await applicationImages(project)).length, 4);
  const all = await imageCatalogue(project);
  assert.equal(all.length, 5);
  assert.equal(all[0].key, 'shared/steamcmd/runtime');
  await imageContext(shared[0], async (directory) => {
    assert.deepEqual(await fs.readdir(directory), ['Dockerfile']);
    assert.ok(
      (await fs.readFile(path.join(directory, 'Dockerfile'), 'utf8')).includes(
        'USER 1000:1000',
      ),
    );
  });
});

test('explicit base dependencies are ordered and targeted builds include their prerequisites', () => {
  const recipes = [
    {key: 'rust/server', dependencies: ['shared/steamcmd/runtime']},
    {key: 'shared/steamcmd/runtime', dependencies: []},
    {key: 'factorio/server', dependencies: []},
  ];
  assert.deepEqual(
    imageBuildOrder(recipes).map((item) => item.key),
    ['shared/steamcmd/runtime', 'rust/server', 'factorio/server'],
  );
  assert.deepEqual(
    selectImageRecipes(recipes, 'rust/server').map((item) => item.key),
    ['shared/steamcmd/runtime', 'rust/server'],
  );
  assert.deepEqual(
    selectImageRecipes(recipes, 'factorio/server').map((item) => item.key),
    ['factorio/server'],
  );
  assert.throws(() => selectImageRecipes(recipes, 'unknown/server'));
  assert.throws(
    () =>
      imageBuildOrder([
        {key: 'rust/server', dependencies: ['missing/runtime']},
      ]),
    /Unknown image dependency/,
  );
  assert.throws(
    () =>
      imageBuildOrder([
        {key: 'a/runtime', dependencies: ['b/runtime']},
        {key: 'b/runtime', dependencies: ['a/runtime']},
      ]),
    /cycle/,
  );
  assert.throws(
    () => imageBuildOrder([{key: 'a/runtime'}, {key: 'a/runtime'}]),
    /Duplicate/,
  );
});
test('a new package recipe is discovered without editing tooling; traversal and symlinks are rejected', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'application-build-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const p = path.join(root, 'panel/applications/example');
  await fs.mkdir(p, {recursive: true});
  await fs.writeFile(
    path.join(root, 'panel/applications/registry.json'),
    '["example"]',
  );
  const spec = {
    version: 1,
    images: [
      {
        id: 'server',
        manifest: 'image.json',
        dockerfile: 'Dockerfile',
        files: [{source: 'Dockerfile', target: 'Dockerfile'}],
        buildArgs: {BASE_IMAGE: 'baseImage'},
        checks: [],
        acceptance: ['acceptance.mjs'],
      },
    ],
  };
  await fs.writeFile(
    path.join(p, 'image.json'),
    JSON.stringify({
      format: 1,
      repository: 'ghcr.io/example/server',
      tag: '1',
      platform: 'linux/amd64',
      baseImage: 'debian:bookworm-slim@sha256:' + 'a'.repeat(64),
    }),
  );
  await fs.writeFile(path.join(p, 'Dockerfile'), 'FROM scratch');
  await fs.writeFile(path.join(p, 'acceptance.mjs'), '// fixture');
  const save = () =>
    fs.writeFile(path.join(p, 'images.json'), JSON.stringify(spec));
  await save();
  assert.equal((await applicationImages(root))[0].key, 'example/server');
  spec.images[0].files[0].source = '../private.env';
  await save();
  await assert.rejects(applicationImages(root), /allowlist/);
  spec.images[0].files[0].source = 'Dockerfile';
  await save();
  await fs.rename(path.join(p, 'Dockerfile'), path.join(root, 'private.env'));
  await fs.symlink(path.join(root, 'private.env'), path.join(p, 'Dockerfile'));
  const recipe = (await applicationImages(root))[0];
  await assert.rejects(
    imageContext(recipe, () =>
      assert.fail('Linked source reached the builder.'),
    ),
    /without links/,
  );
});
