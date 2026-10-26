// Invoked only by the status-page package on a disposable engine. No production
// image-policy exception: the fixture publishes into its own loopback registry.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  brokerClient,
  brokerSocket,
  brokerToken,
} from '../core/broker-client.js';
import {FleetManager} from '../fleet/manager.js';
import {docker} from '../core/docker.js';
import {selectedApplication} from '../applications/index.js';
const {
  ACCEPTANCE_ENGINE_ID: engine,
  ACCEPTANCE_FLEET: fleet,
  ACCEPTANCE_RUNNER: runner,
  ACCEPTANCE_IMAGE: image,
} = process.env;
assert.equal((await docker('GET', '/info')).ID, engine);
assert.match(fleet, /^[a-f0-9]{32}$/);
assert.equal(runner, 'lobby-goblin-host-' + fleet);
const initial = await docker('GET', '/containers/json?all=1');
assert.ok(
  initial.every(
    (item) =>
      item.Labels['io.lobby-goblin.acceptance'] === 'application-packages',
  ),
);
const broker = brokerClient({
  socketPath: brokerSocket,
  tokenFile: brokerToken,
});
const manager = new FleetManager({
  docker: broker.docker,
  broker,
  brokerVolume: `lobby-goblin-fleet-${fleet}-broker-transport`,
  fleet,
  image,
  hostContainer: runner,
  stateVolume: `lobby-goblin-fleet-${fleet}-state`,
  libraryVolume: `lobby-goblin-fleet-${fleet}-library`,
  root: '/fleet',
  library: '/library',
  bind: '127.0.0.1',
  memoryBudgetGiB: 8,
  gameModules: [selectedApplication('status-page')],
});
await manager.init();
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(fn) {
  for (let attempt = 0; attempt < 900; attempt++) {
    const value = await fn();
    if (value) return value;
    await pause();
  }
  throw Error('Disposable application did not settle.');
}
async function operation(action, input) {
  const job = await manager.submit(action, input);
  const result = await until(() => {
    const current = manager.state.jobs.find((item) => item.id === job.id);
    return current &&
      !manager.active &&
      ['succeeded', 'failed', 'interrupted'].includes(current.state)
      ? current
      : null;
  });
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  return result;
}
async function child(item, action, params = {}) {
  const job = await manager.request(item, '/jobs', {action, params});
  const result = await until(async () => {
    const value = await manager.request(item, '/jobs');
    const current = value.jobs.find((entry) => entry.id === job.id);
    return !value.active &&
      current &&
      ['succeeded', 'failed'].includes(current.state)
      ? current
      : null;
  });
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  return result;
}
const created = await operation('create', {
  game: 'status-page',
  name: 'Disposable status page',
  memoryGiB: 1,
  cpu: 0.5,
  autoStart: false,
});
const first = manager.server(created.result.serverId);
await until(async () => (await manager.request(first, '/status')).ready);
assert.match(
  await (await fetch(`http://${first.container}:8080/`)).text(),
  /All systems operational/,
);
assert.match(first.image, /@sha256:[a-f0-9]{64}$/);
execFileSync('docker', [
  'exec',
  first.container,
  'node',
  '-e',
  "const fs=require('node:fs');fs.mkdirSync('/data/nested');fs.writeFileSync('/data/nested/sentinel.txt','application-owned persistent data');",
]);
await child(first, 'stop', {confirm: true});
const settings = await manager.request(first, '/settings');
await child(first, 'save-settings', {
  revision: settings.revision,
  values: {
    title: 'Disposable status',
    message: 'Persisted through backup and clone.',
  },
});
await child(first, 'start');
assert.match(
  await (await fetch(`http://${first.container}:8080/`)).text(),
  /Persisted through backup/,
);
await child(first, 'stop', {confirm: true});
const published = await operation('publish', {
  serverId: first.id,
  title: 'Disposable recovery snapshot',
  confirm: true,
});
const cloned = await operation('create', {
  game: 'status-page',
  name: 'Disposable clone',
  memoryGiB: 1,
  cpu: 0.5,
  autoStart: false,
  snapshotId: published.result.snapshotId,
});
const second = manager.server(cloned.result.serverId);
await until(async () => (await manager.request(second, '/status')).ready);
assert.match(
  await (await fetch(`http://${second.container}:8080/`)).text(),
  /Persisted through backup/,
);
assert.equal(
  execFileSync(
    'docker',
    [
      'exec',
      second.container,
      'node',
      '-e',
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/data/nested/sentinel.txt','utf8'));fs.appendFileSync('/data/nested/sentinel.txt',' retained');",
    ],
    {encoding: 'utf8'},
  ),
  'application-owned persistent data',
);
assert.notEqual(first.volume, second.volume);
assert.notEqual(first.controllerToken, second.controllerToken);
for (const item of [first, second]) {
  const info = await docker('GET', '/containers/' + item.controller + '/json');
  assert.ok(!info.Mounts.some((m) => m.Destination === '/var/run/docker.sock'));
  assert.ok(
    info.HostConfig.Mounts.some(
      (m) =>
        m.Target === '/broker/credential' &&
        m.ReadOnly &&
        m.VolumeOptions.Subpath === 'instances/' + item.id,
    ),
  );
}
execFileSync('docker', [
  'exec',
  second.controller,
  'node',
  '--input-type=module',
  '-e',
  "import assert from 'node:assert/strict';import {brokerClient,brokerSocket,brokerToken} from './core/broker-client.js';const client=brokerClient({socketPath:brokerSocket,tokenFile:brokerToken});await assert.rejects(client.docker('GET','/containers/" +
    first.container +
    "/json'),error=>error.status===409&&error.message==='Container belongs to a different installation.');",
]);
const logs = await manager.request(second, '/logs');
assert.match(logs.logs, /Status page ready/);
for (const item of [first, second])
  await operation('remove', {
    serverId: item.id,
    name: item.name,
    confirm: true,
  });
console.log(
  JSON.stringify(
    {
      passed: true,
      application: 'status-page',
      transport: 'scoped Docker broker',
      engine,
      pinnedImage: first.image,
      checks: [
        'normal host provisioning through broker',
        'controllers have no daemon socket',
        'sibling access refused',
        'Docker health',
        'HTTP content',
        'stopped configuration',
        'logs',
        'backup',
        'snapshot clone',
        'fresh credentials',
        'owned removal',
      ],
    },
    null,
    2,
  ),
);
