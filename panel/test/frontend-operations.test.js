import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationController} from '../public/shared/operations.js';

const job = {
  id: 'operation-1',
  action: 'backup',
  state: 'running',
  message: 'Saving',
};
const idle = {jobs: [], active: null};
function tracker(request, options = {}) {
  let recovery;
  const changes = [],
    notifications = [];
  const model = createOperationController({
    request,
    pollMs: 0,
    isAdmin: () => true,
    shell: {
      operation() {},
      recovery(_jobs, callback) {
        recovery = callback;
      },
    },
    onChange: (value) => changes.push(value.busy),
    notify: (...args) => notifications.push(args),
    ...options,
  });
  return {
    model,
    changes,
    notifications,
    recover: (...args) => recovery(...args),
  };
}

test('browser operation waits for lock release after a terminal job and settles exactly once', async () => {
  const complete = {...job, state: 'succeeded', message: 'Verified'};
  const replies = [
    {jobs: [complete], active: job},
    {jobs: [complete], active: null},
  ];
  const calls = [],
    settled = [];
  const {model} = tracker(
    async (route, options) => {
      calls.push({route, options});
      return options?.method === 'POST' ? job : replies.shift();
    },
    {onSettled: (value) => settled.push(value)},
  );
  let accepted = 0;
  const result = await model.start(
    'backup',
    {},
    {
      onAccepted: () => {
        accepted++;
      },
    },
  );
  assert.equal(result, complete);
  assert.equal(accepted, 1);
  assert.equal(model.busy, false);
  assert.deepEqual(settled, [complete]);
  assert.equal(
    calls.filter((call) => call.options?.method === 'POST').length,
    1,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map(({route}) => route), [
    '/jobs?progress=1&job=operation-1',
    '/jobs?progress=1&job=operation-1',
  ]);
  await model.update({jobs: [complete], active: null});
  assert.equal(settled.length, 1);
});

test('browser recovery blocks submissions until the administrator explicitly reviews it; never replays work', async () => {
  const interrupted = {
    ...job,
    state: 'interrupted',
    recovery: {required: true},
  };
  const calls = [];
  let recovered = 0;
  const {model, recover} = tracker(
    async (route, options) => {
      calls.push({route, options});
      return route === '/jobs/recovery' ? interrupted : idle;
    },
    {
      onRecovery: () => {
        recovered++;
      },
    },
  );
  await model.update({jobs: [interrupted], active: null});
  await assert.rejects(model.start('backup'), /Review interrupted/);
  assert.equal(calls.length, 0);
  await recover(interrupted, 'acknowledge');
  assert.equal(recovered, 1);
  assert.equal(model.busy, false);
  assert.deepEqual(
    calls.map((call) => call.route),
    ['/jobs/recovery', '/jobs?progress=1'],
  );
  assert.deepEqual(calls[0].options.body, {
    id: job.id,
    operation: 'acknowledge',
    confirm: true,
  });
});

test('concurrent submissions and submissions during an active lock are refused', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const {model} = tracker(async () => pending);
  const first = model.start('backup', {}, {wait: false});
  assert.equal(model.sending, true);
  await assert.rejects(model.start('backup'), /already running/);
  release(job);
  await first;
  assert.equal(model.sending, false);
  assert.equal(model.busy, true);
  await assert.rejects(model.start('backup'), /already running/);
});

test('coalesced reads ignore an old response after sign-out without corrupting a new session', async () => {
  const releases = [];
  let requests = 0;
  const {model} = tracker(() => {
    requests++;
    return new Promise((resolve) => releases.push(resolve));
  });
  const old = model.refresh(),
    duplicate = model.refresh();
  assert.equal(requests, 1);
  model.reset();
  const current = model.refresh();
  assert.equal(requests, 2);
  releases[0]({jobs: [job], active: job});
  await Promise.all([old, duplicate]);
  assert.equal(model.active, null);
  releases[1](idle);
  await current;
  assert.equal(model.busy, false);
});

test('failed submissions release the browser sending state so the user can retry', async () => {
  const {model} = tracker(async () => {
    throw Error('Disconnected');
  });
  await assert.rejects(model.start('backup'), /Disconnected/);
  assert.equal(model.busy, false);
  assert.equal(model.sending, false);
});

test('a completion callback can refresh without deadlocking or reporting completion twice', async () => {
  const complete = {...job, state: 'failed', message: 'Could not verify'};
  let settled = 0;
  const {model, notifications} = tracker(
    async (_route, options) =>
      options?.method === 'POST' ? job : {jobs: [complete], active: null},
    {
      onSettled: async () => {
        settled++;
        await model.refresh();
      },
    },
  );
  await model.start('backup', {}, {wait: false});
  await model.refresh();
  assert.equal(settled, 1);
  assert.deepEqual(notifications.at(-1), [complete.message, true]);
});

test('native workflow progress uses the same banner and dispatcher without blocking its specialized recovery',async()=>{
  const seen=[],banners=[],pending=[],native={id:'updates:worker',source:'updates',sourceId:'worker',action:'game-image-update',state:'running',message:'Checking the replacement'};
  const {model}=tracker(async(route,options)=>{seen.push({route,options});return idle;},{includeWorkflows:true,shell:{operation:value=>banners.push(value),recovery:(jobs,callback)=>{pending.push(jobs);pending.callback=callback;}}});
  await model.update({...idle,workflow:{operations:[native],sources:[{id:'updates',available:true}]}});assert.equal(model.active,native);assert.equal(model.busy,true);assert.equal(banners.at(-1),native);
  await assert.rejects(model.start('backup'),/already running/);assert.equal(seen.length,0);
  const uncertain={...native,state:'interrupted',recovery:{required:true,actions:[{id:'inspect',label:'Check update outcome'},{id:'open',label:'Open backups',href:'#backups'}]}};
  await model.update({...idle,workflow:{operations:[uncertain],sources:[{id:'updates',available:true}]}});assert.equal(model.recoveryRequired,false,'native recovery retains its owning workflow rules');assert.equal(model.busy,false);assert.equal(pending.at(-1)[0],uncertain);
  await pending.callback(uncertain,'inspect');assert.equal(seen[0].route,'/operations/recovery');assert.deepEqual(seen[0].options.body,{source:'updates',id:'worker',operation:'inspect',confirm:true});assert.equal(seen[1].route,'/jobs?progress=1&workflows=1');
});
test('rich workflow reads are administrator-only and reset invalidates a previously rendered recovery callback',async()=>{
  let admin=true,callback;const calls=[];
  const {model}=tracker(async route=>{calls.push(route);return {...idle,workflow:{operations:[],sources:[{id:'mods',available:false}]}};},{includeWorkflows:true,isAdmin:()=>admin,shell:{operation(){},recovery(_jobs,action){callback=action;}}});
  await model.refresh();assert.equal(calls[0],'/jobs?progress=1&workflows=1');assert.equal(model.workflowUnavailable,true);
  const stale=callback;model.reset();await stale({id:'jobs:old',source:'jobs',sourceId:'old'},'acknowledge');assert.equal(calls.length,1);
  admin=false;await model.refresh();assert.equal(calls[1],'/jobs?progress=1');
});
