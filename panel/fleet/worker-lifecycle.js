import {assert} from '../common.js';

const requestId = (name) =>
  /^lobby-goblin-worker-([a-f0-9]{32})$/.exec(name)?.[1];
const instanceId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// These are receipts in the owning host job, rather than conclusions inferred
// from a worker label or a stopped Docker state. Unrecorded/instance-owned
// workers remain the responsibility of their native workflow and recovery UI.
export async function hostWorkerLifecycle(manager, name, instance) {
  const job = manager.active;
  assert(
    requestId(name) &&
      instanceId(instance) &&
      job &&
      manager.state.jobs?.includes(job) &&
      job.state === 'running',
    'Host workers require an active recorded host operation.',
    409,
  );
  const receipts = job.workerReceipts || [];
  assert(
    receipts.length < 64 && !receipts.some((receipt) => receipt.name === name),
    'Host worker request is already recorded or exceeds its operation budget.',
    409,
  );
  const receipt = {version: 1, name, instance, phase: 'reserved'};
  job.workerReceipts = [...receipts, receipt];
  await manager.persist();
  const review = async () => {
    job.recovery = {
      ...job.recovery,
      required: true,
      state: 'inspection-required',
      interruptedPhase: job.phase || 'unknown',
      retryable: false,
      message:
        'Worker teardown could not be proven. Inspect its recorded request and container before acknowledging this operation.',
    };
    await manager.persist();
  };
  return {
    async created(id) {
      assert(
        typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
        'Worker creation did not return an immutable ID.',
        409,
      );
      receipt.containerId = id;
      receipt.phase = 'created';
      await manager.persist();
    },
    async collected(exitCode) {
      assert(
        receipt.containerId && Number.isSafeInteger(exitCode) && exitCode >= 0,
        'Collect a verified worker exit before releasing it.',
        409,
      );
      receipt.exitCode = exitCode;
      receipt.phase = 'collected';
      await manager.persist();
    },
    async removed() {
      receipt.phase = 'removed';
      await manager.persist();
    },
    review,
    async teardown(effect) {
      try {
        await effect();
      } catch (error) {
        await review().catch(() => {});
        throw error;
      }
    },
  };
}

export function collectableHostWorker(manager, info) {
  const name = info.Name?.replace(/^\//, '');
  if (
    !requestId(name) ||
    info.State?.Status !== 'exited' ||
    info.State.Running ||
    info.State.Restarting ||
    info.State.Paused
  )
    return null;
  const marker = info.Config?.Labels || {};
  if (
    marker['io.lobby-goblin.fleet'] !== manager.fleet ||
    marker['io.lobby-goblin.worker'] !== 'true'
  )
    return null;
  const matches = (manager.state.jobs || []).flatMap((job) =>
    (Array.isArray(job.workerReceipts) ? job.workerReceipts : []).filter(
      (receipt) =>
        receipt &&
        typeof receipt === 'object' &&
        receipt.version === 1 &&
        receipt.name === name &&
        receipt.containerId === info.Id &&
        receipt.instance === marker['io.lobby-goblin.instance'] &&
        instanceId(receipt.instance) &&
        receipt.phase === 'collected' &&
        receipt.exitCode === info.State.ExitCode &&
        ['succeeded', 'failed'].includes(job.state) &&
        !job.recovery?.required &&
        Number.isFinite(Date.parse(job.finished)) &&
        job.id !== manager.active?.id,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}
