import crypto from 'node:crypto';
import {assertJobIdentities} from '../operation-identity.js';
import {assert} from '../../common.js';
import {DocumentRepository} from './document-repository.js';

export const auditGenesis = '0'.repeat(64);
export const auditDigest = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const emptyAuditHistory = {
  version: 1,
  anchor: {sequence: 0, hash: auditGenesis},
  events: [],
};

export function auditHistory(value) {
  assert(
    value?.version === 1 &&
      Array.isArray(value.events) &&
      Number.isSafeInteger(value.anchor?.sequence) &&
      value.anchor.sequence >= 0 &&
      /^[a-f0-9]{64}$/.test(value.anchor.hash),
    'Audit history is invalid. Preserve it for review.',
    503,
  );
  let previous = value.anchor.hash,
    sequence = value.anchor.sequence;
  for (const event of value.events) {
    assert(
      event && typeof event === 'object' && !Array.isArray(event),
      'Audit history is invalid. Preserve it for review.',
      503,
    );
    const {hash, ...entry} = event;
    assert(
      Number.isSafeInteger(entry.sequence) &&
        entry.sequence === sequence + 1 &&
        entry.previous === previous &&
        auditDigest(entry) === hash,
      'Audit history integrity check failed. Preserve it for review.',
      503,
    );
    previous = hash;
    sequence = entry.sequence;
  }
  return value;
}
export function jobHistory(value) {
  assert(
    Array.isArray(value) &&
      value.every(
        (job) => job && typeof job === 'object' && !Array.isArray(job),
      ),
    'Operation history is invalid. Preserve it for review.',
    503,
  );
  return value;
}
export function hostRegistry(value) {
  assert(
    value?.version === 1 &&
      ['servers', 'snapshots', 'jobs'].every((key) =>
        Array.isArray(value[key]),
      ),
    'Unsupported server registry. Preserve it for review.',
    503,
  );
  jobHistory(value.jobs);
  return value;
}
export function configurationRecord(value) {
  assert(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value.version === undefined || value.version === 1),
    'Unsupported management configuration. Preserve it for review.',
    503,
  );
  return value;
}
export function remoteRegistry(value) {
  assert(
    value?.version === 1 &&
      ['outgoing', 'incoming', 'pending'].every((key) =>
        Array.isArray(value[key]),
      ),
    'Unsupported remote host registry. Preserve it for review.',
    503,
  );
  return value;
}
export class RemoteHostsRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: 'host',
      namespace: 'registry',
      key: 'remote-hosts',
      file: 'remote-hosts.json',
      schemaVersion: 1,
      empty: {version: 1, outgoing: [], incoming: [], pending: []},
      decode: remoteRegistry,
    });
  }
}
export class JobsRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: 'controller',
      namespace: 'operations',
      key: 'jobs',
      file: 'jobs.json',
      schemaVersion: 1,
      empty: [],
      decode: jobHistory,
      validateWrite: assertJobIdentities,
    });
  }
}
export class RegistryRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: 'host',
      namespace: 'registry',
      key: 'host',
      file: 'registry.json',
      schemaVersion: 1,
      empty: {version: 1, servers: [], snapshots: [], jobs: []},
      decode: hostRegistry,
      validateWrite: value => {assertJobIdentities(value.jobs); return value;},
    });
  }
}
export class HostSetupRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: 'host',
      namespace: 'operations',
      key: 'host-setup',
      file: 'host-setup-jobs.json',
      schemaVersion: 1,
      empty: [],
      decode: jobHistory,
      validateWrite: assertJobIdentities,
    });
  }
}
export class AuditRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: ['accounts', 'controller', 'host'],
      namespace: 'audit',
      key: 'history',
      file: 'audit.json',
      schemaVersion: 1,
      empty: emptyAuditHistory,
      decode: auditHistory,
    });
  }
}
export class ConfigurationRepository extends DocumentRepository {
  constructor(root, key, empty, {file = key + '.json'} = {}) {
    assert(
      ['schedule', 'backup-retention'].includes(key),
      'Unknown controller configuration document.',
    );
    super(root, {
      profile: 'controller',
      namespace: 'configuration',
      key,
      file,
      schemaVersion: 1,
      empty,
      decode: configurationRecord,
    });
  }
}
