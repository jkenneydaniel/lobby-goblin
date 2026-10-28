import test from 'node:test';
import assert from 'node:assert/strict';
import {hostWorkerLifecycle} from '../fleet/worker-lifecycle.js';
import {cleanupFleetContainers} from '../core/container-cleanup.js';
const fleet = 'a'.repeat(32),
  instance = 'b'.repeat(32),
  name = 'lobby-goblin-worker-' + 'c'.repeat(32);
function fixture() {
  const history = [],
    deleted = [],
    job = {id: 'd'.repeat(32), state: 'running'},
    info = {
      Id: 'owned-worker-id',
      Name: '/' + name,
      Config: {
        Labels: {
          'io.lobby-goblin.fleet': fleet,
          'io.lobby-goblin.instance': instance,
          'io.lobby-goblin.worker': 'true',
        },
      },
      State: {
        Status: 'created',
        Running: false,
        Restarting: false,
        Paused: false,
        ExitCode: 0,
      },
    };
  const manager = {
    fleet,
    root: '/nonexistent-synthetic-worker-fixture',
    active: job,
    state: {jobs: [job], servers: []},
    assertHost: async () => {},
    persist: async () => history.push(structuredClone(job)),
    docker: async (method, route) => {
      if (method === 'DELETE') {
        deleted.push(route);
        return;
      }
      return route.startsWith('/containers/json?')
        ? [info]
        : structuredClone(info);
    },
  };
  return {manager, job, info, history, deleted};
}
test('host cleanup retains newly created, instance-owned and unknown workers without a collected owning job', async () => {
  const f = fixture();
  const lifecycle = await hostWorkerLifecycle(f.manager, name, instance);
  await lifecycle.created(f.info.Id);
  f.manager.active = null;
  assert.equal((await cleanupFleetContainers(f.manager)).removed, 0);
  f.info.State.Status = 'exited';
  f.job.state = 'succeeded';
  f.job.finished = new Date().toISOString();
  assert.equal((await cleanupFleetContainers(f.manager)).removed, 0);
  f.info.Name = '/lobby-goblin-software-' + instance + '-request';
  f.info.Config.Labels['io.lobby-goblin.worker-kind'] = 'software-preparation';
  assert.equal((await cleanupFleetContainers(f.manager)).removed, 0);
  assert.deepEqual(f.deleted, []);
});
test('only collected exits from settled jobs permit cleanup; interrupted review, replacement IDs and duplicate receipts stay held', async () => {
  for (const mode of [
    'collected',
    'recovery',
    'changed-id',
    'duplicate',
    'created',
    'running',
    'wrong-exit',
    'foreign',
  ]) {
    const f = fixture(),
      lifecycle = await hostWorkerLifecycle(f.manager, name, instance);
    await lifecycle.created(f.info.Id);
    await lifecycle.collected(0);
    assert.equal(f.history[0].workerReceipts[0].phase, 'reserved');
    assert.equal(f.history[1].workerReceipts[0].phase, 'created');
    f.job.state = 'succeeded';
    f.job.finished = new Date().toISOString();
    f.manager.active = null;
    f.info.State.Status = 'exited';
    if (mode === 'recovery') f.job.recovery = {required: true};
    if (mode === 'changed-id') f.info.Id = 'replacement-id';
    if (mode === 'duplicate')
      f.manager.state.jobs.push({...structuredClone(f.job), id: 'different'});
    if (mode === 'created') f.info.State.Status = 'created';
    if (mode === 'running') f.info.State.Running = true;
    if (mode === 'wrong-exit') f.info.State.ExitCode = 1;
    if (mode === 'foreign')
      f.info.Config.Labels['io.lobby-goblin.fleet'] = 'e'.repeat(32);
    assert.equal(
      (await cleanupFleetContainers(f.manager)).removed,
      mode === 'collected' ? 1 : 0,
      mode,
    );
    assert.equal(f.deleted.length, mode === 'collected' ? 1 : 0, mode);
    if (mode === 'collected') {
      assert.equal(f.job.workerReceipts[0].phase, 'removed');
      assert.deepEqual(f.deleted, ['/containers/owned-worker-id']);
    }
  }
});
test('a host operation starting during inspection prevents background cleanup', async () => {
  const f = fixture(),
    lifecycle = await hostWorkerLifecycle(f.manager, name, instance);
  await lifecycle.created(f.info.Id);
  await lifecycle.collected(0);
  f.manager.active = null;
  f.job.state = 'failed';
  f.job.finished = new Date().toISOString();
  f.info.State.Status = 'exited';
  const request = f.manager.docker;
  f.manager.docker = async (...args) => {
    const result = await request(...args);
    if (args[1].endsWith('/json')) f.manager.active = {id: 'new-job'};
    return result;
  };
  assert.equal((await cleanupFleetContainers(f.manager)).removed, 0);
  assert.deepEqual(f.deleted, []);
});

test('uncertain cleanup retains a recovery guard; a proven removal publishes a distinct receipt',async()=>{
 const f=fixture(),lifecycle=await hostWorkerLifecycle(f.manager,name,instance);
 await lifecycle.created(f.info.Id);await lifecycle.review();
 assert.equal(f.job.recovery.required,true);assert.equal(f.job.workerReceipts[0].phase,'created');
 await lifecycle.collected(0);await lifecycle.removed();
 assert.equal(f.history.at(-1).workerReceipts[0].phase,'removed');
 assert.equal(f.job.recovery.required,true,'container cleanup alone cannot acknowledge operation outcome');
});
