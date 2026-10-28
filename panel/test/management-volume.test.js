import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {volumeInstallation, volumeRuntime, managementAnchor, managementVolume, portableRuntimeOverlay} from '../core/management-volume.js';
import {portableStartupRuntime} from '../core/management-startup.js';
import {managementDirectory, saveManagementJSON} from '../core/management-installation.js';
const fleet = 'a'.repeat(32), image = 'sha256:' + 'b'.repeat(64), engine = 'fixture-engine', anchorId = 'c'.repeat(64);
const context = {version: 1, fleet, engine, image, anchor: anchorId, volume: managementVolume(fleet), kind: 'fleet', profile: 'legacy', sourceDirectory: 'C:\\Users\\Player\\Lobby Goblin'};
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-volume-')));
  await fs.chmod(directory, 0o700); t.after(() => fs.rm(directory, {recursive: true, force: true})); return directory;
}
test('enrollment is private, immutable and independent of native source folder ownership', {skip: process.platform === 'win32'}, async t => {
  const directory = await fixture(t), descriptor = await volumeInstallation(directory, context);
  assert.equal(descriptor.sourceDirectory, context.sourceDirectory);
  assert.equal((await fs.stat(path.join(directory, 'installation.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await volumeInstallation(directory, {...context, image: 'sha256:' + 'd'.repeat(64)}), descriptor, 'The initial image remains provenance after later releases.');
  const before = await fs.readFile(path.join(directory, 'installation.json'));
  for (const changed of [{engine: 'other'}, {anchor: 'e'.repeat(64)}, {profile: 'brokered'}, {kind: 'host-agent'}])
    await assert.rejects(volumeInstallation(directory, {...context, ...changed}), /changed/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'installation.json')), before);
  assert.equal((await volumeRuntime(directory, {fleet, engine})).image, image);
  await assert.rejects(volumeRuntime(directory, {fleet, engine: 'other'}), /changed/);
  const root = managementDirectory(directory); await fs.mkdir(root, {mode: 0o700}); await fs.mkdir(path.join(root, 'f'.repeat(32)), {mode: 0o700});
  await saveManagementJSON(path.join(root, 'f'.repeat(32), 'operation.json'), {version: 1, id: 'f'.repeat(32), phase: 'replacing', state: 'running', pending: 'replace'});
  await assert.rejects(volumeRuntime(directory, {fleet, engine}), /Finish/);
});
test('nonempty storage, links and malformed scope cannot be enrolled', {skip: process.platform === 'win32'}, async t => {
  const directory = await fixture(t); await fs.writeFile(path.join(directory, 'world.bin'), 'preserve');
  await assert.rejects(volumeInstallation(directory, context), /Unrecognized/);
  await fs.rm(path.join(directory, 'world.bin')); await volumeInstallation(directory, context);
  await fs.rename(path.join(directory, 'installation.json'), path.join(directory, 'original.json'));
  await fs.symlink('original.json', path.join(directory, 'installation.json'));
  await assert.rejects(volumeInstallation(directory, context), /regular/);
  await assert.rejects(volumeInstallation(directory, {...context, engine: '../../other'}), /Invalid/);
});
test('portable startup selects only checked public images and refuses foreign storage or altered cache', async t => {
  const directory = await fixture(t), calls = [];
  const selected = {enrolled: true, kind: 'fleet', image, engine, profile: 'legacy', id: 'd'.repeat(32), enrollment: 'e'.repeat(32)};
  const volume = {Name: managementVolume(fleet), Driver: 'local', Options: {}, Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': 'management-update-ledger', 'io.lobby-goblin.engine': engine}};
  const anchor = {Id: anchorId, Name: '/' + managementAnchor(fleet), Image: image, Config: {Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': 'management-update-anchor', 'io.lobby-goblin.engine': engine, 'io.lobby-goblin.management-volume': managementVolume(fleet)}}, State: {Running: false, Status: 'created'}, HostConfig: {NetworkMode: 'none', ReadonlyRootfs: true, RestartPolicy: {Name: 'no'}}};
  const execute = async (command, args) => {
    assert.equal(command, 'docker'); calls.push(args);
    if (args[0] === 'volume' && args[1] === 'ls') return managementVolume(fleet);
    if (args[0] === 'volume') return JSON.stringify([volume]);
    if (args[0] === 'info') return engine;
    if (args[0] === 'inspect') return JSON.stringify([anchor]);
    assert.equal(args[0], 'run'); assert.equal(args.filter(v => v === '--mount').length, 1);
    assert.ok(args.includes('type=volume,source=' + managementVolume(fleet) + ',target=/management,readonly,volume-nocopy'));
    assert.equal(args.some(v => v.includes('docker.sock')), false); return JSON.stringify(selected);
  };
  const runtime = await portableStartupRuntime(directory, {id: fleet}, {execute});
  const overlay = JSON.parse(await fs.readFile(runtime.arguments[1]));
  assert.deepEqual(overlay, portableRuntimeOverlay(selected)); assert.equal(overlay.services['docker-broker'], undefined);
  assert.equal(overlay.services['fleet-controller'].environment.FLEET_SKIP_MIGRATIONS, 'true');
  assert.equal(overlay.services['fleet-controller'].environment.PANEL_MAINTENANCE_ID, selected.id);
  assert.equal(runtime.image, image);
  assert.deepEqual(await portableStartupRuntime(directory, {id: fleet}, {execute}), runtime);
  await fs.writeFile(runtime.arguments[1], '{}');
  await assert.rejects(portableStartupRuntime(directory, {id: fleet}, {execute}), /override changed/);
  selected.error = true; await assert.rejects(portableStartupRuntime(directory, {id: fleet}, {execute}), /Inspect/); delete selected.error;
  volume.Labels['io.lobby-goblin.engine'] = 'foreign';
  const previous = calls.filter(v => v[0] === 'run').length;
  await assert.rejects(portableStartupRuntime(directory, {id: fleet}, {execute}), /another/);
  assert.equal(calls.filter(v => v[0] === 'run').length, previous);
});
