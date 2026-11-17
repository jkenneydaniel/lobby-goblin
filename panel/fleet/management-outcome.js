import fs from 'node:fs/promises';
import path from 'node:path';
import {assert} from '../common.js';
import {AuditLog} from '../core/audit.js';
import {recordOperation, describeOperation} from '../core/operation-record.js';
import {operationFileCache} from '../core/operation-file-cache.js';
import {needsOperationAttention} from '../public/shared/operation-progress.js';
import {regularFile, parseStorageJSON} from '../core/storage/files.js';
import {
  saveManagementJSON,
  privateManagementDirectory,
} from '../core/management-installation.js';

// Publication runs inside the owned host controller. Only public metadata is
// copied from the operator; private specifications and snapshots stay outside.
const descriptor = (record) => ({
  source: 'management-updates',
  kind: 'update',
  action: 'update-management',
  state: record.state,
  phase: record.phase,
  message:
    record.state === 'succeeded'
      ? 'Management update completed. Application containers were preserved.'
      : record.phase === 'rolled-back'
        ? 'Previous management services were restored. The update did not complete.'
        : 'Finish the retained management update using the local operator command.',
  recovery: {
    required: record.state === 'interrupted',
    actions:
      record.state === 'interrupted'
        ? [{id: 'inspect', label: 'Review operator update'}]
        : [],
  },
});

export async function publishManagementOutcome(
  root,
  value,
  {audit = new AuditLog(root), save = saveManagementJSON} = {},
) {
  assert(
    value &&
      Object.keys(value).every((key) =>
        [
          'id',
          'actor',
          'state',
          'phase',
          'started',
          'finished',
          'operationRecord',
        ].includes(key),
      ) &&
      /^[a-f0-9]{32}$/.test(value.id) &&
      typeof value.actor === 'string' &&
      value.actor.length <= 100 &&
      ((value.state === 'succeeded' && value.phase === 'complete') ||
        (value.state === 'failed' && value.phase === 'rolled-back')),
    'Invalid management update outcome.',
  );
  const directory = path.join(root, 'management-updates');
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  await privateManagementDirectory(directory);
  const file = path.join(directory, value.id + '.json');
  // A failed final audit write leaves an explicit uncertain public record.
  // Re-publication repeats metadata writes only, never the management update.
  const pending = {...value, state: 'interrupted', phase: 'publishing'};
  delete pending.operationRecord;
  recordOperation(pending, descriptor(pending));
  await save(file, pending);
  await audit.appendOnce({
    requestId: value.id,
    operationId: 'management-updates:' + value.id,
    actor: value.actor,
    action: 'management.update',
    scope: 'host',
    outcome: value.state,
  });
  recordOperation(value, descriptor(value));
  await save(file, value);
}

export function managementUpdateSource(root) {
  const cachedProgress = operationFileCache();
  async function readRecord(file) {
    const record = parseStorageJSON(await regularFile(file, {max: 128 * 1024}));
    assert(
      record.id + '.json' === path.basename(file),
      'Management update history identity changed.',
    );
    return describeOperation(record, descriptor(record));
  }
  async function read(readFile) {
    const directory = path.join(root, 'management-updates');
    const stat = await fs.lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return [];
    await privateManagementDirectory(directory);
    const names = await fs.readdir(directory);
    const published = names.filter((name) =>
      /^[a-f0-9]{32}\.json$/.test(name),
    );
    assert(
      names.length <= 2000 &&
        names.every(
          (name) =>
            published.includes(name) ||
            (/^([a-f0-9]{32})\.json\.[a-f0-9-]{36}\.tmp$/.test(name) &&
              published.includes(name.slice(0, 32) + '.json')),
        ),
      'Management update history needs review.',
    );
    return (
      await Promise.all(published.map((name) => readFile(path.join(directory, name))))
    ).filter(Boolean);
  }
  const source = {
    id: 'management-updates',
    label: 'Management updates',
    read: () => read(readRecord),
    readProgress() {
      return cachedProgress((cached) =>
        read((file) =>
          cached(file, async () => {
            const record = await readRecord(file);
            return needsOperationAttention(record) ? record : null;
          }),
        ),
      );
    },
    async recover({id, operation}) {
      assert(
        operation === 'inspect',
        'Management recovery uses the local operator command.',
        409,
      );
      return (await source.read()).find((record) => record.sourceId === id);
    },
  };
  return source;
}
