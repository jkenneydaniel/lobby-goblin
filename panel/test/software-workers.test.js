import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SoftwareWorkers} from '../core/software-workers.js';
import {softwareWorkerDeployment as deployment} from '../core/software-worker-policy.js';
import {brokerSocket, brokerToken} from '../core/broker-client.js';
import {executeWorkerRequest} from '../providers/steamcmd/worker.js';
import {atomicRecord} from '../providers/steamcmd/files.js';
import {createSteamProvider} from '../providers/steamcmd/provider.js';
import {HttpError} from '../common.js';

const declaration = {
  version: 1,
  provider: 'steamcmd',
  source: {
    application: 'rust',
    appId: '258550',
    platform: 'linux/amd64',
    branches: ['public'],
  },
  requiredFiles: [{path: 'RustDedicated', executable: true}],
};
const env = {
  FLEET_ID: 'a'.repeat(32),
  FLEET_INSTANCE: 'b'.repeat(32),
  FLEET_VOLUME: 'lobby-goblin-' + 'a'.repeat(32) + '-' + 'b'.repeat(32),
  DOCKER_BROKER_SOCKET: brokerSocket,
  DOCKER_BROKER_TOKEN_FILE: brokerToken,
};
const tag = deployment.image.split('@')[0];
const image = {
  Id: deployment.imageId,
  Os: 'linux',
  Architecture: 'amd64',
  RepoDigests: [
    tag.slice(0, tag.lastIndexOf(':')) + '@' + deployment.image.split('@')[1],
  ],
  Config: {
    User: '1000:1000',
    Entrypoint: deployment.entrypoint,
    Cmd: [],
    Env: [],
    Labels: {
      'io.lobby-goblin.provider': 'steamcmd-worker',
      'io.lobby-goblin.image-revision': '1',
    },
  },
};
async function fixture(t) {
  const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-controller-software-')),
    ),
    containers = new Map(),
    calls = [],
    jobs = [];
  t.after(async () => {
    for (const value of containers.values()) value.abort.abort();
    await Promise.allSettled(jobs);
    await fs.rm(root, {recursive: true, force: true});
  });
  const state = {
    lostCreate: false,
    lostStart: false,
    pause: false,
    result: (value) => value,
    fail: false,
  };
  let helper;
  const command = async (args, {signal} = {}) => {
    if (args.includes('+app_info_print'))
      return '"258550" {"depots" {"258552" {"config" {"oslist" "linux"} "manifests" {"public" {"gid" "123" "size" "500"}}} "branches" {"public" {"buildid" "456"}}}}';
    if (state.pause)
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
      });
    if (state.fail) throw new HttpError(503, 'Fixture preparation failed.');
    const destination = args[args.indexOf('+force_install_dir') + 1];
    await fs.mkdir(path.join(destination, 'steamapps'), {recursive: true});
    await fs.writeFile(
      path.join(destination, 'RustDedicated'),
      'fixture binary',
      {mode: 0o755},
    );
    await fs.writeFile(
      path.join(destination, 'steamapps/appmanifest_258550.acf'),
      '"AppState" {"appid" "258550" "buildid" "456" "StateFlags" "4" "UserConfig" {"BetaKey" "public"} "InstalledDepots" {"258552" {"manifest" "123"}}}',
    );
    return 'Success';
  };
  const docker = async (method, route, data) => {
    calls.push({method, route, data: structuredClone(data)});
    const url = new URL(route, 'http://fixture'),
      bits = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (bits[0] === 'images') return structuredClone(image);
    if (url.pathname === '/containers/json')
      return [...containers.values()].map((value) => ({
        Id: value.info.Id,
        Labels: value.info.Config.Labels,
        State: value.info.State.Status,
      }));
    if (url.pathname === '/containers/create') {
      const id = data.Labels['io.lobby-goblin.worker-request'],
        name = url.searchParams.get('name');
      assert.equal(
        (await helper.record(id)).phase,
        'creating',
        'Create must follow its durable intent',
      );
      const value = {
        id,
        abort: new AbortController(),
        info: {
          Id: 'fixture-' + randomUUID(),
          Name: '/' + name,
          Image: deployment.imageId,
          Config: structuredClone(data),
          HostConfig: data.HostConfig,
          State: {
            Running: false,
            Restarting: false,
            Status: 'created',
            ExitCode: 0,
            OOMKilled: false,
          },
        },
      };
      containers.set(name, value);
      if (state.lostCreate) throw Error('Lost create response');
      return {Id: value.info.Id};
    }
    const value = [...containers.values()].find(
      (value) => value.info.Id === bits[1] || value.info.Name === '/' + bits[1],
    );
    if (!value) throw new HttpError(404, 'Fixture container missing');
    if (method === 'GET') return structuredClone(value.info);
    if (bits[2] === 'start') {
      assert.equal(
        (await helper.record(value.id)).phase,
        'starting',
        'Start must follow its durable intent',
      );
      value.info.State = {
        ...value.info.State,
        Status: 'running',
        Running: true,
      };
      value.job = (async () => {
        let response;
        try {
          response = await executeWorkerRequest(
            await helper.request(value.id),
            {
              software: helper.paths.software,
              control: helper.paths.control,
              command,
              signal: value.abort.signal,
            },
          );
        } catch {
          response = {
            format: 1,
            id: value.id,
            ok: false,
            error: {
              code: 'software-worker-failed',
              status: 503,
              message: 'Fixture preparation failed.',
            },
          };
        }
        response = state.result(response);
        if (response)
          await atomicRecord(
            path.join(helper.location(value.id), 'result/result.json'),
            response,
          );
        value.info.State = {
          ...value.info.State,
          Status: 'exited',
          Running: false,
          ExitCode: response?.ok ? 0 : 1,
        };
      })();
      jobs.push(value.job);
      if (state.lostStart) throw Error('Lost start response');
      return null;
    }
    if (bits[2] === 'stop') {
      value.abort.abort();
      await value.job;
      return null;
    }
    if (method === 'DELETE') {
      assert.equal(value.info.State.Running, false);
      containers.delete(value.info.Name.slice(1));
      return null;
    }
    assert.fail('Unexpected fixture Docker operation');
  };
  helper = new SoftwareWorkers({docker, env, declaration, root, pollMs: 1});
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(
    path.join(root, 'data/copied-world.sav'),
    'unchanged fixture',
  );
  return {
    helper,
    root,
    calls,
    state,
    containers,
    command,
    jobs,
    fresh: () =>
      new SoftwareWorkers({docker, env, declaration, root, pollMs: 1}),
  };
}

