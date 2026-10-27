import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
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
    ['shared/steamcmd/runtime', 'shared/steamcmd/worker'],
  );
  assert.equal((await applicationImages(project)).length, 4);
  const all = await imageCatalogue(project);
  assert.equal(all.length, 6);
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

test('the software worker imports its complete shared runtime from an isolated public context', async () => {
  const worker = (await sharedImages(project)).find(
    (recipe) => recipe.id === 'worker',
  );
  await assert.rejects(
    worker.locateRuntime('panel/private.env'),
    /Unknown shared/,
  );
  await imageContext(worker, async (directory) => {
    const runtime = path.join(
      directory,
      'runtime/panel/providers/steamcmd/worker.js',
    );
    const module = await import(pathToFileURL(runtime));
    assert.equal(typeof module.executeWorkerRequest, 'function');
    assert.throws(
      () => module.softwareWorkerRequest({format: 1, action: 'activate'}),
      /supported/,
    );
    const files = await fs.readdir(directory, {recursive: true});
    assert.ok(files.includes('runtime/panel/core/software-installation.js'));
    assert.ok(
      !files.some((file) =>
        /(^|\/)(node_modules|test|\.env|data)(\/|$)/.test(file),
      ),
    );
  });
});

test('provider runtime profiles refuse unknown names, shared-module replacement and linked shared sources', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'image-runtime-profile-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const provider = path.join(root, 'panel/providers/steamcmd');
  await fs.mkdir(path.dirname(provider), {recursive: true});
  await fs.cp(path.join(project, 'panel/providers/steamcmd'), provider, {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, 'panel/providers/registry.json'),
    '["steamcmd"]',
  );
  const file = path.join(provider, 'images.json'),
    spec = JSON.parse(await fs.readFile(file, 'utf8'));
  const worker = spec.images.find((recipe) => recipe.id === 'worker');
  worker.runtimeProfile = '../../private.env';
  await fs.writeFile(file, JSON.stringify(spec));
  await assert.rejects(sharedImages(root), /registered provider/);
  worker.runtimeProfile = 'software-provider-v1';
  worker.files.push({source: 'worker.js', target: 'runtime/panel/common.js'});
  await fs.writeFile(file, JSON.stringify(spec));
  await assert.rejects(sharedImages(root), /replace shared/);
  worker.files.pop();
  await fs.writeFile(file, JSON.stringify(spec));
  const secret = path.join(root, 'private.env');
  await fs.writeFile(secret, 'fixture remains outside');
  await fs.symlink(secret, path.join(root, 'panel/common.js'));
  const recipe = (await sharedImages(root)).find(
    (recipe) => recipe.id === 'worker',
  );
  await assert.rejects(
    imageContext(recipe, () =>
      assert.fail('Linked core source reached Docker'),
    ),
    /without links/,
  );
  assert.equal(await fs.readFile(secret, 'utf8'), 'fixture remains outside');
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
