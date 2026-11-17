import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recordOperation, jobOperation} from '../core/operation-record.js';
import {OperationFeed, jobOperationSource, readJobsSnapshot} from '../core/operation-feed.js';
import {workflowJournal} from '../core/workflow-journal.js';
import {
  setupOperationSource,
  recordSetupJobs,
  agentOperationJournal,
} from '../fleet/operation-sources.js';
import {
  writeUpdateRecord,
  updateOperationSource,
} from '../applications/factorio/update-operations.js';
import {readJSON, writeJSON} from '../common.js';

const id = 'a'.repeat(32),
  at = '2026-10-23T12:00:00.000Z';
const job = () => ({
  id,
  actor: 'Operator',
  action: 'backup',
  state: 'running',
  phase: 'reserved',
  started: at,
  message: 'Preparing backup',
  params: {password: 'never copy this'},
  result: 'private output',
});
async function directory(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lobby-operation-feed-'),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
test('one checked envelope retains phases and parent identity while excluding native private payloads', () => {
  const record = job();
  recordOperation(
    record,
    {source: 'jobs', kind: 'backup', action: 'backup'},
    {at, parentId: 'parent'},
  );
  record.state = 'succeeded';
  record.phase = 'settled';
  record.finished = at;
  recordOperation(
    record,
    {source: 'jobs', kind: 'backup', action: 'backup'},
    {at},
  );
  const value = jobOperation(record);
  assert.equal(value.parentId, 'parent');
  assert.deepEqual(
    value.events.map((event) => event.state),
    ['running', 'succeeded'],
  );
  assert.doesNotMatch(
    JSON.stringify(value),
    /password|private output|never copy/,
  );
  assert.throws(
    () =>
      recordOperation(record, {
        source: 'other',
        kind: 'backup',
        action: 'backup',
      }),
    /identity changed/,
  );
  assert.throws(
    () =>
      recordOperation(record, {
        source: 'jobs',
        kind: 'backup',
        action: 'start',
      }),
    /identity changed/,
  );
});
test('unavailable or malformed sources never publish partial records or imply an empty successful history', async () => {
  const value = jobOperation(job());
  const feed = new OperationFeed({
    scope: 'standalone',
    sources: [
      {
        id: 'jobs',
        label: 'Jobs',
        read: async () => [
          value,
          {...value, id: 'bad', sourceId: 'bad', secret: 'hidden'},
        ],
      },
      {
        id: 'updates',
        label: 'Updates',
        read: async () => {
          throw Error('token=private');
        },
      },
    ],
  });
  const snapshot = await feed.snapshot();
  assert.deepEqual(snapshot.operations, []);
  assert.ok(snapshot.sources.every((source) => source.available === false));
  assert.doesNotMatch(JSON.stringify(snapshot), /private|hidden/);
  await assert.rejects(
    feed.recover({source: 'jobs', id, operation: 'replay'}, 'Operator'),
    /unavailable/,
  );
});
test('native transaction history survives restart and later transactions, retaining uncertainty and parent correlation', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'transaction.json'),
    history = path.join(root, 'history'),
    parent = {id: 'parent-job', actor: 'Operator'};
  let active = parent;
  const options = {
    file,
    history,
    source: 'mods',
    label: 'Mods',
    action: 'mod-change',
    getActive: () => active,
  };
  const first = {
    id: '11111111-1111-1111-1111-111111111111',
    phase: 'applying',
    actor: 'Operator',
    started: at,
    files: [],
    credentials: 'hidden',
  };
  const journal = workflowJournal(options);
  await journal.write(first, parent);
  assert.equal((await journal.operationSource.read())[0].state, 'running');
  active = null;
  const restarted = workflowJournal(options),
    snapshot = await restarted.operationSource.read();
  assert.equal(snapshot[0].state, 'interrupted');
  assert.equal(snapshot[0].recovery.required, true);
  assert.equal(snapshot[0].parentId, parent.id);
  assert.equal((await restarted.operationSource.readProgress())[0].recovery.required, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /credentials|hidden/);
  first.phase = 'recovered';
  await restarted.write(first);
  const second = {
    id: '22222222-2222-2222-2222-222222222222',
    phase: 'complete',
    started: at,
  };
  await restarted.write(second);
  const retained = await restarted.operationSource.read();
  assert.equal(retained.length, 2);
  assert.deepEqual(await restarted.operationSource.readProgress(), []);
  assert.equal(
    retained.find((record) => record.sourceId === first.id).state,
    'failed',
  );
  assert.equal(
    (await restarted.inspect(parent)).outcome,
    undefined,
    'file completion does not prove parent readiness',
  );
  // A staged archive cannot overrule an uncertain current transaction.
  second.phase = 'applying';
  await writeJSON(file, second);
  assert.equal(
    (await restarted.operationSource.read()).find(
      (record) => record.sourceId === second.id,
    ).state,
    'interrupted',
  );
  assert.equal((await restarted.operationSource.readProgress())[0].recovery.required, true);
  await writeJSON(path.join(history, first.id, 'operation.json'), {...first, phase: 'applying'});
  assert.deepEqual((await restarted.operationSource.readProgress()).map((record) => record.sourceId), [first.id, second.id]);
});