test('controller file exchange discovers and prepares exact software without application access or activation', async (t) => {
  const f = await fixture(t),
    phases = [];
  const selected = await f.helper.run(
    'resolve',
    {channel: 'public'},
    {progress: (value) => phases.push(value.phase)},
  );
  assert.equal(selected.softwareVersion, '456');
  assert.equal(await fs.stat(f.helper.paths.software).catch(() => null), null);
  const id = randomUUID();
  await assert.rejects(f.helper.run('prepare', selected, {id}), /Confirm/);
  const prepared = await f.helper.run('prepare', selected, {id, confirm: true});
  assert.equal(prepared.operationId, id);
  assert.equal((await f.helper.record(id)).phase, 'complete');
  assert.deepEqual(phases, [
    'reserved',
    'creating',
    'created',
    'starting',
    'running',
    'exited',
    'complete',
  ]);
  assert.equal(
    await fs.readFile(path.join(f.root, 'data/copied-world.sav'), 'utf8'),
    'unchanged fixture',
  );
  assert.equal(
    await fs
      .stat(path.join(f.helper.paths.control, 'active.json'))
      .catch(() => null),
    null,
  );
  assert.equal(f.containers.size, 0);
  assert.ok(
    f.calls.every(
      (value) => !/\/(exec|archive|restart|wait)(?:\?|$)/.test(value.route),
    ),
  );
  await assert.rejects(
    f.helper.run('prepare', selected, {id, confirm: true}),
    /instead of replaying/,
  );
  const provider = createSteamProvider({
    source: declaration.source,
    requiredFiles: declaration.requiredFiles,
    software: f.helper.paths.software,
    control: f.helper.paths.control,
  });
  await assert.rejects(provider.activate(prepared, {confirm: true}), /Stop/);
  const restored = f.fresh(),
    review = await restored.inspect(id);
  assert.equal(review.response.result.receipt.inventory.files, 2);
  await restored.acknowledge(id);
  assert.equal(await fs.stat(restored.location(id)).catch(() => null), null);
});

