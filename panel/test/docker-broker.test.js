import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {sourceFile} from '../source-layout.js';
import crypto from 'node:crypto';
import {startController} from '../core/controller.js';
import {noManagedUpdater} from '../core/managed-updater.js';
import {fixtureContract} from './fixtures.js';
import {startDockerBroker} from '../core/docker-broker.js';
import {brokerClient, dockerTransport} from '../core/broker-client.js';
import {resources, labels} from '../core/instance.js';
import {registeredApplications} from '../applications/index.js';
import {planBrokerUpgrade} from '../fleet/broker-upgrade.js';
import {brokerCompose} from '../fleet/broker-compose.js';
import {hostAgentCompose} from '../fleet/host-compose.js';
import {FleetManager} from '../fleet/manager.js';
import {runWorker} from '../fleet/worker.js';
import {waitForIdleJob, settingsTar} from './fixtures.js';
import {engineMapSettings} from '../applications/factorio/engine-settings.js';
import {AgentUpdater} from '../fleet/agent-update.js';
import {agentOptionsFor} from '../agent-options.js';
import {writeJSON, readJSON, HttpError} from '../common.js';
import {
  softwareWorkerDeployment,
  softwareWorkerScope,
  softwareWorkerSpec,
  softwareWorkerName,
} from '../core/software-worker-policy.js';

const unix = process.platform === 'win32' ? test.skip : test;
const fleet = 'a'.repeat(32),
  one = 'b'.repeat(32),
  two = 'c'.repeat(32),
  runtime = 'sha256:' + 'd'.repeat(64),
  gameImageId = 'sha256:' + 'e'.repeat(64);
const project = 'lobby-goblin-fleet-' + fleet,
  modules = registeredApplications();
