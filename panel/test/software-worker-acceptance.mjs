// Runs only on an explicitly selected fresh engine. No normal test selects it.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {docker} from '../core/docker.js';
import {resources, labels} from '../core/instance.js';
import {
  softwareWorkerDeployment as deployment,
  validateSoftwareWorkerImage,
} from '../core/software-worker-policy.js';

assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID,
  'Choose an explicit disposable engine.',
);
assert.equal(process.env.DOCKER_BROKER_SOCKET, undefined);
assert.equal(process.env.DOCKER_BROKER_TOKEN_FILE, undefined);
const engine = await docker('GET', '/info');
if (process.env.GITHUB_ACTIONS !== 'true')
  assert.equal(engine.ID, process.env.LOBBY_DISPOSABLE_ENGINE_ID);
assert.equal(engine.OSType, 'linux');
assert.ok(['amd64', 'x86_64'].includes(engine.Architecture));
assert.equal(
  (await docker('GET', '/containers/json?all=1')).length,
  0,
  'Acceptance requires a fresh engine without existing containers.',
);
const run = (args, timeout = 120000) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 ** 2,
  });
const runtimeName = process.env.SOFTWARE_ACCEPTANCE_RUNTIME;
assert.equal(runtimeName, 'local/lobby-software-acceptance:amd64');
const runtime = JSON.parse(run(['image', 'inspect', runtimeName]))[0].Id;
assert.match(runtime, /^sha256:[a-f0-9]{64}$/);
run(['pull', '--platform', 'linux/amd64', deployment.image], 1200000);
// Fail before creating resources when the engine presents a different contract.
// Only public digests, bounded version identifiers and predicate booleans leave
// this diagnostic; never serialize Docker configuration or environment values.
const workerImage = await docker(
  'GET',
  '/images/' + encodeURIComponent(deployment.image) + '/json',
);
try {
  validateSoftwareWorkerImage(workerImage);
} catch {
  const cliImage = JSON.parse(run(['image', 'inspect', deployment.image]))[0];
  const version = await docker('GET', '/version');
  const digest = (value) =>
    typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
      ? value
      : null;
  const identifier = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_.+-]{1,64}$/.test(value)
      ? value
      : null;
  const tag = deployment.image.split('@')[0];
  const repositoryDigest =
    tag.slice(0, tag.lastIndexOf(':')) + '@' + deployment.image.split('@')[1];
  assert.fail(
    JSON.stringify({
      contract: 'published-steam-worker',
      engineVersion: identifier(version.Version),
      apiVersion: identifier(version.ApiVersion),
      storageDriver: identifier(engine.Driver),
      cliImageId: digest(cliImage.Id),
      apiImageId: digest(workerImage.Id),
      expectedConfigId: deployment.imageId,
      descriptorDigest: digest(workerImage.Descriptor?.digest),
      manifests: Array.isArray(workerImage.Manifests)
        ? workerImage.Manifests.slice(0, 8).map((item) =>
            digest(item.Descriptor?.digest),
          )
        : [],
      matches: {
        configId: workerImage.Id === deployment.imageId,
        repositoryDigest:
          workerImage.RepoDigests?.includes(repositoryDigest) === true,
        platform:
          workerImage.Os === 'linux' && workerImage.Architecture === 'amd64',
        user: workerImage.Config?.User === '1000:1000',
        entrypoint:
          JSON.stringify(workerImage.Config?.Entrypoint) ===
          JSON.stringify(deployment.entrypoint),
        command: JSON.stringify(workerImage.Config?.Cmd || []) === '[]',
        provider:
          workerImage.Config?.Labels?.['io.lobby-goblin.provider'] ===
          'steamcmd-worker',
        revision:
          workerImage.Config?.Labels?.['io.lobby-goblin.image-revision'] ===
          deployment.revision,
      },
    }),
  );
}

const fleet = randomUUID().replaceAll('-', ''),
  instance = randomUUID().replaceAll('-', ''),
  owned = resources(fleet, instance, 'rust'),
  project = 'lobby-goblin-fleet-' + fleet;
const transport = project + '-broker-transport',
  state = project + '-broker-state',
  broker = 'lobby-goblin-docker-broker-' + fleet;
