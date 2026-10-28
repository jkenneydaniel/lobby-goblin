import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {assert} from '../common.js';
import {validId, resources} from '../core/instance.js';
import {
  regularFile,
  parseStorageJSON,
  publishJSON,
  syncDirectory,
} from '../core/storage/files.js';
import {definitionFingerprint} from '../core/application-services.js';
import {freezeDefinition} from '../core/definition-data.js';
import {writeManagementActivation} from '../core/management-maintenance.js';
import {RegistryRepository} from '../core/storage/state-repositories.js';

const maxBytes = 512 * 1024 ** 2,
  maxEntries = 20000;
const transportSelection = ['.docker-broker-owner.json', 'host', 'instances'];
const identifier = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const relative = (value) =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  !/[\x00-\x1f\x7f\\]/.test(value) &&
  !path.posix.isAbsolute(value) &&
  (value === '' ||
    value.split('/').every((part) => part && part !== '.' && part !== '..'));
const sum = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Fixed core metadata mounts. Workloads' data/backups and the immutable snapshot
// library are deliberately outside this helper's filesystem authority.
export function managementStorageSlots(input) {
  const {fleet, instances} = freezeDefinition(input);
  assert(
    validId(fleet) &&
      Array.isArray(instances) &&
      instances.length <= 64 &&
      new Set(instances.map((item) => item?.id)).size === instances.length,
    'Invalid management storage ownership.',
  );
  const prefix = 'lobby-goblin-fleet-' + fleet;
  const slots = [
    {id: 'host', kind: 'host', volume: prefix + '-state', subpath: ''},
    {id: 'web', kind: 'web', volume: prefix + '-web', subpath: ''},
    {
      id: 'broker-state',
      kind: 'broker-state',
      volume: prefix + '-broker-state',
      subpath: '',
    },
    {
      id: 'broker-transport',
      kind: 'broker-transport',
      volume: prefix + '-broker-transport',
      subpath: '',
    },
  ];
  for (const instance of instances) {
    assert(
      instance &&
        Object.keys(instance).every((key) => ['id', 'game'].includes(key)) &&
        validId(instance.id) &&
        identifier(instance.game),
      'Invalid management instance storage.',
    );
    for (const [kind, subpath] of [
      ['controller', 'state'],
      ['updates', 'updates'],
      ['control', 'control'],
    ])
      slots.push({
        id: kind + '-' + instance.id,
        kind,
        instance: instance.id,
        volume: resources(fleet, instance.id, instance.game).volume,
        subpath,
      });
  }
  return freezeDefinition(slots);
}
function requestScope(request) {
  assert(
    request &&
      request.version === 1 &&
      validId(request.id) &&
      Object.keys(request).every((key) =>
        [
          'version',
          'id',
          'fleet',
          'instances',
          'operation',
          'confirm',
          'offline',
          'manifestHash',
          'registryHash',
        ].includes(key),
      ),
    'Invalid management storage request.',
  );
  assert(
    ['backup', 'verify', 'restore', 'activate-agent'].includes(
      request.operation,
    ),
    'Unsupported management storage operation.',
  );
  if (request.operation !== 'verify')
    assert(
      request.confirm === true && request.offline === true,
      'Confirm management writers are stopped or held before changing management storage.',
    );
  if (request.operation === 'restore')
    assert(
      /^[a-f0-9]{64}$/.test(request.manifestHash || ''),
      'Restore needs the recorded snapshot manifest identity.',
    );
  assert(request.registryHash === undefined || /^[a-f0-9]{64}$/.test(request.registryHash), 'Invalid reviewed registry identity.');
  return managementStorageSlots(request);
}
async function canonical(directory) {
  assert(
    (await fs.realpath(directory)) === directory,
    'Management storage roots cannot be symbolic links.',
  );
  const stat = await fs.lstat(directory);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Management storage needs directory mounts.',
  );
  return stat;
}
const metadata = (stat) => ({
  mode: stat.mode & 0o777,
  uid: stat.uid,
  gid: stat.gid,
});
const sameStat = (before, after) =>
  [
    'dev',
    'ino',
    'size',
    'mtimeMs',
    'ctimeMs',
    'uid',
    'gid',
    'mode',
    'nlink',
  ].every((key) => before[key] === after[key]);
