import {assert} from '../common.js';
import {resources, validId} from './instance.js';
import {
  softwareWorkerKind,
  softwareWorkerId,
  softwareWorkerName,
  softwareWorkerDeployment,
} from './software-worker-policy.js';

const application = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export function preparationWorker(info, fleet) {
  const marker = info?.Config?.Labels || {},
    id = marker['io.lobby-goblin.instance'],
    game = marker['io.lobby-goblin.game'],
    request = marker['io.lobby-goblin.worker-request'];
  return (
    marker['io.lobby-goblin.fleet'] === fleet &&
    validId(id) &&
    application(game) &&
    marker['io.lobby-goblin.worker'] === 'true' &&
    marker['io.lobby-goblin.worker-kind'] === softwareWorkerKind &&
    marker['io.lobby-goblin.worker-action'] === 'prepare' &&
    softwareWorkerId(request) &&
    info.Name === '/' + softwareWorkerName(id, request) &&
    info.Config.Image === softwareWorkerDeployment.image &&
    info.Image === softwareWorkerDeployment.imageId
  );
}
export function applicationContainer(info, fleet) {
  const marker = info?.Config?.Labels || {},
    id = marker['io.lobby-goblin.instance'],
    game = marker['io.lobby-goblin.game'];
  return (
    marker['io.lobby-goblin.fleet'] === fleet &&
    validId(id) &&
    application(game) &&
    !marker['io.lobby-goblin.worker'] &&
    !marker['io.lobby-goblin.role'] &&
    info.Name === '/' + resources(fleet, id, game).container
  );
}
const stopped = (info) =>
  info?.State?.Running === false && info.State.Restarting !== true;

// A preparation worker temporarily uses its stopped application's reservation.
// Other stopped applications keep their reservations. Unknown or duplicate
// claims never reduce the broker's admission total.
export function softwareReservedMemory(containers, fleet) {
  const claims = new Map();
  for (const info of containers.filter((info) =>
    preparationWorker(info, fleet),
  )) {
    const id = info.Config.Labels['io.lobby-goblin.instance'];
    claims.set(id, [...(claims.get(id) || []), info]);
  }
  return containers.reduce((total, info) => {
    const matches =
      claims.get(info.Config?.Labels?.['io.lobby-goblin.instance']) || [];
    const reused =
      applicationContainer(info, fleet) &&
      stopped(info) &&
      matches.length === 1 &&
      Number.isSafeInteger(matches[0].HostConfig?.Memory) &&
      matches[0].HostConfig.Memory > 0 &&
      matches[0].HostConfig.Memory <= info.HostConfig?.Memory;
    return (
      total +
      (info.HostConfig?.Memory || 0) -
      (reused ? matches[0].HostConfig.Memory : 0)
    );
  }, 0);
}
export function assertPreparationAdmission(containers, candidate, fleet) {
  if (!preparationWorker(candidate, fleet)) return;
  const id = candidate.Config.Labels['io.lobby-goblin.instance'];
  const owner = containers.find(
    (info) =>
      applicationContainer(info, fleet) &&
      info.Config.Labels['io.lobby-goblin.instance'] === id,
  );
  assert(
    stopped(owner) && owner.HostConfig?.Memory >= candidate.HostConfig.Memory,
    'Stop the allocated application before software preparation.',
    409,
  );
  assert(
    !containers.some(
      (info) =>
        info.Config?.Labels?.['io.lobby-goblin.instance'] === id &&
        info.Config.Labels['io.lobby-goblin.worker'] === 'true',
    ),
    'Finish the existing instance worker before preparing software.',
    429,
  );
}
export function assertApplicationStart(containers, owner, fleet) {
  if (!applicationContainer(owner, fleet)) return;
  const id = owner.Config.Labels['io.lobby-goblin.instance'];
  assert(
    !containers.some(
      (info) =>
        preparationWorker(info, fleet) &&
        info.Config.Labels['io.lobby-goblin.instance'] === id,
    ),
    'Finish software preparation before starting the application.',
    409,
  );
}