const steamDeclaration = {
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
const workerImage = {
  Id: softwareWorkerDeployment.imageId,
  Os: 'linux',
  Architecture: 'amd64',
  RepoDigests: [
    softwareWorkerDeployment.image.slice(
      0,
      softwareWorkerDeployment.image.indexOf(':1-lg.1'),
    ) +
      '@' +
      softwareWorkerDeployment.image.split('@')[1],
  ],
  Config: {
    User: '1000:1000',
    Entrypoint: softwareWorkerDeployment.entrypoint,
    Cmd: [],
    Env: ['HOME=/home/node'],
    Labels: {
      'io.lobby-goblin.provider': 'steamcmd-worker',
      'io.lobby-goblin.image-revision': '1',
    },
  },
};
function engine() {
  const calls = [],
    containers = new Map(),
    volumes = new Map(),
    networks = new Map(),
    execs = new Map();
  let serial = 0,
    capacity = 32 * 1024 ** 3;
  const find = (values, ref) =>
    [...values.values()].find(
      (value) =>
        value.Id === ref || value.Name === ref || value.Name === '/' + ref,
    );
  const missing = () => {
    throw new HttpError(404, 'Synthetic resource missing');
  };
  for (const suffix of ['state', 'library', 'web', 'broker-transport'])
    volumes.set(project + '-' + suffix, {
      Name: project + '-' + suffix,
      Driver: 'local',
      Options: null,
      Labels: {'io.lobby-goblin.fleet': fleet},
    });
  containers.set('host', {
    Id: 'host-id',
    Name: '/lobby-goblin-host-' + fleet,
    Image: runtime,
    Config: {
      Labels: {
        'io.lobby-goblin.fleet': fleet,
        'io.lobby-goblin.role': 'host-controller',
      },
    },
    State: {Running: true},
  });
  async function docker(method, route, data) {
    calls.push({method, route, data: structuredClone(data)});
    const url = new URL(route, 'http://synthetic'),
      bits = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && url.pathname === '/info')
      return {
        OSType: 'linux',
        Architecture: 'amd64',
        ServerVersion: '29.0.0',
        MemTotal: capacity,
        Secret: 'host-private',
      };
    if (bits[0] === 'images') {
      if (
        [
          softwareWorkerDeployment.image,
          softwareWorkerDeployment.imageId,
        ].includes(bits[1])
      )
        return structuredClone(workerImage);
      const reference = bits[1],
        module = modules.find((value) =>
          reference.includes(value.id + '-server'),
        );
      return {
        Id: gameImageId,
        Architecture: 'amd64',
        Os: 'linux',
        RepoDigests: [
          (module?.managed.catalog.image || reference).split(':')[0] +
            '@sha256:' +
            'f'.repeat(64),
        ],
        Config: {
          Labels: {
            'io.lobby-goblin.compatibility': '1',
            ...(reference.includes(':runtime-fc.')
              ? {'io.lobby-goblin.software-delivery': 'runtime'}
              : {}),
            'io.lobby-goblin.game': module?.id,
            'factorio.version': '2.0.77',
            'io.lobby-goblin.image-revision': reference.includes(':runtime-fc.')
              ? '1'
              : module?.id === 'rust'
                ? '2'
                : '3',
          },
        },
      };
    }
    if (url.pathname === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') || '{}');
      return [...containers.values()]
        .filter(value=>!filters.volume||filters.volume.every(volume=>(value.HostConfig?.Mounts||[]).some(mount=>mount.Source===volume)))
        .filter((value) =>
          (filters.label || []).every((label) => {
            const at = label.indexOf('=');
            return (
              value.Config.Labels?.[label.slice(0, at)] === label.slice(at + 1)
            );
          }),
        )
        .map((value) => ({
          Id: value.Id,
          Names: [value.Name],
          Labels: value.Config.Labels,
          State: value.State.Running ? 'running' : 'exited',
          Ports: [],
        }));
    }
    if (url.pathname === '/volumes/create') {
      if (!volumes.has(data.Name))
        volumes.set(data.Name, {
          ...structuredClone(data),
          Driver: 'local',
          Options: null,
        });
      return volumes.get(data.Name);
    }
    if (bits[0] === 'volumes'){const volume=volumes.get(bits[1])||missing();if(method==='DELETE'){volumes.delete(bits[1]);return null;}return structuredClone(volume);}
    if (url.pathname === '/networks/create') {
      const value = {
        ...structuredClone(data),
        Id: 'network-' + ++serial,
        Containers: {},
      };
      networks.set(value.Name, value);
      return {Id: value.Id};
    }
    if (bits[0] === 'networks') {
      const value = find(networks, bits[1]) || missing();
      if (method === 'GET') return structuredClone(value);
      if (bits[2] === 'connect') value.Containers[data.Container] = {};
      if (bits[2] === 'disconnect') delete value.Containers[data.Container];
      if (method === 'DELETE') networks.delete(value.Name);
      return null;
    }
    if (url.pathname === '/containers/create') {
      if (containers.has(url.searchParams.get('name')))
        throw new HttpError(409, 'Synthetic container name already exists');
      const name = url.searchParams.get('name'),
        spec = structuredClone(data),
        value = {
          Id: 'immutable-' + ++serial,
          Name: '/' + name,
          Image:
            data.Image === runtime
              ? runtime
              : data.Image === softwareWorkerDeployment.image
                ? workerImage.Id
                : gameImageId,
          Config: {
            Image: data.Image,
            User: spec.User,
            Entrypoint: spec.Entrypoint,
            Cmd: spec.Cmd,
            Labels: spec.Labels || {},
            Env:
              spec.Env ||
              (data.Image === softwareWorkerDeployment.image
                ? workerImage.Config.Env
                : []),
          },
          HostConfig: spec.HostConfig,
          Mounts: spec.HostConfig.Mounts.map((mount) => ({
            Type: mount.Type,
            Name: mount.Source,
            Destination: mount.Target,
            RW: !mount.ReadOnly,
          })),
          State: {Running: false, Status: 'created', ExitCode: 0},
          NetworkSettings: {
            Networks: spec.NetworkingConfig?.EndpointsConfig || {},
          },
        };
      containers.set(name, value);
      return {Id: value.Id};
    }
    if (bits[0] === 'containers') {
      const value = find(containers, bits[1]) || missing();
      if (method === 'GET')
        return bits[2] === 'archive'
          ? settingsTar({pollution: {enabled: true}})
          : structuredClone(value);
      if (bits[2] === 'start') {
        value.State.Running = true;
        value.State.Status = 'running';
      }
      if (bits[2] === 'stop') {
        value.State.Running = false;
        value.State.Status = 'exited';
      }
      if (bits[2] === 'wait') return {StatusCode: 0};
      if (bits[2] === 'exec') {
        const id = 'exec-' + ++serial;
        execs.set(id, {ContainerID: value.Id, ExitCode: 0});
        return {Id: id};
      }
      if (method === 'DELETE') containers.delete(value.Name.slice(1));
      return null;
    }
    if (bits[0] === 'exec') {
      const value = execs.get(bits[1]) || missing();
      return bits[2] === 'start' ? Buffer.from('synthetic rcon output') : value;
    }
    throw Error('Unexpected synthetic Docker route: ' + route);
  }
  function seed(id, game = 'factorio') {
    const module = modules.find((value) => value.id === game),
      item = {
        ...resources(fleet, id, game),
        id,
        game,
        image: module.managed.catalog.image,
      };
    const info = {
      Id: 'game-' + id,
      Name: '/' + item.container,
      Image: gameImageId,
      Config: {Image: item.image, Labels: labels(fleet, id, game)},
      HostConfig: {
        NetworkMode: item.network,
        Mounts: [
          {
            Type: 'volume',
            Source: item.volume,
            Target: module.managed.dataTarget,
            VolumeOptions: {Subpath: 'data'},
          },
        ],
      },
      Mounts: [
        {
          Type: 'volume',
          Name: item.volume,
          Destination: module.managed.dataTarget,
        },
      ],
      State: {Running: true, Status: 'running', ExitCode: 0},
    };
    volumes.set(item.volume, {
      Name: item.volume,
      Driver: 'local',
      Options: null,
      Labels: labels(fleet, id, game),
    });
    containers.set(item.container, info);
    return item;
  }
  return {
    docker,
    calls,
    containers,
    volumes,
    networks,
    seed,
    setCapacity: (value) => {
      capacity = value;
    },
  };
}
async function fixture(t, {softwareWorker = false} = {}) {
  const selectedModules = softwareWorker === 'legacy'
    ? modules.map(module => {if (module.id !== 'rust') return module;const managed = {...module.managed};delete managed.softwareWorker;return {...module, managed};})
    : softwareWorker
    ? modules.map((module) =>
        module.id === 'rust'
          ? {
              ...module,
              managed: {...module.managed, softwareWorker: steamDeclaration},
            }
          : module,
      )
    : modules;
  const directory = await fs.realpath(
      await fs.mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'lgb-'),
      ),
    ),
    root = path.join(directory, 'private'),
    transport = path.join(directory, 'transport'),
    fake = engine();
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  let broker = await startDockerBroker({
    env: {FLEET_ID: fleet},
    root,
    transport,
    docker: fake.docker,
    runtimeImage: runtime,
    modules: selectedModules,
  });
  t.after(async () => {
    broker.server.closeAllConnections();
    await new Promise((resolve) => broker.server.close(resolve));
  });
  const host = brokerClient({
    socketPath: broker.socketPath,
    tokenFile: path.join(transport, 'host/token'),
  });
  async function instance(id, game = 'factorio') {
    await host.grant({id, game});
    return brokerClient({
      socketPath: broker.socketPath,
      tokenFile: path.join(transport, 'instances', id, 'token'),
    });
  }
  return {
    ...fake,
    directory,
    root,
    transport,
    host,
    instance,
    get broker() {
      return broker;
    },
    async restart() {
      broker.server.closeAllConnections();
      await new Promise((resolve) => broker.server.close(resolve));
      broker = await startDockerBroker({
        env: {FLEET_ID: fleet},
        root,
        transport,
        docker: fake.docker,
        runtimeImage: runtime,
        modules: selectedModules,
      });
    },
  };
}
const denied = (error) => [401, 403, 409].includes(error.status);
test('instance capabilities cannot invoke management coordination and the host RPC rejects arbitrary authority', async t => {
 const f = await fixture(t), client = await f.instance(one);
 await assert.rejects(client.managementUpdate({action: 'status'}), error => error.status === 403);
 assert.equal((await f.host.managementUpdate({action: 'status'})).supported, true);
 for (const extra of [{image: 'evil/runtime'}, {directory: '/'}, {command: ['sh']}])
  await assert.rejects(f.host.managementUpdate({action: 'plan', version: '99.0.0-alpha', requestId: 'e'.repeat(32), ...extra}), /Unexpected/);
});

async function steamFixture(t) {
  const f = await fixture(t, {softwareWorker: true}),
    item = f.seed(one, 'rust'),
    client = await f.instance(one, 'rust');
  const owner = f.containers.get(item.container);
  owner.State = {
    Running: false,
    Restarting: false,
    Status: 'exited',
    ExitCode: 0,
  };
  owner.HostConfig.Memory = 2 * 1024 ** 3;
  f.networks.set(item.network, {
    Id: 'steam-network',
    Name: item.network,
    Driver: 'bridge',
    Labels: labels(fleet, one, 'rust'),
  });
  f.containers.set(item.controller, {
    Id: 'controller-' + one,
    Name: '/' + item.controller,
    Config: {
      Labels: {
        ...labels(fleet, one, 'rust'),
        'io.lobby-goblin.role': 'instance-controller',
      },
    },
    HostConfig: {Memory: 1024 ** 3},
    State: {Running: true},
  });
  const scope = softwareWorkerScope({
    fleet,
    instance: one,
    volume: item.volume,
    declaration: steamDeclaration,
  });
  const id = crypto.randomUUID(),
    name = softwareWorkerName(one, id),
    spec = softwareWorkerSpec(scope, id, 'prepare'),
    route = '/containers/create?name=' + name + '&platform=linux%2Famd64';
  return {...f, item, client, owner, scope, id, name, spec, route};
}

