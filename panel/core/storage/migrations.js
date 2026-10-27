import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../../common.js';
import {releaseSettings} from '../release-settings.js';
import {SqliteDocumentStore} from './sqlite-store.js';
import {accountDirectory} from './document-repository.js';
import {
  auditHistory,
  jobHistory,
  hostRegistry,
  configurationRecord,
  remoteRegistry,
} from './state-repositories.js';
import {selectedStorage, storageMarker} from './selection.js';
import {groupDocuments, storageGroupManifest} from './groups.js';
import {withStorageLock} from './coordination.js';
import {
  regularFile,
  parseStorageJSON,
  publishJSON,
  syncDirectory,
  markerName,
  databaseName,
} from './files.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const profiles = {
  accounts: [
    {file: 'release-checks.json', namespace: 'configuration', key: 'release-checks', schemaVersion: 1, decode: releaseSettings},
    {
      file: 'users.json',
      namespace: 'accounts',
      key: 'directory',
      schemaVersion: 2,
      decode: accountDirectory,
    },
    {
      file: 'audit.json',
      namespace: 'audit',
      key: 'history',
      schemaVersion: 1,
      decode: auditHistory,
    },
  ],
  controller: [
    {
      file: 'jobs.json',
      namespace: 'operations',
      key: 'jobs',
      schemaVersion: 1,
      decode: jobHistory,
    },
    {
      file: 'audit.json',
      namespace: 'audit',
      key: 'history',
      schemaVersion: 1,
      decode: auditHistory,
    },
    {
      file: 'schedule.json',
      namespace: 'configuration',
      key: 'schedule',
      schemaVersion: 1,
      decode: configurationRecord,
    },
    {
      file: 'backup-retention.json',
      namespace: 'configuration',
      key: 'backup-retention',
      schemaVersion: 1,
      decode: configurationRecord,
    },
  ],
  host: [
    {
      file: 'remote-hosts.json',
      namespace: 'registry',
      key: 'remote-hosts',
      schemaVersion: 1,
      decode: remoteRegistry,
    },
    {
      file: 'registry.json',
      namespace: 'registry',
      key: 'host',
      schemaVersion: 1,
      decode: hostRegistry,
    },
    {
      file: 'audit.json',
      namespace: 'audit',
      key: 'history',
      schemaVersion: 1,
      decode: auditHistory,
    },
    {
      file: 'host-setup-jobs.json',
      namespace: 'operations',
      key: 'host-setup',
      schemaVersion: 1,
      decode: jobHistory,
    },
  ],
};
const planIdentity = (plan) =>
  hash(
    JSON.stringify({
      version: plan.version,
      root: plan.root,
      profile: plan.profile,
      files: plan.files,
      extensions: plan.extensions || [],
    }),
  );