const fixture = fileURLToPath(
  new URL('./software-worker-native.mjs', import.meta.url),
);
const bind = {
  Type: 'bind',
  Source: fixture,
  Target: '/acceptance.mjs',
  ReadOnly: true,
};
const volume = (source, target, subpath, readOnly = false) => ({
  Type: 'volume',
  Source: source,
  Target: target,
  ReadOnly: readOnly,
  ...(subpath ? {VolumeOptions: {Subpath: subpath, NoCopy: true}} : {}),
});
const credential = (subpath) => [
  volume(transport, '/broker/socket', 'socket', true),
  volume(transport, '/broker/credential', subpath, true),
];
const base = (role, mounts = []) => ({
  Image: runtime,
  User: '0:0',
  Entrypoint: ['node', '/acceptance.mjs'],
  Cmd: [role],
  Env: [
    'SOFTWARE_WORKER_ACCEPTANCE=disposable',
    'FLEET_ID=' + fleet,
    'FLEET_INSTANCE=' + instance,
    'FLEET_VOLUME=' + owned.volume,
  ],
  Labels: {
    ...labels(fleet, instance, 'rust'),
    'io.lobby-goblin.acceptance': 'software-worker',
  },
  HostConfig: {
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Memory: 256 * 1024 ** 2,
    NanoCpus: 1e9,
    PidsLimit: 256,
    CapDrop: ['ALL'],
    CapAdd: ['DAC_OVERRIDE'],
    SecurityOpt: ['no-new-privileges:true'],
    Tmpfs: {'/tmp': 'rw,nosuid,size=64m'},
    Mounts: [bind, ...mounts],
  },
});
async function start(name, spec) {
  const {Id} = await docker(
    'POST',
    '/containers/create?' + new URLSearchParams({name}),
    spec,
  );
  await docker('POST', '/containers/' + Id + '/start');
  return Id;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(id, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const info = await docker('GET', '/containers/' + id + '/json');
    if (!info.State.Running) {
      const logs = run(['logs', id]);
      assert.equal(info.State.ExitCode, 0, logs.slice(-6000));
      return logs;
    }
    assert.ok(Date.now() < deadline, 'Disposable fixture timed out.');
    await sleep(1000);
  }
}
try {
  for (const name of [owned.volume, state, transport])
    await docker('POST', '/volumes/create', {
      Name: name,
      Labels: {
        ...labels(fleet, instance, 'rust'),
        'io.lobby-goblin.acceptance': 'software-worker',
      },
    });
  await docker('POST', '/networks/create', {
    Name: owned.network,
    Driver: 'bridge',
    Labels: labels(fleet, instance, 'rust'),
  });
  const initialize = await start(
    'lobby-software-initialize-' + instance,
    base('initialize', [volume(owned.volume, '/instance')]),
  );
  await wait(initialize);
  await docker('DELETE', '/containers/' + initialize);
  const brokerSpec = base('broker', [
    volume(state, '/broker-state'),
    volume(transport, '/broker-transport'),
    {
      Type: 'bind',
      Source: '/var/run/docker.sock',
      Target: '/var/run/docker.sock',
    },
  ]);
  brokerSpec.Env.push('ACCEPTANCE_RUNTIME=' + runtime, 'MODE=docker-broker');
  brokerSpec.Labels = {
    'io.lobby-goblin.fleet': fleet,
    'io.lobby-goblin.role': 'docker-broker',
    'io.lobby-goblin.acceptance': 'software-worker',
  };
  brokerSpec.HostConfig.CapAdd = [];
  await start(broker, brokerSpec);
  const deadline = Date.now() + 90000;
  for (;;) {
    const info = await docker('GET', '/containers/' + broker + '/json');
    assert.equal(info.State.Running, true);
    if (info.State.Health?.Status === 'healthy') break;
    assert.ok(Date.now() < deadline, 'Disposable broker health timed out.');
    await sleep(1000);
  }
  const grantSpec = base('grant', credential('host'));
  grantSpec.Env.push(
    'DOCKER_BROKER_SOCKET=/broker/socket/docker.sock',
    'DOCKER_BROKER_TOKEN_FILE=/broker/credential/token',
  );
  const grant = await start('lobby-software-grant-' + instance, grantSpec);
  await wait(grant);
  await docker('DELETE', '/containers/' + grant);
  // This is an idle Node process, not Rust or any game executable.
  await start(owned.container, {
    Image: runtime,
    User: '1000:1000',
    Entrypoint: ['node', '-e', 'setInterval(()=>{},1000)'],
    Cmd: [],
    Labels: labels(fleet, instance, 'rust'),
    HostConfig: {
      NetworkMode: owned.network,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 2 * 1024 ** 3,
      NanoCpus: 1e9,
      PidsLimit: 128,
      Mounts: [volume(owned.volume, '/steamcmd/rust', 'data')],
    },
  });
  const controllerSpec = base('controller', [
    volume(owned.volume, '/instance'),
    ...credential('instances/' + instance),
  ]);
  controllerSpec.Labels['io.lobby-goblin.role'] = 'instance-controller';
  controllerSpec.HostConfig.Memory = 1024 ** 3;
  controllerSpec.Env.push(
    'DOCKER_BROKER_SOCKET=/broker/socket/docker.sock',
    'DOCKER_BROKER_TOKEN_FILE=/broker/credential/token',
  );
  const controller = await start(owned.controller, controllerSpec);
  console.log(await wait(controller, 2700000));
} finally {
  const filters = encodeURIComponent(
    JSON.stringify({label: ['io.lobby-goblin.fleet=' + fleet]}),
  );
  for (const item of await docker(
    'GET',
    '/containers/json?all=1&filters=' + filters,
  )) {
    const info = await docker('GET', '/containers/' + item.Id + '/json');
    assert.equal(info.Config.Labels['io.lobby-goblin.fleet'], fleet);
    if (info.State.Running)
      await docker('POST', '/containers/' + item.Id + '/stop?t=30', undefined, {
        timeout: 45000,
      });
    await docker('DELETE', '/containers/' + item.Id);
  }
  await docker('DELETE', '/networks/' + owned.network);
  for (const name of [owned.volume, state, transport]) {
    const info = await docker('GET', '/volumes/' + name);
    assert.equal(info.Labels['io.lobby-goblin.fleet'], fleet);
    await docker('DELETE', '/volumes/' + name);
  }
}
