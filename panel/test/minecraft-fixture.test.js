import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resources} from '../core/instance.js';
import {softwareWorkerDeclaration} from '../core/software-worker-policy.js';
import {
  javaFixtureRelease,
  digest,
  fixtureScope,
  fixtureWorkerRequest,
  validateFixtureWorkerRequest,
  maxFixtureBytes,
} from '../prototypes/minecraft-java/provider.js';
import {
  createJavaFixture,
  fixtureManagementBinding,
} from '../prototypes/minecraft-java/fixture.js';

const bytes = Buffer.from(
  'synthetic Java artifact; not an executable or game download',
);
const releaseData = () => ({
  format: 1,
  edition: 'java',
  gameVersion: 'fixture-1',
  platform: 'linux/amd64',
  sha256: digest(bytes),
  bytes: bytes.length,
});
const release = javaFixtureRelease(releaseData());
const scope = fixtureScope({
  fleet: 'a'.repeat(32),
  instance: 'b'.repeat(32),
  volume: resources('a'.repeat(32), 'b'.repeat(32), 'minecraft-java').volume,
});
const id = '11111111-1111-4111-8111-111111111111';
const request = fixtureWorkerRequest(scope, id, release);
const credentials = {minecraftManagement: 'SyntheticOnly'.padEnd(40, 'X')};
const linux = {skip: process.platform !== 'linux'};
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lobby-minecraft-fixture-'),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const state = {running: true, ready: true, calls: []};
  const exchange = async (input) => {
    state.calls.push(input.method);
    assert.deepEqual(input.scope, scope);
    assert.equal(
      input.environment.MINECRAFT_MANAGEMENT_SECRET,
      credentials.minecraftManagement,
    );
    if (input.method === 'status')
      return JSON.stringify({
        format: 1,
        edition: 'java',
        gameVersion: release.gameVersion,
        running: state.running,
        ready: state.running && state.ready,
      });
    if (input.method === 'stop') state.running = false;
    return JSON.stringify({format: 1, ok: true});
  };
  const options = {root, scope, release, credentials, exchange, ...overrides};
  const api = await createJavaFixture(options);
  return {
    root,
    state,
    api,
    options,
    async prepare() {
      return api.prepare(request, bytes);
    },
  };
}

