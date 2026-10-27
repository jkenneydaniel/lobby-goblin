import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {
  main,
  executeWorkerRequest,
} from '/opt/lobby/panel/providers/steamcmd/worker.js';
import {createSteamProvider} from '/opt/lobby/panel/providers/steamcmd/provider.js';

assert.equal(process.env.LOBBY_STEAM_WORKER_ACCEPTANCE, 'disposable');
assert.equal(process.getuid(), 1000);
for (const root of ['/software', '/control', '/request', '/result'])
  assert.deepEqual(
    await fs.readdir(root),
    [],
    'Acceptance requires fresh container storage.',
  );
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
async function call(input) {
  await fs.writeFile('/request/request.json', JSON.stringify(input));
  await main();
  const response = JSON.parse(await fs.readFile('/result/result.json', 'utf8'));
  assert.equal(response.id, input.id);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
const selection = await call(
  request('resolve', {initial: {channel: 'public'}}),
);
const prepared = await call(request('prepare', {selection, confirm: true}));
assert.equal(await fs.stat('/control/active.json').catch(() => null), null);
await assert.rejects(executeWorkerRequest(request('activate')), /supported/);
// No game process or world exists in this container. Only this trusted fixture
// supplies lifecycle observations; the worker request protocol cannot do so.
const controller = createSteamProvider({
  source,
  requiredFiles,
  software: '/software',
  control: '/control',
  isApplicationEmpty: async () => true,
  isApplicationStopped: async () => true,
  command: async () => assert.fail('Controller verification must be offline'),
});
const receipt = await controller.activate(prepared, {confirm: true});
assert.equal(await controller.installed(receipt), true);
assert.deepEqual(await controller.install(selection), receipt);
const cached = await executeWorkerRequest(
  request('prepare', {selection, confirm: true}),
  {
    command: async () =>
      assert.fail('Verified cache preparation must be offline'),
  },
);
assert.deepEqual(cached.result.receipt, receipt);
assert.deepEqual(
  await controller.activate(cached.result, {confirm: true}),
  receipt,
);
console.log(
  JSON.stringify({
    passed: true,
    user: process.getuid(),
    privatePreparation: true,
    controllerActivation: true,
    inventoryVerified: true,
    offlineRestart: true,
    offlineCachePreparation: true,
    buildId: selection.softwareVersion,
    files: receipt.inventory.files,
    bytes: receipt.inventory.bytes,
    gameProcessStarted: false,
  }),
);