test('progress returns live jobs, unresolved recovery, and only explicitly watched terminal jobs', async () => {
  const jobs = [
    {...job(), id: 'active'},
    {...job(), id: 'recovery', state: 'interrupted', recovery: {required: true}},
    {...job(), id: 'watched', state: 'succeeded'},
    {...job(), id: 'completed', state: 'failed'},
  ];
  const operations = {status: () => ({jobs, active: jobs[0], recoveryRequired: true})};
  const setup = setupOperationSource({jobs: [
    {...job(), id: 'setup-history', state: 'succeeded'},
    {...job(), id: 'setup-recovery', state: 'failed'},
  ]});
  let historyReads = 0;
  const readHistory = setup.read;
  setup.read = () => { historyReads++; return readHistory(); };
  const feed = new OperationFeed({scope: 'host', sources: [jobOperationSource(operations), setup]});
  const read = (query) => readJobsSnapshot(operations, feed, new URLSearchParams(query));
  const progress = await read('progress=1&workflows=1&job=watched');
  assert.deepEqual(progress.jobs.map(({id}) => id), ['active', 'recovery', 'watched']);
  assert.deepEqual(progress.workflow.operations.map(({sourceId}) => sourceId), ['setup-recovery']);
  assert.equal(progress.active, jobs[0]);
  assert.equal(progress.recoveryRequired, true);
  assert.equal(historyReads, 0);
  assert.deepEqual((await read('progress=1')).jobs.map(({id}) => id), ['active', 'recovery']);
  assert.equal((await read('')).jobs.length, 4);
  assert.equal((await read('workflows=1')).workflow.operations.length, 2);
  assert.equal(historyReads, 1);
});
test('independent update records retain one envelope and expose explicit world recovery without host paths', async (t) => {
  const root = await directory(t),
    file = path.join(root, id + '.json');
  let record = {
    id,
    kind: 'game',
    actor: 'Operator',
    started: at,
    state: 'running',
    message: 'Replacing',
    operation: 'image-change',
    root: '/private/install',
  };
  await writeUpdateRecord(file, record);
  record = await readJSON(file);
  assert.equal(record.operation, 'image-change');
  record.state = 'failed';
  record.recovery = {
    requiresWorldRestore: true,
    directory: '/private/recovery',
    action: 'Restore the verified pre-update backup.',
  };
  await writeUpdateRecord(file, record);
  const source = updateOperationSource({
      refresh: async () => {},
      jobs: [await readJSON(file)],
    }),
    value = (await source.read())[0];
  assert.equal(value.recovery.required, true);
  assert.equal(value.recovery.actions.at(-1).href, '#backups');
  assert.deepEqual(
    value.events.map((event) => event.state),
    ['running', 'failed'],
  );
  assert.doesNotMatch(JSON.stringify(value), /private/);
});
test('host setup review persists acknowledgement while preserving the failed original outcome and never contacting the host', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'jobs.json'),
    setup = {
      jobs: [
        {
          id,
          state: 'failed',
          actor: 'Operator',
          started: at,
          message: 'Partial setup',
        },
      ],
      persist: async () => {
        recordSetupJobs(setup.jobs);
        await writeJSON(file, setup.jobs);
      },
    };
  const feed = new OperationFeed({
    scope: 'host:test',
    sources: [setupOperationSource(setup)],
  });
  await assert.rejects(
    feed.recover(
      {source: 'host-setup', id, operation: 'acknowledge', confirm: true},
      'Reviewer',
    ),
    /unavailable/,
  );
  await feed.recover(
    {source: 'host-setup', id, operation: 'inspect'},
    'Reviewer',
  );
  await feed.recover(
    {source: 'host-setup', id, operation: 'acknowledge', confirm: true},
    'Reviewer',
  );
  const saved = (await readJSON(file))[0];
  assert.equal(saved.state, 'failed');
  assert.equal(saved.recoveryReview.reviewedBy, 'Reviewer');
  assert.equal((await feed.snapshot()).operations[0].recovery.required, false);
});
test('management update history survives a subsequent update without storing replacement specs in the public view', async (t) => {
  const root = await directory(t),
    journal = agentOperationJournal(path.join(root, 'agent-update.json'));
  for (const current of ['a', 'b'])
    await journal.write({
      id: current.repeat(32),
      actor: 'Operator',
      started: at,
      state: 'complete',
      message: 'Updated',
      containers: [{Env: ['PASSWORD=hidden']}],
    });
  const view = await journal.operationSource.read();
  assert.equal(view.length, 2);
  assert.ok(
    view.every((record) => record.state === 'succeeded' && record.finished),
  );
  assert.doesNotMatch(JSON.stringify(view), /PASSWORD|hidden|containers/);
});

test('workflow history rejects a linked archive root before reading or writing outside storage', async (t) => {
  const root = await directory(t),
    outside = await directory(t),
    history = path.join(root, 'history');
  await fs.writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await fs.symlink(outside, history, 'dir');
  const journal = workflowJournal({
    file: path.join(root, 'transaction.json'),
    history,
    source: 'mods',
    label: 'Mods',
    action: 'mod-change',
  });
  await assert.rejects(journal.operationSource.read(), /history root/);
  await assert.rejects(
    journal.write({
      id: '11111111-1111-1111-1111-111111111111',
      phase: 'applying',
    }),
    /cannot be a link/,
  );
  assert.deepEqual(await fs.readdir(outside), ['sentinel']);
  assert.equal(
    await fs.readFile(path.join(outside, 'sentinel'), 'utf8'),
    'unchanged',
  );
});