unix(
  'real broker admits only the published private worker and permits stopped orphan cleanup without replay',
  async (t) => {
    const f = await steamFixture(t);
    f.setCapacity(5 * 1024 ** 3);
    const mutated = structuredClone(f.spec);
    mutated.Env = ['BROKER_TOKEN=not-accepted'];
    await assert.rejects(f.client.docker('POST', f.route, mutated), denied);
    await assert.rejects(
      f.client.docker('POST', f.route + '&platform=linux%2Famd64', f.spec),
      denied,
    );
    const created = await f.client.docker('POST', f.route, f.spec);
    assert.ok(created.Id);
    const info = await f.client.docker(
      'GET',
      '/containers/' + created.Id + '/json',
    );
    assert.equal(info.HostConfig.Memory, f.owner.HostConfig.Memory);
    assert.equal(info.Config.User, '1000:0');
    assert.deepEqual(
      info.HostConfig.Mounts.map((value) => value.Target),
      ['/software', '/control', '/request', '/result'],
    );
    await assert.rejects(
      f.host.docker('POST', '/containers/' + f.item.container + '/start'),
      /preparation/,
    );
    await assert.rejects(
      f.client.docker('POST', '/containers/' + f.item.container + '/restart'),
      /preparation/,
    );
    await assert.rejects(
      f.host.docker('POST', '/containers/' + created.Id + '/start'),
      denied,
    );
    await f.client.docker('POST', '/containers/' + created.Id + '/start');
    await assert.rejects(
      f.client.docker('POST', '/containers/' + created.Id + '/start'),
      /replay/,
    );
    await assert.rejects(
      f.host.docker('DELETE', '/containers/' + created.Id),
      denied,
    );
    await assert.rejects(
      f.client.docker('POST', '/containers/' + created.Id + '/exec', {
        Cmd: ['/bin/sh'],
      }),
      denied,
    );
    await assert.rejects(
      f.client.docker(
        'GET',
        '/containers/' + created.Id + '/logs?stdout=1&tail=all',
      ),
      denied,
    );
    await assert.rejects(
      f.client.docker(
        'GET',
        '/containers/' + created.Id + '/archive?path=/control',
      ),
      denied,
    );
    await f.host.docker('POST', '/containers/' + created.Id + '/stop?t=15');
    await assert.rejects(
      f.client.docker('POST', '/containers/' + created.Id + '/start'),
      /replay/,
    );
    await assert.rejects(
      f.host.docker('POST', '/containers/' + f.item.container + '/start'),
      /preparation/,
    );
    f.containers.delete(f.item.container);
    f.containers.delete(f.item.controller);
    // Teardown must not require either the application or its controller to exist.
    assert.equal(
      (await f.host.docker('GET', '/containers/' + created.Id + '/json')).Id,
      created.Id,
    );
    await f.host.docker('DELETE', '/containers/' + created.Id);
    assert.ok(!f.containers.has(f.name));
  },
);

unix(
  'worker claims remain isolated and cannot race host game startup or consume another stopped reservation',
  async (t) => {
    const f = await steamFixture(t);
    f.setCapacity(5 * 1024 ** 3);
    const foreign = f.seed(two, 'rust');
    const other = await f.instance(two, 'rust');
    await assert.rejects(other.docker('POST', f.route, f.spec), denied);
    f.containers.delete(foreign.container);
    const outcomes = await Promise.allSettled([
      f.client.docker('POST', f.route, f.spec),
      f.host.docker('POST', '/containers/' + f.item.container + '/start'),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === 'fulfilled').length,
      1,
    );
    assert.ok(!(f.owner.State.Running && f.containers.has(f.name)));
    if (f.containers.has(f.name))
      await f.client.docker('DELETE', '/containers/' + f.name);
    f.owner.State.Running = false;
    const second = f.seed(two, 'rust');
    f.containers.get(second.container).State.Running = false;
    f.containers.get(second.container).HostConfig.Memory = 2 * 1024 ** 3;
    await assert.rejects(f.client.docker('POST', f.route, f.spec), /headroom/);
    assert.ok(!f.containers.has(f.name));
  },
);

unix(
  'preparing a larger stopped server never frees capacity for another server',
  async (t) => {
    const f = await steamFixture(t),
      GiB = 1024 ** 3;
    f.owner.HostConfig.Memory = 8 * GiB;
    f.setCapacity(11 * GiB); // 8 GiB application + 1 GiB controller + 2 GiB host reserve.
    const {Id} = await f.client.docker('POST', f.route, f.spec);
    const second = f.seed(two, 'rust'),
      module = modules.find((value) => value.id === 'rust'),
      original = f.containers.get(second.container);
    f.containers.delete(second.container);
    f.networks.set(second.network, {
      Id: 'second-network',
      Name: second.network,
      Driver: 'bridge',
      Labels: labels(fleet, two, 'rust'),
    });
    const ports = module.managed.ports.map(
      (value) => value.containerPort + '/' + value.protocol,
    );
    const spec = {
      Image: second.image,
      Env: [],
      Labels: labels(fleet, two, 'rust'),
      ExposedPorts: Object.fromEntries(ports.map((value) => [value, {}])),
      NetworkingConfig: {
        EndpointsConfig: {[second.network]: {Aliases: [second.container]}},
      },
      HostConfig: {
        NetworkMode: second.network,
        Memory: 6 * GiB,
        NanoCpus: 1e9,
        Mounts: original.HostConfig.Mounts,
        PortBindings: Object.fromEntries(
          ports.map((value, index) => [
            value,
            [{HostIp: '127.0.0.1', HostPort: String(40000 + index)}],
          ]),
        ),
      },
    };
    const create = () =>
      f.host.docker(
        'POST',
        '/containers/create?name=' + second.container,
        spec,
      );
    await assert.rejects(create(), /headroom/);
    await f.client.docker('DELETE', '/containers/' + Id);
    await assert.rejects(create(), /headroom/);
    await f.host.docker('POST', '/containers/' + f.item.container + '/start');
    assert.equal(f.owner.State.Running, true);
  },
);

unix(
  'resolving metadata cannot mount provider storage, and legacy profiles cannot launch provider workers',
  async (t) => {
    const f = await steamFixture(t);
    f.owner.State.Running = true;
    const resolve = softwareWorkerSpec(f.scope, f.id, 'resolve');
    const {Id} = await f.client.docker('POST', f.route, resolve);
    const info = await f.client.docker('GET', '/containers/' + Id + '/json');
    assert.deepEqual(
      info.HostConfig.Mounts.map((value) => value.Target),
      ['/request', '/result'],
    );
    await f.host.docker('POST', '/containers/' + f.item.container + '/start');
    await f.client.docker('DELETE', '/containers/' + Id);
    const legacy = await fixture(t, {softwareWorker: 'legacy'}),
      item = legacy.seed(one, 'rust'),
      client = await legacy.instance(one, 'rust');
    assert.equal(item.container, f.item.container);
    await assert.rejects(client.docker('POST', f.route, resolve), denied);
  },
);

