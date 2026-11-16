import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, readJSON} from '../common.js';
import {describeOperation, writeOperationRecord} from './operation-record.js';
import {operationFileCache} from './operation-file-cache.js';
import {needsOperationAttention} from '../public/shared/operation-progress.js';

// The current transaction remains authoritative. Retain each transaction beside
// its recovery files before publishing the current record. If publication fails,
// readers prefer the current copy for that ID and retain its uncertainty.
export function workflowJournal({
  file,
  history,
  source,
  label,
  action,
  href = '#mods',
  getActive = () => null,
  describe,
}) {
  const descriptor =
    describe ||
    ((record, parent) => {
      const parentId = parent?.id || record.operationRecord?.parentId,
        active = !!parentId && parentId === getActive()?.id;
      return {
        source,
        kind: 'mods',
        action: record.action || action,
        state:
          record.phase === 'complete'
            ? 'succeeded'
            : record.phase === 'recovered'
              ? 'failed'
              : active
                ? 'running'
                : 'interrupted',
        phase: record.phase,
        message:
          record.phase === 'complete'
            ? 'The file transaction completed. Check its parent operation for application readiness.'
            : record.phase === 'recovered'
              ? 'Previous files were restored. The original transaction did not complete.'
              : 'The file transaction has not settled. Review the application before making changes.',
        recovery: {
          required:
            !active && !['complete', 'recovered'].includes(record.phase),
          message:
            'Recovery belongs to the application workflow. No mutation is replayed from history.',
          actions: [
            {id: 'inspect', label: 'Check transaction'},
            {id: 'open', label: 'Open recovery tools', href},
          ],
        },
      };
    });
  async function write(record, parent) {
    const name = record.id;
    assert(
      /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(name),
      'Invalid workflow transaction identity.',
    );
    const directory = path.join(history, name);
    await fs.mkdir(history, {recursive: true, mode: 0o700});
    const rootStat = await fs.lstat(history);
    assert(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      'Workflow history cannot be a link.',
      409,
    );
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const stat = await fs.lstat(directory);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await fs.realpath(directory)) ===
          path.join(await fs.realpath(history), name),
      'Workflow history cannot be a link.',
      409,
    );
    await writeOperationRecord(
      path.join(directory, 'operation.json'),
      record,
      descriptor(record, parent),
      {parentId: parent?.id},
    );
    await writeOperationRecord(file, record, descriptor(record, parent), {
      parentId: parent?.id,
    });
  }
  async function readRecord(location) {
    const stat = await fs.lstat(location).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024,
      'Invalid workflow record.',
      503,
    );
    return readJSON(location, null);
  }
  const cachedProgress = operationFileCache();
  async function readRecords(readArchived, readCurrent = readRecord) {
    const records = new Map();
    const historyStat = await fs.lstat(history).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert(
      !historyStat ||
        (historyStat.isDirectory() && !historyStat.isSymbolicLink()),
      'Invalid workflow history root.',
      503,
    );
    const names = await fs.readdir(history).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert(names.length <= 10000, 'Too many workflow history entries.', 503);
    for (const name of names.filter((name) =>
      /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(name),
    )) {
      const directory = path.join(history, name),
        stat = await fs.lstat(directory);
      assert(
        stat.isDirectory() && !stat.isSymbolicLink(),
        'Invalid workflow history directory.',
        503,
      );
      const record = await readArchived(path.join(directory, 'operation.json'));
      if (record) records.set(record.id, record);
    }
    const current = await readCurrent(file);
    if (current) records.set(current.id, current);
    return [...records.values()];
  }
  async function read() {
    return (await readRecords(readRecord)).map((record) =>
      describeOperation(record, descriptor(record)),
    );
  }
  async function readUnsettledArchive(location) {
    const record = await readRecord(location);
    if (!record) return null;
    const view = descriptor(record);
    // Reevaluate unsettled records against the current parent job. Even a
    // failed publication of the current copy can leave one in the archive.
    return ['succeeded', 'failed'].includes(view.state) && !view.recovery?.required
      ? null
      : record;
  }
  async function readProgress() {
    const records = await cachedProgress((cached) =>
      readRecords(
        (location) => cached(location, readUnsettledArchive),
        (location) => cached(location, readRecord),
      ),
    );
    return records.flatMap((record) => {
      const view = descriptor(record);
      return needsOperationAttention(view) ? [describeOperation(record, view)] : [];
    });
  }
  const operationSource = {
    id: source,
    label,
    read,
    readProgress,
    inspectJob: inspect,
    async recover({id}) {
      return (await read()).find((record) => record.sourceId === id);
    },
  };
  async function inspect(job) {
    const records = await read(),
      record = records.find((record) => record.parentId === job.id);
    if (!record) return null;
    return {
      message:
        record.message +
        ' The parent operation’s readiness and cleanup still require review.',
    };
  }
  return {write, operationSource, inspect};
}
