import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ManagementPanel} from '../core/management-panel.js';
import {saveManagementJSON} from '../core/management-installation.js';
import {runPanelUpdate, resolvePanelRuntime} from '../management-panel-worker.js';
import {assertPanelWorker} from '../core/management-panel-contract.js';

const fleet = 'a'.repeat(32), runtimeImage = 'sha256:' + 'b'.repeat(64), project = 'lobby-goblin-fleet-' + fleet;
test('release resolution uses only the owned repository, verifies metadata and pins the reviewed digest', async () => {
  const digest = 'ghcr.io/jkenneydaniel/lobby-goblin@sha256:' + 'a'.repeat(64), calls = [];
  const image = {Id: runtimeImage, Os: 'linux', Architecture: 'amd64', RepoDigests: [digest], Config: {Labels: {'org.opencontainers.image.version': '99.0.0-alpha', 'org.opencontainers.image.source': 'https://github.com/jkenneydaniel/lobby-goblin', 'io.lobby-goblin.runtime': '1'}}};
  const engine = {request: async (...args) => {calls.push(args); return image;}};
  assert.equal(await resolvePanelRuntime(engine, '99.0.0-alpha'), digest);
  assert.equal(new URL('http://fixture' + calls[0][1]).searchParams.get('fromImage'), 'ghcr.io/jkenneydaniel/lobby-goblin:99.0.0-alpha');
  assert.ok(calls[2][1].includes(encodeURIComponent(digest)));
  await assert.rejects(resolvePanelRuntime(engine, 'evil/repo:latest'), /Invalid/);
  image.Config.Labels['org.opencontainers.image.source'] = 'https://evil.example';
  await assert.rejects(resolvePanelRuntime(engine, '99.0.0-alpha'), /does not match/);
});
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-panel-update-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const containers = new Map(), calls = [];
  for (const [name, role] of [['lobby-goblin-docker-broker-', 'docker-broker'], ['lobby-goblin-host-', 'host-controller']]) {
    const value = {Id: name + fleet, Image: runtimeImage, Config: {Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': role, 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': '/reviewed/installation'}}, Mounts: [{Type: 'bind', Source: '/run/owned.sock', Destination: '/var/run/docker.sock'}, {Type: 'volume', Name: project + '-broker-state', Destination: '/broker-state'}]};
    containers.set(name + fleet, value);
  }
  const docker = async (method, route, data) => {
    calls.push({method, route, data});
    if (route === '/info') return {ID: 'fixture-engine', OSType: 'linux'};
    const url = new URL(route, 'http://fixture');
    if (url.pathname === '/containers/create') {
      const name = url.searchParams.get('name'), value = {Id: 'helper-' + name, Name: '/' + name, Image: data.Image, Config: {...data, HostConfig: undefined}, HostConfig: data.HostConfig, State: {Running: false}};
      containers.set(name, value); containers.set(value.Id, value); return {Id: value.Id};
    }
    const [, , name, action] = url.pathname.split('/'), value = containers.get(name);
    if (!value) throw Object.assign(Error('missing'), {status: 404});
    if (method === 'DELETE') { containers.delete(name); containers.delete(value.Name.slice(1)); return; }
    if (action === 'start') { value.State.Running = true; return; }
    assert.equal(action, 'json'); return structuredClone(value);
  };
  const panel = new ManagementPanel({root, fleet, docker, runtimeImage}); await panel.init();
  const request = {action: 'plan', version: '99.0.0-alpha', requestId: 'c'.repeat(32)};
  async function finish(state = 'reviewed', extra = {}) {
    const current = await panel.current(); containers.get(current.worker.Id).State.Running = false;
    await saveManagementJSON(path.join(panel.root, current.job.attempt, 'result.json'), {state, plan: {id: current.job.id, image: 'sha256:' + 'd'.repeat(64), commit: false, operation: {phase: 'planned'}}, message: 'Public result', ...extra});
    return current.job;
  }
  return {panel, containers, calls, request, finish};
}
test('broker starts only its fixed, scoped helper and reads a lost response without replaying', async t => {
  const f = await fixture(t), first = await f.panel.handle(f.request);
  assert.equal(first.update.state, 'planning');
  assert.equal((await f.panel.handle(f.request)).update.id, first.update.id);
  assert.equal(f.calls.filter(c => c.route.startsWith('/containers/create')).length, 1);
  const job = (await f.panel.current()).job;
  assert.deepEqual(job.spec.Entrypoint, ['node', '/app/management-panel-worker.js']);
  assert.equal(job.spec.HostConfig.NetworkMode, 'none');
  assert.equal(job.spec.HostConfig.AutoRemove, true, 'Completed helpers cannot block a later operator CLI plan as stray fleet containers.');
  assert.equal(job.spec.HostConfig.Mounts.length, 3);
  assert.ok(job.spec.HostConfig.Mounts.every(m => !/world|library|instance/.test(m.Target)));
  assert.equal(JSON.stringify(first).includes('/reviewed/installation'), false);
  assert.equal(first.update.actions.length, 0);
  await assert.rejects(f.panel.handle({...f.request, requestId: 'e'.repeat(32)}), /Wait/);
  await f.finish();
  const fresh = new ManagementPanel({root: path.dirname(f.panel.root), fleet, docker: f.panel.docker, runtimeImage}); await fresh.init();
  const review = await fresh.handle({action: 'status'});
  assert.deepEqual(review.update.actions, ['apply', 'cancel']);
  await assert.rejects(fresh.handle({action: 'apply', id: job.id, requestId: 'e'.repeat(32), confirm: false}), /Confirm/);
  await fresh.handle({action: 'apply', id: job.id, requestId: 'e'.repeat(32), confirm: true});
  assert.equal((await fresh.handle({action: 'status'})).update.state, 'running');
});
test('untrusted parameters, altered helper authority and expired reviews fail closed', async t => {
  const f = await fixture(t);
  for (const extra of [{directory: '/'}, {image: 'evil/runtime'}, {socket: '/run/evil'}, {command: 'sh'}])
    await assert.rejects(f.panel.handle({...f.request, ...extra}), /Unexpected/);
  for (const version of ['99.0.0;id', '../../evil', '0.0.1'])
    await assert.rejects(f.panel.handle({...f.request, version}), /newer/);
  await f.panel.handle(f.request); const job = await f.finish();
  f.panel.now = () => job.expires + 1;
  await assert.rejects(f.panel.handle({action: 'apply', id: job.id, requestId: 'f'.repeat(32), confirm: true}), /expired/);
  const current = await f.panel.current(), altered = structuredClone(current.worker);
  altered.HostConfig.Mounts.push({Type: 'bind', Source: '/', Target: '/host'});
  assert.throws(() => assertPanelWorker(altered, job.spec, job.name), /changed/);
  altered.HostConfig = structuredClone(job.spec.HostConfig); altered.Config.Env.push('NODE_OPTIONS=--require /evil');
  assert.throws(() => assertPanelWorker(altered, job.spec, job.name), /changed/);
  assert.deepEqual((await f.panel.handle({action: 'status'})).update.actions, ['apply', 'cancel']);
  await f.panel.handle({action: 'cancel', id: job.id, requestId: 'f'.repeat(32), confirm: true});
});
test('recovery actions follow the durable commit point and uncertain stops retain authority', async t => {
  const f = await fixture(t); await f.panel.handle(f.request);
  const job = await f.finish('attention', {plan: {commit: true, operation: {phase: 'activating'}}});
  assert.deepEqual((await f.panel.handle({action: 'status'})).update.actions, ['resume']);
  await assert.rejects(f.panel.handle({action: 'rollback', id: job.id, requestId: 'e'.repeat(32), confirm: true}), /unavailable/);
  await f.panel.handle({action: 'resume', id: job.id, requestId: 'e'.repeat(32), confirm: true});
  const current = await f.panel.current(); f.containers.get(current.worker.Id).State.Running = false;
  assert.equal((await f.panel.handle({action: 'status'})).update.state, 'attention');
  await assert.rejects(f.panel.handle({...f.request, requestId: 'f'.repeat(32)}), /Finish or cancel/);
});
test('worker delegates planning, install and recovery to the coordinated workflow without leaking errors', async () => {
  const id = 'f'.repeat(32), publications = [], calls = [];
  let plan = {id, commit: false, image: 'sha256:' + 'a'.repeat(64), operation: {phase: 'planned'}};
  const workflow = {plan: async (image, options) => {calls.push({image, options}); return plan;}, status: async () => plan,
    load: async () => ({plan: {services: [1, 2, 3], games: [1]}}),
    run: async (...args) => {calls.push(args); plan = {...plan, commit: true, operation: {phase: 'complete'}}; return plan;}};
  const options = {input: {id, action: 'plan', targetVersion: '99.0.0-alpha'}, workflow, resolveImage: async () => plan.image, save: async value => publications.push(value)};
  await runPanelUpdate(options); assert.equal(publications.at(-1).state, 'reviewed'); assert.deepEqual(calls[0].options, {id});
  await runPanelUpdate({...options, input: {id, action: 'apply'}}); assert.equal(publications.at(-1).state, 'complete');
  assert.deepEqual(calls[1], [id, {confirm: true, rollback: false}]);
  workflow.run = async () => {throw Error('private-password and /operator/files');};
  await runPanelUpdate({...options, input: {id, action: 'resume'}});
  assert.equal(publications.at(-1).state, 'attention');
  assert.equal(JSON.stringify(publications).includes('private-password'), false);
});
