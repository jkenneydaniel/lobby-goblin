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
  registrations: [],
  removals: [],
  route(url, handler, options) {
    this.registered = {url, handler, options};
    this.registrations.push(this.registered);
  },
  unroute(url, handler) {
    this.removed = {url, handler};
    this.removals.push(this.removed);
  },
  unrouteAll() {
    throw new Error(
      'Page interception must remain installed until context close.',
    );
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
    assert.equal(page.removed, undefined);
    assert.equal(page.route, original);
    gate.resolve();
    await running;
    await Promise.resolve();
    assert.equal(page.removed, undefined);
  },
);

test(
  'the same deadline bounds unregister itself and restores methods',
  {timeout: 3000},
  async () => {
    const page = fakePage(),
      hold = deferred(),
      original = page.route;
    let removals = 0;
    page.unroute = () => {
      removals++;
      return hold.promise;
    };
    const tracked = trackPageRoutes(page, {timeout: 20});
    await page.route('first', () => {});
    await page.route('second', () => {});
    await assert.rejects(tracked.dispose(), /did not drain and unregister/);
    assert.equal(page.route, original);
    assert.equal(removals, 1);
    hold.resolve();
    await hold.promise;
    await Promise.resolve();
    assert.equal(removals, 1);
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
  page.unroute = async () => {
    assert.equal(active, 0);
    page.removed = true;
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
    if (!page.removed)
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
  assert.equal(page.removed, undefined);
  lateGate.resolve();
  await late;
  await cleanup;
  assert.equal(page.removed, true);
});

test('cleanup removes only owned registrations and keeps a fallback until context close', async () => {
  const page = fakePage(),
    foreign = () => {},
    owned = () => {};
  await page.route('foreign', foreign);
  const tracked = trackPageRoutes(page);
  await page.route('owned', owned, {times: 1});
  const wrapped = page.registered.handler;
  assert.deepEqual(page.registered.options, {times: 1});
  const cleanup = tracked.dispose();
  assert.equal(tracked.dispose(), cleanup);
  await cleanup;
  assert.deepEqual(page.removals, [{url: 'owned', handler: wrapped}]);
  assert.equal(page.registered.url, '**/*');
  let fallbacks = 0;
  await page.registered.handler({fallback: () => fallbacks++});
  assert.equal(fallbacks, 1);
});

test('cleanup retains owned removal failures', async () => {
  const page = fakePage(),
    failure = new Error('owned removal failed');
  page.unroute = () => {
    throw failure;
  };
  const tracked = trackPageRoutes(page);
  await page.route('owned', () => {});
  await assert.rejects(
    tracked.dispose(),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
});

test('cleanup drains and reports late abort failures dispatched during owned removal', async () => {
  const page = fakePage(),
    entered = deferred(),
    gate = deferred(),
    failure = new Error('late abort failed during removal');
  let wrapped, lateRejection;
  page.unroute = () => {
    const late = wrapped(
      {
        abort: async () => {
          entered.resolve();
          await gate.promise;
          throw failure;
        },
      },
      {},
    );
    lateRejection = assert.rejects(late, (error) => error === failure);
  };
  const tracked = trackPageRoutes(page);
  await page.route('owned', () => {});
  wrapped = page.registered.handler;
  const cleanup = tracked.dispose();
  let settled = false;
  cleanup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await lateRejection;
  await assert.rejects(
    cleanup,
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
});

test('the cleanup deadline bounds barrier registration before any owned removal', async () => {
  const page = fakePage(),
    gate = deferred(),
    originalRoute = page.route;
  page.route = function (url, handler, options) {
    originalRoute.call(this, url, handler, options);
    if (url === '**/*') return gate.promise;
  };
  const original = page.route,
    tracked = trackPageRoutes(page, {timeout: 20});
  await page.route('owned', () => {});
  await assert.rejects(tracked.dispose(), /did not drain and unregister/);
  assert.equal(page.route, original);
  assert.deepEqual(page.removals, []);
  gate.resolve();
  await gate.promise;
  await Promise.resolve();
  assert.deepEqual(page.removals, []);
});
