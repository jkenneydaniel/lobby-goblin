// Shared browser transport; session cookies and server-side permissions stay unchanged.
export function createApi({
  base = '/api',
  getSession = () => null,
  onUnauthorized = () => {},
  fetcher = (...args) => fetch(...args),
} = {}) {
  const pending = new Map();
  return async function request(
    route,
    {method = 'GET', body, raw = false, signal, binary = false} = {},
  ) {
    const requestedSession = getSession();
    route = '/' + route.replace(/^\//, '');
    const operation =
      method === 'POST' &&
      !raw &&
      body &&
      (route === '/jobs' ||
        /(?:^|\/)servers(?:\/[a-f0-9]{32}\/(?:snapshot|remove))?$/.test(
          route,
        ) ||
        (route.endsWith('/jobs/recovery') && body.operation === 'retry'));
    const pendingKey =
      operation && JSON.stringify([getSession()?.username, route, body]);
    if (operation && !body.requestId) {
      if (!pending.has(pendingKey))
        pending.set(
          pendingKey,
          globalThis.crypto?.randomUUID?.() ||
            Date.now().toString(36) +
              '_' +
              Math.random().toString(36).slice(2).padEnd(16, '0'),
        );
      body = {...body, requestId: pending.get(pendingKey)};
    }
    const headers = {};
    if (method !== 'GET') headers['x-csrf-token'] = getSession()?.csrf || '';
    if (body !== undefined && !raw)
      headers['content-type'] = 'application/json';
    const response = await fetcher(base + route, {
      method,
      credentials: 'same-origin',
      headers,
      signal,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    let result;
    try {
      result =
        binary && response.ok
          ? await readResponseBytes(response)
          : await response.json();
    } catch {
      throw new Error(
        'The panel returned an incomplete response. Check the connection and try again.',
      );
    }
    if (!response.ok) {
      if (response.status < 500) pending.delete(pendingKey);
      if (
        response.status === 401 &&
        !['/login', '/register', '/registration'].includes(route) &&
        getSession() === requestedSession
      )
        onUnauthorized();
      throw Object.assign(
        new Error(result.error || 'The request could not be completed.'),
        {status: response.status},
      );
    }
    pending.delete(pendingKey);
    return result;
  };
}

// Explicit binary files retain the same authentication and error handling.
async function readResponseBytes(response) {
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024 * 1024)
        throw new Error('Response exceeds its delivery budget.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const playerCount = (value) =>
  Array.isArray(value) ? value.length : Number.isFinite(value) ? value : null;
export function sameImageReference(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const [a, ad] = from.split('@'),
    [b, bd] = to.split('@');
  return a === b && (!ad || !bd || ad === bd);
}
export function serverState(value) {
  if (!value) return {label: 'Unavailable', state: 'attention'};
  if (value.imageMigration)
    return {label: 'Needs attention', state: 'attention'};
  if (value.summary) {
    const labels = {
      ready: 'Ready',
      paused: 'Paused',
      starting: 'Starting',
      stopped: 'Stopped',
      unavailable: 'Unavailable',
    };
    return {
      label: labels[value.summary.state] || 'Unavailable',
      state: ['ready', 'paused'].includes(value.summary.state)
        ? 'ready'
        : value.summary.state === 'unavailable'
          ? 'attention'
          : value.summary.state,
    };
  }
  if (value.ready)
    return {label: value.paused ? 'Paused' : 'Ready', state: 'ready'};
  if (value.running) return {label: 'Starting', state: 'starting'};
  return {label: 'Stopped', state: 'stopped'};
}

// A slow request must not cause several overlapping refreshes of the same view.
export function pollEvery(work, delay) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } finally {
      running = false;
    }
  }, delay);
}
