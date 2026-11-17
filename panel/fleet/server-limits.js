import {assert} from '../common.js';
import {
  configuredLimits,
  containerLimitUpdate,
  dockerLimits,
  giB,
} from '../core/container-limits.js';
import {validateResourceLimits} from '../core/managed-game.js';
import {applicationContainer} from '../core/software-worker-resources.js';
import {DockerTransportError} from '../core/docker-transport-error.js';

const sameLimits = (a, b) => a.cpu === b.cpu && a.memoryGiB === b.memoryGiB;

export function validateServerLimits(manager, item, input) {
  assert(
    item.state === 'installed' &&
      (!item.migration || item.migration.state === 'complete'),
    'Finish installing or migrating this server before editing its limits.',
    409,
  );
  assert(
    sameLimits(input.current || {}, item),
    'Limits changed in another session. Reopen Edit limits to review them.',
    409,
  );
  return {
    serverId: item.id,
    ...validateResourceLimits(input, manager.module(item.game)),
  };
}

async function ownedGame(manager, item) {
  const target = await manager.ownedContainer(item.container, item.id);
  assert(
    applicationContainer(target, manager.fleet) &&
      target.Config.Labels['io.lobby-goblin.game'] === item.game &&
      /^[a-f0-9]{64}$/.test(target.Id),
    'The registered server container changed.',
    409,
  );
  return target;
}

export async function resizeServer(manager, input, job) {
  const item = manager.server(input.serverId);
  item.maintenance = 'Changing CPU and memory limits';
  const target = await ownedGame(manager, item);
  const previous = configuredLimits(target.HostConfig);
  assert(
    sameLimits(item, previous),
    'Docker limits differ from the configured limits. Review the server before editing.',
    409,
  );
  if (sameLimits(previous, input))
    return 'CPU and memory limits are already set.';
  const desired = dockerLimits(input),
    update = containerLimitUpdate(target, desired);
  if (input.memoryGiB > previous.memoryGiB) {
    const otherMemory =
      manager.allocations().reduce((sum, server) => sum + server.totalGiB, 0) -
      previous.memoryGiB;
    assert(
      otherMemory + input.memoryGiB <= manager.memoryBudgetGiB,
      `At most ${manager.memoryBudgetGiB - otherMemory} GiB is available for this server. Review the allocation in Host settings.`,
      409,
    );
    const {MemTotal} = await manager.docker('GET', '/info');
    assert(
      (otherMemory + input.memoryGiB + 2) * giB <= MemTotal,
      'Keep at least 2 GiB of Docker memory available for host management.',
      409,
    );
  }
  await manager.stage(
    job,
    'Applying CPU and memory limits…',
    'applying-limits',
    {
      containerId: target.Id,
      cpu: input.cpu,
      memoryGiB: input.memoryGiB,
      previous,
    },
  );
  try {
    await manager.docker(
      'POST',
      '/containers/' + target.Id + '/update',
      manager.broker ? desired : update,
    );
  } catch (error) {
    // Direct Docker uses this type for an actual daemon response. The broker
    // can also use it to report a failure to reach Docker.
    const rejected =
      (!manager.broker && error instanceof DockerTransportError) ||
      (error.status >= 400 && error.status < 500);
    if (!rejected) job.target.responseUncertain = true;
    throw error;
  }
  return 'CPU and memory limits updated.';
}

// Read the engine after the request, including when the response was lost. The
// existing job checkpoint persists the observed limits with the operation.
export async function inspectServerLimits(manager, job) {
  const target = job.target;
  if (!target?.containerId)
    return {
      outcome: 'failed',
      message: 'The limit change did not reach Docker.',
    };
  const item = manager.server(target.serverId);
  const observed = await ownedGame(manager, item);
  assert(
    observed.Id === target.containerId,
    'The server container changed. Review its limits before retrying.',
    409,
  );
  const actual = configuredLimits(observed.HostConfig);
  const settled = sameLimits(actual, target);
  assert(
    ['cpu', 'memoryGiB'].every((key) =>
      [target[key], target.previous[key]].includes(actual[key]),
    ),
    'Docker returned different limits. Review the server before retrying.',
    409,
  );
  Object.assign(item, actual);
  return {
    outcome: settled ? 'succeeded' : 'failed',
    message: settled
      ? 'CPU and memory limits updated.'
      : 'Docker did not apply all requested limits. Review the current limits before retrying.',
    result: {serverId: item.id, ...actual},
  };
}

export async function settleServerLimits(manager, job) {
  if (!job.target?.containerId) return;
  const {outcome, message, result} = await inspectServerLimits(manager, job);
  if (job.state === 'failed' && sameLimits(result, job.target.previous)) {
    // An early read may still show the old limits after a transport failure.
    assert(
      !job.target.responseUncertain,
      'Docker did not confirm the limit change. Inspect its outcome before retrying.',
      409,
    );
    return;
  }
  Object.assign(job, {state: outcome, message, result});
  delete job.failure;
}
