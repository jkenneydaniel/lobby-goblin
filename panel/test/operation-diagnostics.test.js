import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HttpError} from '../common.js';
import {
  OperationFailure,
  operationDiagnostic,
  operationReason,
  publicOperationDiagnostic,
} from '../core/operation-errors.js';
import {retainOperationDiagnostic} from '../core/operation-diagnostics.js';
import {Operations} from '../core/operations.js';
import {managementFailure} from '../core/management-errors.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-operation-diagnostics-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
test('public client rejections retain their cause while arbitrary exceptions and forged codes stay private', () => {
  const error = new HttpError(
    409,
    'The selected Docker engine changed or is not a Linux engine.',
  );
  assert.match(
    managementFailure(new Error('private wrapper', {cause: error})).message,
    /Docker engine changed/,
  );
  for (const untrusted of [
    Error('private-password /operator/files'),
    Object.assign(Error('private'), {
      status: 409,
      diagnostic: {code: 'storage-full'},
    }),
  ])
    assert.doesNotMatch(
      JSON.stringify(operationDiagnostic(untrusted)),
      /private-password|operator\/files|private wrapper|"private"/,
    );
  assert.equal(
    operationDiagnostic(new OperationFailure('storage-full')).code,
    'storage-full',
  );
  assert.equal(
    operationDiagnostic(
      Object.assign(Error('private disk details'), {code: 'ENOSPC'}),
    ).code,
    'storage-full',
  );
  assert.doesNotThrow(() => operationReason({toString: 0}));
  assert.equal(
    publicOperationDiagnostic({
      code: 'storage-full',
      message: 'secret',
      action: 'secret',
    }).message,
    operationReason('storage-full').message,
  );
});
test('private diagnostics retain bounded original causes and cleanup failures without publishing them', async (t) => {
  const root = await fixture(t),
    scope = {id: 'a'.repeat(32), source: 'host-operations', phase: 'executing'};
  const cause = Error('private cause /operator/files');
  cause.cause = cause;
  const diagnostic = await retainOperationDiagnostic(
    root,
    new Error('private wrapper', {cause}),
    scope,
  );
  assert.equal(diagnostic.retained, true);
  assert.equal(diagnostic.reference, scope.id);
  assert.equal(diagnostic.phase, 'executing');
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /private wrapper|private cause|operator\/files/,
  );
  for (let i = 0; i < 12; i++)
    await retainOperationDiagnostic(root, Error('cleanup ' + i), {
      ...scope,
      phase: 'cleanup',
    });
  const file = path.join(
      root,
      'operation-diagnostics',
      'host-operations-' + scope.id + '.json',
    ),
    saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.events.length, 8);
  assert.equal(
    saved.events[0].causes[1].message,
    'private cause /operator/files',
  );
  assert.equal(saved.events.at(-1).causes[0].message, 'cleanup 11');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});
test('failed diagnostic persistence preserves the public cause and reports missing retained evidence', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'operation-diagnostics'), 'occupied');
  const result = await retainOperationDiagnostic(
    root,
    new HttpError(409, 'Owned resource changed.'),
    {id: 'safe-id', source: 'host-operations', phase: 'executing'},
  );
  assert.equal(result.retained, false);
  assert.equal(result.message, 'Owned resource changed.');
});
test('ordinary operations expose safe cause/reference/phase while retaining private exceptions', async (t) => {
  const root = await fixture(t);
  let jobs = [],
    active = null;
  const service = new Operations({
    getJobs: () => jobs,
    setJobs: (value) => {
      jobs = value;
    },
    getActive: () => active,
    setActive: (value) => {
      active = value;
    },
    persist: async () => {},
    failure: (error, job) =>
      retainOperationDiagnostic(root, error, {
        id: job.id,
        source: 'application-operations',
        phase: job.phase,
      }),
  });
  const {job} = await service.reserve({
    action: 'save',
    actor: 'administrator',
    input: {},
  });
  await service.execute(job, {
    run: async () => {
      throw Error('private-password /operator/files');
    },
  });
  assert.equal(job.state, 'failed');
  assert.equal(job.failure.reference, job.id);
  assert.equal(job.failure.phase, 'executing');
  assert.equal(job.failure.retained, true);
  assert.doesNotMatch(
    JSON.stringify(service.status()),
    /private-password|operator\/files/,
  );
});

test('malformed exception metadata cannot prevent safe classification or private retention', async (t) => {
  const root = await fixture(t),
    error = Object.assign(Error('original failure'), {
      code: {toString: 0},
      syscall: 123,
    });
  assert.equal(operationDiagnostic(error).code, 'operation-failed');
  const diagnostic = await retainOperationDiagnostic(root, error, {
    id: 'malformed-error',
    source: 'host-operations',
    phase: 'executing',
  });
  assert.equal(diagnostic.retained, true);
});
