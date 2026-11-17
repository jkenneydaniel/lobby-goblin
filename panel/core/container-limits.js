import {assert} from '../common.js';

export const giB = 1024 ** 3;

export const dockerLimits = ({cpu, memoryGiB}) => ({
  NanoCpus: cpu * 1e9,
  Memory: memoryGiB * giB,
});

export const configuredLimits = ({NanoCpus, Memory}) => ({
  cpu: NanoCpus / 1e9,
  memoryGiB: Memory / giB,
});

export function containerLimitUpdate(target, {Memory, NanoCpus}) {
  const current = target.HostConfig;
  const update = {};
  if (NanoCpus !== current.NanoCpus) update.NanoCpus = NanoCpus;
  if (Memory !== current.Memory) {
    assert(
      Memory > current.Memory ||
        (target.State?.Running === false && !target.State.Restarting),
      'Stop the server before lowering its memory limit.',
      409,
    );
    update.Memory = Memory;
    // Docker's positive total includes swap. Preserve the existing swap allowance.
    update.MemorySwap =
      current.MemorySwap === -1
        ? -1
        : current.MemorySwap > 0
          ? Memory + Math.max(0, current.MemorySwap - current.Memory)
          : Memory * 2;
  }
  return update;
}