unix(
  'real Unix broker authenticates before bodies, scopes credentials, persists revocations and never falls back',
  async (t) => {
    const f = await fixture(t),
      first = f.seed(one),
      second = f.seed(two),
      client = await f.instance(one),
      other = await f.instance(two);
    assert.equal(
      (await client.docker('GET', '/containers/' + first.container + '/json'))
        .Id,
      'game-' + one,
    );
    assert.deepEqual(await client.docker('GET', '/info'), {
      OSType: 'linux',
      Architecture: 'amd64',
      ServerVersion: '29.0.0',
    });
    const before = f.calls.filter((call) => call.method !== 'GET').length;
    for (const [method, route, body] of [
      ['POST', '/containers/' + second.container + '/stop'],
      ['POST', '/volumes/create', {Name: 'host-data'}],
      [
        'POST',
        '/containers/' + first.container + '/exec',
        {Cmd: ['sh'], Privileged: true},
      ],
    ])
      await assert.rejects(client.docker(method, route, body), denied);
    await assert.rejects(client.grant({id: two, game: 'factorio'}), denied);
    assert.equal(
      f.calls.filter((call) => call.method !== 'GET').length,
      before,
    );
    await client.docker('POST', '/containers/' + first.container + '/stop');
    assert.equal(f.calls.at(-1).route, '/containers/game-' + one + '/stop');
    assert.equal(f.containers.get(second.container).State.Running, true);
    await f.host.revoke(one);
    await f.restart();
    await assert.rejects(
      client.docker('GET', '/containers/' + first.container + '/json'),
      denied,
    );
    assert.equal(
      (await other.docker('GET', '/containers/' + second.container + '/json'))
        .Id,
      'game-' + two,
    );
    await assert.rejects(f.host.grant({id: one, game: 'factorio'}), denied);
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: f.broker.socketPath,
          path: '/v1/docker',
          method: 'POST',
          headers: {
            'content-length': '1048576',
            authorization: 'Bearer ' + 'x'.repeat(43),
          },
        },
        (result) => {
          result.resume();
          result.once('end', () => resolve(result.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(response, 401);
    let fallback = 0;
    const unavailable = dockerTransport(
      {
        DOCKER_BROKER_SOCKET: path.join(f.directory, 'missing.sock'),
        DOCKER_BROKER_TOKEN_FILE: path.join(f.transport, 'host/token'),
      },
      () => {
        fallback++;
      },
    );
    await assert.rejects(unavailable.docker('GET', '/info'));
    assert.equal(fallback, 0);
    assert.throws(() =>
      dockerTransport({DOCKER_BROKER_SOCKET: '/missing'}, () => {}),
    );
  },
);

unix(
  'old data-root helpers allow inspection and teardown, while new helpers require private state scratch',
  async (t) => {
    const f = await fixture(t), item = f.seed(one), client = await f.instance(one), id = crypto.randomUUID(), name = 'factorio-panel-preview-' + id;
    const spec = {Image: gameImageId, HostConfig: {NetworkMode: 'none', Memory: 1024 ** 3, Mounts: [{Type: 'volume', Source: item.volume, Target: '/factorio', VolumeOptions: {Subpath: 'data/.panel-work/preview-' + id, NoCopy: true}}]}};
    const writes = () => f.calls.filter(call => call.method !== 'GET').length, before = writes();
    await assert.rejects(client.docker('POST', '/containers/create?name=' + name, spec), denied);
    assert.equal(writes(), before);
    const current = structuredClone(spec); current.HostConfig.Mounts[0].VolumeOptions.Subpath = 'state/.panel-work/preview-' + id;
    const created = await client.docker('POST', '/containers/create?name=' + name, current);
    const old = f.containers.get(name); delete old.Config.Labels['io.lobby-goblin.worker-kind']; old.HostConfig.Mounts[0].VolumeOptions.Subpath = spec.HostConfig.Mounts[0].VolumeOptions.Subpath;
    assert.equal((await client.docker('GET', '/containers/' + created.Id + '/json')).Id, created.Id);
    for (const operation of ['start', 'restart', 'exec']) await assert.rejects(client.docker('POST', '/containers/' + created.Id + '/' + operation, operation === 'exec' ? {Cmd: ['rcon', '/version']} : undefined), denied);
    await client.docker('POST', '/containers/' + created.Id + '/stop');
    await client.docker('DELETE', '/containers/' + created.Id);
    assert.equal(f.containers.has(name), false);
  },
);

unix(
  'compromised instance cannot create host mounts, exec storage helpers or exhaust preview workers',
  async (t) => {
    const f = await fixture(t),
      item = f.seed(one),
      client = await f.instance(one),
      id = crypto.randomUUID(),
      name = 'factorio-panel-preview-' + id;
    const spec = {
      Image: gameImageId,
      HostConfig: {
        NetworkMode: 'none',
        Memory: 1024 ** 3,
        Mounts: [
          {
            Type: 'volume',
            Source: item.volume,
            Target: '/factorio',
            VolumeOptions: {
              Subpath: 'state/.panel-work/preview-' + id,
              NoCopy: true,
            },
          },
        ],
      },
    };
    for (const change of [
      {Binds: ['/var/run/docker.sock:/socket']},
      {PidMode: 'host'},
      {Devices: [{}]},
      {Privileged: true},
    ])
      await assert.rejects(
        client.docker('POST', '/containers/create?name=' + name, {
          ...spec,
          HostConfig: {...spec.HostConfig, ...change},
        }),
        denied,
      );
    await assert.rejects(
      client.docker('POST', '/containers/create?name=' + name, {
        ...spec,
        HostConfig: {
          ...spec.HostConfig,
          Mounts: [
            {
              Type: 'volume',
              Source: project + '-broker-transport',
              Target: '/factorio',
              VolumeOptions: {Subpath: 'host'},
            },
          ],
        },
      }),
      denied,
    );
    assert.deepEqual(
      await engineMapSettings(item.container, item.image, {
        docker: client.docker,
      }),
      {pollution: {enabled: true}},
    );
    await assert.rejects(
      client.docker(
        'GET',
        '/containers/' + item.container + '/archive?path=%2Fproc%2F1%2Froot',
      ),
      denied,
    );
    await assert.rejects(
      client.docker('POST', '/exec/foreign-command/start', {
        Detach: false,
        Tty: false,
      }),
      denied,
    );
    const created = await client.docker(
      'POST',
      '/containers/create?name=' + name,
      spec,
    );
    const exec = await client.docker(
      'POST',
      '/containers/' + created.Id + '/exec',
      {Cmd: ['rcon', '/version'], AttachStdout: true, AttachStderr: true},
    );
    assert.equal(
      (
        await client.docker(
          'POST',
          '/exec/' + exec.Id + '/start',
          {Detach: false, Tty: false},
          {raw: true},
        )
      ).toString(),
      'synthetic rcon output',
    );
    await client.docker(
      'POST',
      '/containers/create?name=factorio-panel-job-' + crypto.randomUUID(),
      spec,
    );
    await assert.rejects(
      client.docker(
        'POST',
        '/containers/create?name=factorio-panel-map-' + crypto.randomUUID(),
        spec,
      ),
      (error) => error.status === 429,
    );
    const storage = {
      Id: 'storage-helper',
      Name: '/lobby-goblin-worker-' + 'f'.repeat(32),
      Image: runtime,
      Config: {
        Labels: {
          ...labels(fleet, one, 'factorio'),
          'io.lobby-goblin.worker': 'true',
        },
      },
      HostConfig: {
        Mounts: [{Type: 'volume', Source: item.volume, Target: '/instance'}],
      },
      State: {Running: true},
    };
    f.containers.set(storage.Name.slice(1), storage);
    await assert.rejects(
      client.docker('POST', '/containers/storage-helper/exec', {Cmd: ['sh']}),
      denied,
    );
    assert.ok(
      !f.calls.some(
        (call) =>
          call.method === 'POST' &&
          call.route === '/containers/storage-helper/exec',
      ),
    );
  },
);

unix('real broker confines the read-only runtime helper overlay to its private scratch child',async t=>{
 const f=await fixture(t),item=f.seed(one),client=await f.instance(one),id=crypto.randomUUID();
 const mount={Type:'volume',Source:item.volume,Target:'/factorio',VolumeOptions:{Subpath:'state/.panel-work/preview-'+id,NoCopy:true}};
 const overlay={...mount,Target:'/opt/factorio',ReadOnly:true,VolumeOptions:{Subpath:mount.VolumeOptions.Subpath+'/engine',NoCopy:true}};
 const spec={Image:gameImageId,Entrypoint:['/opt/factorio/bin/x64/factorio'],HostConfig:{NetworkMode:'none',Memory:1024**3,Mounts:[mount,overlay]}};
 for(const mutate of [value=>value.ReadOnly=false,value=>value.VolumeOptions.Subpath='control',value=>value.Source=project+'-broker-transport']){
  const attack=structuredClone(spec);mutate(attack.HostConfig.Mounts[1]);await assert.rejects(client.docker('POST','/containers/create?name=factorio-panel-preview-'+id,attack),denied);
 }
 const created=await client.docker('POST','/containers/create?name=factorio-panel-preview-'+id,spec);
 const info=await client.docker('GET','/containers/'+created.Id+'/json');assert.equal(info.HostConfig.Mounts[1].ReadOnly,true);
 await client.docker('POST','/containers/'+created.Id+'/start');await client.docker('POST','/containers/'+created.Id+'/stop');await client.docker('DELETE','/containers/'+created.Id);
});

unix(
  'host capability cannot mount the daemon, create privileged runtimes, exec management or adopt foreign resources',
  async (t) => {
    const f = await fixture(t),
      item = f.seed(one),
      h = f.host;
    assert.equal((await h.docker('GET', '/info')).Secret, undefined);
    for (const [method, route, data] of [
      [
        'POST',
        '/containers/create?name=escape',
        {Image: runtime, HostConfig: {Privileged: true, Binds: ['/:/host']}},
      ],
      [
        'POST',
        '/containers/lobby-goblin-host-' + fleet + '/exec',
        {Cmd: ['sh']},
      ],
      ['DELETE', '/containers/lobby-goblin-host-' + fleet],
      ['POST', '/images/create?fromImage=attacker/image&platform=linux/amd64'],
      [
        'POST',
        '/volumes/create',
        {
          Name: item.volume,
          Labels: labels(fleet, one, 'factorio'),
          DriverOpts: {device: '/'},
        },
      ],
      ['DELETE', '/volumes/' + item.volume],
    ])
      await assert.rejects(h.docker(method, route, data), denied);
    f.volumes.set(item.volume, {
      Name: item.volume,
      Labels: labels('9'.repeat(32), one, 'factorio'),
    });
    await assert.rejects(
      h.docker('POST', '/volumes/create', {
        Name: item.volume,
        Labels: labels(fleet, one, 'factorio'),
      }),
      denied,
    );
    f.volumes.set(item.volume, {
      Name: item.volume,
      Driver: 'local',
      Options: {type: 'none', o: 'bind', device: '/'},
      Labels: labels(fleet, one, 'factorio'),
    });
    await assert.rejects(
      h.docker('POST', '/volumes/create', {
        Name: item.volume,
        Labels: labels(fleet, one, 'factorio'),
      }),
      denied,
    );
    assert.equal(f.calls.filter((call) => call.method !== 'GET').length, 0);
  },
);

unix(
  'broker audit survives restart, excludes credentials and fails before a Docker mutation when storage fails',
  async (t) => {
    const f = await fixture(t),
      item = f.seed(one),
      client = await f.instance(one),
      token = await fs.readFile(
        path.join(f.transport, 'instances', one, 'token'),
        'utf8',
      );
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (file, ...args) => {
      if (String(file).startsWith(path.join(f.root, 'audit.json.')))
        throw Error('Synthetic full disk');
      return write(file, ...args);
    });
    await assert.rejects(
      client.docker('POST', '/containers/' + item.container + '/stop'),
      (error) => error.status === 503,
    );
    assert.equal(f.containers.get(item.container).State.Running, true);
    t.mock.restoreAll();
    await client.docker('POST', '/containers/' + item.container + '/stop');
    await f.restart();
    const history = await f.broker.audit.list();
    assert.ok(
      history.events.some(
        (event) =>
          event.actor === 'instance:' + one && event.outcome === 'succeeded',
      ),
    );
    assert.ok(!JSON.stringify(history).includes(token));
    assert.ok(
      !(
        await fs.readFile(path.join(f.root, 'capabilities.json'), 'utf8')
      ).includes(token),
    );
  },
);

test('fresh Compose definitions give only the broker a daemon socket and isolate credential subdirectories', async () => {
  const template = await fs.readFile(
    await sourceFile(
      fileURLToPath(new URL('../../', import.meta.url)),
      'fleet.compose.yaml',
    ),
    'utf8',
  );
  const managerTemplate = template.slice(
    template.indexOf('  fleet-controller:'),
    template.indexOf('  fleet-web:'),
  );
  assert.equal(
    (
      template.match(/- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/g) ||
      []
    ).length,
    1,
  );
  assert.ok(!managerTemplate.includes('/var/run/docker.sock'));
  assert.ok(
    managerTemplate.includes('subpath: socket') &&
      managerTemplate.includes('subpath: host'),
  );
  const config = brokerCompose('official-runtime', fleet),
    options = agentOptionsFor(
      {domain: 'host.example.test', address: 'host.example.test', memory: 16},
      '0.3.6-alpha',
    ),
    compose = hostAgentCompose(options, fleet);
  assert.equal(config.service.network_mode, 'none');
  assert.equal(config.service.ports, undefined);
  assert.equal(
    compose.services['fleet-controller'].environment.DOCKER_BROKER_SOCKET,
    '/broker/socket/docker.sock',
  );
  for (const [name, service] of Object.entries(compose.services))
    assert.equal(
      service.volumes?.some(
        (value) =>
          typeof value === 'string' && value.includes('/var/run/docker.sock'),
      ) || false,
      name === 'docker-broker',
    );
  assert.deepEqual(
    config.mounts.map((value) => [value.read_only, value.volume.subpath]),
    [
      [true, 'socket'],
      [true, 'host'],
    ],
  );
});

unix(
  'a configured broker refuses an existing legacy registry before controller adoption',
  async (t) => {
    const f = await fixture(t),
      root = path.join(f.directory, 'manager');
    await fs.mkdir(root);
    await writeJSON(path.join(root, 'registry.json'), {
      version: 1,
      jobs: [],
      snapshots: [],
      servers: [
        {
          id: one,
          game: 'factorio',
          state: 'installed',
          container: 'legacy-game',
        },
      ],
    });
    const manager = new FleetManager({
      docker: f.host.docker,
      broker: f.host,
      brokerVolume: project + '-broker-transport',
      root,
      library: path.join(f.directory, 'library'),
      fleet,
      stateVolume: project + '-state',
      libraryVolume: project + '-library',
      image: runtime,
      hostContainer: 'lobby-goblin-host-' + fleet,
    });
    await assert.rejects(manager.init(), /reviewed broker upgrade/);
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await readJSON(path.join(root, 'registry.json'))).servers[0].container,
      'legacy-game',
    );
    const updater = new AgentUpdater(manager, {enabled: true});
    assert.equal((await updater.status()).supported, false);
    await assert.rejects(
      updater.plan({version: '0.3.7-alpha'}),
      /reviewed operator update/,
    );
  },
);

