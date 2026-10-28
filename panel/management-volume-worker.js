// Fixed operator entrypoint. Host Docker context transport remains on the host;
// private records and Unix ownership stay entirely inside the Linux engine.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from './common.js';
import {docker} from './core/docker.js';
import {ManagementEngine} from './fleet/management-engine.js';
import {ManagementUpdate} from './fleet/management-update.js';
import {volumeInstallation, volumeRuntime, portableRuntimeOverlay} from './core/management-volume.js';
import {readManagementJSON} from './core/management-installation.js';
import {operatorWorkerSpec, assertPanelWorker} from './core/management-panel-contract.js';

export async function main({env = process.env, log = console.log} = {}) {
  const input = JSON.parse(env.MANAGEMENT_REQUEST || 'null');
  assert(input && /^[a-f0-9]{32}$/.test(input.fleet) && ['runtime', 'plan', 'status', 'apply', 'resume', 'rollback'].includes(input.action), 'Invalid management operator scope.');
  if (input.action === 'runtime') {
    // No daemon socket, network or writable metadata mount in this mode.
    const runtime = await volumeRuntime('/management', input);
    if (input.output === 'compose') {
      assert(runtime.profile === input.profile && runtime.kind === 'fleet', 'Use the matching original Compose layout. No services were started.', 409);
      return log(JSON.stringify(portableRuntimeOverlay(runtime)));
    }
    return log(JSON.stringify(runtime));
  }
  const own = await docker('GET', '/containers/' + encodeURIComponent(input.name) + '/json');
  const spec = operatorWorkerSpec({fleet: input.fleet, attempt: input.attempt, image: own.Image, socket: input.socket,
    managementVolume: input.volume, request: input});
  assertPanelWorker(own, spec, input.name);
  const installation = input.context ? await volumeInstallation('/management', input.context) :
    await readManagementJSON('/management/installation.json');
  assert(installation.id === input.fleet && installation.management?.engine === input.engine && installation.management.volume === input.volume, 'Operator recovery storage scope changed.');
  const engine = new ManagementEngine({socket: '/var/run/docker.sock', engine: input.engine,
    coordinator: {id: own.Id, spec, name: input.name}});
  const workflow = new ManagementUpdate({directory: '/management', installation, engine});
  const result = input.action === 'plan' ? await workflow.plan(input.image, {id: input.id}) : input.action === 'status' ? await workflow.status(input.id) :
    await workflow.run(input.id, {confirm: input.confirm === true, rollback: input.action === 'rollback'});
  if (!['plan', 'status'].includes(input.action) && !result.cleanupRequired && result.pending === null)
    await engine.reconcilePanelUpdate(result, {profile: installation.management.profile});
  log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main().catch(() => { console.log(JSON.stringify({error: 'Management recovery needs inspection. Preserve its retained ID, storage and engine claim.'})); process.exitCode = 1; });