test('Java fixture selection is exact data and never admits Bedrock, URLs, aliases or getters', () => {
  for (const change of [
    {edition: 'bedrock'},
    {gameVersion: 'latest'},
    {sha256: 'bad'},
    {bytes: 0},
    {bytes: maxFixtureBytes + 1},
    {platform: 'windows/amd64'},
    {url: 'https://invalid.example/game.jar'},
    {command: 'anything'},
  ])
    assert.throws(() => javaFixtureRelease({...releaseData(), ...change}));
  let getters = 0;
  const unsafe = {...releaseData()};
  Object.defineProperty(unsafe, 'gameVersion', {
    enumerable: true,
    get() {
      getters++;
      return 'fixture-1';
    },
  });
  assert.throws(() => javaFixtureRelease(unsafe));
  assert.equal(getters, 0);
  assert.equal(Object.isFrozen(release), true);
});
test('synthetic worker fencing rejects foreign scope, commands, mounts, network and resource changes', () => {
  for (const mutate of [
    (x) => {
      x.scope.volume = 'foreign';
    },
    (x) => {
      x.scope.instance = 'c'.repeat(32);
    },
    (x) => {
      x.limits.network = 'host';
    },
    (x) => {
      x.limits.memoryMiB = 4096;
    },
    (x) => {
      x.limits.cpus = 2;
    },
    (x) => {
      x.limits.pids = 512;
    },
    (x) => {
      x.mounts[0].access = 'write';
    },
    (x) => {
      x.mounts[1].path = 'worlds';
    },
    (x) => {
      x.mounts.push({
        volume: 'foreign',
        path: '/var/run/docker.sock',
        access: 'write',
      });
    },
    (x) => {
      x.command = ['arbitrary'];
    },
    (x) => {
      x.environment = {secret: 'injected'};
    },
    (x) => {
      x.release.edition = 'bedrock';
    },
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.throws(() =>
      validateFixtureWorkerRequest(changed, scope, id, release),
    );
  }
  assert.equal(
    validateFixtureWorkerRequest(request, scope, id, release),
    request,
  );
  assert.throws(() => fixtureScope({...scope, volume: 'foreign'}));
});
test('production dispatch remains closed and Minecraft is not registered', async () => {
  for (const provider of ['mojang', 'mojang-fixture'])
    assert.throws(
      () =>
        softwareWorkerDeclaration({
          version: 1,
          provider,
          source: {},
          requiredFiles: [],
        }),
      /registered/,
    );
  const registry = JSON.parse(
    await fs.readFile(
      new URL('../applications/registry.json', import.meta.url),
    ),
  );
  assert.deepEqual(registry, ['factorio', 'rust', 'status-page']);
});
test('management binding uses only its explicit private slot', () => {
  assert.equal(
    fixtureManagementBinding(credentials).MINECRAFT_MANAGEMENT_SECRET,
    credentials.minecraftManagement,
  );
  for (const value of [
    {rconPassword: credentials.minecraftManagement},
    {...credentials, NODE_OPTIONS: 'bad'},
    {minecraftManagement: 'short'},
    {minecraftManagement: 'x'.repeat(39) + '\n'},
  ])
    assert.throws(() => fixtureManagementBinding(value));
});
test(
  'verified synthetic bytes stage read-only with private durable receipt, without transport calls',
  linux,
  async (t) => {
    const f = await fixture(t);
    const result = await f.prepare();
    assert.equal(result.preparation, 'complete');
    assert.equal(result.request, id);
    assert.equal(result.receipt.selection.provider, 'mojang-fixture');
    assert.equal(result.receipt.selection.application, 'minecraft-java');
    assert.equal(
      (await fs.stat(path.join(f.root, 'server.jar'))).mode & 0o777,
      0o400,
    );
    assert.equal(
      (await fs.stat(path.join(f.root, 'fixture.json'))).mode & 0o777,
      0o600,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'server.jar')), bytes);
    assert.deepEqual(f.state.calls, []);
    assert.equal(
      JSON.stringify(result).includes(credentials.minecraftManagement),
      false,
    );
    await assert.rejects(f.prepare(), /prior fixture preparation/);
  },
);
test(
  'corrupt bytes and untrusted request accessors are rejected before writes',
  linux,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.api.prepare(request, Buffer.from('corrupt')),
      /artifact/,
    );
    assert.deepEqual(await fs.readdir(f.root), []);
    let getters = 0;
    const unsafe = {...request};
    Object.defineProperty(unsafe, 'request', {
      enumerable: true,
      get() {
        getters++;
        return id;
      },
    });
    await assert.rejects(f.api.prepare(unsafe, bytes));
    assert.equal(getters, 0);
    assert.deepEqual(await fs.readdir(f.root), []);
  },
);

