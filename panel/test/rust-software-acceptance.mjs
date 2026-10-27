// Explicit fresh-engine acceptance only. All resources use this run's fleet ID.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {docker} from '../core/docker.js';
import {resources, labels} from '../core/instance.js';
import {selectedApplication} from '../applications/index.js';
const engine = await docker('GET', '/info');
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine.ID,
  'Choose this explicit disposable engine.',
);
assert.equal(process.env.DOCKER_BROKER_SOCKET, undefined);
assert.equal(
  (await docker('GET', '/containers/json?all=1')).length,
  0,
  'A fresh engine is required.',
);
assert.equal(engine.OSType, 'linux');
assert.ok(['amd64', 'x86_64'].includes(engine.Architecture));
const run = (args, timeout = 120000) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 ** 2,
  });
const runtimeName = process.env.SOFTWARE_ACCEPTANCE_RUNTIME;
assert.equal(runtimeName, 'local/lobby-software-acceptance:amd64');
const runtime = JSON.parse(run(['image', 'inspect', runtimeName]))[0].Id;
const rust = selectedApplication('rust'),
  image = rust.managed.runtime.imagePolicy.defaultImage;
run(['pull', '--platform', 'linux/amd64', image], 1200000);
const imageId = JSON.parse(run(['image', 'inspect', image]))[0].Id;
assert.equal(
  imageId,
  'sha256:372dc5104189728730e7efacc3dea7d649203957718b702fee52a53d390bbe29',
);
const fleet = randomUUID().replaceAll('-', ''),
  first = randomUUID().replaceAll('-', ''),
  second = randomUUID().replaceAll('-', ''),
  snapshot = randomUUID().replaceAll('-', '');
const scopes = [first, second].map((id) => ({
  id,
  ...resources(fleet, id, 'rust'),
}));
const project = 'lobby-goblin-fleet-' + fleet,
  transport = project + '-broker-transport',
  state = project + '-broker-state',
  library = project + '-native-library',
  broker = 'lobby-goblin-docker-broker-' + fleet;
const passwords = new Map(
  scopes.map((scope) => [
    scope.id,
    randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
  ]),
);
const redact = (text) =>
  [...passwords.values()].reduce(
    (text, password) => text.replaceAll(password, '[redacted]'),
    String(text),
  );
