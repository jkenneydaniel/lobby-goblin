import crypto from 'node:crypto';
import {ManagementFailure, managementFailure} from './management-errors.js';
import {assert} from '../common.js';
import {run} from '../install.js';
import {docker as dockerAPI, demultiplex} from './docker.js';
import {managementImage} from './management-installation.js';
import {managementVolume, managementAnchor, assertAnchor, assertVolume, ensureManagementVolume} from './management-volume.js';
import {operatorWorkerSpec, assertPanelWorker, panelWorkerName} from './management-panel-contract.js';

export function localDockerSocket(endpoint, platform = process.platform) {
  assert(typeof endpoint === 'string', 'Select a local Docker context.');
  if (endpoint.startsWith('unix:///')) return decodeURIComponent(endpoint.slice(7));
  if (platform === 'win32' && /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)) return endpoint.slice(8).replaceAll('/', '\\');
  assert(false, 'Management recovery requires a local Unix or Windows named-pipe Docker context. Remote contexts are not adopted.', 409);
}
export async function nativeDocker({execute = run, env = process.env, platform = process.platform, api = dockerAPI} = {}) {
  assert(env.DOCKER_BROKER_SOCKET === undefined && env.DOCKER_BROKER_TOKEN_FILE === undefined, 'Run operator recovery outside application and broker credentials.');
  const endpoint = env.DOCKER_CONTEXT ? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', '--', env.DOCKER_CONTEXT])).trim() :
    env.DOCKER_HOST || (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim();
  const socketPath = localDockerSocket(endpoint, platform);
  return (method, route, body, options) => api(method, route, body, {...options, socketPath});
}
export async function operatorManagement(command, options, {docker, execute = run, env = process.env, platform = process.platform} = {}) {
  const fleet = options.fleet;
  assert(/^[a-f0-9]{32}$/.test(fleet || ''), 'Choose the existing fleet ID.');
  assert(['runtime', 'plan', 'status', 'apply', 'resume', 'rollback'].includes(command), 'Choose a supported operator command.');
  if (!['runtime', 'plan'].includes(command)) assert(/^[a-f0-9]{32}$/.test(options.id || ''), 'Choose the retained management update ID.');
  if (['apply', 'resume', 'rollback'].includes(command)) assert(options.confirm === true, 'Confirm the reviewed management update or recovery.');
  docker ||= await nativeDocker({execute, env, platform});
  const info = await docker('GET', '/info');
  assert(info.OSType === 'linux' && /^[A-Za-z0-9:_-]{1,128}$/.test(info.ID || '') && (!options.engine || options.engine === info.ID), 'The reviewed Linux Docker engine changed.', 409);
  const inspect = async name => { try { return await docker('GET', '/containers/' + encodeURIComponent(name) + '/json'); } catch (error) { if (error.status !== 404) throw error; return null; } };
  let anchor = await inspect(managementAnchor(fleet)), context;
  if (command === 'plan') {
    assert(managementImage(options.image), 'Choose a reviewed immutable management image.');
    const candidate = await docker('GET', '/images/' + encodeURIComponent(options.image) + '/json');
    assert(candidate.Config?.Labels?.['io.lobby-goblin.runtime'] === '1' && candidate.Config.Labels['org.opencontainers.image.source'] === 'https://github.com/jkenneydaniel/lobby-goblin', 'Use the verified published management runtime.');
    const host = await inspect('lobby-goblin-host-' + fleet);
    const variables = Object.fromEntries((host?.Config?.Env || []).map(line => {const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];}));
    assert(host?.Config?.Labels?.['io.lobby-goblin.fleet'] === fleet && host.Config.Labels['io.lobby-goblin.role'] === 'host-controller' && host.Config.Labels['com.docker.compose.project'] === 'lobby-goblin-fleet-' + fleet, 'Choose the existing owned management installation.');
    const enrolled = await ensureManagementVolume({docker, inspect, fleet, engine: info.ID, image: anchor?.Image || candidate.Id});
    anchor = await inspect(enrolled.anchor);
    context = {version: 1, fleet, engine: info.ID, anchor: anchor.Id, volume: enrolled.volume, image: host.Image,
      profile: variables.DOCKER_BROKER_SOCKET ? 'brokered' : 'legacy', kind: variables.FLEET_AGENT_ONLY === 'true' ? 'host-agent' : 'fleet',
      sourceDirectory: host.Config.Labels['com.docker.compose.project.working_dir'] || ''};
  }
  if (!anchor && command === 'runtime') return {enrolled: false};
  assertAnchor(anchor, fleet, info.ID);
  assertVolume(await docker('GET', '/volumes/' + managementVolume(fleet)), fleet, info.ID);
  const source = context?.profile === 'brokered' || (!context && await inspect('lobby-goblin-docker-broker-' + fleet)) ?
    await inspect('lobby-goblin-docker-broker-' + fleet) : await inspect('lobby-goblin-host-' + fleet);
  // For recovery after management is down the standard engine-side socket is
  // available; Windows named pipes never enter a Linux container mount.
  const socket = source?.Mounts?.find(m => m.Type === 'bind' && m.Destination === '/var/run/docker.sock')?.Source || '/var/run/docker.sock';
  const attempt = crypto.randomBytes(16).toString('hex'), name = panelWorkerName(fleet, attempt);
  const input = {fleet, engine: info.ID, action: command, ...(context && {context}), ...(command === 'plan' ? {id: crypto.randomBytes(16).toString('hex')} : options.id && {id: options.id}),
    ...(options.image && {image: options.image}), ...(options.confirm === true && {confirm: true}), attempt, name, socket, volume: managementVolume(fleet)};
  const spec = operatorWorkerSpec({fleet, attempt, image: anchor.Image, socket, managementVolume: managementVolume(fleet), request: input});
  let created;
  try {
    created = await docker('POST', '/containers/create?' + new URLSearchParams({name}), spec);
    assertPanelWorker(await inspect(created.Id), spec, name);
    await docker('POST', '/containers/' + created.Id + '/start');
    const stopped = await docker('POST', '/containers/' + created.Id + '/wait?condition=not-running', undefined, {timeout: 1200000});
    const logs = await docker('GET', '/containers/' + created.Id + '/logs?stdout=1&stderr=0', undefined, {raw: true});
    const value = JSON.parse(demultiplex(logs).trim());
    if (stopped.StatusCode !== 0 || value.error) throw ManagementFailure.fromDiagnostic(value.diagnostic);
    return value;
  } catch (error) {
    const diagnostic = managementFailure(error);
    throw Object.assign(new Error(diagnostic.message + ' ' + diagnostic.action + ' [' + diagnostic.code + '] Coordinator: ' + name + (input.id ? '. Update ID: ' + input.id : ''), {cause: error}), {status: 409, diagnostic});
  } finally {
    if (created) {
      const current = await inspect(created.Id);
      if (current && current.State.Running === false) {
        assertPanelWorker(current, spec, name);
        await docker('DELETE', '/containers/' + created.Id);
      }
    }
  }
}
