import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {softwareWorkerRequest, executeWorkerRequest} from './worker.js';
import {createSteamProvider} from './provider.js';

const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public'],
};
const requiredFiles = [{path: 'RustDedicated', executable: true}];
const request = (action, extra = {}) => ({
  format: 1,
  id: randomUUID(),
  action,
  source,
  requiredFiles,
  ...extra,
});
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-steam-worker-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const software = path.join(root, 'software'),
    control = path.join(root, 'control');
  const command = async (args) => {
    if (args.includes('+app_info_print'))
      return '"258550" {"depots" {"258552" {"config" {"oslist" "linux"} "manifests" {"public" {"gid" "123" "size" "500"}}} "branches" {"public" {"buildid" "456"}}}}';
    const destination = args[args.indexOf('+force_install_dir') + 1];
    await fs.mkdir(path.join(destination, 'steamapps'));
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
  return {root, software, control, command};
}

test('worker discovery is read-only and private preparation requires separate controller activation', async (t) => {
  const f = await fixture(t),
    world = path.join(f.root, 'copied-world');
  await fs.writeFile(world, 'unchanged');
  const resolved = await executeWorkerRequest(
    request('resolve', {initial: {channel: 'public'}}),
    f,
  );
  assert.equal(await fs.stat(f.software).catch(() => null), null);
  const input = request('prepare', {selection: resolved.result, confirm: true});
  const prepared = await executeWorkerRequest(input, f);
  assert.equal(prepared.id, input.id);
  assert.equal(prepared.result.operationId, input.id);
  assert.equal(
    await fs.stat(path.join(f.control, 'active.json')).catch(() => null),
    null,
  );
  const inspected = await executeWorkerRequest(request('inspect'), f);
  assert.equal(inspected.result.observation.state, 'staged');
  assert.equal(await fs.readFile(world, 'utf8'), 'unchanged');
  const noLifecycleAuthority = createSteamProvider({
    ...f,
    source,
    requiredFiles,
  });
  await assert.rejects(
    noLifecycleAuthority.activate(prepared.result, {confirm: true}),
    /Stop the application/,
  );
  const controller = createSteamProvider({
    ...f,
    source,
    requiredFiles,
    isApplicationEmpty: async () => true,
    isApplicationStopped: async () => true,
    command: async () => assert.fail('Activation cannot invoke Steam'),
  });
  const receipt = await controller.activate(prepared.result, {confirm: true});
  assert.equal(await controller.installed(receipt), true);
});

test('worker requests cannot select activation, paths, executables, environment or an unconfirmed preparation', async (t) => {
  const f = await fixture(t);
  const resolved = await executeWorkerRequest(
    request('resolve', {initial: {channel: 'public'}}),
    f,
  );
  for (const action of ['install', 'activate', 'recover', 'adopt', 'exec'])
    assert.throws(() => softwareWorkerRequest(request(action)), /supported/);
  for (const extra of [
    {software: '/outside'},
    {control: '/outside'},
    {program: '/bin/sh'},
    {env: {TOKEN: 'not permitted'}},
    {command: ['+quit']},
  ])
    assert.throws(
      () =>
        softwareWorkerRequest(
          request('prepare', {
            selection: resolved.result,
            confirm: true,
            ...extra,
          }),
        ),
      /Unknown/,
    );
  for (const confirm of [false, 'true', 1])
    await assert.rejects(
      executeWorkerRequest(
        request('prepare', {selection: resolved.result, confirm}),
        f,
      ),
      /Confirm/,
    );
  await assert.rejects(
    executeWorkerRequest(
      request('prepare', {
        selection: {...resolved.result, application: 'other'},
        confirm: true,
      }),
      f,
    ),
    /another Steam/,
  );
  assert.equal(await fs.stat(f.software).catch(() => null), null);
  assert.throws(
    () => softwareWorkerRequest({...request('inspect'), requiredFiles: []}),
    /required software/,
  );
  assert.throws(
    () => softwareWorkerRequest({...request('inspect'), id: '../other'}),
    /supported/,
  );
});

test('worker cancellation leaves retained private work incomplete and never publishes an active receipt', async (t) => {
  const f = await fixture(t);
  const resolved = await executeWorkerRequest(
    request('resolve', {initial: {channel: 'public'}}),
    f,
  );
  const abort = new AbortController();
  abort.abort();
  const command = async (args, options) => {
    if (options.signal?.aborted)
      throw Object.assign(Error('Cancelled'), {status: 409});
    return f.command(args, options);
  };
  await assert.rejects(
    executeWorkerRequest(
      request('prepare', {selection: resolved.result, confirm: true}),
      {...f, command, signal: abort.signal},
    ),
    /cancelled/i,
  );
  const inspected = await executeWorkerRequest(request('inspect'), f);
  assert.equal(inspected.result.state.state, 'failed');
  assert.equal(
    await fs.stat(path.join(f.control, 'active.json')).catch(() => null),
    null,
  );
});
