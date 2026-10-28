// Opt-in ordinary management-lifecycle acceptance. Only a newly created fleet
// on the explicitly marked disposable engine is used. Application files are
// fingerprinted read-only and no application action is submitted after setup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {docker} from '../core/docker.js';
import {ManagementEngine} from '../fleet/management-engine.js';
import {ManagementUpdate} from '../fleet/management-update.js';
import {main as updateCLI} from '../management-update.js';
import {
  installationFiles,
  optionsFor,
  readInstallation,
  composeArgs,
  run,
} from '../install.js';
import {
  hostInstallationFiles,
  readHostInstallation,
  hostComposeArgs,
} from '../host-install.js';
import {agentOptionsFor} from '../agent-options.js';
import {
  assertManagementStartAllowed,
  managementInstallationRuntime,
  managementHash,
} from '../core/management-installation.js';

const owner = '01a16598-733c-7232-bd99-1d6b06086183';
assert.equal(
  (await fs.readFile('/acceptance-owner', 'utf8')).trim(),
  owner + ' disposable platform acceptance only',
);
assert.equal(process.env.DOCKER_SOCKET, '/var/run/docker.sock');
const engineId = process.env.ACCEPTANCE_ENGINE_ID,
  runtime = process.env.ACCEPTANCE_RUNTIME,
  next = process.env.ACCEPTANCE_NEXT;
assert.equal((await docker('GET', '/info')).ID, engineId);
for (const image of [runtime, next])
  assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
const initial = await docker('GET', '/containers/json?all=1');
const previousFleets = (process.env.ACCEPTANCE_PREVIOUS_FLEETS || '')
  .split(',')
  .filter(Boolean);
assert.ok(
  previousFleets.length <= 4 &&
    previousFleets.every((id) => /^[a-f0-9]{32}$/.test(id)),
);
const agent = process.env.ACCEPTANCE_AGENT === 'true';
assert.ok(process.env.ACCEPTANCE_AGENT === undefined || agent);
const runners = initial.filter(
  (item) => item.Labels['io.lobby-goblin.acceptance'] === owner,
);
assert.equal(runners.length, 1);
assert.ok(
  initial.every(
    (item) =>
      item.Id === runners[0].Id ||
      previousFleets.includes(item.Labels['io.lobby-goblin.fleet']),
  ),
  'Only the new runner and explicitly retained disposable fleet may exist.',
);
const fleet = crypto.randomBytes(16).toString('hex'),
  project = 'lobby-goblin-fleet-' + fleet;
