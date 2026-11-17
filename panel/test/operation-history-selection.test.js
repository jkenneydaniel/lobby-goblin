import test from 'node:test';
import assert from 'node:assert/strict';

// The shared browser module imports URL scoping; selection itself needs no DOM.
globalThis.location = {pathname: '/'};
const {selectOperationHistory: select} =
  await import('../public/shared/operation-history.js');
delete globalThis.location;

const record = {
  id: 'jobs:Public.ID',
  sourceId: 'Source[7]',
  parentId: 'Parent+42',
  action: 'create-backup',
  actor: 'MixedCaseOperator',
  sourceLabel: 'Application operations',
  message: 'Saved literal .* [world]?',
  phase: 'VerifyingSnapshot',
  state: 'interrupted',
  recovery: {required: true, message: 'excludedRecoveryText'},
  events: [{phase: 'excludedEventText'}],
  private: 'excludedPrivateText',
};

test('find uses trimmed case insensitive literal public summary fields', () => {
  for (const query of [
    ' CREATE-BACKUP ',
    'create backup',
    'mixedcaseoperator',
    'APPLICATION OPERATIONS',
    '.* [WORLD]?',
    'verifyingsnapshot',
    'PUBLIC.id',
    'source[7]',
    'PARENT+42',
  ])
    assert.deepEqual(select([record], query, 'all'), [record], query);
  for (const query of [
    'excludedRecoveryText',
    'excludedEventText',
    'excludedPrivateText',
    '^Saved',
    'world.*',
    'interrupted',
  ])
    assert.deepEqual(
      select([{...record, phase: 'current'}], query, 'all'),
      [],
      query,
    );
});

test('missing optional IDs are safe and empty queries preserve selected Show semantics', () => {
  const {parentId: _parentId, ...withoutParent} = record;
  const {id: _id, sourceId: _sourceId, ...withoutIds} = withoutParent;
  assert.deepEqual(select([withoutIds], 'Parent+42', 'all'), []);
  assert.deepEqual(select([withoutIds], '   ', 'review'), [withoutIds]);
  assert.deepEqual(select([withoutIds], '', 'active'), []);
});

test('one Show predicate selects exact terminal outcomes and retains review and active semantics', () => {
  const records = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'interrupted',
    'succeeded-extra',
  ].map((state) => ({
    ...record,
    id: state,
    state,
    recovery: {required: ['failed', 'interrupted'].includes(state)},
  }));
  for (const state of ['succeeded', 'failed', 'interrupted'])
    assert.deepEqual(
      select(records, '', state).map(({id}) => id),
      [state],
    );
  assert.deepEqual(
    select(records, '', 'review').map(({id}) => id),
    ['failed', 'interrupted'],
  );
  assert.deepEqual(
    select(records, '', 'active').map(({id}) => id),
    ['queued', 'running'],
  );
  assert.deepEqual(
    select(records, 'interrupted', 'review').map(({id}) => id),
    ['interrupted'],
  );
  assert.deepEqual(select(records, 'succeeded', 'active'), []);
  assert.deepEqual(select(records, 'queued', 'failed'), []);
});

test('selection does not cap loaded snapshots above 500 or mutate original outcomes', () => {
  const records = Array.from({length: 503}, (_, i) => ({
    ...record,
    id: 'row-' + i,
    state: i < 500 ? 'succeeded' : 'interrupted',
  }));
  const before = structuredClone(records);
  assert.equal(select(records, '', 'all').length, 503);
  assert.equal(select(records, '', 'interrupted').length, 3);
  assert.equal(select(records, 'nothing found', 'all').length, 0);
  assert.deepEqual(records, before);
});