test('lost create and start responses retain durable requests and cannot replay on a reconstructed controller', async (t) => {
  for (const kind of ['lostCreate', 'lostStart']) {
    const f = await fixture(t),
      id = randomUUID();
    f.state[kind] = true;
    await assert.rejects(
      f.helper.run('resolve', {channel: 'public'}, {id}),
      (error) => error.message.includes('Lost') && error.workerRequestId === id,
    );
    await Promise.all(f.jobs);
    const helper = f.fresh();
    assert.equal((await helper.record(id)).phase, 'attention');
    const before = f.calls.filter((value) =>
      value.route.endsWith('/start'),
    ).length;
    await assert.rejects(
      helper.run('resolve', {channel: 'public'}),
      /interrupted/,
    );
    assert.equal(
      f.calls.filter((value) => value.route.endsWith('/start')).length,
      before,
    );
    const review = await helper.inspect(id);
    await assert.rejects(helper.close(review, {confirm: true}), /offline/);
    await helper.close(review, {confirm: true, offline: true});
    assert.equal((await helper.record(id)).phase, 'closed');
    assert.equal(f.containers.size, 0);
  }
});

test('cancellation stops only the private worker and retains its incomplete state for inspection', async (t) => {
  const f = await fixture(t),
    selected = await f.helper.run('resolve', {channel: 'public'}),
    abort = new AbortController(),
    id = randomUUID();
  f.state.pause = true;
  await assert.rejects(
    f.helper.run('prepare', selected, {
      id,
      confirm: true,
      signal: abort.signal,
      progress: (value) => {
        if (value.phase === 'running') abort.abort();
      },
    }),
    (error) => error.name === 'AbortError',
  );
  const review = await f.helper.inspect(id);
  assert.equal(review.record.phase, 'attention');
  assert.equal(review.worker.running, false);
  assert.equal(
    f.calls.filter((value) => /\/stop\?t=30$/.test(value.route)).length,
    1,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'data/copied-world.sav'), 'utf8'),
    'unchanged fixture',
  );
  assert.equal(
    await fs
      .stat(path.join(f.helper.paths.control, 'active.json'))
      .catch(() => null),
    null,
  );
  await f.helper.close(review, {confirm: true, offline: true});
});

test('malformed, foreign and missing results remain fenced after the worker exits', async (t) => {
  for (const change of [
    () => null,
    (value) => ({...value, id: randomUUID()}),
    (value) => ({...value, result: {...value.result, application: 'other'}}),
    (value) => ({...value, privateExtra: 'must-not-surface'}),
  ]) {
    const f = await fixture(t),
      id = randomUUID();
    f.state.result = change;
    await assert.rejects(f.helper.run('resolve', {channel: 'public'}, {id}));
    assert.equal((await f.helper.record(id)).phase, 'attention');
    assert.equal(f.containers.size, 1);
    await assert.rejects(
      f.fresh().run('resolve', {channel: 'public'}),
      /interrupted/,
    );
    const helper = f.fresh(),
      review = await helper.inspect(id);
    assert.equal(review.response, null);
    assert.ok(!JSON.stringify(review).includes('must-not-surface'));
    assert.ok(['missing', 'invalid'].includes(review.result.status));
    await helper.close(review, {confirm: true, offline: true});
    assert.equal((await helper.record(id)).phase, 'closed');
    assert.equal(f.containers.size, 0);
  }
});

