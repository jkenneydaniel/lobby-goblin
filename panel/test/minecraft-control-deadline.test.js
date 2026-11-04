import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {resources} from '../core/instance.js';
import {
  digest,
  fixtureWorkerRequest,
} from '../prototypes/minecraft-java/provider.js';
import {createJavaFixture} from '../prototypes/minecraft-java/fixture.js';

const artifact = Buffer.from('synthetic control fixture, not a game');
const release = {
  format: 1,
  edition: 'java',
  gameVersion: 'fixture-1',
  platform: 'linux/amd64',
  sha256: digest(artifact),
  bytes: artifact.length,
};
const scope = {
  fleet: 'a'.repeat(32),
  instance: 'b'.repeat(32),
  volume: resources('a'.repeat(32), 'b'.repeat(32), 'minecraft-java').volume,
};
const request = fixtureWorkerRequest(
  scope,
  '11111111-1111-4111-8111-111111111111',
  release,
);
const credentials = {minecraftManagement: 'SyntheticOnly'.padEnd(40, 'X')};
const linux = {skip: process.platform !== 'linux', timeout: 5000};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {promise, resolve};
}
function timers(t) {
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = {callback, delay, cleared: false};
    scheduled.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timer.cleared = true;
  });
  return scheduled;
}
async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-deadline-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const state = {running: true, saves: 0, calls: [], signals: []};
  const exchange = async (input) => {
    assert.deepEqual(input.scope, scope);
    assert.equal(
      input.environment.MINECRAFT_MANAGEMENT_SECRET,
      credentials.minecraftManagement,
    );
    assert.ok(input.signal instanceof AbortSignal);
    state.calls.push(input.method);
    state.signals.push(input.signal);
    if (input.method === 'status')
      return JSON.stringify({
        format: 1,
        edition: 'java',
        gameVersion: release.gameVersion,
        running: state.running,
        ready: state.running,
      });
    if (input.method === 'save') state.saves++;
    if (input.method === 'stop') state.running = false;
    return JSON.stringify({format: 1, ok: true});
  };
  const options = {root, scope, release, credentials, exchange, ...override};
  const api = await createJavaFixture(options);
  await api.prepare(request, artifact);
  return {root, options, api, exchange, state};
}

test(
  'exchange budget is a bounded integer validated before filesystem effects',
  linux,
  async (t) => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'minecraft-budget-'),
    );
    t.after(() => fs.rm(parent, {recursive: true, force: true}));
    const root = path.join(parent, 'absent');
    for (const exchangeTimeoutMs of [
      0,
      -1,
      1.5,
      30001,
      Infinity,
      NaN,
      '5000',
      null,
    ]) {
      await assert.rejects(
        createJavaFixture({
          root,
          scope,
          release,
          credentials,
          exchange: async () => '',
          exchangeTimeoutMs,
        }),
        /timeout/,
      );
      await assert.rejects(fs.lstat(root), (e) => e.code === 'ENOENT');
    }
  },
);

test(
  'default and boundary budgets create fresh signals and clear all successful timers',
  linux,
  async (t) => {
    const scheduled = timers(t);
    const f = await fixture(t);
    assert.equal(
      (await f.api.saveAndStop({confirm: true})).control,
      'complete',
    );
    assert.deepEqual(f.state.calls, ['status', 'save', 'stop', 'status']);
    assert.equal(new Set(f.state.signals).size, 4);
    assert.ok(f.state.signals.every((signal) => !signal.aborted));
    assert.deepEqual(
      scheduled.map((x) => x.delay),
      [5000, 5000, 5000, 5000],
    );
    assert.ok(scheduled.every((x) => x.cleared));
    // Admission of the inclusive endpoints does not depend on a real 1 ms call.
    for (const exchangeTimeoutMs of [1, 30000])
      await fixture(t, {exchangeTimeoutMs});
  },
);

test(
  'actual timer requests cooperative abort and redacts rejection details',
  linux,
  async (t) => {
    const f = await fixture(t);
    let signal;
    const api = await createJavaFixture({
      ...f.options,
      exchangeTimeoutMs: 20,
      exchange: async (input) => {
        signal = input.signal;
        await new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(Error(credentials.minecraftManagement)),
            {once: true},
          ),
        );
      },
    });
    await assert.rejects(
      api.observe(),
      (e) =>
        e.message === 'Synthetic Minecraft transport failed.' &&
        e.cause === undefined,
    );
    assert.ok(signal.aborted);
    assert.equal((await api.inspect()).control, 'idle');
  },
);

