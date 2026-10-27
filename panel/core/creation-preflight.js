import fs from 'node:fs/promises';
import {validateManagedCreation} from './managed-game.js';
import {selectedRuntime} from './runtime-option.js';
import {imageMatch} from './image-policy.js';
import {publicSoftwareDelivery} from './software-delivery.js';

const GiB = 1024 ** 3;

// Advisory inspection only: no image pulls, port/volume reservations, workers,
// snapshot reads or game controls. Creation independently rechecks admission.
export async function creationPreflight(manager, request) {
  const module = manager.module(request?.game);
  let input = validateManagedCreation(request, module);
  const snapshot = input.snapshotId ? manager.snapshot(input.snapshotId) : null;
  // Disabled selectors are omitted by browsers and older clients. Infer only
  // from the snapshot ledger here; creation still verifies its exact receipt.
  if (snapshot && !input.softwareMode && module.managed.runtime) {
    const option = module.managed.runtime;
    input = {
      ...input,
      softwareMode: imageMatch(option.imagePolicy, snapshot.image)
        ? option.key || 'runtime'
        : module.managed.software?.mode || 'image',
    };
  }
  const runtime = selectedRuntime(module.managed, input),
    policy = runtime?.software || module.managed.software,
    checks = [];
  const add = (id, label, status, message) =>
    checks.push({id, label, status, message});
  let info;
  try {
    info = await manager.docker('GET', '/info');
  } catch {
    info = null;
  }
  const supportedHost =
    info?.OSType === 'linux' && ['amd64', 'x86_64'].includes(info.Architecture);
  add(
    'platform',
    'Host platform',
    supportedHost ? 'pass' : 'fail',
    supportedHost
      ? 'Linux amd64 is supported by this host manager.'
      : 'This host manager requires Linux amd64. Choose a supported host.',
  );
  const engineReady =
    Number(String(info?.ServerVersion || '').split('.')[0]) >= 26;
  add(
    'engine',
    'Storage support',
    engineReady ? 'pass' : 'fail',
    engineReady
      ? 'Docker supports isolated application storage.'
      : 'Docker Engine 26 or newer must be available.',
  );
  const allocated = manager
      .allocations()
      .reduce((sum, item) => sum + item.totalGiB, 0),
    available = Math.max(0, manager.memoryBudgetGiB - allocated),
    required = input.memoryGiB + 1,
    budgetReady =
      required <= available &&
      Number.isFinite(info?.MemTotal) &&
      (allocated + required + 2) * GiB <= info.MemTotal;
  add(
    'memory',
    'Memory allocation',
    budgetReady ? 'pass' : 'fail',
    `${required} GiB needed including the controller; ${available} GiB remains in the managed budget. The host keeps another 2 GiB for management.`,
  );
  const cpuKnown = Number.isInteger(info?.NCPU) && info.NCPU > 0;
  add(
    'cpu',
    'CPU limit',
    cpuKnown ? (input.cpu <= info.NCPU ? 'pass' : 'warning') : 'warning',
    cpuKnown
      ? `${input.cpu} CPU requested; the host has ${info.NCPU}. CPU limits can share capacity across applications.`
      : 'Host CPU capacity could not be inspected. Choose a limit appropriate for this host.',
  );
  const preparationReady = !runtime?.controllerPrepared || !!manager.broker;
  add(
    'preparation',
    'Software preparation',
    preparationReady ? 'pass' : 'fail',
    preparationReady
      ? runtime?.controllerPrepared
        ? 'The host supports private, brokered software preparation.'
        : 'The selected installation method is supported.'
      : 'Update this host to use private software preparation.',
  );
  if (snapshot) {
    const image =
        runtime?.imagePolicy.defaultImage || module.managed.catalog.image,
      compatible =
        snapshot.game === module.id &&
        module.managed.snapshots.compatible(snapshot.image, image);
    add(
      'snapshot',
      'Copied data',
      compatible ? 'pass' : 'fail',
      compatible
        ? 'Snapshot metadata matches this application and installation method. Its archive is verified during creation.'
        : 'This copied snapshot needs its compatible application and installation method.',
    );
  }
  let freeBytes = null;
  try {
    const space = await fs.statfs(manager.root);
    freeBytes = space.bavail * space.bsize;
  } catch {
    /* Report unknown capacity; installers enforce their exact space requirements. */
  }
  add(
    'disk',
    'Host storage',
    'information',
    freeBytes === null
      ? 'Available storage could not be inspected. Installation checks its exact requirements before publication.'
      : `${(freeBytes / GiB).toFixed(1)} GiB is available on management storage. Software, worlds and retained recovery copies need additional space; installation checks its exact requirements.`,
  );
  return {
    version: 1,
    ready: !checks.some((check) => check.status === 'fail'),
    application: module.id,
    softwareMode:
      input.softwareMode || module.managed.software?.mode || 'image',
    software: publicSoftwareDelivery(policy),
    requiredMemoryGiB: required,
    freeBytes,
    checks,
    message:
      'No resources have been reserved. Availability and snapshot integrity are checked again when creation starts.',
  };
}
