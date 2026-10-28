import path from 'node:path';
import crypto from 'node:crypto';
import {assert, writeJSON, HttpError} from '../../common.js';
import {regularFile, parseStorageJSON} from './files.js';
import {selectedStorage} from './selection.js';
import {withStorageLock} from './coordination.js';

const fingerprint = (bytes) =>
  bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
// Legacy files remain the authority until a reviewed storage marker selects the
// database. SQLite commits use revision checks; async application callbacks run
// outside SQL transactions and are never silently replayed after a conflict.
export class DocumentRepository {
  constructor(
    root,
    {
      profile,
      namespace,
      key,
      file,
      schemaVersion,
      empty,
      decode = (value) => value,
      extension = null,
      validateWrite = (value) => value,
    },
  ) {
    assert(
      typeof file === 'string' &&
        !path.isAbsolute(file) &&
        file.endsWith('.json') &&
        !file.split(/[\\/]/).some((part) => part === '..' || part === ''),
      'Repository file must stay inside its storage root.',
    );
    Object.assign(this, {
      root,
      profile,
      namespace,
      key,
      file: path.join(root, file),
      schemaVersion,
      empty,
      decode,
      extension,
      validateWrite,
    });
  }
  async read() {
    const store = await selectedStorage(this.root);
    if (store) {
      this.assertExtension(store);
      assert(
        (Array.isArray(this.profile) ? this.profile : [this.profile]).includes(
          store.metadata.profile,
        ),
        'Repository does not belong to the selected storage profile.',
        503,
      );
      const record = store.read(this.namespace, this.key);
      assert(
        record.schemaVersion <= this.schemaVersion,
        'Repository data requires a newer panel version.',
        503,
      );
      if (!record.exists) {
        assert(
          !(await regularFile(this.file, {optional: true})),
          'Selected storage is missing a legacy document. Preserve both stores for review.',
          503,
        );
      }
      return {
        value: this.decode(
          record.exists ? record.value : structuredClone(this.empty),
        ),
        revision: record.revision,
        store,
      };
    }
    const bytes = await regularFile(this.file, {optional: true});
    return {
      value: this.decode(
        bytes ? parseStorageJSON(bytes) : structuredClone(this.empty),
      ),
      revision: fingerprint(bytes),
      store: null,
    };
  }
  async save(snapshot, value) {
    return withStorageLock(this.root, 'write', () =>
      this.saveLocked(snapshot, value),
    );
  }
  async saveLocked(snapshot, value) {
    value = this.validateWrite(this.decode(value));
    const selected = await selectedStorage(this.root);
    assert(
      selected === snapshot.store,
      'Panel storage changed while this request was open. Reload before saving.',
      409,
    );
    if (selected) {
      this.assertExtension(selected);
      const [revision] = selected.commit([
        {
          namespace: this.namespace,
          key: this.key,
          expectedRevision: snapshot.revision,
          schemaVersion: this.schemaVersion,
          value,
        },
      ]);
      snapshot.revision = revision;
    } else {
      if (
        fingerprint(await regularFile(this.file, {optional: true})) !==
        snapshot.revision
      )
        throw new HttpError(
          409,
          'Panel state changed in another writer. Reload before saving again.',
        );
      await writeJSON(this.file, value);
      snapshot.revision = fingerprint(
        Buffer.from(JSON.stringify(value, null, 2)),
      );
    }
    snapshot.value = structuredClone(value);
    return value;
  }
  assertExtension(store) {
    if (!this.extension) return;
    const groups = parseStorageJSON(store.metadata.extensions || '[]');
    assert(
      Array.isArray(groups) &&
        groups.some(
          (group) =>
            group.id === this.extension.id &&
            group.version === this.extension.version &&
            group.profile === store.metadata.profile &&
            group.namespace === this.namespace &&
            group.schemaVersion === this.schemaVersion,
        ),
      'This module needs a reviewed storage extension migration. Preserve its existing records.',
      503,
    );
  }
  async transaction(action) {
    const snapshot = await this.read(),
      state = structuredClone(snapshot.value);
    return action(
      state,
      (related = []) =>
        related.length
          ? commitDocuments([
              {repository: this, snapshot, value: state},
              ...related,
            ])
          : this.save(snapshot, state),
      snapshot,
    );
  }
}
// Related records share one database transaction. Callers must include the
// directory/ownership record even if only a child value changes, so deletion or
// reassignment cannot race a write to an old owner's document.
export async function commitDocuments(entries) {
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 10000,
    'Choose a bounded related-record transaction.',
  );
  return withStorageLock(entries[0].repository.root, 'write', () =>
    commitLocked(entries),
  );
}
async function commitLocked(entries) {
  let store;
  const changes = [];
  for (const entry of entries) {
    const {repository, snapshot} = entry;
    assert(
      repository instanceof DocumentRepository,
      'Invalid related repository.',
    );
    const selected = await selectedStorage(repository.root);
    assert(
      selected && selected === snapshot.store && (!store || selected === store),
      'Related records require the same selected transactional store.',
      409,
    );
    assert(
      (Array.isArray(repository.profile)
        ? repository.profile
        : [repository.profile]
      ).includes(selected.metadata.profile),
      'Related repository profile changed.',
      409,
    );
    store = selected;
    repository.assertExtension(selected);
    const value = entry.delete ? null : repository.validateWrite(repository.decode(entry.value));
    changes.push({
      namespace: repository.namespace,
      key: repository.key,
      schemaVersion: repository.schemaVersion,
      expectedRevision: snapshot.revision,
      value,
      ...(entry.delete ? {delete: true} : {}),
    });
  }
  const revisions = store.commit(changes);
  entries.forEach((entry, index) => {
    entry.snapshot.revision = revisions[index];
    entry.snapshot.value = structuredClone(changes[index].value);
  });
}
export function accountDirectory(value) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid account storage.',
    503,
  );
  if (typeof value.version === 'number')
    assert(
      value.version === 2,
      'Unsupported account storage version. Preserve it for review.',
      503,
    );
  const state =
    value.version === 2
      ? structuredClone(value)
      : {version: 2, users: structuredClone(value), invitations: {}};
  assert(
    state.users &&
      typeof state.users === 'object' &&
      !Array.isArray(state.users) &&
      state.invitations &&
      typeof state.invitations === 'object' &&
      !Array.isArray(state.invitations),
    'Invalid account directory.',
    503,
  );
  return state;
}
export class AccountsRepository extends DocumentRepository {
  constructor(root) {
    super(root, {
      profile: 'accounts',
      namespace: 'accounts',
      key: 'directory',
      file: 'users.json',
      schemaVersion: 2,
      empty: {version: 2, users: {}, invitations: {}},
      decode: accountDirectory,
    });
  }
}
