import {test as base, expect} from '@playwright/test';
import http from 'node:http';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const test = base.extend({
  page: async ({page}, use) => {
    const errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origins.rust) return route.continue();
      external.push(url.origin);
      return route.abort();
    });
    await use(page);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {promise, resolve};
};

test('draining overlapping callbacks keeps routes registered and aborts late requests', async ({
  page,
}) => {
  const tracked = trackPageRoutes(page),
    gates = {status: deferred(), jobs: deferred()},
    entered = {status: deferred(), jobs: deferred()},
    finished = {status: deferred(), jobs: deferred()},
    calls = [];
  for (const name of ['status', 'jobs'])
    await page.route('**/api/' + name, async (route) => {
      const response = await route.fetch(),
        json = await response.json();
      calls.push(name);
      entered[name].resolve();
      await gates[name].promise;
      await route.fulfill({json});
      finished[name].resolve();
    });
  try {
    await page.goto(origins.rust);
    await page.evaluate(() => {
      globalThis.routeProbe = Promise.allSettled([
        fetch('/api/status'),
        fetch('/api/jobs'),
      ]);
    });
    await Promise.all(Object.values(entered).map((item) => item.promise));
    const drain = tracked.dispose();
    gates.jobs.resolve();
    await finished.jobs.promise;
    // A new poll during the drain must not enter its mock callback or escape
    // the context guard. It is deliberately aborted while old work finishes.
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('/api/status');
          return 'fulfilled';
        } catch {
          return 'aborted';
        }
      }),
    ).toBe('aborted');
    expect([...calls].sort()).toEqual(['jobs', 'status']);
    gates.status.resolve();
    await drain;
    await page.evaluate(() => globalThis.routeProbe);
  } finally {
    gates.status.resolve();
    gates.jobs.resolve();
    await tracked.dispose();
  }
});

test('route registration options, handler identity and disposable removal stay intact', async ({
  page,
}) => {
  await page.route('**/foreign-route-probe', (route) =>
    route.fulfill({json: {foreign: true}}),
  );
  const tracked = trackPageRoutes(page);
  const handler = (route) => route.fulfill({json: {mocked: true}});
  try {
    await page.goto(origins.rust);
    await page.route('**/api/status', handler, {times: 1});
    expect(
      await page.evaluate(async () => (await fetch('/api/status')).json()),
    ).toEqual({mocked: true});
    expect(
      await page.evaluate(async () => (await fetch('/api/status')).json()),
    ).not.toHaveProperty('mocked');
    await page.route('**/api/status', handler);
    await page.unroute('**/api/status', handler);
    expect(
      await page.evaluate(async () => (await fetch('/api/status')).json()),
    ).not.toHaveProperty('mocked');
    const registration = await page.route('**/api/status', handler);
    await registration.dispose();
    expect(
      await page.evaluate(async () => (await fetch('/api/status')).json()),
    ).not.toHaveProperty('mocked');
    await tracked.dispose();
    expect(
      await page.evaluate(async () =>
        (await fetch('/foreign-route-probe')).json(),
      ),
    ).toEqual({foreign: true});
  } finally {
    await tracked.dispose();
  }
});

test('page fallback and cleanup preserve the context guard across the final callback handoff', async ({
  browser,
  contextOptions,
}) => {
  const requests = [],
    external = [],
    errors = [],
    started = deferred();
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'text/html');
    response.end(
      request.url === '/'
        ? '<!doctype html><title>Route handoff</title>'
        : 'probe',
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port,
    origin = 'http://127.0.0.1:' + port,
    forbidden = 'http://localhost:' + port;
  const context = await browser.newContext({
    ...contextOptions,
    serviceWorkers: 'block',
  });
  let tracked;
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      external.push(url.origin);
      return route.abort();
    });
    tracked = trackPageRoutes(page);
    await page.goto(origin);
    let cleanup;
    await page.route('**/probe', (route) => {
      const fallback = route.fallback();
      // End the mock callback and begin cleanup in adjacent microtasks. The
      // context guard is synchronous, as in the application browser fixtures.
      queueMicrotask(() => {
        cleanup = tracked.dispose();
        started.resolve();
      });
      return fallback;
    });
    await page.evaluate(() => {
      globalThis.routeProbe = fetch('/probe').then((response) =>
        response.text(),
      );
    });
    await started.promise;
    await cleanup;
    expect(await page.evaluate(() => globalThis.routeProbe)).toBe('probe');
    const outcomes = await page.evaluate(async (blockedOrigin) => {
      const results = await Promise.allSettled([
        fetch('/late').then((response) => response.text()),
        fetch(blockedOrigin + '/forbidden'),
      ]);
      return results.map((result) => result.status);
    }, forbidden);
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(external).toEqual([forbidden]);
    expect(requests).toContain('/probe');
    expect(requests).toContain('/late');
    expect(requests).not.toContain('/forbidden');
    expect(errors).toEqual([]);
  } finally {
    try {
      if (tracked) await tracked.dispose();
    } finally {
      try {
        await context.close();
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  }
});
