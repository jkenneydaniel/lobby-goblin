import {test as base, expect} from '@playwright/test';
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
  } finally {
    await tracked.dispose();
  }
});
