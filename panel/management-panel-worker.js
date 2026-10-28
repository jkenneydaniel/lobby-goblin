import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from './common.js';
import {readInstallation} from './install.js';
import {readHostInstallation} from './host-install.js';
import {docker} from './core/docker.js';
import {panelImage, panelRepository, validatePanelImage} from './core/panel-image.js';
import {assertPanelWorker} from './core/management-panel-contract.js';
import {readManagementJSON} from './core/management-installation.js';
import {syncDirectory} from './core/storage/files.js';
import {ManagementEngine} from './fleet/management-engine.js';
import {ManagementUpdate} from './fleet/management-update.js';
import {volumeInstallation} from './core/management-volume.js';

export async function resolvePanelRuntime(engine, version) {
  const tag = panelImage(version);
  await engine.request('POST', '/images/create?' + new URLSearchParams({fromImage: tag}), undefined, {raw: true, timeout: 900000});
  const image = await engine.request('GET', '/images/' + encodeURIComponent(tag) + '/json');
  const digest = panelRepository + '@' + validatePanelImage(image, version).split('@')[1];
  assert((await engine.request('GET', '/images/' + encodeURIComponent(digest) + '/json')).Id === image.Id, 'The release image changed while planning.');
  return digest;
}

export async function runPanelUpdate({input, workflow, resolveImage, save}) {
  let plan;
  const publish = async (state, message, services) => {
    plan = await workflow.status(input.id).catch(() => plan);
    await save({state, message, ...(plan && {plan}), ...(services && {services})});
  };
  try {
    if (input.action === 'plan') {
      plan = await workflow.plan(await resolveImage(input.targetVersion), {id: input.id});
      const context = await workflow.load(input.id);
      await publish('reviewed', 'Review complete. Management services will restart together; game containers keep running.', {
        management: context.plan.services.length, applications: context.plan.games.length,
      });
      return;
    }
    plan = await workflow.status(input.id);
    const rollback = ['cancel', 'rollback'].includes(input.action);
    // Progress is mirrored into the scoped broker record. It contains only the
    // public workflow summary; original configurations never leave installation storage.
    await publish('running', 'Management update is in progress.');
    let progress = Promise.resolve();
    const timer = setInterval(() => { progress = progress.then(() => publish('running', 'Management update is in progress.')).catch(() => {}); }, 2000);
    try {
      plan = await workflow.run(input.id, {confirm: true, rollback});
    } finally { clearInterval(timer); await progress; }
    await publish(plan.cleanupRequired ? 'attention' : rollback ? 'rolled-back' : 'complete', plan.cleanupRequired ?
      'Management services are available. Finish retained coordinator cleanup before another update.' : rollback ?
        'The update was cancelled or rolled back. Previous management services were preserved.' :
        'Management update complete. Application containers and storage were preserved.');
  } catch {
    plan = await workflow.status(input.id).catch(() => plan);
    const recover = !!plan || input.action !== 'plan';
    await publish(recover ? 'attention' : 'failed', recover ?
      'The management update needs recovery. Keep the retained update ID and recovery records.' :
      'The management review failed. Check the selected release and installation using the host update guide.');
  }
}

export async function main() {
  // Only the fixed broker helper can reach this entry point. No command-line
  // options or inherited broker credentials can redirect its authority.
  const input = await readManagementJSON('/request/input.json');
  assert(input.version === 1 && /^[a-f0-9]{32}$/.test(input.fleet) && /^[a-f0-9]{32}$/.test(input.id) &&
    ['plan', 'apply', 'resume', 'rollback', 'cancel'].includes(input.action) &&
    (input.context || path.isAbsolute(input.directory) && input.directory !== '/'), 'Invalid coordinator scope.');
  const own = await docker('GET', '/containers/' + input.name + '/json');
  assertPanelWorker(own, input.spec, input.name);
  let installation, directory;
  if (input.context) {
    directory = '/management';
    assert(input.context.fleet === input.fleet && input.context.engine === input.engine, 'The coordinator enrollment changed.');
    installation = await volumeInstallation(directory, input.context);
  } else {
  directory = input.directory;
  const owner = await fs.lstat(directory), socket = await fs.stat('/var/run/docker.sock');
  assert(owner.isDirectory() && !owner.isSymbolicLink() && await fs.realpath(directory) === directory && socket.isSocket(), 'The installation or Docker socket changed.');
  // Match operator ownership so the existing CLI can read/recover these records.
  // Keep only socket-group membership; no host user credentials are imported.
  // The enclosing broker-state directory stays root-only. Within this single
  // subpath, group 0 permits the coordinator to publish public progress and the
  // capability-dropped broker to read it. Operator plans remain owner-only.
  await fs.chmod('/request', 0o770);
  process.setgroups([socket.gid]); process.setgid(0); process.setuid(owner.uid);
  const central = await fs.lstat(path.join(input.directory, 'installation.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  installation = await (central ? readInstallation : readHostInstallation)(directory);
  }
  assert(installation?.id === input.fleet && installation.project === 'lobby-goblin-fleet-' + input.fleet, 'Installer identity changed. No resources were adopted.');
  const engine = new ManagementEngine({socket: '/var/run/docker.sock', engine: input.engine, coordinator: {id: own.Id, spec: input.spec, name: input.name}});
  const workflow = new ManagementUpdate({directory, installation, engine, actor: 'panel-administrator'});
  await runPanelUpdate({input, workflow,
    resolveImage: version => resolvePanelRuntime(engine, version), save: async value => {
      const temporary = '/request/result.next';
      const handle = await fs.open(temporary, 'w', 0o640);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, '/request/result.json'); await syncDirectory('/request');
    },
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main().catch(() => { console.error('The scoped management coordinator stopped. Preserve its records for operator recovery.'); process.exitCode = 1; });
