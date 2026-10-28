import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../common.js';
import {saveManagementJSON, privateManagementDirectory} from './management-installation.js';
import {regularFile} from './storage/files.js';
import {compareVersions, version as parseVersion} from '../updates.js';
import {panelWorkerName, panelWorkerSpec, assertPanelWorker} from './management-panel-contract.js';
import {ensureManagementVolume} from './management-volume.js';

const idOK = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
async function read(file) {
  try { return JSON.parse(await regularFile(file, {max: 1024 * 1024})); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Called only by the operator CLI through an ownership-checked Docker exec,
// after run() has durably completed and released its private workflow lease.
// There is deliberately no broker HTTP/RPC route for publishing this receipt.
export async function publishPanelRecovery(root, result) {
  assert(result && idOK(result.id) && idOK(result.fleet) && result.pending === null &&
    !result.cleanupRequired && ((result.operation?.phase === 'complete' && result.operation.state === 'succeeded') ||
      (result.operation?.phase === 'rolled-back' && result.operation.state === 'failed')), 'Only completed operator recovery can release the panel guard.', 409);
  const directory = path.join(root, 'panel-updates'), job = await read(path.join(directory, 'current.json'));
  if (!job || job.id !== result.id) return {updated: false};
  assert(job.fleet === result.fleet && job.engine === result.engine, 'Operator recovery scope changed.', 409);
  const plan = {id: result.id, fleet: result.fleet, engine: result.engine, image: result.image, commit: result.commit, pending: null, operation: result.operation};
  await saveManagementJSON(path.join(directory, 'operator-' + job.id + '.json'), {version: 1, id: job.id, fleet: job.fleet, engine: job.engine, result: {
    plan, state: result.operation.phase === 'complete' ? 'complete' : 'rolled-back', message: 'Operator recovery completed. Management changes are available again.',
  }});
  return {updated: true};
}

// This RPC accepts release versions and retained review IDs, never Docker
// requests, host paths, mounts, commands or arbitrary image references.
export class ManagementPanel {
  constructor({root, fleet, docker, runtimeImage, profile = 'brokered', now = Date.now}) {
    assert(['brokered', 'legacy'].includes(profile), 'Unsupported management update profile.');
    Object.assign(this, {fleet, docker, runtimeImage, profile, now});
    this.root = path.join(root, 'panel-updates');
  }
  async init() {
    await fs.mkdir(this.root, {recursive: true, mode: 0o700});
    await privateManagementDirectory(this.root);
    this.version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  }
  async inspect(name) {
    try { return await this.docker('GET', '/containers/' + name + '/json'); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async current() {
    const job = await read(path.join(this.root, 'current.json'));
    if (!job) return null;
    assert(job.fleet === this.fleet && idOK(job.id) && idOK(job.attempt), 'Management update identity changed.', 409);
    const worker = await this.inspect(job.name);
    if (worker) assertPanelWorker(worker, job.spec, job.name);
    let result = await read(path.join(this.root, job.attempt, 'result.json'));
    const operator = await read(path.join(this.root, 'operator-' + job.id + '.json'));
    if (operator) {
      assert(operator.version === 1 && operator.id === job.id && operator.fleet === this.fleet && operator.engine === job.engine &&
        ['complete', 'rolled-back'].includes(operator.result?.state), 'Operator recovery receipt changed.', 409);
      if (!worker?.State?.Running) result = operator.result;
    }
    assert(!result || (['planning', 'running', 'reviewed', 'attention', 'complete', 'rolled-back', 'failed'].includes(result.state) &&
      typeof result.message === 'string' && result.message.length <= 1200 &&
      (!result.plan || result.plan.id === job.id)), 'The coordinator result changed. Preserve its records for review.', 409);
    const running = !!worker?.State?.Running;
    // The result can be durably published just before the helper exits. Do not
    // admit another helper until Docker confirms that the first has stopped.
    return {job, worker, result, running};
  }
  view(current) {
    if (!current) return {supported: true, profile: this.profile, currentVersion: this.version, update: null};
    const {job, running} = current;
    const result = job.reset === true ? {state: 'failed', message: 'The review coordinator never started. You can review the release again.'} : current.result;
    const interrupted = !running && (!result || ['running', 'planning'].includes(result.state));
    const state = running ? (job.action === 'plan' ? 'planning' : 'running') : interrupted ? 'attention' : result.state;
    return {supported: true, profile: this.profile, currentVersion: this.version, update: {
      id: job.id, requestId: job.requestId, action: job.action, version: job.version, state, expires: job.expires,
      image: result?.plan?.image || null, phase: result?.plan?.operation?.phase || null,
      committed: result?.plan?.commit === true, cleanupRequired: result?.plan?.cleanupRequired === true,
      services: result?.services || null,
      message: running ? (job.action === 'plan' ? 'Preparing the management review…' : 'Updating management services. Waiting for the panel to reconnect…') :
        interrupted ? (this.canReset(current) ? 'The review coordinator never started. Reset this failed review to try again.' : 'The coordinator stopped before reporting completion. Inspect recovery before retrying.') : result.message,
      actions: running ? [] : state === 'reviewed' ? ['apply', 'cancel'] :
        state === 'attention' ? (this.canReset(current) ? ['reset'] : result?.plan ? ['resume', ...(!result.plan.commit ? ['rollback'] : [])] : ['inspect']) : [],
    }};
  }
  canReset(current) {
    if (!current || current.job.action !== 'plan' || current.running || current.result) return false;
    const worker = current.worker;
    // No start request was durably intended, or Docker positively reports an
    // owned created container which has never run. Absence after an uncertain
    // start is insufficient: an auto-removed coordinator may have made effects.
    return !worker ? current.job.startRequested === false :
      worker.State?.Status === 'created' && worker.State.StartedAt === '0001-01-01T00:00:00Z' && !worker.State.Restarting;
  }
  blocksChanges(current) {
    return !!current && current.job.action !== 'plan' &&
      (current.running || this.view(current).update.state === 'attention');
  }
  async handle(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input), 'Invalid management update request.');
    const {action} = input;
    assert(['status', 'plan', 'apply', 'resume', 'rollback', 'cancel', 'reset'].includes(action), 'Unknown management update action.');
    const keys = action === 'status' ? ['action'] : action === 'plan' ? ['action', 'requestId', 'version'] : ['action', 'requestId', 'id', 'confirm'];
    assert(Object.keys(input).every(key => keys.includes(key)), 'Unexpected management update parameters.');
    let current = await this.current();
    if (action === 'status') return this.view(current);
    assert(idOK(input.requestId), 'Choose a fresh management request identity.');
    // Lost HTTP responses are read back. They never replay a cutover.
    if (current?.job.requestId === input.requestId) {
      assert(current.job.action === action && (action === 'plan' ? current.job.version === input.version : current.job.id === input.id), 'Request identity was reused for another action.', 409);
      return this.view(current);
    }
    assert(!current?.running, 'Wait for the current management coordinator to finish.', 409);
    if (action === 'reset') {
      assert(current && input.id === current.job.id && input.confirm === true && this.canReset(current), 'Only a confirmed never-started review can be reset. Preserve uncertain launches for operator inspection.', 409);
      if (current.worker) await this.docker('DELETE', '/containers/' + current.worker.Id);
      await saveManagementJSON(path.join(this.root, 'current.json'), {...current.job, action, requestId: input.requestId, reset: true});
      return this.view(await this.current());
    }
    let id, targetVersion;
    if (action === 'plan') {
      const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
      assert(typeof input.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(input.version) && parseVersion(input.version) && compareVersions(input.version, version) > 0, 'Choose a newer published management version.');
      assert(!current || ['complete', 'rolled-back', 'failed'].includes(this.view(current).update.state), 'Finish or cancel the retained management review first.', 409);
      id = crypto.randomBytes(16).toString('hex'); targetVersion = input.version;
    } else {
      assert(current && input.id === current.job.id && input.confirm === true, 'Confirm the retained management review.', 409);
      assert(this.view(current).update.actions.includes(action), 'This action is unavailable for the retained update.', 409);
      assert(action !== 'apply' || current.job.expires > this.now(), 'This review expired. Cancel it and review the release again.', 409);
      id = current.job.id; targetVersion = current.job.version;
    }
    const host = await this.inspect('lobby-goblin-host-' + this.fleet);
    const own = this.profile === 'legacy' ? host : await this.inspect('lobby-goblin-docker-broker-' + this.fleet);
    const project = 'lobby-goblin-fleet-' + this.fleet;
    for (const [info, role] of [[own, this.profile === 'legacy' ? 'host-controller' : 'docker-broker'], [host, 'host-controller']])
      assert(info?.Config?.Labels?.['io.lobby-goblin.fleet'] === this.fleet && info.Config.Labels['io.lobby-goblin.role'] === role && info.Config.Labels['com.docker.compose.project'] === project, 'Only an owned installer-created host supports panel updates.', 409);
    const directory = host.Config.Labels['com.docker.compose.project.working_dir'];
    assert(typeof directory === 'string' && directory.length <= 4096 && !/[\x00-\x1f]/.test(directory), 'The existing Compose installation identity is unavailable.', 409);
    const socket = own.Mounts?.filter(m => m.Type === 'bind' && m.Destination === '/var/run/docker.sock');
    const stateTarget = this.profile === 'legacy' ? '/fleet' : '/broker-state';
    const state = own.Mounts?.filter(m => m.Type === 'volume' && m.Destination === stateTarget);
    assert(socket?.length === 1 && state?.length === 1 && state[0].Name === project + (this.profile === 'legacy' ? '-state' : '-broker-state'), 'The management deployment requires operator review.', 409);
    const engine = await this.docker('GET', '/info');
    assert(engine.OSType === 'linux' && /^[A-Za-z0-9:_-]{1,128}$/.test(engine.ID || ''), 'A local Linux Docker engine is required.', 409);
    assert(own.Image === this.runtimeImage && /^sha256:[a-f0-9]{64}$/.test(own.Image), 'The broker runtime changed.', 409);
    const enrolled = await ensureManagementVolume({docker: this.docker, inspect: name => this.inspect(name), fleet: this.fleet, engine: engine.ID, image: own.Image});
    const env = Object.fromEntries((host.Config.Env || []).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
    const context = {version: 1, fleet: this.fleet, engine: engine.ID, volume: enrolled.volume, anchor: enrolled.anchor,
      profile: this.profile, kind: env.FLEET_AGENT_ONLY === 'true' ? 'host-agent' : 'fleet', image: own.Image, sourceDirectory: directory};
    if (current?.worker) await this.docker('DELETE', '/containers/' + current.worker.Id).catch(error => { if (error.status !== 404) throw error; });
    const attempt = crypto.randomBytes(16).toString('hex'), name = panelWorkerName(this.fleet, attempt);
    const scope = path.join(this.root, attempt);
    await fs.mkdir(scope, {mode: 0o700});
    const spec = panelWorkerSpec({fleet: this.fleet, attempt, image: own.Image, managementVolume: enrolled.volume, socket: socket[0].Source, volume: state[0].Name, subpath: 'panel-updates/' + attempt});
    const job = {id, fleet: this.fleet, engine: engine.ID, attempt, name, spec, startRequested: false, requestId: input.requestId, action, version: targetVersion, expires: action === 'plan' ? this.now() + 15 * 60000 : current.job.expires};
    await saveManagementJSON(path.join(scope, 'input.json'), {version: 1, fleet: this.fleet, id, action, targetVersion, context, engine: engine.ID, spec, name});
    // Intent is saved before create/start; a lost response is never permission
    // to launch another socket-owning coordinator.
    await saveManagementJSON(path.join(this.root, 'current.json'), job);
    try {
      const created = await this.docker('POST', '/containers/create?' + new URLSearchParams({name}), spec);
      assertPanelWorker(await this.inspect(created.Id), spec, name);
      job.startRequested = true;
      await saveManagementJSON(path.join(this.root, 'current.json'), job);
      await this.docker('POST', '/containers/' + created.Id + '/start');
    } catch {
      // Status inspects the exact fixed helper after an uncertain response.
      // Do not expose Docker payloads, installation paths or private plans.
    }
    return this.view(await this.current());
  }
}