export function profileDocuments(profile) {
  assert(Object.hasOwn(profiles, profile), 'Unknown panel storage profile.');
  return profiles[profile];
}
export async function planStorageMigration(root, profile, {groups = []} = {}) {
  assert(Object.hasOwn(profiles, profile), 'Unknown panel storage profile.');
  const extensions = storageGroupManifest(groups).filter(
    (group) => group.profile === profile,
  );
  const canonical = await fs.realpath(root);
  const marker = await regularFile(path.join(canonical, markerName), {
    optional: true,
    max: 1024 * 1024,
  });
  if (marker) {
    const selected = storageMarker(parseStorageJSON(marker));
    assert(
      selected.profile === profile,
      'Selected storage belongs to another management profile.',
      409,
    );
    const store = await selectedStorage(canonical);
    assert(
      JSON.stringify(parseStorageJSON(store.metadata.extensions || '[]')) ===
        JSON.stringify(extensions),
      'Selected storage requires its original registered module storage contracts.',
      409,
    );
    return {
      version: 1,
      root: canonical,
      profile,
      selected,
      files: [],
      extensions,
    };
  }
  const files = [];
  for (const descriptor of [
    ...profiles[profile],
    ...(await groupDocuments(canonical, profile, groups)),
  ]) {
    const bytes = await regularFile(path.join(canonical, descriptor.file), {
      optional: true,
    });
    if (!bytes) continue;
    const value = parseStorageJSON(bytes);
    if (descriptor.decode) descriptor.decode(value);
    files.push({
      file: descriptor.file,
      namespace: descriptor.namespace,
      key: descriptor.key,
      schemaVersion: descriptor.schemaVersion,
      sha256: hash(bytes),
    });
  }
  const plan = {version: 1, root: canonical, profile, files, extensions};
  return {...plan, id: planIdentity(plan)};
}
async function sameInputs(plan, groups) {
  const current = await planStorageMigration(plan.root, plan.profile, {groups});
  assert(
    !current.selected && current.id === plan.id,
    'Panel state changed after storage review. Create a new plan before migrating.',
    409,
  );
}
// This internal migration API is intentionally offline. It does not stop a
// service or game. Callers must stop management writers before activation;
// existing JSON and all application/world files remain untouched.
export async function applyStorageMigration(
  plan,
  {confirm = false, offline = false, publish = publishJSON, groups = []} = {},
) {
  assert(
    confirm === true && offline === true,
    'Confirm that management writers are stopped before migrating panel storage.',
  );
  assert(
    plan.version === 1 &&
      Object.hasOwn(profiles, plan.profile) &&
      plan.id === planIdentity(plan),
    'Invalid storage migration plan.',
  );
  return withStorageLock(plan.root, 'migration', () =>
    applyLocked(plan, {publish, groups}),
  );
}
async function applyLocked(plan, {publish, groups}) {
  const extensions = storageGroupManifest(groups).filter(
    (group) => group.profile === plan.profile,
  );
  assert(
    JSON.stringify(plan.extensions || []) === JSON.stringify(extensions),
    'Storage module contracts changed after migration review.',
    409,
  );
  const markerFile = path.join(plan.root, markerName),
    existing = await regularFile(markerFile, {
      optional: true,
      max: 1024 * 1024,
    });
  if (existing) {
    const marker = storageMarker(parseStorageJSON(existing));
    assert(
      marker.planHash === plan.id && marker.profile === plan.profile,
      'Another storage migration is already selected.',
      409,
    );
    const store = await selectedStorage(plan.root);
    assert(
      JSON.stringify(parseStorageJSON(store.metadata.extensions || '[]')) ===
        JSON.stringify(extensions),
      'Selected storage module contracts changed. Preserve the database for review.',
      503,
    );
    return marker;
  }
  await sameInputs(plan, groups);
  const target = path.join(plan.root, databaseName),
    prepared = await fs.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  let identity;
  if (prepared) {
    const store = new SqliteDocumentStore(target);
    try {
      assert(
        store.metadata.planHash === plan.id &&
          store.metadata.profile === plan.profile &&
          JSON.stringify(
            parseStorageJSON(store.metadata.extensions || '[]'),
          ) === JSON.stringify(extensions),
        'A prepared database belongs to another plan. Preserve it for explicit recovery.',
        409,
      );
      identity = store.metadata.identity;
    } finally {
      store.close();
    }
  } else {
    identity = crypto.randomUUID();
    const staging = target + '.' + identity + '.preparing';
    let store;
    try {
      store = new SqliteDocumentStore(staging, {
        create: true,
        identity,
        profile: plan.profile,
        planHash: plan.id,
        extensions,
      });
      const changes = [];
      const descriptors = [
        ...profiles[plan.profile],
        ...(await groupDocuments(plan.root, plan.profile, groups)),
      ];
      for (const reviewed of plan.files) {
        const descriptor = descriptors.find(
            (item) => item.file === reviewed.file,
          ),
          bytes = await regularFile(path.join(plan.root, descriptor.file));
        assert(
          hash(bytes) === reviewed.sha256,
          'A source document changed during storage migration.',
          409,
        );
        const value = parseStorageJSON(bytes);
        changes.push({
          namespace: descriptor.namespace,
          key: descriptor.key,
          schemaVersion: descriptor.schemaVersion,
          expectedRevision: 0,
          value: descriptor.decode ? descriptor.decode(value) : value,
        });
      }
      if (changes.length) store.commit(changes);
      store.close();
      store = null;
      await sameInputs(plan, groups);
      await fs.link(staging, target);
      await fs.unlink(staging);
      await syncDirectory(plan.root);
    } catch (error) {
      store?.close();
      await fs.unlink(staging).catch(() => {});
      await fs.unlink(staging + '-journal').catch(() => {});
      throw error;
    }
  }
  await sameInputs(plan, groups);
  const marker = {
    version: 1,
    backend: 'sqlite',
    identity,
    profile: plan.profile,
    planHash: plan.id,
    activatedAt: new Date().toISOString(),
  };
  await publish(markerFile, marker);
  return marker;
}
