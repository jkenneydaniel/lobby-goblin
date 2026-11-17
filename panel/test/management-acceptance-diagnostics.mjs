// Fixture-only: imported by explicitly instrumented acceptance copies, never
// production modules. Async-local stages exclude unrelated concurrent requests.
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export const diagnosticPrefix = 'LGB_ACCEPTANCE_DOCKER ';
export const failurePrefix = 'LGB_ACCEPTANCE_FAILURE ';
export const maxRecords = 64;
export const maxLogBytes = 64 * 1024;
const context = new AsyncLocalStorage();
const stages = ['unknown', 'initial-inspection', 'host-inspection', 'owner-inspection', 'engine-check', 'recovery-enrollment', 'retained-worker-delete', 'worker-create', 'worker-inspection', 'worker-start', 'final-inspection'];
const methods = ['GET', 'POST', 'DELETE'];
const operations = ['container-inspect', 'engine-info', 'volume-inspect', 'volume-create', 'container-create', 'container-delete', 'container-start', 'container-exec', 'exec-start', 'exec-inspect', 'other'];
const transports = ['timeout', 'socket', 'other'];
const operation = (method, route) => {
  if (typeof route !== 'string' || route.length > 8192) return 'other';
  const pathname = route.split('?')[0];
  if (method === 'GET' && pathname === '/info') return 'engine-info';
  if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) return 'container-inspect';
  if (method === 'GET' && /^\/volumes\/[^/]+$/.test(pathname)) return 'volume-inspect';
  if (method === 'POST' && pathname === '/volumes/create') return 'volume-create';
  if (method === 'POST' && pathname === '/containers/create') return 'container-create';
  if (method === 'DELETE' && /^\/containers\/[^/]+$/.test(pathname)) return 'container-delete';
  if (method === 'POST' && /^\/containers\/[^/]+\/start$/.test(pathname)) return 'container-start';
  if (method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(pathname)) return 'container-exec';
  if (method === 'POST' && /^\/exec\/[^/]+\/start$/.test(pathname)) return 'exec-start';
  if (method === 'GET' && /^\/exec\/[^/]+\/json$/.test(pathname)) return 'exec-inspect';
  return 'other';
};

export function validDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return value.phase === 'apply' && stages.includes(value.stage) && methods.includes(value.method) && operations.includes(value.operation) &&
    (keys === 'method,operation,phase,stage,status' ? Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 :
      keys === 'method,operation,phase,stage,transport' && transports.includes(value.transport));
}

export function managementApplyDiagnostics(action, work, emit = line => console.log(line)) {
  return action === 'apply' ? context.run({stage: 'unknown', ledger: {count: 0, emit}}, work) : work();
}
export function managementDiagnosticStage(stage, work) {
  const current = context.getStore();
  return current ? context.run({...current, stage: stages.includes(stage) ? stage : 'unknown'}, work) : work();
}
export function dockerDiagnostic(method, route) {
  const current = context.getStore();
  let received = false, recorded = false;
  const record = fields => {
    if (!current || recorded || current.ledger.count >= maxRecords) return;
    const value = {phase: 'apply', stage: current.stage, method, operation: operation(method, route), ...fields};
    if (!validDiagnostic(value)) return;
    recorded = true;
    current.ledger.count++;
    // Diagnostics must never change the original transport outcome.
    try { current.ledger.emit(diagnosticPrefix + JSON.stringify(value)); } catch {}
  };
  return {
    http(status) { received = Number.isInteger(status) && status >= 100 && status <= 599; if (received) record({status}); },
    transport(error) {
      if (received) return;
      const category = error?.message === 'Docker operation timed out.' ? 'timeout' : ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code) ? 'socket' : 'other';
      record({transport: category});
    },
  };
}

export function diagnosticRecords(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxLogBytes) return [];
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(diagnosticPrefix) || line.length > 512) continue;
    try {
      const value = JSON.parse(line.slice(diagnosticPrefix.length));
      if (validDiagnostic(value)) records.push(value);
    } catch {}
    if (records.length === maxRecords) break;
  }
  return records;
}
export async function withApplyFailureDiagnostics(work, collect, emit = line => console.log(line)) {
  try { return await work(); }
  catch (original) {
    let records = [];
    try { records = diagnosticRecords(await collect()); } catch {}
    try { emit(failurePrefix + JSON.stringify({version: 1, complete: false, failed: true, records})); } catch {}
    throw original;
  }
}
export function safeFailureReports(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxLogBytes) return [];
  const result = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(failurePrefix) || line.length > 20 * 1024) continue;
    try {
      const value = JSON.parse(line.slice(failurePrefix.length));
      if (value && Object.keys(value).sort().join(',') === 'complete,failed,records,version' && value.version === 1 && value.complete === false && value.failed === true && Array.isArray(value.records) && value.records.length <= maxRecords && value.records.every(validDiagnostic)) result.push(value);
    } catch {}
    if (result.length === 1) break;
  }
  return result;
}