test('inspection is read-only, stale observations cannot close a request, and linked claim parents fail closed', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  f.state.lostCreate = true;
  await assert.rejects(f.helper.run('resolve', {channel: 'public'}, {id}));
  const review = await f.helper.inspect(id),
    recordBytes = await fs.readFile(
      path.join(f.helper.location(id), 'operation.json'),
    );
  assert.deepEqual(
    await fs.readFile(path.join(f.helper.location(id), 'operation.json')),
    recordBytes,
  );
  const value = [...f.containers.values()][0];
  value.info.State.ExitCode = 2;
  await assert.rejects(
    f.helper.close(review, {confirm: true, offline: true}),
    /observations changed/,
  );
  const fresh = await f.helper.inspect(id);
  await f.helper.close(fresh, {confirm: true, offline: true});
  await fs.rename(
    path.join(f.helper.location(id), 'result'),
    path.join(f.root, 'moved-result'),
  );
  await fs.symlink(
    path.join(f.root, 'moved-result'),
    path.join(f.helper.location(id), 'result'),
  );
  await assert.rejects(f.helper.inspect(id), /linked directories/);
});

test('a retained writer lease needs bound offline recovery without executing or promoting software', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  f.state.lostCreate = true;
  await assert.rejects(f.helper.run('resolve', {channel: 'public'}, {id}));
  await fs.mkdir(path.join(f.helper.paths.requests, '.panel-storage-lock'), {
    mode: 0o700,
  });
  await assert.rejects(
    f.fresh().run('resolve', {channel: 'public'}),
    /interrupted writer/,
  );
  const review = await f.helper.inspect(id),
    before = f.calls.filter((value) => value.route.endsWith('/start')).length;
  assert.ok(review.lease);
  await f.helper.close(review, {confirm: true, offline: true});
  assert.equal(
    f.calls.filter((value) => value.route.endsWith('/start')).length,
    before,
  );
  assert.equal((await f.helper.inspect(id)).lease, null);
});

test('provider claims expose only known controller-owned records to the scoped worker group', async (t) => {
  const f = await fixture(t);
  await f.helper.providerClaims();
  const file = path.join(f.helper.paths.control, 'active.json');
  await atomicRecord(file, {fixture: true});
  await f.helper.providerClaims();
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(f.helper.paths.software)).mode & 0o2777, 0o2770);
  await fs.unlink(file);
  await fs.symlink(path.join(f.root, 'data/copied-world.sav'), file);
  await assert.rejects(f.helper.providerClaims());
  assert.equal(
    await fs.readFile(path.join(f.root, 'data/copied-world.sav'), 'utf8'),
    'unchanged fixture',
  );
  assert.equal(f.calls.length, 0);
  assert.throws(
    () =>
      new SoftwareWorkers({
        docker: async () => {},
        env: {...env, DOCKER_BROKER_SOCKET: undefined},
        declaration,
        root: f.root,
      }),
    /broker transport/,
  );
});

test('failure to publish the start intent prevents execution and retains the created worker', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await assert.rejects(
    f.helper.run(
      'resolve',
      {channel: 'public'},
      {
        id,
        progress: async (value) => {
          if (value.phase === 'created') {
            const file = path.join(f.helper.location(id), 'operation.json');
            await fs.unlink(file);
            await fs.mkdir(file);
          }
        },
      },
    ),
    (error) => error.workerRequestId === id,
  );
  assert.equal(
    f.calls.filter((value) => value.route.endsWith('/start')).length,
    0,
  );
  assert.equal([...f.containers.values()][0].info.State.Status, 'created');
});

