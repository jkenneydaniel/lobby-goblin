import {cpus} from 'node:os';

const intervalMs = 5000;

export function createHostCpuSampler({read = cpus, now = () => performance.now()} = {}) {
  let previous = null;
  let sample = null;
  function take() {
    const cores = read();
    if (!cores.length) {
      previous = null;
      return;
    }
    const current = cores.map(({times}) => ({
      idle: times.idle,
      total: Object.values(times).reduce((sum, time) => sum + time, 0),
    }));
    const prior = previous;
    previous = current;
    if (prior?.length !== current.length) return;
    let total = 0;
    let idle = 0;
    for (const [index, cpu] of current.entries()) {
      const elapsed = cpu.total - prior[index].total;
      const idleTime = cpu.idle - prior[index].idle;
      if (!Number.isFinite(elapsed) || !Number.isFinite(idleTime) || idleTime < 0 || elapsed < idleTime)
        return;
      total += elapsed;
      idle += idleTime;
    }
    if (total > 0)
      sample = {percent: Math.round(100 * (total - idle) / total), at: now()};
  }
  take();
  const timer = setInterval(take, intervalMs).unref();
  return {
    read: () => sample && {percent: sample.percent, ageMs: Math.max(0, Math.round(now() - sample.at))},
    close: () => clearInterval(timer),
  };
}

// Remote clocks can disagree. Translate the controller's elapsed sample age to
// the clock serving the host inventory, without trusting a remote wall clock.
export function hostCpuSample(value, now) {
  if (!Number.isFinite(value?.percent) || value.percent < 0 || value.percent > 100 ||
      !Number.isSafeInteger(value.ageMs) || value.ageMs < 0 || value.ageMs > now)
    return null;
  return {percent: value.percent, sampledAt: now - value.ageMs};
}