// Fail closed when the source shape changes. Call only on the fresh prepared
// context; this helper never resolves or edits a checkout production path.
export async function instrumentManagementAcceptance(panel) {
  const marker = await fs.readFile(path.join(panel, '../acceptance-source.json'), 'utf8');
  assert.equal(JSON.parse(marker).testOnlyModule, 'arena');
  const replace = (source, needle, replacement) => {
    assert.equal(source.split(needle).length, 2, 'Acceptance diagnostic source boundary changed.');
    return source.replace(needle, replacement);
  };
  const file = path.join(panel, 'core/docker.js');
  let source = await fs.readFile(file, 'utf8');
  source = "import {dockerDiagnostic} from '../test/management-acceptance-diagnostics.mjs';\n" + source;
  source = replace(source, '    const req=http.request(', '    const diagnostic=dockerDiagnostic(method,route);\n    const req=http.request(');
  source = replace(source, '},res=>{', '},res=>{\n      diagnostic.http(res.statusCode);');
  source = replace(source, "req.on('error',reject)", "req.on('error',error=>{diagnostic.transport(error);reject(error);})");
  const management = path.join(panel, 'core/management-panel.js');
  let controller = await fs.readFile(management, 'utf8');
  controller = "import {managementApplyDiagnostics,managementDiagnosticStage} from '../test/management-acceptance-diagnostics.mjs';\n" + controller;
  controller = replace(controller, '  async handle(input) {', "  handle(input) { return managementApplyDiagnostics(input?.action,()=>this.acceptanceHandle(input)); }\n  async acceptanceHandle(input) {");
  for (const [needle, replacement] of [
    ['let current = await this.current();', "let current = await managementDiagnosticStage('initial-inspection',()=>this.current());"],
    ["const host = await this.inspect('lobby-goblin-host-' + this.fleet);", "const host = await managementDiagnosticStage('host-inspection',()=>this.inspect('lobby-goblin-host-' + this.fleet));"],
    ["await this.inspect('lobby-goblin-docker-broker-' + this.fleet);", "await managementDiagnosticStage('owner-inspection',()=>this.inspect('lobby-goblin-docker-broker-' + this.fleet));"],
    ["const engine = await this.docker('GET', '/info');", "const engine = await managementDiagnosticStage('engine-check',()=>this.docker('GET', '/info'));"],
    ["const enrolled = await ensureManagementVolume({docker: this.docker, inspect: name => this.inspect(name), fleet: this.fleet, engine: engine.ID, image: own.Image});", "const enrolled = await managementDiagnosticStage('recovery-enrollment',()=>ensureManagementVolume({docker: this.docker, inspect: name => this.inspect(name), fleet: this.fleet, engine: engine.ID, image: own.Image}));"],
    ["if (current?.worker) await this.docker('DELETE', '/containers/' + current.worker.Id).catch(error => { if (error.status !== 404) throw error; });", "if (current?.worker) await managementDiagnosticStage('retained-worker-delete',()=>this.docker('DELETE', '/containers/' + current.worker.Id).catch(error => { if (error.status !== 404) throw error; }));"],
    ["const created = await this.docker('POST', '/containers/create?' + new URLSearchParams({name}), spec);", "const created = await managementDiagnosticStage('worker-create',()=>this.docker('POST', '/containers/create?' + new URLSearchParams({name}), spec));"],
    ['assertPanelWorker(await this.inspect(created.Id), spec, name);', "assertPanelWorker(await managementDiagnosticStage('worker-inspection',()=>this.inspect(created.Id)), spec, name);"],
    ["await this.docker('POST', '/containers/' + created.Id + '/start');", "await managementDiagnosticStage('worker-start',()=>this.docker('POST', '/containers/' + created.Id + '/start'));"],
    ['    return this.view(await this.current());\n  }\n}', "    return this.view(await managementDiagnosticStage('final-inspection',()=>this.current()));\n  }\n}"],
  ]) controller = replace(controller, needle, replacement);
  await fs.writeFile(file, source);
  await fs.writeFile(management, controller);
}
