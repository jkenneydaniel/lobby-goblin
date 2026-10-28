// Never follow a supplied redirect URL. Scoped pages with expired sessions can
// reconnect through the known same-origin sign-in page instead.
export async function checkMaintenancePage(pageURL, fetcher = fetch) {
  const url = new URL(pageURL);
  const read = (target, redirect) =>
    fetcher(target, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect,
      headers: {accept: 'text/html'},
      signal: AbortSignal.timeout(5000),
    });
  const response = await read(url.origin + url.pathname + url.search, 'manual');
  if (
    (response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)) &&
    /^(?:\/hosts\/[a-f0-9]{32})?\/servers\/[a-f0-9]{32}(?:\/.*)?$/.test(
      url.pathname,
    )
  ) {
    const signIn = await read(url.origin + '/', 'error');
    return {status: signIn.status, headers: signIn.headers, signIn: true};
  }
  return response;
}

// Reconnection only reads documents. It never retries an update, signs in or
// uses /health (which is healthy even while management is held).
export function watchMaintenance({
  check,
  ready,
  slow,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
  interval = 3000,
  slowAfter = 120000,
}) {
  const started = now();
  let stopped = false,
    pending = false,
    timer,
    warned = false;
  async function retry() {
    if (stopped || pending) return;
    cancel(timer);
    pending = true;
    try {
      const response = await check();
      if (
        !stopped &&
        response.status === 200 &&
        /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')
      ) {
        stopped = true;
        ready(response);
      }
    } catch {
      // Management ingress can be absent briefly while it is replaced.
    } finally {
      pending = false;
      if (!stopped) {
        if (!warned && now() - started >= slowAfter) {
          warned = true;
          slow();
        }
        timer = schedule(retry, interval);
      }
    }
  }
  timer = schedule(retry, interval);
  return {
    retry,
    stop() {
      stopped = true;
      cancel(timer);
    },
  };
}

if (
  typeof document !== 'undefined' &&
  document.body.classList.contains('maintenance-document')
) {
  const status = document.querySelector('[data-maintenance-status]');
  const watcher = watchMaintenance({
    check: () => checkMaintenancePage(location.href),
    ready: (response) => {
      status.textContent = 'Your panel is ready. Bringing you back…';
      if (response.signIn) location.assign('/');
      else location.reload();
    },
    slow: () => {
      status.textContent = 'Still waiting for your panel. We’ll keep checking.';
      document.querySelector('[data-maintenance-help]').hidden = false;
    },
  });
  document
    .querySelector('[data-maintenance-retry]')
    .addEventListener('click', () => watcher.retry());
  addEventListener('pagehide', () => watcher.stop(), {once: true});
}
