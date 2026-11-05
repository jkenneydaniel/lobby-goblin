import {hostRoute} from './host-paths.js';
import {escapeHTML as esc} from '../shared/view.js';

function summary(value) {
  if (
    !value ||
    !['memoryBudgetGiB', 'allocatedMemoryGiB', 'availableMemoryGiB'].every(
      (key) => Number.isFinite(value[key]) && value[key] >= 0,
    ) ||
    value.availableMemoryGiB > value.memoryBudgetGiB ||
    (value.dockerMemoryGiB != null &&
      (!Number.isFinite(value.dockerMemoryGiB) || value.dockerMemoryGiB <= 0))
  )
    throw Error('Unsupported host capacity response.');
  return {
    memoryBudgetGiB: value.memoryBudgetGiB,
    allocatedMemoryGiB: value.allocatedMemoryGiB,
    availableMemoryGiB: value.availableMemoryGiB,
    dockerMemoryGiB: value.dockerMemoryGiB ?? null,
  };
}

// Read snapshots on entry/new connection or deliberate refresh, not on every
// host-list repaint. The backend accounts for controllers and retained records.
export function createHostCapacity({
  request,
  onChange = () => {},
  now = Date.now,
}) {
  const entries = new Map();
  let hosts = new Map(),
    queue = [],
    active = 0,
    disposed = false;
  const current = (key, record) =>
    !disposed && hosts.get(key)?.connected && entries.get(key) === record;
  function pump() {
    while (!disposed && active < 4 && queue.length) {
      const {key, record} = queue.shift();
      if (!current(key, record)) continue;
      active++;
      Promise.resolve()
        .then(() => {
          if (!current(key, record))
            throw new DOMException('Host view closed', 'AbortError');
          return request(key, {
            method: 'GET',
            signal: AbortSignal.any([
              record.abort.signal,
              AbortSignal.timeout(10000),
            ]),
          });
        })
        .then((value) => {
          if (!current(key, record)) return;
          record.data = summary(value);
          record.checkedAt = now();
          record.state = 'ready';
        })
        .catch(() => {
          if (current(key, record)) record.state = 'unavailable';
        })
        .finally(() => {
          active--;
          if (current(key, record)) onChange();
          pump();
        });
    }
  }
  function schedule(key, force = false) {
    if (!hosts.get(key)?.connected) return;
    const previous = entries.get(key);
    if (previous && (!force || previous.state === 'loading')) return;
    const record = {state: 'loading', abort: new AbortController()};
    entries.set(key, record);
    queue.push({key, record});
  }
  return {
    get(host) {
      return entries.get(hostRoute(host, '/host-settings'));
    },
    get loading() {
      return [...entries.values()].some((item) => item.state === 'loading');
    },
    sync(value) {
      if (disposed) return;
      hosts = new Map(
        value.map((host) => [hostRoute(host, '/host-settings'), host]),
      );
      for (const [key, record] of entries)
        if (!hosts.get(key)?.connected) {
          record.abort?.abort();
          entries.delete(key);
        }
      for (const key of hosts.keys()) schedule(key);
      onChange();
      pump();
    },
    refresh() {
      if (disposed) return;
      for (const key of hosts.keys()) schedule(key, true);
      onChange();
      pump();
    },
    dispose() {
      disposed = true;
      for (const record of entries.values()) record.abort.abort();
      entries.clear();
      hosts.clear();
      queue = [];
    },
  };
}

export function hostCapacityView(host, record) {
  if (!host.connected)
    return '<p class="hint">Capacity unavailable while this host is offline.</p>';
  if (!record || record.state === 'loading')
    return '<p class="hint">Checking configured capacity…</p>';
  if (record.state !== 'ready')
    return '<p class="hint">Capacity unavailable. Refresh capacity to try again.</p>';
  const data = record.data;
  return `<h4>Configured memory</h4><dl class="capacity-summary"><div><dt>Host budget</dt><dd>${esc(data.memoryBudgetGiB)} GiB</dd></div><div><dt>Allocated, including controllers</dt><dd>${esc(data.allocatedMemoryGiB)} GiB</dd></div><div><dt>Available to allocate</dt><dd>${esc(data.availableMemoryGiB)} GiB</dd></div><div><dt>Docker capacity</dt><dd>${data.dockerMemoryGiB === null ? 'Not reported' : esc(data.dockerMemoryGiB.toFixed(1)) + ' GiB'}</dd></div></dl><p class="hint">Configured allocations, not live RAM usage. Checked ${esc(new Date(record.checkedAt).toLocaleString())}. Creation rechecks current capacity.</p>`;
}
