import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {creationPreflight} from '../core/creation-preflight.js';
import {selectedApplication} from '../applications/index.js';
import {rustSoftwareSummary} from '../applications/rust/software-summary.js';

test('creation preflight reports admission failures using host and snapshot metadata only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-preflight-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let calls = 0, snapshots = 0;
  const host = {OSType: 'linux', Architecture: 'amd64', ServerVersion: '29.1.3', NCPU: 8, MemTotal: 32 * 1024 ** 3};
  const manager = {root, module: selectedApplication, broker: {}, memoryBudgetGiB: 24,
    allocations: () => [{totalGiB: 4}],
    docker: async (method, route) => { assert.equal(method, 'GET'); assert.equal(route, '/info'); calls++; return host; },
    snapshot: () => { snapshots++; return {game: 'factorio', image: selectedApplication('factorio').managed.catalog.image}; },
  };
  const input = {game: 'factorio', name: 'Disposable check', memoryGiB: 2, cpu: 1};
  assert.equal((await creationPreflight(manager, input)).ready, true);
  assert.equal(calls, 1); assert.equal(snapshots, 0);
  const check = id => async () => (await creationPreflight(manager, input)).checks.find(item => item.id === id).status;
  host.Architecture = 'arm64'; assert.equal(await check('platform')(), 'fail'); host.Architecture = 'amd64';
  host.ServerVersion = '25.0'; assert.equal(await check('engine')(), 'fail'); host.ServerVersion = '29.1.3';
  host.NCPU = 1; assert.equal((await creationPreflight(manager, {...input, cpu: 2})).checks.find(item => item.id === 'cpu').status, 'warning');
  host.NCPU = 0; assert.equal(await check('cpu')(), 'warning'); host.NCPU = 8;
  manager.memoryBudgetGiB = 5; assert.equal(await check('memory')(), 'fail'); manager.memoryBudgetGiB = 24;
  host.MemTotal = 8 * 1024 ** 3; assert.equal(await check('memory')(), 'fail'); host.MemTotal = 32 * 1024 ** 3;
  const copied = await creationPreflight(manager, {...input, snapshotId: 'a'.repeat(32)});
  assert.equal(copied.ready, true); assert.equal(snapshots, 1);
  manager.snapshot = () => ({game: 'factorio', image: selectedApplication('factorio').managed.runtime.imagePolicy.defaultImage});
  const runtimeClone = await creationPreflight(manager, {...input, snapshotId: 'a'.repeat(32)});
  assert.equal(runtimeClone.ready, true); assert.equal(runtimeClone.softwareMode, 'runtime');
  manager.snapshot = () => ({game: 'rust', image: selectedApplication('rust').managed.runtime.imagePolicy.defaultImage});
  const managedClone = {game: 'rust', name: 'Managed clone', snapshotId: 'a'.repeat(32), memoryGiB: 12, cpu: 2};
  assert.equal((await creationPreflight(manager, managedClone)).softwareMode, 'managed');
  assert.equal((await creationPreflight(manager, managedClone)).ready, true);
  manager.broker = null;
  assert.equal((await creationPreflight(manager, managedClone)).checks.find(item => item.id === 'preparation').status, 'fail');
  manager.broker = {};
  manager.snapshot = () => ({game: 'rust', image: 'unrelated'});
  assert.equal((await creationPreflight(manager, {...input, snapshotId: 'a'.repeat(32)})).ready, false);
  manager.broker = null;
  assert.equal((await creationPreflight(manager, {game: 'rust', name: 'Managed check', softwareMode: 'managed', memoryGiB: 12, cpu: 2})).ready, false);
  assert.deepEqual(await fs.readdir(root), []);
});

test('Rust setup metadata does not inspect world contents, resolve software or expose recovery records', async () => {
  const unused = () => { throw Error('No preparation, deep inspection or framework enumeration is allowed.'); };
  const legacy = await rustSoftwareSummary({software: null, changes: null, framework: unused});
  assert.equal(legacy.managed, false);
  const software = {status: async () => ({version: '123', phase: 'complete', recoveryRequired: false}), ensure: unused, inspect: unused};
  const changes = {inspect: async options => { assert.equal(options, undefined); return {pending: true, kind: 'software', phase: 'reviewed', previousFramework: 'carbon', observation: {private: 'never expose'}}; }, softwareStatus: async () => ({current: {softwareVersion: '123'}, target: {softwareVersion: '124'}})};
  const value = await rustSoftwareSummary({software, changes, framework: unused, activeJob: {message: 'Preparing exact build', secret: 'private'}});
  assert.equal(value.framework, 'carbon'); assert.equal(value.installation.version, '123');
  assert.equal(value.change.observation, undefined); assert.equal(value.activeJob.secret, undefined);
  for (const [phase, record, allowed] of [['checking-software', {}, true], ['checking-software', {prepareId: 'retained'}, false], ['checking-software', {world: 'retained'}, false], ['reviewed', {}, false]]) {
    changes.inspect = async () => ({pending: true, kind: 'software', phase, previousFramework: 'none', observation: {record}});
    assert.equal((await rustSoftwareSummary({software, changes, framework: unused})).change.metadataOnlyRecovery, allowed);
  }

  const module = selectedApplication('rust');
  assert.equal(module.contract.policy.routes['/software-setup'].GET, 'images.change');
  assert.equal(module.presentation.screens.find(screen => screen.id === 'software').permission, 'images.change');
});

test('the copyable app template loads through the existing registry and runs its package checks', {timeout: 30000}, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'app-template-')));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const run = promisify(execFile);
  const prepared = path.join(temporary, 'prepared');
  await run(process.execPath, [path.join(root, 'panel/test/prepare-runtime-acceptance.mjs'), '--out', prepared], {timeout: 20000});
  const runtime = path.join(prepared, 'panel');
  await fs.cp(path.join(root, 'docs/templates/application'), path.join(runtime, 'applications/example-app'), {recursive: true});
  const registry = path.join(runtime, 'applications/registry.json'), ids = JSON.parse(await fs.readFile(registry, 'utf8'));
  await fs.writeFile(registry, JSON.stringify([...ids, 'example-app']));
  const result = await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import {selectedApplication} from './applications/index.js';
    import {imageCatalogue,checkApplicationImage} from './core/application-image-build.js';
    const app=selectedApplication('example-app');
    assert.equal(app.definition.services[0].profile,'managed-container-v1');
    assert.equal(app.web.extensions,undefined);
    const recipe=(await imageCatalogue(path.resolve('..'))).find(recipe=>recipe.key==='example-app/server');
    assert.ok(recipe);
    await checkApplicationImage(recipe);
    console.log('Template checks passed');
  `], {cwd: runtime, timeout: 10000, env: {...process.env, DOCKER_SOCKET: path.join(temporary, 'no-engine.sock')}});
  assert.match(result.stdout, /Template checks passed/);
});
