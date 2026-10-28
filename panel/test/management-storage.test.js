import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  managementStorageSlots,
  backupManagementStorage,
  verifyManagementSnapshot,
  restoreManagementStorage,
  activateAgentManagementStorage,
} from '../fleet/management-storage.js';
import {Accounts} from '../core/accounts.js';
import {hashPassword, checkPassword} from '../auth.js';
import {
  planStorageMigration,
  applyStorageMigration,
} from '../core/storage/migrations.js';
import {closeStorage} from '../core/storage/selection.js';

const fleet = 'a'.repeat(32),
  id = 'b'.repeat(32),
  instance = 'c'.repeat(32);
const request = {
  version: 1,
  id,
  fleet,
  instances: [{id: instance, game: 'arena'}],
  operation: 'backup',
  confirm: true,
  offline: true,
};
const operation = (name, extra = {}) => ({
  ...request,
  operation: name,
  ...extra,
});
async function fixture(t) {
  const base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-management-snapshot-')),
    ),
    storageRoot = path.join(base, 'storage'),
    artifactRoot = path.join(base, 'artifacts');
  await fs.mkdir(storageRoot);
  await fs.mkdir(artifactRoot, {mode: 0o700});
  const slots = managementStorageSlots(request);
  for (const slot of slots) await fs.mkdir(path.join(storageRoot, slot.id));
  async function write(relative, content) {
    const file = path.join(storageRoot, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, content, {mode: 0o600});
  }
  await write('host/.fleet-owner.json', JSON.stringify({fleet}));
  await write('host/registry.json', 'original registry bytes');
  for (const [slot, kind] of [
    ['broker-state', 'state'],
    ['broker-transport', 'transport'],
  ])
    await write(
      slot + '/.docker-broker-owner.json',
      JSON.stringify({version: 1, fleet, kind}),
    );
  await write('broker-state/capabilities.json', 'private capability bytes');
  await write('broker-transport/host/token', 'private host token');
  await write(
    'broker-transport/instances/' + instance + '/token',
    'private instance token',
  );
  await write(
    'broker-transport/socket/placeholder',
    'current socket directory remains outside recovery',
  );
  await write('web/auth/users.json', 'original accounts');
  await write('web/secrets/controller-token', 'private controller token');
  await write('controller-' + instance + '/jobs.json', 'original job bytes');
  await write(
    'updates-' + instance + '/native-job.json',
    'original native recovery bytes',
  );
  await write(
    'control-' + instance + '/controller-token',
    'private child token',
  );
  const world = path.join(base, 'world.bin');
  await fs.writeFile(world, 'world outside management authority');
  t.after(async () => {
    await closeStorage(path.join(storageRoot, 'web/auth'));
    await fs.rm(base, {recursive: true, force: true});
  });
  return {
    base,
    storageRoot,
    artifactRoot,
    slots,
    write,
    world,
    options: {storageRoot, artifactRoot},
    manifest: path.join(artifactRoot, id, 'snapshot/manifest.json'),
  };
}
test('metadata slots are derived from fleet ownership and exclude workload data, backups and the snapshot library', () => {
  const slots = managementStorageSlots(request);
  assert.equal(slots.length, 7);
  assert.ok(
    slots.every(
      (slot) =>
        slot.subpath === '' ||
        ['state', 'updates', 'control'].includes(slot.subpath),
    ),
  );
  assert.ok(
    !slots.some(
      (slot) =>
        /data|backups|library/.test(slot.volume) || slot.subpath === 'data',
    ),
  );
  for (const next of [
    {...request, fleet: 'foreign'},
    {...request, instances: [...request.instances, ...request.instances]},
    {...request, instances: [{id: instance, game: 'arena', path: '/world'}]},
  ])
    assert.throws(() => managementStorageSlots(next));
});
test('management snapshot and rollback preserve the detached coordinator journal outside metadata recovery', async t => {
  const f = await fixture(t);
  await f.write('broker-state/panel-updates/current.json', 'before update');
  const backup = await backupManagementStorage(request, f.options);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  assert.ok(manifest.slots.find(slot => slot.descriptor.kind === 'broker-state').entries.every(entry => !entry.path.startsWith('panel-updates')));
  await f.write('broker-state/panel-updates/current.json', 'live recovery authority');
  await f.write('broker-state/capabilities.json', 'failed replacement');
  await restoreManagementStorage(operation('restore', {manifestHash: backup.manifestHash}), f.options);
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'broker-state/panel-updates/current.json'), 'utf8'), 'live recovery authority');
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'broker-state/capabilities.json'), 'utf8'), 'private capability bytes');
});
test('legacy metadata rollback excludes broker slots and preserves live host update authority', async t => {
  const f = await fixture(t), legacy = {...request, profile: 'legacy'};
  assert.equal(managementStorageSlots(legacy).length, 5);
  assert.ok(managementStorageSlots(legacy).every(slot => !slot.kind.startsWith('broker')));
  await f.write('host/panel-updates/current.json', 'before');
  const backup = await backupManagementStorage(legacy, f.options);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  assert.equal(manifest.profile, 'legacy');
  assert.ok(manifest.slots.find(slot => slot.descriptor.kind === 'host').entries.every(entry => !entry.path.startsWith('panel-updates')));
  await f.write('host/panel-updates/current.json', 'live recovery authority');
  await f.write('host/registry.json', 'failed replacement');
  await restoreManagementStorage({...legacy, operation: 'restore', manifestHash: backup.manifestHash}, f.options);
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'host/panel-updates/current.json'), 'utf8'), 'live recovery authority');
  assert.equal(await fs.readFile(path.join(f.storageRoot, 'host/registry.json'), 'utf8'), 'original registry bytes');
  assert.equal(await fs.readFile(f.world, 'utf8'), 'world outside management authority');
});
test('private snapshots restore exact management bytes and remove failed-version metadata without touching world or socket data', async (t) => {
  const f = await fixture(t),
    backup = await backupManagementStorage(request, f.options);
  assert.equal(backup.slots, 7);
  assert.match(backup.manifestHash, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes('private controller token'));
  for (const slot of f.slots)
    await f.write(slot.id + '/new-version.json', 'new failed-version state');
  await f.write('web/auth/users.json', 'failed-version accounts');
  await f.write(
    'updates-' + instance + '/native-job.json',
    'failed-version journal',
  );
  await f.write(
    'broker-transport/socket/placeholder',
    'current socket sentinel',
  );
  const restore = operation('restore', {manifestHash: backup.manifestHash});
  await restoreManagementStorage(restore, f.options);
  assert.equal(
    await fs.readFile(path.join(f.storageRoot, 'web/auth/users.json'), 'utf8'),
    'original accounts',
  );
  assert.equal(
    await fs.readFile(
      path.join(f.storageRoot, 'updates-' + instance + '/native-job.json'),
      'utf8',
    ),
    'original native recovery bytes',
  );
  for (const slot of f.slots)
    await assert.rejects(
      () => fs.access(path.join(f.storageRoot, slot.id, 'new-version.json')),
      {code: 'ENOENT'},
    );
  assert.equal(
    await fs.readFile(f.world, 'utf8'),
    'world outside management authority',
  );
  assert.equal(
    await fs.readFile(
      path.join(f.storageRoot, 'broker-transport/socket/placeholder'),
      'utf8',
    ),
    'current socket sentinel',
  );
  assert.equal(
    (await verifyManagementSnapshot(operation('verify'), f.options))
      .manifestHash,
    backup.manifestHash,
  );
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(f.manifest)).mode & 0o777, 0o600);
});
test('payload corruption and path traversal fail before any metadata replacement', async (t) => {
  const f = await fixture(t),
    backup = await backupManagementStorage(request, f.options),
    manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  await f.write('host/do-not-remove', 'unchanged after rejected recovery');
  const entry = manifest.slots
      .flatMap((slot) => slot.entries)
      .find((entry) => entry.kind === 'file'),
    blob = path.join(path.dirname(f.manifest), 'blobs', entry.blob),
    original = await fs.readFile(blob);
  await fs.writeFile(blob, 'corrupt payload');
  await assert.rejects(
    () =>
      restoreManagementStorage(
        operation('restore', {manifestHash: backup.manifestHash}),
        f.options,
      ),
    /payload changed/,
  );
  assert.equal(
    await fs.readFile(path.join(f.storageRoot, 'host/do-not-remove'), 'utf8'),
    'unchanged after rejected recovery',
  );
  await fs.writeFile(blob, original);
  entry.path = '../world.bin';
  const edited = JSON.stringify(manifest, null, 2);
  await fs.writeFile(f.manifest, edited);
  const digest = crypto.createHash('sha256').update(edited).digest('hex');
  await assert.rejects(
    () =>
      restoreManagementStorage(
        operation('restore', {manifestHash: digest}),
        f.options,
      ),
    /snapshot entry/,
  );
  assert.equal(
    await fs.readFile(path.join(f.storageRoot, 'host/do-not-remove'), 'utf8'),
    'unchanged after rejected recovery',
  );
  assert.equal(
    await fs.readFile(f.world, 'utf8'),
    'world outside management authority',
  );
});
test('partial metadata restoration can be explicitly resumed; a completed restoration cannot overwrite later changes', async (t) => {
  const f = await fixture(t),
    backup = await backupManagementStorage(request, f.options),
    restore = operation('restore', {manifestHash: backup.manifestHash});
  await f.write('host/new-version.json', 'failed update');
  await f.write('web/new-version.json', 'failed update');
  await assert.rejects(
    () =>
      restoreManagementStorage(restore, {
        ...f.options,
        checkpoint: async () => {
          throw Error('Operator helper interrupted');
        },
      }),
    /interrupted/,
  );
  await assert.rejects(
    () => fs.access(path.join(f.artifactRoot, id, 'restore-complete.json')),
    {code: 'ENOENT'},
  );
  await restoreManagementStorage(restore, f.options);
  const file = path.join(f.storageRoot, 'host/registry.json'),
    before = (await fs.stat(file)).mtimeMs;
  await restoreManagementStorage(restore, f.options);
  assert.equal(
    (await fs.stat(file)).mtimeMs,
    before,
    'Completed recovery verifies rather than rewriting data.',
  );
  await f.write('host/post-recovery-change', 'new legitimate state');
  await assert.rejects(
    () => restoreManagementStorage(restore, f.options),
    /differs/,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.storageRoot, 'host/post-recovery-change'),
      'utf8',
    ),
    'new legitimate state',
  );
});
test('backup rejects links, retained leases, foreign ownership and missing confirmation before publication', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => backupManagementStorage({...request, offline: false}, f.options),
    /writers/,
  );
  const link = path.join(f.storageRoot, 'host/unreviewed');
  await fs.symlink(f.world, link);
  await assert.rejects(
    () => backupManagementStorage(request, f.options),
    /links/,
  );
  await fs.rm(link);
  await fs.mkdir(path.join(f.storageRoot, 'host/.panel-storage-lock'));
  await assert.rejects(
    () => backupManagementStorage(request, f.options),
    /lease/,
  );
  await fs.rm(path.join(f.storageRoot, 'host/.panel-storage-lock'), {
    recursive: true,
  });
  await f.write(
    'host/.fleet-owner.json',
    JSON.stringify({fleet: 'd'.repeat(32)}),
  );
  await assert.rejects(
    () => backupManagementStorage(request, f.options),
    /another fleet/,
  );
  await assert.rejects(() => fs.access(f.manifest), {code: 'ENOENT'});
  assert.equal(
    await fs.readFile(f.world, 'utf8'),
    'world outside management authority',
  );
});
test('selected transactional accounts survive raw offline management restoration with their original identities and revisions', async (t) => {
  const f = await fixture(t),
    root = path.join(f.storageRoot, 'web/auth');
  await f.write(
    'web/auth/users.json',
    JSON.stringify({
      Owner: {...hashPassword('fixture original password'), role: 'admin'},
      Member: {
        ...hashPassword('fixture member password'),
        role: 'member',
        grants: {standalone: ['server.view']},
        accessRevision: 7,
      },
    }),
  );
  await applyStorageMigration(await planStorageMigration(root, 'accounts'), {
    confirm: true,
    offline: true,
  });
  await closeStorage(root);
  const backup = await backupManagementStorage(request, f.options),
    accounts = new Accounts(root);
  await accounts.update({
    username: 'Member',
    operation: 'grants',
    revision: 7,
    grants: {standalone: ['server.view', 'logs.read']},
    confirm: true,
  });
  await closeStorage(root);
  await restoreManagementStorage(
    operation('restore', {manifestHash: backup.manifestHash}),
    f.options,
  );
  const users = await new Accounts(root).users();
  assert.ok(checkPassword('fixture original password', users.Owner));
  assert.equal(users.Member.accessRevision, 7);
  assert.deepEqual(users.Member.grants, {standalone: ['server.view']});
  await closeStorage(root);
  await activateAgentManagementStorage(operation('activate-agent'), f.options);
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(f.storageRoot, 'web/management-activation.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.id, id);
  assert.equal(receipt.activated, true);
  assert.equal(
    await fs.readFile(f.world, 'utf8'),
    'world outside management authority',
  );
});

test('metadata snapshots retain legacy history repair evidence through rollback',async t=>{
  const f=await fixture(t),relative='host/migration-history-repairs/'+'a'.repeat(64)+'.json';
  const evidence=JSON.stringify({version:1,registryHash:'a'.repeat(64),registry:{version:1,servers:[],snapshots:[],jobs:[]},changes:[]});
  await f.write(relative,evidence);
  const backup=await backupManagementStorage(request,f.options);
  await f.write(relative,'failed replacement');
  await restoreManagementStorage(operation('restore',{manifestHash:backup.manifestHash}),f.options);
  assert.equal(await fs.readFile(path.join(f.storageRoot,relative),'utf8'),evidence);
});