unix(
  'real manager provisioning crosses the broker without mounting Docker into games or controllers',
  async (t) => {
    const f = await fixture(t),
      root = path.join(f.directory, 'manager'),
      library = path.join(f.directory, 'library'),
      instances = new Map();
    const manager = new FleetManager({
      docker: f.host.docker,
      broker: f.host,
      brokerVolume: project + '-broker-transport',
      root,
      library,
      fleet,
      stateVolume: project + '-state',
      libraryVolume: project + '-library',
      image: runtime,
      hostContainer: 'lobby-goblin-host-' + fleet,
      memoryBudgetGiB: 24,
    });
    await manager.init();
    // Model a worker's private volume mounts while using the real storage adapter.
    // Its Docker create/start/wait/delete requests still cross the real broker.
    const write = async (item, config) => {
      const directory = path.join(f.directory, item.id);
      await fs.mkdir(directory);
      instances.set(item.id, directory);
      return runWorker(
        {...config, fleet, id: item.id, game: item.game},
        {instance: directory, library},
      );
    };
    const originalHelper = manager.helper.bind(manager);
    manager.helper = async (item, config, options) => {
      const result = await originalHelper(item, config, options);
      await write(item, config);
      return result;
    };
    manager.request = async (item, route) => {
      assert.equal(route, '/jobs');
      await manager.ownedContainer(item.controller, item.id);
      return {id: 'synthetic-start', state: 'running'};
    };
    for (const [game,softwareMode] of [['factorio','image'], ['rust','runtime'], ['factorio','runtime']]) {
      const submitted = await manager.submit('create', {
        game,
        name: 'Broker ' + game,
        softwareMode,
      });
      const completed = await waitForIdleJob(
        async () => ({jobs: manager.state.jobs, active: manager.active}),
        submitted.id,
        {
          attempts: 1000,
          pause: () => new Promise((resolve) => setTimeout(resolve, 5)),
        },
      );
      assert.equal(completed.state, 'succeeded', completed.message);
      const item = manager.server(completed.result.serverId),
        info = f.containers.get(item.controller),
        gameInfo = f.containers.get(item.container);
      const controllerSpec = f.calls.find(
        (call) =>
          call.method === 'POST' &&
          call.route.startsWith('/containers/create?') &&
          new URL(call.route, 'http://docker').searchParams.get('name') ===
            item.controller,
      ).data;
      const storageWorker = f.calls.find(call => call.data?.Labels?.['io.lobby-goblin.worker'] === 'true').data;
      assert.deepEqual(storageWorker.HostConfig.CapDrop, ['ALL']);
      assert.deepEqual(storageWorker.HostConfig.CapAdd, ['DAC_OVERRIDE']);
      assert.equal(storageWorker.HostConfig.NetworkMode, 'none');
      assert.equal(storageWorker.HostConfig.Mounts.length, 3);
      // Operator metadata maintenance must never become a panel helper grant.
      const maintenanceWorker = structuredClone(
        f.calls.find(
          (call) =>
            call.method === 'POST' &&
            call.route.startsWith('/containers/create?') &&
            call.data?.Labels?.['io.lobby-goblin.instance'] === item.id &&
            call.data?.Labels?.['io.lobby-goblin.worker'] === 'true',
        ).data,
      );
      const maintenanceRequest = '8'.repeat(32),
        beforeMaintenance = f.calls.filter(
          (call) => call.method === 'POST',
        ).length;
      maintenanceWorker.Entrypoint = [
        'node',
        '/app/fleet/management-storage-worker.js',
      ];
      maintenanceWorker.HostConfig.Mounts[0].VolumeOptions.Subpath =
        'requests/' + maintenanceRequest;
      await assert.rejects(
        f.host.docker(
          'POST',
          '/containers/create?name=lobby-goblin-worker-' + maintenanceRequest,
          maintenanceWorker,
        ),
        denied,
      );
      assert.equal(
        f.calls.filter((call) => call.method === 'POST').length,
        beforeMaintenance,
      );
      const mutations = [
        (spec) => {
          spec.HostConfig.Privileged = true;
        },
        (spec) => {
          spec.HostConfig.Mounts[2].VolumeOptions.Subpath = 'host';
        },
        (spec) => {
          spec.HostConfig.Mounts[2].Source = project + '-broker-state';
        },
        (spec) => {
          spec.Entrypoint = ['sh', '-c'];
        },
        (spec) => {
          spec.Env.push('NODE_OPTIONS=--require=/instance/data/evil.js');
        },
      ];
      for (const mutate of mutations) {
        const attack = structuredClone(controllerSpec),
          before = f.calls.filter((call) => call.method === 'POST').length;
        mutate(attack);
        await assert.rejects(
          f.host.docker(
            'POST',
            '/containers/create?name=' + item.controller,
            attack,
          ),
          denied,
        );
        assert.equal(
          f.calls.filter((call) => call.method === 'POST').length,
          before,
        );
      }
      if(game==='factorio')assert.equal(item.software.mode,softwareMode);
      assert.equal(item.isolationVersion, 1);
      assert.ok(
        info.Config.Env.includes(
          'DOCKER_BROKER_SOCKET=/broker/socket/docker.sock',
        ),
      );
      assert.ok(
        info.HostConfig.Mounts.every((mount) => mount.Type === 'volume'),
      );
      assert.deepEqual(
        info.HostConfig.Mounts.slice(1).map((mount) => [
          mount.ReadOnly,
          mount.VolumeOptions.Subpath,
        ]),
        [
          [true, 'socket'],
          [true, 'instances/' + item.id],
        ],
      );
      assert.ok(
        gameInfo.HostConfig.Mounts.every(
          (mount) => mount.Source === item.volume,
        ),
      );
      assert.deepEqual(gameInfo.HostConfig.CapDrop, ['ALL']);
      assert.equal(gameInfo.HostConfig.PidsLimit, 1024);
      assert.equal(
        await fs.readFile(
          path.join(instances.get(item.id), 'control/controller-token'),
          'utf8',
        ),
        item.controllerToken,
      );
      const client = brokerClient({
        socketPath: f.broker.socketPath,
        tokenFile: path.join(f.transport, 'instances', item.id, 'token'),
      });
      await client.docker(
        'POST',
        '/containers/' +
          item.container +
          '/stop?t=' +
          (game === 'rust' ? '-1' : '120'),
      );
      assert.equal(gameInfo.State.Running, false);
    }
    assert.equal(manager.state.servers.length, 3);
    assert.equal((await f.host.docker('GET', '/info')).OSType, 'linux');
    const first = manager.state.servers[0],
      client = brokerClient({
        socketPath: f.broker.socketPath,
        tokenFile: path.join(f.transport, 'instances', first.id, 'token'),
      });
    const removal = await manager.submit('remove', {
      serverId: first.id,
      name: first.name,
      confirm: true,
    });
    const removed = await waitForIdleJob(
      async () => ({jobs: manager.state.jobs, active: manager.active}),
      removal.id,
    );
    assert.equal(removed.state, 'succeeded', removed.message);
    assert.ok(f.volumes.has(first.volume));
    assert.ok(
      !f.calls.some(
        (call) =>
          call.method === 'DELETE' && call.route.startsWith('/volumes/'),
      ),
    );
    await assert.rejects(
      client.docker('GET', '/containers/' + first.container + '/json'),
      (error) => error.status === 401,
    );
    assert.equal(manager.state.servers[1].state, 'installed');
  },
);

