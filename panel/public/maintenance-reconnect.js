// Reconnection only reads the original page. It never retries an update, signs
// in, follows a redirect or uses /health (which is healthy even while held).
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
        ready();
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
    check: () =>
      fetch(location.pathname + location.search, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: {accept: 'text/html'},
        signal: AbortSignal.timeout(5000),
      }),
    ready: () => {
      status.textContent = 'Your panel is ready. Bringing you back…';
      location.reload();
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
