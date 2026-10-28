import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagementFailure,
  managementFailure,
} from '../core/management-errors.js';
import {operatorFailure} from '../management-volume-worker.js';
import {runPanelUpdate} from '../management-panel-worker.js';
import {OperationFeed} from '../core/operation-feed.js';
import {jobOperation} from '../core/operation-record.js';
import {assertManagementIdle} from '../core/management-maintenance.js';

test('duplicate operation history reports its exact safe cause and still blocks management updates', async () => {
  const job = {
    id: 'migration-034',
    action: 'image-migration',
    actor: 'system',
    state: 'succeeded',
  };
  const snapshot = await new OperationFeed({
    scope: 'host:fixture',
    sources: [
      {
        id: 'jobs',
        label: 'Application operations',
        read: async () => [jobOperation(job), jobOperation(job)],
      },
    ],
  }).snapshot();
  assert.deepEqual(snapshot.operations, []);
  assert.equal(snapshot.sources[0].available, false);
  assert.equal(snapshot.sources[0].reason, 'duplicate-operation-identity');
  assert.match(snapshot.sources[0].message, /duplicate operation IDs/);
  assert.throws(
    () => assertManagementIdle(snapshot),
    (error) => managementFailure(error).code === 'duplicate-operation-identity',
  );
});
test('known failures survive panel and operator wrappers; arbitrary exception data is never published', async () => {
  const cause = new ManagementFailure('docker-socket-unverified', {
    cause: Error('password=private /operator/files'),
  });
  const wrapped = new Error('private Docker payload', {cause});
  const operator = operatorFailure(wrapped);
  assert.equal(operator.diagnostic.code, 'docker-socket-unverified');
  const saved = [];
  await runPanelUpdate({
    input: {id: 'a'.repeat(32), action: 'plan', targetVersion: '99.0.0-alpha'},
    resolveImage: async () => {
      throw wrapped;
    },
    workflow: {
      status: async () => {
        throw Error('absent');
      },
    },
    save: async (value) => saved.push(value),
  });
  assert.equal(saved.at(-1).state, 'failed');
  assert.equal(saved.at(-1).diagnostic.code, operator.diagnostic.code);
  assert.match(saved.at(-1).message, /same engine/);
  assert.doesNotMatch(
    JSON.stringify({operator, saved}),
    /password=|operator\/files|private Docker/,
  );
  assert.equal(
    managementFailure(
      Object.assign(Error('secret'), {
        diagnostic: {code: 'docker-socket-unverified'},
      }),
    ).code,
    'management-update-failed',
  );
});
