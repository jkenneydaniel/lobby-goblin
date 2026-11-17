import {ManagementFailure, managementFailure} from './management-errors.js';
import {assert} from '../common.js';
import {jobOperation, validateOperationView} from './operation-record.js';
import {needsOperationAttention} from '../public/shared/operation-progress.js';

// Providers read authoritative native records, rather than maintaining a second
// success/failure cache. A missing provider is explicit; it cannot become an empty
// successful history. Only reviewed code registers recovery handlers.
export class OperationFeed {
  constructor({scope, sources}) {
    assert(
      typeof scope === 'string' &&
        scope.length <= 160 &&
        Array.isArray(sources) &&
        sources.length <= 32,
      'Invalid operation feed.',
    );
    const ids = new Set();
    for (const source of sources) {
      assert(
        /^[a-z][a-z0-9-]{0,63}$/.test(source.id) &&
          !ids.has(source.id) &&
          typeof source.label === 'string' &&
          typeof source.read === 'function' &&
          (source.recover === undefined ||
            typeof source.recover === 'function') &&
          (source.inspectJob === undefined ||
            typeof source.inspectJob === 'function'),
        'Invalid operation source.',
      );
      ids.add(source.id);
    }
    this.scope = scope;
    this.sources = sources;
  }
  async snapshot({progress = false} = {}) {
    const providers = progress ? this.sources.filter((source) => source.id !== 'jobs') : this.sources;
    const operations = [],
      sources = await Promise.all(
        providers.map(async (source) => {
          try {
            const records = await (progress && source.readProgress
              ? source.readProgress()
              : source.read());
            assert(
              Array.isArray(records) && records.length <= 2000,
              'Invalid operation source records.',
            );
            const ids = new Set(),
              checked = [];
            for (const record of records) {
              validateOperationView(record, source.id);
              if (ids.has(record.id)) throw new ManagementFailure('duplicate-operation-identity');
              assert(
                record?.version === 1 &&
                  record.source === source.id &&
                  typeof record.id === 'string' &&
                  !ids.has(record.id),
                'Invalid operation source identity.',
              );
              ids.add(record.id);
              if (progress && !needsOperationAttention(record)) continue;
              checked.push({
                ...record,
                scope: this.scope,
                sourceLabel: source.label,
              });
            }
            operations.push(...checked);
            return {id: source.id, label: source.label, available: true};
          } catch (error) {
            const diagnostic = managementFailure(error);
            return {
              id: source.id,
              label: source.label,
              available: false,
              reason: diagnostic.code === 'duplicate-operation-identity' ? diagnostic.code : 'workflow-history-unavailable',
              message: diagnostic.code === 'duplicate-operation-identity' ? diagnostic.message + ' ' + diagnostic.action :
                'This workflow history is unavailable. Its outcome has not been inferred.',
            };
          }
        }),
      );
    operations.sort(
      (a, b) =>
        (b.started || '').localeCompare(a.started || '') ||
        a.id.localeCompare(b.id),
    );
    return {
      version: 1,
      scope: this.scope,
      operations: operations.filter(
        (record, index) =>
          index < 500 ||
          needsOperationAttention(record),
      ),
      sources,
    };
  }
  async recover({source: id, id: recordId, operation, confirm}, actor) {
    const source = this.sources.find((source) => source.id === id);
    assert(
      source &&
        source.recover &&
        typeof recordId === 'string' &&
        recordId.length <= 100,
      'Recovery is unavailable for this workflow.',
      404,
    );
    const record = (await source.read()).find(
      (record) => record.sourceId === recordId,
    );
    assert(
      record?.recovery?.required &&
        record.recovery.actions.some(
          (action) => action.id === operation && action.id !== 'open',
        ),
      'This recovery action is unavailable.',
      409,
    );
    if (operation !== 'inspect')
      assert(confirm === true, 'Confirm reviewing this operation.');
    return validateOperationView(
      await source.recover({id: recordId, operation, confirm}, actor),
      source.id,
    );
  }
}
export function jobOperationSource(operations) {
  return {
    id: 'jobs',
    label: 'Application operations',
    read: async () => operations.status().jobs.map(jobOperation),
    recover: async (input, actor) =>
      jobOperation(await operations.recover(input, actor)),
  };
}

export async function readJobsSnapshot(operations, feed, query) {
  const progress = query.get('progress') === '1';
  const workflow = query.get('workflows') === '1' ? await feed.snapshot({progress}) : null;
  const status = operations.status();
  if (progress) {
    const watched = new Set(query.getAll('job'));
    status.jobs = status.jobs.filter(
      (job) => needsOperationAttention(job) || job.id === status.active?.id || watched.has(job.id),
    );
  }
  if (workflow) {
    status.workflow = {...workflow, operations: workflow.operations.filter((record) => record.source !== 'jobs')};
  }
  return status;
}