unix(
  'concurrent instance creates cannot overrun the broker host memory allowance',
  async (t) => {
    const f = await fixture(t);
    f.seed(one);
    f.seed(two);
    const a = await f.instance(one),
      b = await f.instance(two);
    f.setCapacity(3 * 1024 ** 3);
    const spec = (id) => ({
      Image: gameImageId,
      HostConfig: {
        NetworkMode: 'none',
        Memory: 1024 ** 3,
        Mounts: [
          {
            Type: 'volume',
            Source: resources(fleet, id, 'factorio').volume,
            Target: '/factorio',
            VolumeOptions: {
              Subpath: 'state/.panel-work/job-' + crypto.randomUUID(),
              NoCopy: true,
            },
          },
        ],
      },
    });
    const results = await Promise.allSettled([
      a.docker(
        'POST',
        '/containers/create?name=factorio-panel-job-' + crypto.randomUUID(),
        spec(one),
      ),
      b.docker(
        'POST',
        '/containers/create?name=factorio-panel-job-' + crypto.randomUUID(),
        spec(two),
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.find((result) => result.status === 'rejected').reason.status,
      409,
    );
    assert.equal(
      [...f.containers.values()].filter(
        (value) =>
          value.Config.Labels['io.lobby-goblin.worker-kind'] === 'game-preview',
      ).length,
      1,
    );
  },
);

unix(
  'a real instance controller uses the broker without a second incompatible Docker wrapper',
  async (t) => {
    const f = await fixture(t),
      item = f.seed(one);
    await f.instance(one);
    const state = path.join(f.directory, 'controller'),
      tokenFile = path.join(f.directory, 'controller-token');
    await fs.writeFile(tokenFile, 'synthetic-controller-token');
    const module = {
      ...modules.find((value) => value.id === 'factorio'),
      // This transport-only fixture declares its own historical v1 surface.
      definition: undefined,
      application: undefined,
      presentation: undefined,
      routes: [],
      web: {
        ...modules.find((value) => value.id === 'factorio').web,
        adminReadRoutes: [],
      },
      contract: fixtureContract(['create']),
      configuration: () => ({
        state,
        library: path.join(f.directory, 'world-library'),
        backupDir: path.join(f.directory, 'backups'),
        container: item.container,
      }),
      createUpdater: () => noManagedUpdater('fixture'),
      createController: async (ctx) => ({
        actions: {
          create: async () => {
            const id = crypto.randomUUID(),
              name = 'factorio-panel-job-' + id,
              spec = {
                Image: gameImageId,
                HostConfig: {
                  NetworkMode: 'none',
                  Memory: 1024 ** 3,
                  Mounts: [
                    {
                      Type: 'volume',
                      Source: item.volume,
                      Target: '/factorio',
                      VolumeOptions: {
                        Subpath: 'state/.panel-work/' + id,
                        NoCopy: true,
                      },
                    },
                  ],
                },
              };
            await ctx.docker('POST', '/containers/create?name=' + name, spec);
            await ctx.docker('POST', '/containers/' + name + '/start');
            await ctx.docker(
              'POST',
              '/containers/' + name + '/wait?condition=not-running',
            );
            await ctx.docker('DELETE', '/containers/' + name);
            return 'Synthetic generation completed';
          },
        },
        status: async () => ({ready: true, running: true}),
        handle: async () => {},
        validateAction() {},
        backupFiles: async () => [],
        validateBackup() {},
        backupVerified: () => '',
        init: async () => {},
        start: async () => {},
        beforeJob: async () => {},
        afterJob: async () => {},
        waitIdle: async () => {},
        invalidate() {},
        recentStatus: () => null,
        locations: [],
      }),
    };
    const controller = await startController(module, {
      hostname: '127.0.0.1',
      port: 0,
      env: {
        FLEET_ID: fleet,
        FLEET_INSTANCE: one,
        FLEET_VOLUME: item.volume,
        CONTROLLER_TOKEN_FILE: tokenFile,
        UPDATE_STATE_DIR: path.join(f.directory, 'updates'),
        DOCKER_BROKER_SOCKET: f.broker.socketPath,
        DOCKER_BROKER_TOKEN_FILE: path.join(
          f.transport,
          'instances',
          one,
          'token',
        ),
      },
      docker: () => assert.fail('Raw Docker fallback must not be used'),
    });
    t.after(
      () =>
        new Promise((resolve) => {
          controller.closeAllConnections();
          controller.close(resolve);
        }),
    );
    const origin = 'http://127.0.0.1:' + controller.address().port,
      headers = {
        authorization: 'Bearer synthetic-controller-token',
        'content-type': 'application/json',
      };
    const response = await fetch(origin + '/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({action: 'create', actor: 'Fixture'}),
    });
    assert.equal(response.status, 202);
    const job = await response.json();
    const result = await waitForIdleJob(
      async () => (await fetch(origin + '/jobs', {headers})).json(),
      job.id,
    );
    assert.equal(result.state, 'succeeded', result.message);
    assert.equal(f.containers.get(item.container).State.Running, true);
  },
);

test('upgrade planning preserves game metadata, excludes credentials and refuses custom or interrupted installations', () => {
  const item = {
    ...resources(fleet, one, 'factorio'),
    id: one,
    game: 'factorio',
    image: modules[0].managed.catalog.image,
    state: 'installed',
  };
  const registry = {version: 1, servers: [item], jobs: []},
    marker = labels(fleet, one, 'factorio');
  const game = {
    Id: 'unchanged-game',
    Name: '/' + item.container,
    Image: gameImageId,
    Config: {
      Image: item.image,
      Labels: marker,
      Env: ['RCON_PASSWORD=never-copy-this-secret'],
    },
    Mounts: [{Type: 'volume', Name: item.volume, Destination: '/factorio'}],
    HostConfig: {
      NetworkMode: item.network,
      Mounts: [
        {
          Type: 'volume',
          Source: item.volume,
          Target: '/factorio',
          VolumeOptions: {Subpath: 'data'},
        },
      ],
    },
    NetworkSettings: {Networks: {[item.network]: {}}},
  };
  const controller = {
    Id: 'existing-controller',
    Name: '/' + item.controller,
    Config: {Labels: marker, Env: ['CONTROLLER_TOKEN=never-copy-this-secret']},
    Mounts: [
      {Type: 'volume', Name: item.volume, Destination: '/instance'},
      {
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
      },
    ],
    NetworkSettings: {Networks: {[item.network]: {}}},
  };
  const host = {
    Id: 'existing-host',
    Name: '/lobby-goblin-host-' + fleet,
    Config: {
      Labels: {
        'io.lobby-goblin.fleet': fleet,
        'io.lobby-goblin.role': 'host-controller',
      },
    },
    Mounts: [
      {Type: 'volume', Name: project + '-state', Destination: '/fleet'},
      {
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
      },
    ],
  };
  const input = {
      fleet,
      runtimeReference:
        'ghcr.io/jkenneydaniel/lobby-goblin@sha256:' + 'f'.repeat(64),
      registry,
      containers: [host, game, controller],
    },
    before = structuredClone(input),
    plan = planBrokerUpgrade(input);
  assert.deepEqual(input, before);
  assert.equal(plan.appliesChanges, false);
  assert.equal(plan.servers[0].unchangedGame.id, game.Id);
  assert.equal(plan.servers[0].controller.expectedId, controller.Id);
  assert.ok(!JSON.stringify(plan).includes('never-copy-this-secret'));
  const custom = structuredClone(input);
  custom.containers[2].Mounts.push({
    Type: 'bind',
    Source: '/anything',
    Destination: '/custom',
  });
  assert.throws(() => planBrokerUpgrade(custom), /manual review/);
  assert.throws(
    () =>
      planBrokerUpgrade({
        ...input,
        registry: {...registry, jobs: [{state: 'interrupted'}]},
      }),
    /Review existing operations/,
  );
});

unix(
  'broker startup refuses unrelated nonempty storage without adopting or changing it',
  async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(
        path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'lgb-'),
      ),
    );
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const root = path.join(directory, 'unrelated');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'keep.txt'), 'unchanged');
    let calls = 0;
    await assert.rejects(
      startDockerBroker({
        env: {FLEET_ID: fleet},
        root,
        transport: path.join(directory, 'transport'),
        runtimeImage: runtime,
        docker: () => {
          calls++;
          assert.fail('No engine access is allowed');
        },
      }),
      /existing directory was preserved/,
    );
    assert.deepEqual(await fs.readdir(root), ['keep.txt']);
    assert.equal(
      await fs.readFile(path.join(root, 'keep.txt'), 'utf8'),
      'unchanged',
    );
    assert.equal(calls, 0);
  },
);