test('unacknowledged request history is bounded before Docker or provider storage is touched', async (t) => {
  const f = await fixture(t);
  await f.helper.initialize();
  for (let index = 0; index < 129; index++) {
    const id = randomUUID(),
      location = f.helper.location(id);
    await fs.mkdir(location);
    await fs.writeFile(
      path.join(location, 'operation.json'),
      JSON.stringify({
        format: 1,
        id,
        action: 'resolve',
        phase: 'complete',
        containerId: null,
        exitCode: 0,
      }),
    );
  }
  await assert.rejects(
    f.helper.run('resolve', {channel: 'public'}),
    /acknowledge/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.stat(f.helper.paths.software).catch(() => null), null);
});

test('invalid JSON and oversized responses can be inspected and closed without accepting their contents', async (t) => {
  for (const bytes of [
    '{"truncated":',
    JSON.stringify({private: 'x'.repeat(300 * 1024)}),
  ]) {
    const f = await fixture(t),
      id = randomUUID();
    await assert.rejects(
      f.helper.run(
        'resolve',
        {channel: 'public'},
        {
          id,
          progress: async (value) => {
            if (value.phase === 'exited')
              await fs.writeFile(
                path.join(f.helper.location(id), 'result/result.json'),
                bytes,
              );
          },
        },
      ),
    );
    const review = await f.helper.inspect(id);
    assert.equal(review.result.status, 'invalid');
    assert.match(review.result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(review.result.bytes, Buffer.byteLength(bytes));
    assert.equal(review.response, null);
    assert.ok(!JSON.stringify(review).includes('"private"'));
    // Same byte count, different invalid bytes still invalidate the review.
    await fs.writeFile(
      path.join(f.helper.location(id), 'result/result.json'),
      ' '.repeat(Buffer.byteLength(bytes)),
    );
    await assert.rejects(
      f.helper.close(review, {confirm: true, offline: true}),
      /observations changed/,
    );
    await f.helper.close(await f.helper.inspect(id), {
      confirm: true,
      offline: true,
    });
    assert.equal((await f.helper.record(id)).phase, 'closed');
  }
});

test('every interrupted initialization window has an explicit offline closure path', async (t) => {
  for (const point of [
    'directory',
    'request-directory',
    'request-file',
    'operation-file',
    'truncated-operation',
    'empty-operation',
    'truncated-request',
  ]) {
    const f = await fixture(t),
      id = randomUUID();
    await f.helper.initialize();
    const location = f.helper.location(id);
    await fs.mkdir(location);
    if (point !== 'directory') await fs.mkdir(path.join(location, 'request'));
    if (['request-file', 'operation-file'].includes(point))
      await fs.writeFile(
        path.join(location, 'request/request.json'),
        JSON.stringify({
          format: 1,
          id,
          action: 'resolve',
          source: declaration.source,
          requiredFiles: declaration.requiredFiles,
          initial: {channel: 'public'},
        }),
      );
    if (point === 'operation-file')
      await fs.writeFile(
        path.join(location, 'operation.json'),
        JSON.stringify({
          format: 1,
          id,
          action: 'resolve',
          phase: 'reserved',
          containerId: null,
          exitCode: null,
        }),
      );
    if (point === 'truncated-operation')
      await fs.writeFile(path.join(location, 'operation.json'), '{"format":');
    if (point === 'empty-operation')
      await fs.writeFile(path.join(location, 'operation.json'), '');
    if (point === 'truncated-request')
      await fs.writeFile(
        path.join(location, 'request/request.json'),
        '{"format":',
      );
    const helper = f.fresh();
    await assert.rejects(
      helper.run('resolve', {channel: 'public'}),
      /interrupted/,
    );
    const review = await helper.inspect(id);
    assert.equal(review.worker, null);
    assert.equal(review.response, null);
    await assert.rejects(helper.close(review, {confirm: true}), /offline/);
    await helper.close(review, {confirm: true, offline: true});
    assert.equal((await helper.record(id)).phase, 'closed');
    assert.equal(f.calls.filter((value) => value.method !== 'GET').length, 0);
    await helper.acknowledge(id);
    assert.equal(await fs.stat(location).catch(() => null), null);
    assert.equal(
      (await helper.run('resolve', {channel: 'public'})).softwareVersion,
      '456',
    );
  }
});