const fixture = fileURLToPath(
  new URL('./rust-software-native.mjs', import.meta.url),
);
const volume = (source, target, subpath, readOnly = false) => ({
  Type: 'volume',
  Source: source,
  Target: target,
  ReadOnly: readOnly,
  VolumeOptions: {NoCopy: true, ...(subpath ? {Subpath: subpath} : {})},
});
const credential = (subpath) => [
  volume(transport, '/broker/socket', 'socket', true),
  volume(transport, '/broker/credential', subpath, true),
];
const base = (scope, role, mounts = []) => ({
  Image: runtime,
  User: '0:0',
  Entrypoint: ['node', '/acceptance.mjs'],
  Cmd: [role],
  Env: [
    'RUST_SOFTWARE_ACCEPTANCE=disposable',
    'FLEET_ID=' + fleet,
    'FLEET_INSTANCE=' + scope.id,
    'FLEET_VOLUME=' + scope.volume,
    'NATIVE_GAME_PASSWORD=' + passwords.get(scope.id),
    'NATIVE_GAME_IMAGE=' + image,
    'NATIVE_SOURCE_ID=' + first,
    'NATIVE_SNAPSHOT_ID=' + snapshot,
  ],
  Labels: {
    ...labels(fleet, scope.id, 'rust'),
    'io.lobby-goblin.acceptance': 'rust-software',
  },
  HostConfig: {
    Init: true,
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    Memory: 512 * 1024 ** 2,
    NanoCpus: 1e9,
    PidsLimit: 256,
    CapDrop: ['ALL'],
    CapAdd: ['DAC_OVERRIDE'],
    SecurityOpt: ['no-new-privileges:true'],
    Tmpfs: {'/tmp': 'rw,nosuid,size=64m'},
    Mounts: [
      {
        Type: 'bind',
        Source: fixture,
        Target: '/acceptance.mjs',
        ReadOnly: true,
      },
      ...mounts,
    ],
  },
});
async function create(name, spec, start = true) {
  const {Id} = await docker(
    'POST',
    '/containers/create?' + new URLSearchParams({name}),
    spec,
  );
  if (start) await docker('POST', '/containers/' + Id + '/start');
  return Id;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(id, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const info = await docker('GET', '/containers/' + id + '/json');
    if (!info.State.Running) {
      const logs = redact(run(['logs', id]));
      assert.equal(info.State.ExitCode, 0, logs.slice(-10000));
      return logs;
    }
    assert.ok(Date.now() < deadline, 'Disposable Rust acceptance timed out.');
    await sleep(1000);
  }
}
async function grant(scope) {
  const spec = base(scope, 'grant', credential('host'));
  spec.Env.push(
    'DOCKER_BROKER_SOCKET=/broker/socket/docker.sock',
    'DOCKER_BROKER_TOKEN_FILE=/broker/credential/token',
  );
  const id = await create('lobby-rust-grant-' + scope.id, spec);
  await wait(id);
  await docker('DELETE', '/containers/' + id);
}
async function game(scope) {
  const item = {
    id: scope.id,
    image,
    rconPassword: passwords.get(scope.id),
    worldSize: 1000,
    seed: 12345,
  };
  return create(
    scope.container,
    {
      Image: image,
      Env: Object.entries(rust.managed.gameEnvironment(item)).map(
        ([k, v]) => k + '=' + v,
      ),
      Labels: labels(fleet, scope.id, 'rust'),
      HostConfig: {
        RestartPolicy: {Name: 'no'},
        NetworkMode: scope.network,
        Memory: 10 * 1024 ** 3,
        NanoCpus: 2e9,
        PidsLimit: 1024,
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'],
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [volume(scope.volume, '/steamcmd/rust', 'data')],
      },
    },
    false,
  );
}
async function controller(scope, clone) {
  const spec = base(scope, 'controller', [
    volume(scope.volume, '/instance'),
    ...credential('instances/' + scope.id),
  ]);
  spec.Env.push(
    'DOCKER_BROKER_SOCKET=/broker/socket/docker.sock',
    'DOCKER_BROKER_TOKEN_FILE=/broker/credential/token',
    'NATIVE_CLONE=' + String(clone),
  );
  spec.Labels['io.lobby-goblin.role'] = 'instance-controller';
  spec.HostConfig.NetworkMode = scope.network;
  spec.HostConfig.Memory = 1024 ** 3;
  const id = await create(scope.controller, spec);
  const logs = await wait(id, 4800000);
  console.log(logs);
  const info = await docker('GET', '/containers/' + scope.container + '/json');
  assert.equal(info.State.Running, false);
  assert.equal(info.State.ExitCode, 0);
  assert.equal(info.Image, imageId);
  return JSON.parse(logs.trim().split('\n').at(-1));
}
try {
  for (const name of [scopes[0].volume, state, transport, library])
    await docker('POST', '/volumes/create', {
      Name: name,
      Labels: {
        ...(name === scopes[0].volume
          ? labels(fleet, first, 'rust')
          : {'io.lobby-goblin.fleet': fleet}),
        'io.lobby-goblin.acceptance': 'rust-software',
      },
    });
  const init = await create(
    'lobby-rust-initialize-' + first,
    base(scopes[0], 'initialize', [volume(scopes[0].volume, '/instance')]),
  );
  await wait(init);
  await docker('DELETE', '/containers/' + init);
  const brokerSpec = base(scopes[0], 'broker', [
    volume(state, '/broker-state'),
    volume(transport, '/broker-transport'),
    {
      Type: 'bind',
      Source: '/var/run/docker.sock',
      Target: '/var/run/docker.sock',
    },
  ]);
  brokerSpec.Env = brokerSpec.Env.filter(
    (value) => !value.startsWith('NATIVE_GAME_PASSWORD='),
  );
  brokerSpec.Env.push('ACCEPTANCE_RUNTIME=' + runtime, 'MODE=docker-broker');
  brokerSpec.Labels = {
    'io.lobby-goblin.fleet': fleet,
    'io.lobby-goblin.role': 'docker-broker',
    'io.lobby-goblin.acceptance': 'rust-software',
  };
  brokerSpec.HostConfig.CapAdd = [];
  await create(broker, brokerSpec);
  const deadline = Date.now() + 90000;
  for (;;) {
    const info = await docker('GET', '/containers/' + broker + '/json');
    assert.equal(info.State.Running, true);
    if (info.State.Health?.Status === 'healthy') break;
    assert.ok(Date.now() < deadline, 'Broker health timed out.');
    await sleep(1000);
  }
  await docker('POST', '/networks/create', {
    Name: scopes[0].network,
    Driver: 'bridge',
    Labels: labels(fleet, first, 'rust'),
  });
  await grant(scopes[0]);
  await game(scopes[0]);
  const original = await controller(scopes[0], false);
  assert.equal(original.passed, true);
  assert.equal(original.exactBackup, true);
  assert.equal(original.pairedFrameworks, true);
  // Release only this stopped fresh fixture's allocation; retain its volume.
  await docker('DELETE', '/containers/' + scopes[0].container);
  await docker('DELETE', '/containers/' + scopes[0].controller);
  await docker('POST', '/volumes/create', {
    Name: scopes[1].volume,
    Labels: {
      ...labels(fleet, second, 'rust'),
      'io.lobby-goblin.acceptance': 'rust-software',
    },
  });
  const clone = await create(
    'lobby-rust-clone-' + second,
    base(scopes[1], 'clone', [
      volume(scopes[0].volume, '/source', undefined, true),
      volume(library, '/library'),
      volume(scopes[1].volume, '/instance'),
    ]),
  );
  await wait(clone);
  await docker('DELETE', '/containers/' + clone);
  await docker('POST', '/networks/create', {
    Name: scopes[1].network,
    Driver: 'bridge',
    Labels: labels(fleet, second, 'rust'),
  });
  await grant(scopes[1]);
  await game(scopes[1]);
  const copied = await controller(scopes[1], true);
  assert.equal(copied.passed, true);
  assert.equal(copied.buildId, original.buildId);
  assert.deepEqual(copied.preparationActions, ['prepare']);
  assert.equal(copied.worldLoaded, true);
  console.log(
    JSON.stringify({
      passed: true,
      game: 'rust',
      buildId: original.buildId,
      controllerPrepared: true,
      exactBackupAndClone: true,
      worldTime: copied.worldTime,
      existingServicesTouched: false,
      existingWorldsTouched: false,
    }),
  );
} finally {
  const filters = encodeURIComponent(
    JSON.stringify({label: ['io.lobby-goblin.fleet=' + fleet]}),
  );
  const containers = await docker(
    'GET',
    '/containers/json?all=1&filters=' + filters,
  );
  for (const item of containers) {
    const info = await docker('GET', '/containers/' + item.Id + '/json');
    assert.equal(info.Config.Labels['io.lobby-goblin.fleet'], fleet);
    if (info.State.Running)
      await docker('POST', '/containers/' + item.Id + '/stop?t=-1', undefined, {
        timeout: 180000,
      });
    const stopped = await docker('GET', '/containers/' + item.Id + '/json');
    assert.equal(stopped.State.Running, false);
    await docker('DELETE', '/containers/' + item.Id);
  }
  for (const scope of scopes) {
    const info = await docker('GET', '/networks/' + scope.network).catch(
      (error) => {
        if (error.status === 404) return null;
        throw error;
      },
    );
    if (info) {
      assert.equal(info.Labels['io.lobby-goblin.fleet'], fleet);
      await docker('DELETE', '/networks/' + scope.network);
    }
  }
  for (const name of [
    ...scopes.map((scope) => scope.volume),
    state,
    transport,
    library,
  ]) {
    const info = await docker('GET', '/volumes/' + name).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (info) {
      assert.equal(info.Labels['io.lobby-goblin.fleet'], fleet);
      await docker('DELETE', '/volumes/' + name);
    }
  }
}
