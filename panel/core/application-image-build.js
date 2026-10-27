import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assert} from '../common.js';
import {sourceFile, installationPath} from '../source-layout.js';
import {safeSnapshotPath} from './snapshot-files.js';
const execute = promisify(execFile);
const identifier = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

// Build manifests are reviewed repository data. HTTP never exposes this runner.
async function packageImages(root, group) {
  const registry = await fs
    .readFile(path.join(root, 'panel', group, 'registry.json'), 'utf8')
    .catch((error) => {
      if (group === 'providers' && error.code === 'ENOENT') return '[]';
      throw error;
    });
  const ids = JSON.parse(registry);
  assert(
    Array.isArray(ids) &&
      ids.length <= 64 &&
      ids.every(identifier) &&
      new Set(ids).size === ids.length,
    'Invalid image package registry.',
  );
  const images = [];
  for (const application of ids) {
    const packageRoot = path.join(root, 'panel', group, application);
    const manifest = await fs
      .readFile(path.join(packageRoot, 'images.json'), 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (manifest === null) continue; // Some packages use upstream images only.
    const spec = JSON.parse(manifest);
    assert(
      exact(spec, ['version', 'images']) &&
        spec.version === 1 &&
        Array.isArray(spec.images) &&
        spec.images.length > 0 &&
        spec.images.length <= 8,
      'Invalid package image manifest.',
    );
    for (const recipe of spec.images) {
      assert(
        exact(recipe, [
          'id',
          'manifest',
          'dockerfile',
          'files',
          'buildArgs',
          'checks',
          'acceptance',
          'dependencies',
        ]) &&
          identifier(recipe.id) &&
          safeSnapshotPath(recipe.manifest) &&
          safeSnapshotPath(recipe.dockerfile),
        'Invalid image recipe.',
      );
      const locate = async (relative) => {
        assert(
          safeSnapshotPath(relative),
          'Image source must stay inside its package.',
        );
        const file = await sourceFile(
          root,
          installationPath(
            'panel/' + group + '/' + application + '/' + relative,
          ),
        );
        assert(
          (await fs.lstat(file)).isFile() && (await fs.realpath(file)) === file,
          'Image sources must be regular files without links.',
        );
        return file;
      };
      const value = JSON.parse(
        await fs.readFile(await locate(recipe.manifest), 'utf8'),
      );
      assert(
        value.format === 1 &&
          /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value.repository) &&
          /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.tag) &&
          value.platform === 'linux/amd64' &&
          /^[a-z0-9:/._-]+@sha256:[a-f0-9]{64}$/.test(value.baseImage),
        'Invalid pinned image metadata.',
      );
      assert(
        Array.isArray(recipe.files) &&
          recipe.files.length > 0 &&
          recipe.files.length <= 128 &&
          recipe.files.every(
            (file) =>
              exact(file, ['source', 'target']) &&
              safeSnapshotPath(file.source) &&
              safeSnapshotPath(file.target),
          ) &&
          new Set(recipe.files.map((file) => file.target)).size ===
            recipe.files.length &&
          recipe.files.some((file) => file.target === recipe.dockerfile),
        'Invalid image context allowlist.',
      );
      assert(
        exact(recipe.buildArgs, Object.keys(recipe.buildArgs || {})) &&
          Object.entries(recipe.buildArgs).every(
            ([key, field]) =>
              /^[A-Z][A-Z0-9_]*$/.test(key) &&
              Object.hasOwn(value, field) &&
              ['string', 'number'].includes(typeof value[field]) &&
              !/[\x00\r\n]/.test(String(value[field])),
          ),
        'Invalid image build argument.',
      );
      assert(
        Array.isArray(recipe.checks) &&
          recipe.checks.length <= 16 &&
          recipe.checks.every(
            (check) =>
              exact(check, ['runner', 'file']) &&
              ['node-test', 'node', 'python'].includes(check.runner) &&
              safeSnapshotPath(check.file),
          ),
        'Invalid image checks.',
      );
      assert(
        Array.isArray(recipe.acceptance) &&
          recipe.acceptance.length > 0 &&
          recipe.acceptance.length <= 8 &&
          recipe.acceptance.every((file) => safeSnapshotPath(file)),
        'Image recipes need package-owned native acceptance.',
      );
      const key =
        (group === 'providers' ? 'shared/' : '') +
        application +
        '/' +
        recipe.id;
      const dependencies = recipe.dependencies || [];
      assert(
        Array.isArray(dependencies) &&
          dependencies.length <= 8 &&
          dependencies.every(
            (item) =>
              typeof item === 'string' &&
              /^(?:shared\/)?[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}$/.test(
                item,
              ),
          ) &&
          new Set(dependencies).size === dependencies.length,
        'Invalid image dependencies.',
      );
      assert(
        !images.some((image) => image.key === key),
        'Duplicate package image.',
      );
      images.push({
        key,
        application,
        ...recipe,
        dependencies,
        metadata: value,
        image: value.repository + ':' + value.tag,
        locate,
      });
    }
  }
  return images;
}
export const applicationImages = (root) => packageImages(root, 'applications');
export const sharedImages = (root) => packageImages(root, 'providers');
export function imageBuildOrder(recipes) {
  const indexed = new Map(recipes.map((recipe) => [recipe.key, recipe]));
  assert(indexed.size === recipes.length, 'Duplicate image identity.');
  const complete = new Set(),
    pending = new Set(),
    ordered = [];
  function visit(recipe) {
    if (complete.has(recipe.key)) return;
    assert(!pending.has(recipe.key), 'Image dependency cycle.');
    pending.add(recipe.key);
    for (const dependency of recipe.dependencies || []) {
      assert(indexed.has(dependency), 'Unknown image dependency.');
      visit(indexed.get(dependency));
    }
    pending.delete(recipe.key);
    complete.add(recipe.key);
    ordered.push(recipe);
  }
  for (const recipe of recipes) visit(recipe);
  return ordered;
}
export async function imageCatalogue(root) {
  const [shared, applications] = await Promise.all([
    sharedImages(root),
    applicationImages(root),
  ]);
  const ordered = imageBuildOrder([...shared, ...applications]);
  for (const recipe of ordered)
    if (recipe.dependencies.length) {
      assert(
        recipe.dependencies.length === 1,
        'An image may declare one pinned base dependency.',
      );
      const base = ordered.find(
        (candidate) => candidate.key === recipe.dependencies[0],
      );
      assert(
        recipe.metadata.baseImage.startsWith(
          base.metadata.repository + '@sha256:',
        ) && recipe.metadata.platform === base.metadata.platform,
        'Image dependency must match its pinned base and platform.',
      );
    }
  return ordered;
}
export function selectImageRecipes(recipes, key) {
  const wanted = new Set();
  function include(name) {
    if (wanted.has(name)) return;
    const recipe = recipes.find((candidate) => candidate.key === name);
    assert(recipe, 'Unknown application image.');
    wanted.add(name);
    for (const dependency of recipe.dependencies || []) include(dependency);
  }
  if (key) include(key);
  else for (const recipe of recipes) include(recipe.key);
  return imageBuildOrder(recipes).filter((recipe) => wanted.has(recipe.key));
}
export async function imageContext(recipe, run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lobby-image-context-'),
  );
  try {
    for (const file of recipe.files) {
      const target = path.join(directory, file.target);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.copyFile(await recipe.locate(file.source), target);
    }
    return await run(directory);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
}
export const runImageCommand = async (program, args) =>
  (await execute(program, args, {timeout: 1800000, maxBuffer: 8 * 1024 * 1024}))
    .stdout;