unix('real broker confines retained storage usage, read-only inspection and volume deletion including foreign stopped references',async t=>{
 const f=await fixture(t),source=f.seed(one),destination=f.seed(two),client=await f.instance(one);
 for(const item of [source,destination]){f.containers.delete(item.container);Object.assign(f.volumes.get(item.volume),{Scope:'local',CreatedAt:'fixture'});}
 const usage='/containers/json?'+new URLSearchParams({all:'1',filters:JSON.stringify({volume:[source.volume]})});
 assert.deepEqual(await f.host.docker('GET',usage),[]);
 f.containers.set('foreign',{Id:'foreign-id',Name:'/unmanaged',Config:{Labels:{}},State:{Running:false},HostConfig:{Mounts:[{Type:'volume',Source:source.volume,Target:'/data'}]}});
 assert.deepEqual(await f.host.docker('GET',usage),[{Id:'foreign-id'}]);
 await assert.rejects(f.host.docker('DELETE','/volumes/'+source.volume),/still uses/);
 const requestId='f'.repeat(32),spec={Image:runtime,User:'0:0',Entrypoint:['node','/app/fleet/retained-worker.js'],Labels:{...labels(fleet,one,'factorio'),'io.lobby-goblin.worker':'true','io.lobby-goblin.retained-source':one},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Memory:512*1024**2,NanoCpus:1e9,Mounts:[{Type:'volume',Source:project+'-state',Target:'/setup',VolumeOptions:{Subpath:'requests/'+requestId}},{Type:'volume',Source:source.volume,Target:'/source',ReadOnly:true}]}};
 const route='/containers/create?name=lobby-goblin-worker-'+requestId;
 await assert.rejects(f.host.docker('POST',route,structuredClone(spec)),/still uses/);f.containers.delete('foreign');
 for(const mutate of [s=>s.HostConfig.Mounts[1].ReadOnly=false,s=>s.HostConfig.Mounts.push({Type:'bind',Source:'/',Target:'/host'}),s=>s.Entrypoint=['sh'],s=>s.HostConfig.ReadonlyRootfs=false,s=>s.Labels['io.lobby-goblin.retained-source']=two]){const invalid=structuredClone(spec);mutate(invalid);await assert.rejects(f.host.docker('POST',route,invalid),denied);}
 const copy=structuredClone(spec);copy.Labels={...copy.Labels,...labels(fleet,two,'factorio')};copy.HostConfig.Mounts.push({Type:'volume',Source:destination.volume,Target:'/instance'});
 await f.host.docker('POST',route,copy);const worker=[...f.containers.values()].find(c=>c.Name==='/lobby-goblin-worker-'+requestId);assert.deepEqual(worker.HostConfig.CapAdd,['CHOWN','DAC_OVERRIDE','FOWNER']);f.containers.delete('lobby-goblin-worker-'+requestId);
 await assert.rejects(client.docker('DELETE','/volumes/'+source.volume),denied);await assert.rejects(f.host.docker('DELETE','/volumes/'+project+'-library'),denied);await assert.rejects(f.host.docker('DELETE','/volumes/'+source.volume+'?force=true'),denied);
 await f.host.docker('DELETE','/volumes/'+source.volume);assert.equal(f.volumes.has(source.volume),false);assert.equal(f.volumes.has(destination.volume),true);assert.equal(f.volumes.has(project+'-library'),true);
});