for (const phase of [
  'initial-status',
  'save',
  'stop-before-effect',
  'stop-after-effect',
  'final-status',
]) {
  test(
    'expired ' +
      phase +
      ' retains its lock through settlement and refuses late success',
    linux,
    async (t) => {
      const scheduled = timers(t),
        entered = deferred(),
        gate = deferred();
      const f = await fixture(t);
      let statusCalls = 0,
        held = false,
        settled = false,
        heldSignal;
      const api = await createJavaFixture({
        ...f.options,
        exchange: async (input) => {
          if (input.method === 'status') statusCalls++;
          const target =
            !held &&
            (phase === input.method ||
              (phase === 'initial-status' &&
                input.method === 'status' &&
                statusCalls === 1) ||
              (phase === 'final-status' &&
                input.method === 'status' &&
                statusCalls === 2) ||
              (phase.startsWith('stop-') && input.method === 'stop'));
          if (target) {
            held = true;
            heldSignal = input.signal;
            if (phase === 'stop-after-effect') f.state.running = false;
            entered.resolve();
            await gate.promise; // Deliberately ignore abort until this work settles.
          }
          return f.exchange(input);
        },
      });
      const pending = api.saveAndStop({confirm: true}).then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await entered.promise;
      try {
        const deadline = scheduled.at(-1);
        deadline.callback();
        assert.ok(heldSignal.aborted);
        await new Promise(setImmediate);
        assert.equal(settled, false);
        assert.equal(deadline.cleared, false);
        assert.ok(
          (await fs.lstat(path.join(f.root, '.fixture.lock'))).isFile(),
        );
        const expected = phase === 'initial-status' ? 'idle' : 'unknown';
        assert.equal((await api.inspect()).control, expected);
        const other = await createJavaFixture(f.options),
          count = scheduled.length;
        await assert.rejects(
          other.saveAndStop({confirm: true}),
          (e) => e.code === 'EEXIST',
        );
        assert.equal(scheduled.length, count);
      } finally {
        gate.resolve();
        await pending;
      }
      const error = await pending;
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        phase === 'initial-status'
          ? 'Synthetic Minecraft transport failed.'
          : 'Fixture control outcome requires inspection.',
      );
      const calls =
        phase === 'initial-status'
          ? ['status']
          : phase === 'save'
            ? ['status', 'save']
            : phase === 'final-status'
              ? ['status', 'save', 'stop', 'status']
              : ['status', 'save', 'stop'];
      assert.deepEqual(f.state.calls, calls);
      assert.ok(scheduled.every((x) => x.cleared));
      await assert.rejects(
        fs.lstat(path.join(f.root, '.fixture.lock')),
        (e) => e.code === 'ENOENT',
      );
      const resumed = await createJavaFixture(f.options);
      assert.equal(
        (await resumed.inspect()).control,
        phase === 'initial-status' ? 'idle' : 'unknown',
      );
      if (phase !== 'initial-status') {
        const before = f.state.calls.length;
        await assert.rejects(
          resumed.saveAndStop({confirm: true}),
          /do not replay/,
        );
        assert.equal(f.state.calls.length, before);
      }
      const record = JSON.parse(
        await fs.readFile(path.join(f.root, 'fixture.json'), 'utf8'),
      );
      assert.deepEqual(Object.keys(record).sort(), [
        'control',
        'format',
        'preparation',
        'receipt',
        'release',
        'request',
        'scope',
      ]);
      assert.ok(
        !JSON.stringify(record).includes(credentials.minecraftManagement),
      );
    },
  );
}

test(
  'monotonic check rejects an overdue reply before a blocked timer can run',
  linux,
  async (t) => {
    const scheduled = timers(t);
    const f = await fixture(t);
    const api = await createJavaFixture({
      ...f.options,
      exchangeTimeoutMs: 5,
      exchange: async (input) => {
        const end = performance.now() + 12;
        while (performance.now() < end) {
          /* bounded event-loop block */
        }
        assert.equal(input.signal.aborted, false);
        return f.exchange(input);
      },
    });
    await assert.rejects(api.saveAndStop({confirm: true}), /transport failed/);
    assert.deepEqual(f.state.calls, ['status']);
    assert.equal((await api.inspect()).control, 'idle');
    assert.ok(scheduled.every((x) => x.cleared));
  },
);

test(
  'ordinary rejection and malformed replies also clear timers without leaking credentials',
  linux,
  async (t) => {
    const scheduled = timers(t),
      f = await fixture(t);
    for (const exchange of [
      async () => {
        throw Error(credentials.minecraftManagement);
      },
      async () => 'not JSON',
      async () => 'x'.repeat(16385),
    ]) {
      const api = await createJavaFixture({...f.options, exchange});
      await assert.rejects(
        api.observe(),
        (e) =>
          !e.message.includes(credentials.minecraftManagement) &&
          e.cause === undefined,
      );
      assert.ok(scheduled.at(-1).cleared);
    }
  },
);
