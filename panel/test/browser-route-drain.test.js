import test from 'node:test';
import assert from 'node:assert/strict';
import {trackPageRoutes} from './browser/route-drain.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {promise, resolve};
};
const fakePage = () => ({
  route(url, handler, options) {
    this.registered = {url, handler, options};
  },
  unroute(url, handler) {
    this.removed = {url, handler};
  },
  async unrouteAll(options) {
    this.unregistered = options;
  },
});

test('route cleanup retains settled callback failures and restores public methods', async () => {
  const page = fakePage(),
    route = page.route,
    unroute = page.unroute;
  const tracked = trackPageRoutes(page),
    failure = new Error('genuine callback assertion failed');
  await page.route('fixture', async () => {
    throw failure;
  });
  await assert.rejects(
    page.registered.handler({}, {}),
    (error) => error === failure,
  );
  await assert.rejects(
    tracked.dispose(),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.equal(page.route, route);
  assert.equal(page.unroute, unroute);
});

test(
  'cleanup deadline leaves a held callback registered, even after it later finishes',
  {timeout: 3000},
  async () => {
    const page = fakePage(),
      gate = deferred(),
      entered = deferred(),
      original = page.route;
    for (const timeout of [0, -1, 30001, Infinity])
      assert.throws(() => trackPageRoutes(page, {timeout}), /bounded timeout/);
    const tracked = trackPageRoutes(page, {timeout: 20});
    await page.route('fixture', async () => {
      entered.resolve();
      await gate.promise;
    });
    const running = page.registered.handler({}, {});
    await entered.promise;
    await assert.rejects(tracked.dispose(), /did not drain and unregister/);
    assert.equal(page.unregistered, undefined);
    assert.equal(page.route, original);
    gate.resolve();
    await running;
    await Promise.resolve();
    assert.equal(page.unregistered, undefined);
  },
);

test(
  'the same deadline bounds unregister itself and restores methods',
  {timeout: 3000},
  async () => {
    const page = fakePage(),
      hold = deferred(),
      original = page.route;
    page.unrouteAll = () => hold.promise;
    const tracked = trackPageRoutes(page, {timeout: 20});
    await assert.rejects(tracked.dispose(), /did not drain and unregister/);
    assert.equal(page.route, original);
    hold.resolve();
  },
);

test('late abort failures stay visible and registrations close while cleanup runs', async () => {
  const page = fakePage(),
    gate = deferred(),
    entered = deferred(),
    tracked = trackPageRoutes(page);
  await page.route('fixture', async () => {
    entered.resolve();
    await gate.promise;
  });
  const first = page.registered.handler({}, {});
  await entered.promise;
  const cleanup = tracked.dispose();
  assert.throws(() => page.route('new', () => {}), /during teardown/);
  const failure = new Error('late abort failed');
  await assert.rejects(
    page.registered.handler(
      {
        abort: async () => {
          throw failure;
        },
      },
      {},
    ),
    (error) => error === failure,
  );
  gate.resolve();
  await first;
  await assert.rejects(cleanup, (error) => error.errors[0] === failure);
});

test('a callback arriving at the final completion boundary is drained before removal', async () => {
  const page = fakePage(),
    firstGate = deferred(),
    lateGate = deferred(),
    entered = deferred();
  let active = 0,
    late;
  page.unrouteAll = async () => {
    assert.equal(active, 0);
    page.unregistered = true;
  };
  const tracked = trackPageRoutes(page);
  await page.route('fixture', async () => {
    entered.resolve();
    await firstGate.promise;
  });
  const first = page.registered.handler({}, {});
  await entered.promise;
  const cleanup = tracked.dispose();
  const arrival = first.then(() => {
    if (!page.unregistered)
      late = page.registered.handler(
        {
          abort: async () => {
            active++;
            await lateGate.promise;
            active--;
          },
        },
        {},
      );
  });
  firstGate.resolve();
  await arrival;
  assert.ok(late, 'Completion-boundary route must enter before removal');
  assert.equal(page.unregistered, undefined);
  lateGate.resolve();
  await late;
  await cleanup;
  assert.equal(page.unregistered, true);
});