test(
  'validated request and artifact are snapshotted before asynchronous preparation',
  linux,
  async (t) => {
    const f = await fixture(t),
      callerRequest = structuredClone(request),
      callerBytes = Buffer.from(bytes);
    const pending = f.api.prepare(callerRequest, callerBytes);
    let getters = 0;
    Object.defineProperty(callerRequest, 'request', {
      enumerable: true,
      get() {
        getters++;
        throw Error('late accessor');
      },
    });
    callerRequest.scope.instance = 'c'.repeat(32);
    callerBytes.fill(0);
    const result = await pending;
    assert.equal(result.preparation, 'complete');
    assert.equal(result.request, id);
    assert.equal(getters, 0);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'server.jar')), bytes);
    assert.equal((await f.api.inspect()).request, id);
  },
);
test(
  'artifact corruption, executable permissions and linked files cannot certify preparation',
  linux,
  async (t) => {
    for (const kind of ['corruption', 'executable', 'hardlink', 'symlink']) {
      const f = await fixture(t);
      await f.prepare();
      const jar = path.join(f.root, 'server.jar');
      if (kind === 'corruption') {
        await fs.chmod(jar, 0o600);
        await fs.writeFile(jar, Buffer.alloc(bytes.length, 0));
        await fs.chmod(jar, 0o400);
      }
      if (kind === 'executable') await fs.chmod(jar, 0o500);
      if (kind === 'hardlink') await fs.link(jar, path.join(f.root, 'linked'));
      if (kind === 'symlink') {
        await fs.rename(jar, path.join(f.root, 'original'));
        await fs.symlink('original', jar);
      }
      await assert.rejects(f.api.inspect());
    }
  },
);
test(
  'interrupted staging survives reconstruction as unknown and cannot be replayed',
  linux,
  async (t) => {
    const f = await fixture(t, {
      fault: async () => {
        throw Error('synthetic crash');
      },
    });
    await assert.rejects(f.prepare(), /synthetic crash/);
    const resumed = await createJavaFixture({
      ...f.options,
      fault: async () => {},
    });
    assert.equal((await resumed.inspect()).preparation, 'unknown');
    await assert.rejects(
      resumed.prepare(request, bytes),
      /prior fixture preparation/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'server.jar')), bytes);
  },
);
test(
  'save and stop require ready state, explicit confirmation and durable intent before each effect',
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.prepare();
    const base = f.options.exchange;
    const api = await createJavaFixture({
      ...f.options,
      exchange: async (input) => {
        if (input.method !== 'status') {
          const record = JSON.parse(
            await fs.readFile(path.join(f.root, 'fixture.json')),
          );
          assert.equal(
            record.control,
            input.method === 'save' ? 'saving' : 'stopping',
          );
        }
        return base(input);
      },
    });
    await assert.rejects(api.saveAndStop({confirm: false}), /confirmation/);
    await assert.rejects(api.saveAndStop({confirm: true, method: 'arbitrary'}));
    const result = await api.saveAndStop({confirm: true});
    assert.equal(result.control, 'complete');
    assert.deepEqual(f.state.calls, ['status', 'save', 'stop', 'status']);
    await assert.rejects(api.saveAndStop({confirm: true}), /do not replay/);
    assert.deepEqual(f.state.calls, ['status', 'save', 'stop', 'status']);
  },
);
test(
  'connected but unready synthetic world cannot trigger save or stop',
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.prepare();
    f.state.ready = false;
    await assert.rejects(f.api.saveAndStop({confirm: true}), /not ready/);
    assert.deepEqual(f.state.calls, ['status']);
    assert.equal((await f.api.inspect()).control, 'idle');
  },
);
test(
  'lost stop reply is private, persists unknown across restart and never replays',
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.prepare();
    const base = f.options.exchange;
    const api = await createJavaFixture({
      ...f.options,
      exchange: async (input) => {
        if (input.method === 'stop')
          throw Error(credentials.minecraftManagement);
        return base(input);
      },
    });
    await assert.rejects(
      api.saveAndStop({confirm: true}),
      (error) =>
        error.message === 'Fixture control outcome requires inspection.' &&
        !error.message.includes(credentials.minecraftManagement),
    );
    const resumed = await createJavaFixture(f.options);
    assert.equal((await resumed.inspect()).control, 'unknown');
    const count = f.state.calls.length;
    await assert.rejects(resumed.saveAndStop({confirm: true}), /do not replay/);
    assert.equal(f.state.calls.length, count);
    await resumed.observe();
    assert.equal(f.state.calls.at(-1), 'status');
  },
);
test(
  'bounded synthetic response parser rejects wrong edition, release, fields and readiness',
  linux,
  async (t) => {
    const valid = {
      format: 1,
      edition: 'java',
      gameVersion: release.gameVersion,
      running: true,
      ready: true,
    };
    for (const response of [
      'not JSON',
      'x'.repeat(16385),
      JSON.stringify({...valid, edition: 'bedrock'}),
      JSON.stringify({...valid, gameVersion: 'other'}),
      JSON.stringify({...valid, running: false}),
      JSON.stringify({...valid, secret: credentials.minecraftManagement}),
    ]) {
      const f = await fixture(t, {exchange: async () => response});
      await f.prepare();
      await assert.rejects(
        f.api.observe(),
        (error) => !error.message.includes(credentials.minecraftManagement),
      );
    }
  },
);
test(
  'concurrent fixture mutations are fenced even across reconstructed controllers',
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.prepare();
    let releaseSave, entered;
    const seen = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        releaseSave = resolve;
      });
    const first = await createJavaFixture({
      ...f.options,
      exchange: async (input) => {
        if (input.method === 'save') {
          entered();
          await gate;
        }
        return f.options.exchange(input);
      },
    });
    const pending = first.saveAndStop({confirm: true});
    await seen;
    try {
      assert.equal((await first.inspect()).control, 'unknown');
      const second = await createJavaFixture(f.options);
      await assert.rejects(
        second.saveAndStop({confirm: true}),
        (error) => error.code === 'EEXIST',
      );
    } finally {
      releaseSave();
    }
    assert.equal((await pending).control, 'complete');
  },
);
test(
  'private root and journal bindings refuse foreign or unrelated state',
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.prepare();
    const file = path.join(f.root, 'fixture.json'),
      record = JSON.parse(await fs.readFile(file));
    record.scope.instance = 'c'.repeat(32);
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(f.api.inspect(), /private binding/);
    const g = await fixture(t);
    await fs.chmod(g.root, 0o770);
    await assert.rejects(createJavaFixture(g.options), /private and owned/);
    await fs.chmod(g.root, 0o700);
    await fs.writeFile(
      path.join(g.root, 'world.dat'),
      'synthetic unrelated data',
    );
    await assert.rejects(createJavaFixture(g.options), /unrelated data/);
  },
);