const host = 'lobby-goblin-host-' + fleet;
const inspect = (id) => docker('GET', '/containers/' + id + '/json');
const driver = new ManagementEngine({
  socket: '/var/run/docker.sock',
  engine: engineId,
  timeout: 90000,
});
const wait = async (read) => {
  const deadline = Date.now() + 120000;
  do {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw Error('Disposable management fixture timed out.');
};
const directory = '/acceptance-output/installation';
await fs.mkdir(directory, {mode: 0o700});
const reference = 'ghcr.io/jkenneydaniel/lobby-goblin:acceptance-' + fleet;
const files = agent
  ? hostInstallationFiles(
      agentOptionsFor(
        {
          image: reference,
          domain: 'acceptance.example.test',
          agentPort: process.env.ACCEPTANCE_AGENT_PORT || 24443,
          address: '127.0.0.1',
          memory: 2,
        },
        '0.3.6-alpha',
      ),
      fleet,
    )
  : installationFiles(
      optionsFor({image: reference, address: '127.0.0.1'}, '0.3.6-alpha'),
      await fs.readFile('/acceptance-template', 'utf8'),
      fleet,
    );
for (const [name, value] of Object.entries(files))
  await fs.writeFile(path.join(directory, name), value, {
    mode: 0o600,
    flag: 'wx',
  });
const installation = await (agent ? readHostInstallation : readInstallation)(
  directory,
);
const command = (args) =>
  run('docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
// Tags and Compose resources are local to this disposable engine. Nothing is
// pushed, and --pull never prevents the fixture from selecting a registry image.
await command(['image', 'tag', runtime, reference]);
const compose = (agent ? hostComposeArgs : composeArgs)(
  directory,
  installation,
);
await command([
  ...compose,
  'up',
  '-d',
  '--no-build',
  '--pull',
  'never',
  '--wait',
  '--wait-timeout',
  '180',
]);
const network = Object.keys(
  (await inspect(host)).NetworkSettings.Networks,
).find((name) => name.startsWith(project));
assert.ok(network);
await docker('POST', '/networks/' + network + '/connect', {
  Container: runners[0].Id,
});
const token = (
  await driver.readFile(host, '/web-state/secrets/controller-token')
)
  .toString()
  .trim();
async function request(route, body) {
  const response = await fetch('http://' + host + ':8091' + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const value = await response.json();
  assert.ok(response.ok, value.error || 'Fixture request failed.');
  return value;
}
const job = await request('/servers', {
  name: 'Management preservation fixture',
  game: 'arena',
  cpu: 1,
  memoryGiB: 1,
  maxPlayers: 8,
  autoStart: true,
  tickRate: 20,
});
await wait(async () => {
  const value = await request('/jobs'),
    current = value.jobs.find((item) => item.id === job.id);
  if (current && ['failed', 'interrupted'].includes(current.state))
    throw Error(current.message);
  return current?.state === 'succeeded' && !value.active;
});
const item = (await request('/servers')).servers.find(
  (value) => value.game === 'arena',
);
assert.ok(item);
await wait(
  async () =>
    (await request('/servers/' + item.id + '/controller/status')).ready,
);
const before = await inspect(item.container),
  world = await driver.readFile(item.container, '/arena/matches/current.json');
const protectedHash = managementHash({
  id: before.Id,
  image: before.Image,
  mounts: before.Mounts,
  host: before.HostConfig,
  networks: before.NetworkSettings.Networks,
  started: before.State.StartedAt,
});
async function preserved() {
  const after = await inspect(item.container);
  assert.equal(
    managementHash({
      id: after.Id,
      image: after.Image,
      mounts: after.Mounts,
      host: after.HostConfig,
      networks: after.NetworkSettings.Networks,
      started: after.State.StartedAt,
    }),
    protectedHash,
  );
  assert.deepEqual(
    await driver.readFile(item.container, '/arena/matches/current.json'),
    world,
  );
  await assertManagementStartAllowed(directory);
  const effective = await managementInstallationRuntime(
    directory,
    installation,
  );
  const selected = await command([
    ...compose,
    ...effective.arguments,
    'ps',
    '--all',
    '--quiet',
    'fleet-controller',
  ]);
  assert.equal(
    selected.trim(),
    (await inspect(host)).Id,
    'Compose must select only the current management service.',
  );
  for (const [name, value] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), value);
}
const options = [
  '--directory',
  directory,
  '--socket',
  '/var/run/docker.sock',
  '--engine',
  engineId,
];
if (process.env.ACCEPTANCE_PANEL === 'true') {
  const originalHost = (await inspect(host)).Id;
  const reviewed = await request('/management-update', {action: 'plan', version: '0.3.7-alpha', requestId: crypto.randomBytes(16).toString('hex')});
  const id = reviewed.update.id;
  const review = await wait(async () => {
    const value = await request('/management-update');
    if (['failed', 'attention'].includes(value.update?.state)) throw Error(JSON.stringify(value));
    return value.update?.state === 'reviewed' && value.update;
  });
  assert.equal(review.services.applications, 1);
  assert.ok(review.actions.includes('apply'));
  await request('/management-update', {action: 'apply', id, confirm: true, requestId: crypto.randomBytes(16).toString('hex')});
  const complete = await wait(async () => {
    try {
      const value = await request('/management-update');
      if (value.update?.state === 'attention') throw Object.assign(Error(JSON.stringify(value)), {fatal: true});
      return value.update?.state === 'complete' && value;
    } catch (error) { if (error.fatal) throw error; return null; }
  });
  assert.equal(complete.currentVersion, '0.3.7-alpha');
  assert.equal(complete.update.id, id);
  await preserved();
  const operatorRecord = JSON.parse(await fs.readFile(path.join(directory, '.management-updates', id, 'operation.json'), 'utf8'));
  assert.equal((await fs.stat(path.join(directory, '.management-updates'))).uid, process.getuid());
  assert.equal(operatorRecord.phase, 'complete');
  assert.equal(operatorRecord.pending, null);
  assert.equal((await inspect(item.container)).State.Running, true);
  assert.notEqual((await inspect(host)).Id, originalHost);
  await wait(async () => !(await docker('GET', '/containers/json?all=1')).some(value => value.Labels?.['io.lobby-goblin.fleet'] === fleet && value.Labels?.['io.lobby-goblin.role'] === 'management-panel-worker'));
  // A panel update must not leave a helper which breaks the existing operator
  // planner's strict stray-container guard. Prove the fallback remains usable.
  const operatorReview = await updateCLI(['plan', ...options, '--image', next], {log: () => {}});
  await updateCLI(['rollback', ...options, '--id', operatorReview.id, '--confirm'], {log: () => {}});
  await preserved();
  await fs.writeFile('/acceptance-output/result.json', JSON.stringify({panel: true, complete: true, fleet, engineId, id, protectedHash, game: before.Id, worldHash: crypto.createHash('sha256').update(world).digest('hex')}, null, 2), {flag: 'wx', mode: 0o600});
  console.log('Panel-triggered detached management update passed with operator-owned records, broker reconnection and unchanged application/world identity.');
  process.exit(0);
}
let plan = await updateCLI(['plan', ...options, '--image', next], {
  log: () => {},
});
await fs.writeFile(
  '/acceptance-output/scope.json',
  JSON.stringify(
    {
      fleet,
      engineId,
      game: before.Id,
      worldHash: crypto.createHash('sha256').update(world).digest('hex'),
      id: plan.id,
    },
    null,
    2,
  ),
  {mode: 0o600, flag: 'wx'},
);
try {
  const success = await updateCLI(
    ['apply', ...options, '--id', plan.id, '--confirm'],
    {log: () => {}},
  );
  assert.equal(success.operation.state, 'succeeded');
  await preserved();
  console.log(
    'Fresh CLI update passed; original application identity and bytes preserved.',
  );
  const outcomes = [];
  for (const scenario of [
    'rollback',
    'replacement-response',
    'activation-response',
    'publication-response',
  ]) {
    const engine = new ManagementEngine({
      socket: '/var/run/docker.sock',
      engine: engineId,
      timeout: 90000,
    });
    const workflow = new ManagementUpdate({directory, installation, engine});
    const target =
      (await managementInstallationRuntime(directory, installation)).image ===
      next
        ? runtime
        : next;
    plan = await workflow.plan(target);
    let once = true;
    if (scenario === 'rollback') {
      const verify = engine.verifyReplacements.bind(engine);
      engine.verifyReplacements = async (p, o) => {
        await verify(p, o);
        if (o.held && once) {
          once = false;
          throw Error('Injected pre-activation verification failure');
        }
      };
    }
    if (scenario === 'replacement-response') {
      const send = engine.request;
      engine.request = async (method, route, ...args) => {
        const result = await send(method, route, ...args);
        if (
          once &&
          method === 'POST' &&
          route.startsWith('/containers/create?') &&
          new URL('http://engine' + route).searchParams.get('name') === host
        ) {
          once = false;
          throw Error('Injected lost create response');
        }
        return result;
      };
    }
    if (scenario === 'activation-response') {
      const activate = engine.activate.bind(engine);
      engine.activate = async (s, p) => {
        const result = await activate(s, p);
        if (once && s.role === 'host-controller') {
          once = false;
          const crashed = await engine.inspect(s.name);
          await engine.request(
            'POST',
            '/containers/' + crashed.Id + '/stop?t=10',
          );
          throw Error(
            'Injected lost activation response and management process stop',
          );
        }
        return result;
      };
    }
    if (scenario === 'publication-response') {
      const publish = engine.publish.bind(engine);
      engine.publish = async (...args) => {
        await publish(...args);
        if (once) {
          once = false;
          throw Error('Injected lost outcome publication response');
        }
      };
    }
    await assert.rejects(workflow.run(plan.id, {confirm: true}));
    await assert.rejects(assertManagementStartAllowed(directory));
    if (scenario === 'activation-response')
      await assert.rejects(
        workflow.run(plan.id, {confirm: true, rollback: true}),
        /Resume forward/,
      );
    const result = await workflow.run(plan.id, {
      confirm: true,
      rollback: scenario === 'rollback',
    });
    assert.equal(
      result.operation.state,
      scenario === 'rollback' ? 'failed' : 'succeeded',
    );
    await preserved();
    outcomes.push({scenario, id: plan.id, state: result.operation.state});
    console.log('Recovery passed: ' + scenario);
  }
  await fs.writeFile(
    '/acceptance-output/result.json',
    JSON.stringify(
      {
        fleet,
        engineId,
        game: before.Id,
        protectedHash,
        outcomes,
        complete: true,
      },
      null,
      2,
    ),
    {mode: 0o600, flag: 'wx'},
  );
  console.log(
    'All real Docker management update/recovery scenarios passed without changing the application container or world bytes.',
  );
} catch (error) {
  console.error(error.cause?.message || error.message);
  throw error;
}