async function streamFile(source, destination, {expected, device} = {}) {
  const before = await fs.lstat(source);
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= maxBytes &&
      (device === undefined || before.dev === device),
    'Management snapshots need bounded regular files, without links or nested mounts.',
  );
  let input, output;
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await input.stat();
    assert(
      sameStat(before, opened),
      'Management storage changed while opening a file.',
      409,
    );
    if (destination) output = await fs.open(destination, 'wx', 0o600);
    for await (const chunk of input.createReadStream({autoClose: false})) {
      size += chunk.length;
      assert(size <= maxBytes, 'Management snapshot file is too large.');
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat(),
      digest = hash.digest('hex');
    assert(
      size === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      'Management storage changed during the snapshot.',
      409,
    );
    assert(
      !expected || (size === expected.size && digest === expected.sha256),
      'Management snapshot payload changed. Preserve it for review.',
      409,
    );
    if (output) await output.sync();
    return {size, sha256: digest};
  } finally {
    await input?.close();
    await output?.close();
  }
}
async function walk(slot, root, visit) {
  const mounted = await canonical(root);
  async function descend(name) {
    // Detached coordinator journals remain live while management is stopped.
    // They are recovery authority, not management metadata to roll back.
    if (slot.kind === 'broker-state' && name === 'panel-updates') return;
    assert(relative(name), 'Invalid management snapshot path.');
    const location = name ? path.join(root, name) : root,
      stat = await fs.lstat(location);
    assert(
      !stat.isSymbolicLink() &&
        stat.dev === mounted.dev &&
        (stat.mode & 0o7000) === 0 &&
        (stat.isDirectory() || stat.isFile()),
      'Management snapshots cannot traverse links, special files, special permissions or nested mounts.',
    );
    if (stat.isFile())
      assert(
        stat.nlink === 1,
        'Management snapshots cannot adopt linked files.',
      );
    assert(
      path.basename(name) !== '.panel-storage-lock',
      'Review the retained storage lease before management maintenance.',
      409,
    );
    await visit(name, stat, location, mounted.dev);
    if (stat.isDirectory())
      for (const entry of (await fs.readdir(location)).sort())
        await descend(name ? name + '/' + entry : entry);
    assert(
      sameStat(stat, await fs.lstat(location)),
      'Management storage changed during traversal.',
      409,
    );
  }
  if (slot.kind === 'broker-transport') {
    assert(
      (mounted.mode & 0o7000) === 0,
      'Management roots cannot use special permissions.',
    );
    await canonical(path.join(root, 'socket'));
    assert(
      (await fs.readdir(root)).every(
        (name) => transportSelection.includes(name) || name === 'socket',
      ),
      'Unreviewed broker transport files require manual review.',
    );
    await visit('', mounted, root, mounted.dev);
    for (const name of transportSelection) await descend(name);
    assert(
      sameStat(mounted, await fs.lstat(root)),
      'Broker transport changed during traversal.',
      409,
    );
  } else await descend('');
}
async function initialOwner(slot, root, fleet) {
  if (slot.kind === 'host') {
    const owner = parseStorageJSON(
      await regularFile(path.join(root, '.fleet-owner.json'), {max: 2048}),
    );
    assert(
      owner?.fleet === fleet,
      'Host management metadata belongs to another fleet.',
      409,
    );
  }
  if (['broker-state', 'broker-transport'].includes(slot.kind)) {
    const owner = parseStorageJSON(
      await regularFile(path.join(root, '.docker-broker-owner.json'), {
        max: 2048,
      }),
    );
    assert(
      owner?.version === 1 &&
        owner.fleet === fleet &&
        owner.kind === (slot.kind === 'broker-state' ? 'state' : 'transport'),
      'Broker management metadata belongs to another fleet.',
      409,
    );
  }
}
function locations(request, artifactRoot) {
  return {
    job: path.join(artifactRoot, request.id),
    snapshot: path.join(artifactRoot, request.id, 'snapshot'),
  };
}
async function snapshotManifest(request, artifactRoot) {
  const slots = requestScope(request),
    {snapshot} = locations(request, artifactRoot);
  await canonical(artifactRoot);
  await canonical(path.dirname(snapshot));
  await canonical(snapshot);
  await canonical(path.join(snapshot, 'blobs'));
  const bytes = await regularFile(path.join(snapshot, 'manifest.json'), {
      max: 8 * 1024 ** 2,
    }),
    manifest = parseStorageJSON(bytes),
    digest = sum(bytes);
  assert(
    manifest?.version === 1 &&
      manifest.complete === true &&
      manifest.id === request.id &&
      manifest.fleet === request.fleet &&
      definitionFingerprint(manifest.instances) ===
        definitionFingerprint(request.instances) &&
      Array.isArray(manifest.slots) &&
      manifest.slots.length === slots.length &&
      Object.keys(manifest).every((key) =>
        ['version', 'complete', 'id', 'fleet', 'instances', 'slots'].includes(
          key,
        ),
      ),
    'Management snapshot ownership changed.',
    409,
  );
  assert(
    !request.manifestHash || request.manifestHash === digest,
    'The management snapshot manifest changed.',
    409,
  );
  let count = 0,
    total = 0;
  const blobs = new Set();
  for (const [index, slot] of slots.entries()) {
    const saved = manifest.slots[index];
    assert(
      definitionFingerprint(saved.descriptor) === definitionFingerprint(slot) &&
        Array.isArray(saved.entries) &&
        saved.entries.length > 0 &&
        Object.keys(saved).every((key) =>
          ['descriptor', 'entries'].includes(key),
        ),
      'Management snapshot scope changed.',
      409,
    );
    const paths = new Map();
    for (const entry of saved.entries) {
      assert(
        ++count <= maxEntries &&
          entry &&
          relative(entry.path) &&
          (slot.kind !== 'broker-state' || entry.path.split('/')[0] !== 'panel-updates') &&
          !entry.path.split('/').includes('.panel-storage-lock') &&
          !paths.has(entry.path) &&
          ['directory', 'file'].includes(entry.kind) &&
          Number.isInteger(entry.mode) &&
          entry.mode >= 0 &&
          entry.mode <= 0o777 &&
          ['uid', 'gid'].every(
            (key) =>
              Number.isInteger(entry[key]) &&
              entry[key] >= 0 &&
              entry[key] <= 0xffffffff,
          ),
        'Invalid management snapshot entry.',
      );
      assert(
        Object.keys(entry).every((key) =>
          [
            'path',
            'kind',
            'mode',
            'uid',
            'gid',
            ...(entry.kind === 'file' ? ['blob', 'size', 'sha256'] : []),
          ].includes(key),
        ),
        'Unknown management snapshot entry field.',
      );
      if (slot.kind === 'broker-transport')
        assert(
          entry.path === '' ||
            transportSelection.some(
              (name) =>
                entry.path === name || entry.path.startsWith(name + '/'),
            ),
          'Snapshot contains an unreviewed broker transport path.',
        );
      if (entry.kind === 'file') {
        assert(
          /^[0-9]{6}\.bin$/.test(entry.blob) &&
            !blobs.has(entry.blob) &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0 &&
            /^[a-f0-9]{64}$/.test(entry.sha256),
          'Invalid management snapshot payload.',
        );
        blobs.add(entry.blob);
        total += entry.size;
        assert(
          total <= maxBytes,
          'Management snapshot exceeds its byte limit.',
        );
        await streamFile(path.join(snapshot, 'blobs', entry.blob), null, {
          expected: entry,
        });
      }
      paths.set(entry.path, entry.kind);
    }
    assert(
      paths.get('') === 'directory' &&
        [...paths.keys()].every(
          (name) =>
            name === '' ||
            paths.get(
              path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name),
            ) === 'directory',
        ),
      'Management snapshot directory structure is incomplete.',
    );
  }
  return {manifest, digest, slots, total, snapshot};
}
export async function backupManagementStorage(
  request,
  {storageRoot = '/storage', artifactRoot = '/artifact'} = {},
) {
  request = freezeDefinition(request);
  assert(request.operation === 'backup', 'Choose the backup operation.');
  const slots = requestScope(request);
  await canonical(storageRoot);
  await canonical(artifactRoot);
  if (request.registryHash !== undefined) assert(
    definitionFingerprint((await new RegistryRepository(path.join(storageRoot, 'host')).read()).value) === request.registryHash,
    'The registry changed after review. Preserve the update and inspect it before continuing.', 409);
  assert(
    storageRoot !== artifactRoot &&
      !artifactRoot.startsWith(storageRoot + '/') &&
      !storageRoot.startsWith(artifactRoot + '/'),
    'Management storage and snapshot artifacts need separate roots.',
  );
  for (const slot of slots) {
    await initialOwner(slot, path.join(storageRoot, slot.id), request.fleet);
    await walk(slot, path.join(storageRoot, slot.id), async () => {});
  } // reject unsafe roots before writing any archive
  const {job, snapshot} = locations(request, artifactRoot);
  const existing = await regularFile(path.join(snapshot, 'manifest.json'), {optional: true, max: 8 * 1024 ** 2});
  if (existing) return {...await verifyManagementSnapshot({...request, operation: 'verify'}, {artifactRoot}), operation: 'backup'};
  await fs.mkdir(job, {mode: 0o700});
  await fs.mkdir(snapshot, {mode: 0o700});
  await fs.mkdir(path.join(snapshot, 'blobs'), {mode: 0o700});
  const manifest = {
    version: 1,
    complete: true,
    id: request.id,
    fleet: request.fleet,
    instances: request.instances,
    slots: [],
  };
  let count = 0,
    total = 0,
    serial = 0;
  for (const slot of slots) {
    const entries = [];
    await walk(
      slot,
      path.join(storageRoot, slot.id),
      async (name, stat, location, device) => {
        assert(
          ++count <= maxEntries,
          'Management snapshot has too many entries.',
        );
        const entry = {
          path: name,
          kind: stat.isDirectory() ? 'directory' : 'file',
          ...metadata(stat),
        };
        if (stat.isFile()) {
          entry.blob = String(++serial).padStart(6, '0') + '.bin';
          Object.assign(
            entry,
            await streamFile(
              location,
              path.join(snapshot, 'blobs', entry.blob),
              {device},
            ),
          );
          total += entry.size;
          assert(
            total <= maxBytes,
            'Management snapshot exceeds its byte limit.',
          );
        }
        entries.push(entry);
      },
    );
    manifest.slots.push({descriptor: slot, entries});
  }
  assert(
    Buffer.byteLength(JSON.stringify(manifest, null, 2)) <= 8 * 1024 ** 2,
    'Management snapshot manifest is too large.',
  );
  await syncDirectory(path.join(snapshot, 'blobs'));
  await publishJSON(path.join(snapshot, 'manifest.json'), manifest);
  await syncDirectory(job);
  await syncDirectory(artifactRoot);
  const verified = await snapshotManifest(
    {...request, operation: 'verify'},
    artifactRoot,
  );
  return {
    version: 1,
    operation: 'backup',
    id: request.id,
    manifestHash: verified.digest,
    slots: slots.length,
    bytes: total,
  };
}
export async function verifyManagementSnapshot(
  request,
  {artifactRoot = '/artifact'} = {},
) {
  request = freezeDefinition(request);
  assert(request.operation === 'verify', 'Choose snapshot verification.');
  const result = await snapshotManifest(request, artifactRoot);
  return {
    version: 1,
    operation: 'verify',
    id: request.id,
    manifestHash: result.digest,
    slots: result.slots.length,
    bytes: result.total,
  };
}
async function assertRestored(storageRoot, result) {
  for (const [index, slot] of result.slots.entries()) {
    const expected = new Map(
      result.manifest.slots[index].entries.map((entry) => [entry.path, entry]),
    );
    await walk(
      slot,
      path.join(storageRoot, slot.id),
      async (name, stat, location, device) => {
        const entry = expected.get(name);
        assert(
          entry &&
            entry.kind === (stat.isDirectory() ? 'directory' : 'file') &&
            ['mode', 'uid', 'gid'].every(
              (key) => metadata(stat)[key] === entry[key],
            ),
          'Restored management metadata differs from its snapshot.',
          409,
        );
        if (stat.isFile())
          await streamFile(location, null, {expected: entry, device});
        expected.delete(name);
      },
    );
    assert(
      expected.size === 0,
      'Restored management files are incomplete.',
      409,
    );
  }
}
export async function restoreManagementStorage(
  request,
  {
    storageRoot = '/storage',
    artifactRoot = '/artifact',
    checkpoint = async () => {},
  } = {},
) {
  request = freezeDefinition(request);
  assert(request.operation === 'restore', 'Choose the restore operation.');
  requestScope(request);
  await canonical(storageRoot);
  const result = await snapshotManifest(request, artifactRoot),
    {job} = locations(request, artifactRoot);
  for (const slot of result.slots)
    await canonical(path.join(storageRoot, slot.id));
  const completed = await regularFile(path.join(job, 'restore-complete.json'), {
    optional: true,
    max: 4096,
  });
  if (completed) {
    const receipt = parseStorageJSON(completed);
    assert(
      receipt.version === 1 &&
        receipt.operation === 'restore' &&
        receipt.id === request.id &&
        receipt.manifestHash === result.digest &&
        receipt.slots === result.slots.length &&
        receipt.bytes === result.total &&
        Object.keys(receipt).every((key) =>
          [
            'version',
            'operation',
            'id',
            'manifestHash',
            'slots',
            'bytes',
          ].includes(key),
        ),
      'Recovery receipt changed.',
      409,
    );
    await assertRestored(storageRoot, result);
    return receipt;
  }
  // Every blob and path has been checked before the first destructive metadata
  // write. A failure retains the archive and leaves management services stopped.
  for (const [index, slot] of result.slots.entries()) {
    const root = path.join(storageRoot, slot.id),
      entries = result.manifest.slots[index].entries;
    const selected = (await fs.readdir(root)).filter(
      (name) => (slot.kind !== 'broker-transport' || name !== 'socket') &&
        (slot.kind !== 'broker-state' || name !== 'panel-updates'),
    );
    for (const name of selected)
      await fs.rm(path.join(root, name), {recursive: true, force: true});
    const directories = entries
      .filter((entry) => entry.kind === 'directory')
      .sort(
        (a, b) =>
          a.path.split('/').length - b.path.split('/').length ||
          a.path.localeCompare(b.path),
      );
    for (const entry of directories)
      if (entry.path)
        await fs.mkdir(path.join(root, entry.path), {mode: 0o700});
    for (const entry of entries.filter((entry) => entry.kind === 'file')) {
      const destination = path.join(root, entry.path);
      await streamFile(
        path.join(result.snapshot, 'blobs', entry.blob),
        destination,
        {expected: entry},
      );
      const handle = await fs.open(
        destination,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.chown(entry.uid, entry.gid);
        await handle.chmod(entry.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const entry of directories.reverse()) {
      const directory = entry.path ? path.join(root, entry.path) : root;
      await fs.chown(directory, entry.uid, entry.gid);
      await fs.chmod(directory, entry.mode);
      await syncDirectory(directory);
    }
    await checkpoint({phase: 'restored-slot', slot: slot.id});
  }
  await assertRestored(storageRoot, result);
  const receipt = {
    version: 1,
    operation: 'restore',
    id: request.id,
    manifestHash: result.digest,
    slots: result.slots.length,
    bytes: result.total,
  };
  await publishJSON(path.join(job, 'restore-complete.json'), receipt);
  return receipt;
}
export async function activateAgentManagementStorage(
  request,
  {storageRoot = '/storage'} = {},
) {
  request = freezeDefinition(request);
  assert(request.operation === 'activate-agent', 'Choose agent activation.');
  requestScope(request);
  await canonical(storageRoot);
  await writeManagementActivation(path.join(storageRoot, 'web'), request.id);
  return {version: 1, operation: 'activate-agent', id: request.id};
}