export async function buildApplicationImage(
  recipe,
  {run = runImageCommand} = {},
) {
  return imageContext(recipe, (context) =>
    run('docker', [
      'build',
      '--platform',
      recipe.metadata.platform,
      '--file',
      path.join(context, recipe.dockerfile),
      '--tag',
      recipe.image,
      '--build-arg',
      'TARGETARCH=' + recipe.metadata.platform.split('/')[1],
      ...Object.entries(recipe.buildArgs).flatMap(([key, field]) => [
        '--build-arg',
        key + '=' + recipe.metadata[field],
      ]),
      context,
    ]),
  );
}
export async function checkApplicationImage(
  recipe,
  {run = runImageCommand} = {},
) {
  for (const check of recipe.checks)
    await run(check.runner === 'python' ? 'python3' : process.execPath, [
      ...(check.runner === 'node-test'
        ? ['--test']
        : check.runner === 'python'
          ? ['-B']
          : []),
      await recipe.locate(check.file),
    ]);
}

export async function acceptApplicationImage(
  recipe,
  {run = runImageCommand} = {},
) {
  assert(
    process.env.LOBBY_DISPOSABLE_ENGINE_ID ||
      process.env.GITHUB_ACTIONS === 'true',
    'Native image acceptance requires an explicit disposable engine identity.',
  );
  const engine = JSON.parse(
    await run('docker', ['info', '--format', '{{json .ID}}']),
  );
  assert(
    !process.env.LOBBY_DISPOSABLE_ENGINE_ID ||
      engine === process.env.LOBBY_DISPOSABLE_ENGINE_ID,
    'The disposable engine identity changed.',
  );
  const output = [];
  for (const file of recipe.acceptance)
    output.push(await run(process.execPath, [await recipe.locate(file)]));
  return output.join('\n');
}
