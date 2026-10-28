import fs from 'node:fs/promises';
import {assert, sleep} from '../common.js';
import {docker, demultiplex} from '../core/docker.js';
import {
  managementHash,
  managementImage,
} from '../core/management-installation.js';
import {resources, validId} from '../core/instance.js';
import {managementStorageSlots} from './management-storage.js';
import {assertPanelWorker} from '../core/management-panel-contract.js';
import {managementAnchor, assertAnchor} from '../core/management-volume.js';

const roleKey = 'io.lobby-goblin.role',
  fleetKey = 'io.lobby-goblin.fleet';
const endpoint = (id, tail) =>
  '/containers/' + encodeURIComponent(id) + '/' + tail;
const environment = (info) =>
  Object.fromEntries(
    (info.Config.Env || []).map((value) => {
      const i = value.indexOf('=');
      return [value.slice(0, i), value.slice(i + 1)];
    }),
  );
const gameIdentity = (info) => ({
  id: info.Id,
  image: info.Image,
  reference: info.Config.Image,
  mounts: info.Mounts,
  host: info.HostConfig,
  networks: info.NetworkSettings.Networks,
  running: info.State.Running,
  started: info.State.StartedAt,
});
const configFields = [
  'Hostname',
  'Domainname',
  'User',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'ExposedPorts',
  'Tty',
  'OpenStdin',
  'StdinOnce',
  'Env',
  'Cmd',
  'Healthcheck',
  'ArgsEscaped',
  'Image',
  'Volumes',
  'WorkingDir',
  'Entrypoint',
  'NetworkDisabled',
  'MacAddress',
  'Labels',
  'StopSignal',
  'StopTimeout',
  'Shell',
];
const config = (info) =>
  Object.fromEntries(
    configFields
      .filter((key) => info.Config[key] !== undefined)
      .map((key) => [key, info.Config[key]]),
  );
const originalHash = (info) =>
  managementHash({
    config: config(info),
    host: {...info.HostConfig, RestartPolicy: null},
  });

function archiveFile(bytes, filename) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length <= 4 * 1024 ** 2,
    'Invalid management metadata archive.',
  );
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start, end) =>
      header.subarray(start, end).toString().replace(/\0.*$/s, '');
    const size = parseInt(text(124, 136).trim() || '0', 8);
    assert(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        offset + 512 + size <= bytes.length,
      'Invalid management metadata archive.',
    );
    if (text(0, 100).replace(/^\.\//, '') === filename) {
      assert(
        [0, 48].includes(header[156]) && size <= 1024 ** 2,
        'Management metadata must be a bounded regular file.',
      );
      return bytes.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error(
    'The selected runtime does not contain the required management metadata.',
  );
}

export class ManagementEngine {
  constructor({
    socket,
    engine,
    request,
    coordinator,
    pause = () => sleep(200),
    timeout = 90000,
  }) {
    assert(
      typeof socket === 'string' &&
        socket.startsWith('/') &&
        !/[\x00-\x1f]/.test(socket),
      'Select an explicit local Docker socket.',
    );
    assert(
      typeof engine === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(engine),
      'Select the reviewed Docker engine ID.',
    );
    assert(
      process.env.DOCKER_BROKER_SOCKET === undefined &&
        process.env.DOCKER_BROKER_TOKEN_FILE === undefined,
      'Management updates require local operator authority, outside the panel broker.',
    );
    Object.assign(this, {socket, expectedEngine: engine, pause, timeout, coordinator});
    this.request =
      request ||
      ((method, route, body, options) =>
        docker(method, route, body, {...options, socketPath: socket}));
  }
  async identity() {
    const info = await this.request('GET', '/info');
    assert(
      info.ID === this.expectedEngine && info.OSType === 'linux',
      'The selected Docker engine changed or is not a Linux engine.',
      409,
    );
    return info.ID;
  }
  async inspect(id, {optional = false} = {}) {
    try {
      return await this.request('GET', endpoint(id, 'json'));
    } catch (error) {
      if (optional && error.status === 404) return null;
      throw error;
    }
  }
  async exec(id, script, args = []) {
    const command = await this.request('POST', endpoint(id, 'exec'), {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ['node', '--input-type=module', '-e', script, ...args],
    });
    const output = await this.request(
      'POST',
      '/exec/' + command.Id + '/start',
      {Detach: false, Tty: false},
      {raw: true},
    );
    const result = await this.request('GET', '/exec/' + command.Id + '/json');
    assert(
      !result.Running && result.ExitCode === 0,
      'A management inspection or publication failed. Retain the operator record for recovery.',
      409,
    );
    return JSON.parse(demultiplex(output));
  }
  async readFile(id, file) {
    return archiveFile(
      await this.request(
        'GET',
        endpoint(id, 'archive?') + new URLSearchParams({path: file}),
        undefined,
        {raw: true},
      ),
      file.split('/').at(-1),
    );
  }
  async wait(read) {
    const deadline = Date.now() + this.timeout;
    do {
      if (await read()) return;
      await this.pause();
    } while (Date.now() < deadline);
    throw Error(
      'Management verification timed out. Inspect the retained update before recovery.',
    );
  }
  async plan({fleet, image, id, installation, retained = []}) {
    assert(
      validId(fleet) && validId(id) && managementImage(image),
      'Use the installation identity and a reviewed immutable management image.',
    );
    const engine = await this.identity();
    const anchor = await this.inspect(managementAnchor(fleet), {optional: true});
    if (installation.management) {
      assert(anchor?.Id === installation.management.anchor, 'Portable management enrollment changed.', 409);
      assertAnchor(anchor, fleet, engine);
    } else assert(!anchor, 'Another management update or portable enrollment retains this fleet. Use its original records or --fleet.', 409);
    assert(
      !(await this.inspect((installation.management ? 'lobby-goblin-management-active-' : 'lobby-goblin-management-lock-') + fleet, {
        optional: true,
      })),
      'Another management update retains this fleet. Recover its operator record first.',
      409,
    );
    const runtime = await this.request(
      'GET',
      '/images/' + encodeURIComponent(image) + '/json',
    );
    assert(
      runtime.Os === 'linux' &&
        runtime.Architecture === 'amd64' &&
        /^sha256:[a-f0-9]{64}$/.test(runtime.Id) &&
        runtime.Config.Labels?.['io.lobby-goblin.runtime'] === '1' &&
        runtime.Config.Labels?.['org.opencontainers.image.source'] ===
          'https://github.com/jkenneydaniel/lobby-goblin' &&
        (image === runtime.Id || runtime.RepoDigests?.includes(image)),
      'The selected runtime image identity is not verified.',
    );
    const probe = 'lobby-goblin-management-probe-' + id;
    let inspector;
    try {
      inspector = await this.request(
        'POST',
        '/containers/create?' + new URLSearchParams({name: probe}),
        {
          Image: runtime.Id,
          Labels: {
            [fleetKey]: fleet,
            [roleKey]: 'management-probe',
            'io.lobby-goblin.management-update': id,
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
          },
        },
      );
      const manifest = JSON.parse(
        await this.readFile(inspector.Id, '/app/management-runtime.json'),
      );
      const supported = JSON.parse(
        await fs.readFile(
          new URL('../management-runtime.json', import.meta.url),
          'utf8',
        ),
      );
      assert(
        managementHash(manifest) === managementHash(supported),
        'The selected runtime does not support this management update protocol.',
      );
    } finally {
      const retained = inspector
        ? await this.inspect(inspector.Id)
        : await this.inspect(probe, {optional: true});
      if (retained) {
        assert(
          retained.Config.Labels?.['io.lobby-goblin.management-update'] === id,
          'Image probe ownership changed.',
        );
        await this.request('DELETE', '/containers/' + retained.Id);
      }
    }
    const hostName = 'lobby-goblin-host-' + fleet;
    const host = await this.inspect(hostName);
    const profile = installation.management?.profile || 'brokered';
    assert(['brokered', 'legacy'].includes(profile), 'Unsupported management profile.');
    assert(
      host.Config.Labels?.[fleetKey] === fleet &&
        host.Config.Labels?.[roleKey] === 'host-controller' &&
        (profile === 'brokered' ? environment(host).DOCKER_BROKER_SOCKET === '/broker/socket/docker.sock' :
          !environment(host).DOCKER_BROKER_SOCKET && host.Mounts.some(m => m.Type === 'bind' && m.Source === '/var/run/docker.sock' && m.Destination === '/var/run/docker.sock')),
      'The management transport no longer matches its reviewed profile.',
      409,
    );
    const registry = await this.exec(
      host.Id,
      "import {RegistryRepository} from './core/storage/state-repositories.js';console.log(JSON.stringify((await new RegistryRepository('/fleet').read()).value));",
    );
    assert(
      registry.version === 1 &&
        Array.isArray(registry.servers) &&
        registry.servers.length <= 64,
      'Invalid fleet registry.',
    );
    const instances = registry.servers.filter(
      (item) => item.state !== 'removed',
    );
    assert(
      instances.every(
        (item) =>
          item.state === 'installed' &&
          (profile === 'brokered' ? item.isolationVersion === 1 : item.isolationVersion === undefined || item.isolationVersion === 0) &&
          !item.maintenance &&
          (!item.migration || item.migration.state === 'complete') &&
          Object.entries(resources(fleet, item.id, item.game)).every(
            ([key, value]) => item[key] === value,
          ),
      ),
      'Recover incomplete or unconverted instances before updating management.',
      409,
    );
    const expected = new Map([
      [hostName, 'host-controller'],
      ...(profile === 'brokered' ? [['lobby-goblin-docker-broker-' + fleet, 'docker-broker']] : []),
      [
        installation.kind === 'host-agent'
          ? 'lobby-goblin-agent-' + fleet
          : 'lobby-goblin-host-web-' + fleet,
        installation.kind === 'host-agent' ? 'host-agent-web' : 'host-web',
      ],
      ...instances.map((item) => [item.controller, 'instance-controller']),
    ]);
    const listed = await this.request(
      'GET',
      '/containers/json?' +
        new URLSearchParams({
          all: '1',
          filters: JSON.stringify({label: [fleetKey + '=' + fleet]}),
        }),
    );
    const services = [];
    const slots = managementStorageSlots({
      fleet,
      ...(profile === 'legacy' ? {profile} : {}),
      instances: instances.map(({id, game}) => ({id, game})),
    });
    const allowedVolumes = new Set([
      ...slots.map((slot) => slot.volume),
      'lobby-goblin-fleet-' + fleet + '-library',
      'lobby-goblin-fleet-' + fleet + '-https-data',
      'lobby-goblin-fleet-' + fleet + '-https-config',
    ]);
    for (const [name, role] of expected) {
      const info = name === hostName ? host : await this.inspect(name);
      assert(
        info.Config.Labels?.[fleetKey] === fleet &&
          info.Config.Labels[roleKey] === role &&
          info.State.Running &&
          !info.HostConfig.Privileged &&
          !info.HostConfig.Devices?.length &&
          !['host'].includes(info.HostConfig.PidMode) &&
          info.HostConfig.IpcMode !== 'host' &&
          info.Mounts.every(
            (mount) =>
              (mount.Type === 'volume' && allowedVolumes.has(mount.Name)) ||
              ((role === 'docker-broker' || profile === 'legacy' && ['host-controller', 'instance-controller'].includes(role)) &&
                mount.Type === 'bind' &&
                mount.Source === '/var/run/docker.sock' &&
                mount.Destination === '/var/run/docker.sock'),
          ),
        'Custom or unavailable management services require operator review.',
        409,
      );
      assert(
        JSON.stringify(info.Config.Entrypoint) ===
          JSON.stringify(runtime.Config.Entrypoint) &&
          JSON.stringify(info.Config.Cmd) ===
            JSON.stringify(runtime.Config.Cmd),
        'Custom management commands require manual review.',
        409,
      );
      services.push({
        id: info.Id,
        name,
        role,
        before: name + '-before-' + id,
        info,
        hash: originalHash(info),
        imageDefaults: (
          await this.request(
            'GET',
            '/images/' + encodeURIComponent(info.Image) + '/json',
          )
        ).Config,
      });
    }
    const games = [];
    for (const item of instances) {
      const info = await this.inspect(item.container);
      assert(
        info.Config.Labels?.[fleetKey] === fleet &&
          info.Config.Labels['io.lobby-goblin.instance'] === item.id &&
          info.Config.Labels['io.lobby-goblin.game'] === item.game &&
          info.Config.Image === item.image,
        'Application container ownership changed.',
        409,
      );
      games.push(gameIdentity(info));
    }
    // Helpers may still own writable state after a lost controller response.
    // Retained previous management containers are allowed only when stopped.
    if (this.coordinator)
      assertPanelWorker(await this.inspect(this.coordinator.id), this.coordinator.spec, this.coordinator.name);
    for (const value of listed)
      assert(
        services.some((service) => service.id === value.Id) ||
          value.Id === anchor?.Id ||
          value.Id === this.coordinator?.id ||
          games.some((game) => game.id === value.Id) ||
          value.Labels?.[roleKey] === 'host-gateway' ||
          (value.State === 'exited' &&
            retained.some(
              (prior) =>
                prior.services.some(
                  (service) =>
                    service.id === value.Id &&
                    value.Names.includes('/' + service.before),
                ) ||
                (value.Labels?.[roleKey] === 'management-storage' &&
                  value.Labels?.['io.lobby-goblin.management-update'] ===
                    prior.id),
            )),
        'Unexpected fleet workers or containers need review before updating management.',
        409,
      );
    for (const volume of new Set(slots.map((slot) => slot.volume))) {
      const value = await this.request(
        'GET',
        '/volumes/' + encodeURIComponent(volume),
      );
      assert(
        value.Driver === 'local' &&
          !Object.keys(value.Options || {}).length &&
          value.Labels?.[fleetKey] === fleet,
        'Management storage ownership changed.',
        409,
      );
    }
    return {
      version: 1,
      id,
      fleet,
      engine,
      image,
      imageId: runtime.Id,
      imageDefaults: runtime.Config,
      registryHash: managementHash(registry),
      ...(anchor ? {authority: anchor.Id} : {}),
      ...(profile === 'legacy' ? {profile} : {}),
      instances: instances.map(({id, game}) => ({id, game})),
      services,
      games,
      artifactVolume: 'lobby-goblin-management-' + fleet + '-' + id,
    };
  }
  async verifyGames(games) {
    for (const game of games)
      assert(
        managementHash(gameIdentity(await this.inspect(game.id))) ===
          managementHash(game),
        'An application container changed. Management recovery requires operator review.',
        409,
      );
  }
  async acquire(plan) {
    // Docker names provide an engine-wide exclusive claim, including operators
    // using two copies of the same installation directory. This container never
    // starts and has no mounts or credentials; it is only an ownership record.
    const anchor = await this.inspect(managementAnchor(plan.fleet), {optional: true});
    if (plan.authority) {
      assert(anchor?.Id === plan.authority, 'Portable management enrollment changed.', 409);
      assertAnchor(anchor, plan.fleet, plan.engine);
    } else assert(!anchor || anchor.Config.Labels?.[roleKey] === 'management-lock', 'Use the enrolled portable updater with --fleet. Original directory records were preserved.', 409);
    const name = (plan.authority ? 'lobby-goblin-management-active-' : 'lobby-goblin-management-lock-') + plan.fleet;
    let claim = await this.inspect(name, {optional: true});
    if (!claim) {
      const result = await this.request(
        'POST',
        '/containers/create?' + new URLSearchParams({name}),
        {
          Image: plan.imageId,
          Labels: {
            [fleetKey]: plan.fleet,
            [roleKey]: 'management-lock',
            'io.lobby-goblin.management-update': plan.id,
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            RestartPolicy: {Name: 'no'},
          },
        },
      );
      claim = await this.inspect(result.Id);
    }
    assert(
      !claim.State.Running &&
        claim.Config.Labels?.[fleetKey] === plan.fleet &&
        claim.Config.Labels?.[roleKey] === 'management-lock' &&
        claim.Config.Labels?.['io.lobby-goblin.management-update'] ===
          plan.id &&
        !claim.Mounts?.length,
      'Another operator owns this fleet update. Inspect the retained claim before recovery.',
      409,
    );
  }
  async release(plan, {removeOriginals = false} = {}) {
    // Pre-commit rollback retains exact originals. After a successful commit,
    // remove their stopped containers so Compose cannot select duplicate service
    // labels. Their specifications and metadata snapshot remain private.
    if (removeOriginals)
      for (const service of plan.services) {
        const original = await this.inspect(service.id, {optional: true});
        if (!original) continue;
        assert(
          !original.State.Running &&
            original.Name === '/' + service.before &&
            originalHash(original) === service.hash,
          'Retained management service changed. Preserve it for operator review.',
          409,
        );
        await this.request('DELETE', '/containers/' + original.Id);
      }
    const claim = await this.inspect(
      (plan.authority ? 'lobby-goblin-management-active-' : 'lobby-goblin-management-lock-') + plan.fleet,
      {optional: true},
    );
    if (
      !claim ||
      claim.Config.Labels?.['io.lobby-goblin.management-update'] !== plan.id
    )
      return;
    assert(
      !claim.State.Running &&
        claim.Config.Labels?.[fleetKey] === plan.fleet &&
        claim.Config.Labels?.[roleKey] === 'management-lock' &&
        !claim.Mounts?.length,
      'Fleet update ownership changed. Retain the operator claim for review.',
      409,
    );
    await this.request('DELETE', '/containers/' + claim.Id);
  }
  async verifyOriginals(plan) {
    for (const service of plan.services) {
      const info = await this.inspect(service.id);
      assert(
        info.Name === '/' + service.name &&
          originalHash(info) === service.hash &&
          info.State.Running === service.info.State.Running &&
          managementHash(info.HostConfig.RestartPolicy) ===
            managementHash(service.info.HostConfig.RestartPolicy),
        'The original management service changed.',
        409,
      );
    }
  }
  async stopOriginal(service) {
    let info = await this.inspect(service.id);
    assert(
      originalHash(info) === service.hash &&
        ['/' + service.name, '/' + service.before].includes(info.Name),
      'Original management service changed.',
      409,
    );
    if (
      info.State.Running &&
      ['host-controller', 'instance-controller'].includes(service.role)
    ) {
      const {assertManagementIdle} =
        await import('../core/management-maintenance.js');
      assertManagementIdle(
        (await this.maintenance(service, 'status')).workflow,
      );
    }
    if (info.HostConfig.RestartPolicy.Name !== 'no')
      await this.request('POST', endpoint(service.id, 'update'), {
        RestartPolicy: {Name: 'no'},
      });
    info = await this.inspect(service.id);
    if (info.State.Running)
      await this.request('POST', endpoint(service.id, 'stop?t=30'));
    assert(
      !(await this.inspect(service.id)).State.Running,
      'Management writer did not stop.',
      409,
    );
  }
  async assertQuiet(plan) {
    for (const service of plan.services)
      assert(
        !(await this.inspect(service.id)).State.Running,
        'Management writers must remain stopped.',
        409,
      );
  }
  async storage(plan, operation, manifestHash) {
    await this.identity();
    let volume;
    try {
      volume = await this.request('GET', '/volumes/' + plan.artifactVolume);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!volume)
      volume = await this.request('POST', '/volumes/create', {
        Name: plan.artifactVolume,
        Labels: {
          [fleetKey]: plan.fleet,
          [roleKey]: 'management-operator',
          'io.lobby-goblin.management-update': plan.id,
        },
      });
    assert(
      volume.Labels?.[fleetKey] === plan.fleet &&
        volume.Labels?.['io.lobby-goblin.management-update'] === plan.id &&
        volume.Driver === 'local' &&
        !Object.keys(volume.Options || {}).length,
      'Private operator snapshot volume changed.',
      409,
    );
    const name = 'lobby-goblin-management-storage-' + plan.id + '-' + operation;
    let helper = await this.inspect(name, {optional: true});
    if (helper) {
      assert(
        helper.Config.Labels?.['io.lobby-goblin.management-update'] ===
          plan.id && helper.Image === plan.imageId,
        'Management snapshot helper ownership changed.',
        409,
      );
      if (
        !helper.State.Running &&
        helper.State.ExitCode === 0 &&
        operation !== 'verify' &&
        helper.State.Status === 'exited'
      )
        return this.storageResult(helper.Id, plan, operation, manifestHash);
      assert(
        helper.State.Running ||
          ['created', 'exited'].includes(helper.State.Status),
        'The metadata helper needs operator review.',
        409,
      );
    } else {
      const request = {
        version: 1,
        id: plan.id,
        fleet: plan.fleet,
        instances: plan.instances,
        ...(plan.profile ? {profile: plan.profile} : {}),
        operation,
        confirm: true,
        offline: true,
        ...(manifestHash ? {manifestHash} : {}),
        ...(operation === 'backup' ? {registryHash: plan.registryHash} : {}),
      };
      helper = await this.request(
        'POST',
        '/containers/create?' + new URLSearchParams({name}),
        {
          Image: plan.imageId,
          User: '0:0',
          Entrypoint: ['node', '/app/fleet/management-storage-worker.js'],
          Env: [
            'FLEET_ID=' + plan.fleet,
            'PANEL_MAINTENANCE_ID=' + plan.id,
            'PANEL_MAINTENANCE_REQUEST=' + JSON.stringify(request),
          ],
          Labels: {
            [fleetKey]: plan.fleet,
            [roleKey]: 'management-storage',
            'io.lobby-goblin.management-update': plan.id,
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            RestartPolicy: {Name: 'no'},
            CapDrop: ['ALL'],
            CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
            SecurityOpt: ['no-new-privileges:true'],
            Memory: 512 * 1024 ** 2,
            PidsLimit: 64,
            Tmpfs: {'/maintenance': 'rw,nosuid,size=1m'},
            Mounts: [
              {
                Type: 'volume',
                Source: plan.artifactVolume,
                Target: '/artifact',
              },
              ...managementStorageSlots({
                fleet: plan.fleet,
                instances: plan.instances,
                ...(plan.profile ? {profile: plan.profile} : {}),
              }).map((slot) => ({
                Type: 'volume',
                Source: slot.volume,
                Target: '/storage/' + slot.id,
                ReadOnly: ['backup', 'verify'].includes(operation),
                ...(slot.subpath
                  ? {VolumeOptions: {Subpath: slot.subpath, NoCopy: true}}
                  : {}),
              })),
            ],
          },
        },
      );
    }
    const state = await this.inspect(helper.Id);
    if (['created', 'exited'].includes(state.State.Status))
      await this.request('POST', endpoint(helper.Id, 'start'));
    await this.wait(async () => !(await this.inspect(helper.Id)).State.Running);
    const final = await this.inspect(helper.Id);
    assert(
      final.State.ExitCode === 0,
      'Metadata helper failed. Keep management stopped and preserve the private snapshot.',
      409,
    );
    return this.storageResult(helper.Id, plan, operation, manifestHash);
  }
  async storageResult(id, plan, operation, manifestHash) {
    const result = JSON.parse(
      await this.readFile(
        id,
        '/artifact/' + plan.id + '/result-' + operation + '.json',
      ),
    );
    assert(
      result.id === plan.id &&
        result.fleet === plan.fleet &&
        result.operation === operation &&
        (!manifestHash || result.manifestHash === manifestHash),
      'Management storage result identity changed.',
      409,
    );
    return result;
  }
  replacement(service, plan) {
    const info = service.info,
      inherited = environment({Config: service.imageDefaults}),
      env = {
        ...environment({Config: plan.imageDefaults}),
        ...Object.fromEntries(
          Object.entries(environment(info)).filter(
            ([key, value]) => inherited[key] !== value,
          ),
        ),
      };
    env.PANEL_MAINTENANCE_ID = plan.id;
    if (service.role === 'host-controller') env.FLEET_IMAGE = plan.image;
    if (service.role === 'host-controller' && plan.profile === 'legacy') env.FLEET_SKIP_MIGRATIONS = 'true';
    const networks = Object.fromEntries(
      Object.entries(info.NetworkSettings.Networks).map(([name, value]) => {
        assert(
          !value.IPAMConfig || !Object.values(value.IPAMConfig).some(Boolean),
          'Static management addresses require manual review.',
        );
        return [
          name,
          {
            Aliases: (value.Aliases || []).filter(
              (alias) => ![info.Id, info.Id.slice(0, 12)].includes(alias),
            ),
          },
        ];
      }),
    );
    return {
      ...config(info),
      Image: plan.imageId,
      Env: Object.entries(env).map(([key, value]) => key + '=' + value),
      Labels: {
        ...plan.imageDefaults.Labels,
        ...Object.fromEntries(
          Object.entries(info.Config.Labels || {}).filter(
            ([key, value]) => service.imageDefaults.Labels?.[key] !== value,
          ),
        ),
        'io.lobby-goblin.management-update': plan.id,
      },
      HostConfig: {
        ...info.HostConfig,
        RestartPolicy: service.info.HostConfig.RestartPolicy,
      },
      NetworkingConfig: {EndpointsConfig: networks},
    };
  }
  async replacementInfo(service, plan, optional = false) {
    const info = await this.inspect(service.name, {optional});
    if (!info) return null;
    const expected = this.replacement(service, plan);
    const effectiveHost = (host) => ({
      ...host,
      OomKillDisable: !!host.OomKillDisable,
    });
    assert(
      info.Id !== service.id &&
        info.Image === plan.imageId &&
        info.Config.Labels?.['io.lobby-goblin.management-update'] === plan.id &&
        info.Config.Labels?.[fleetKey] === plan.fleet &&
        info.Config.Labels?.[roleKey] === service.role &&
        managementHash({
          ...config(info),
          HostConfig: effectiveHost(info.HostConfig),
        }) ===
          managementHash({
            ...expected,
            HostConfig: effectiveHost(expected.HostConfig),
            NetworkingConfig: undefined,
          }),
      'Replacement management service changed. Preserve it for operator review.',
      409,
    );
    return info;
  }
  async replace(service, plan) {
    const original = await this.inspect(service.id);
    assert(
      !original.State.Running && originalHash(original) === service.hash,
      'Original management service is not safely stopped.',
      409,
    );
    if (original.Name === '/' + service.name)
      await this.request(
        'POST',
        endpoint(service.id, 'rename?') +
          new URLSearchParams({name: service.before}),
      );
    else
      assert(
        original.Name === '/' + service.before,
        'Original management service name changed.',
        409,
      );
    return this.ensureReplacement(service, plan);
  }
  async ensureReplacement(service, plan) {
    let next = await this.replacementInfo(service, plan, true);
    if (!next) {
      const result = await this.request(
        'POST',
        '/containers/create?' + new URLSearchParams({name: service.name}),
        this.replacement(service, plan),
      );
      next = await this.inspect(result.Id);
    }
    if (!next.State.Running)
      await this.request('POST', endpoint(next.Id, 'start'));
    await this.wait(async () => {
      const info = await this.inspect(next.Id);
      return (
        info.State.Running &&
        (!info.State.Health || info.State.Health.Status === 'healthy')
      );
    });
  }
  async maintenance(service, operation, id, target = service.id) {
    const agent =
      service.role === 'host-agent-web' &&
      environment(service.info).AGENT_TRANSPORT === 'persistent';
    const client = agent
      ? `
      import http2 from 'node:http2';
      import {AgentConnection} from './fleet/agent-connection.js';
      import {readAgentIdentity} from './fleet/agent-identity.js';
      const connection=new AgentConnection('https://127.0.0.1:'+(process.env.PORT||8080),(await readAgentIdentity('/web-state')).fingerprint);
      // Operator-only loopback inspection uses the pinned session directly.
      // Ordinary paired clients still cannot request reserved management paths.
      const request=async(url,options)=>{
        const session=await connection.session(),target=new URL(url);
        return new Promise((resolve,reject)=>{
          const stream=session.request({':method':options.method,':path':target.pathname,...options.headers,[http2.sensitiveHeaders]:['authorization']});
          let status=0,size=0,ended=false;const chunks=[];
          stream.setTimeout(10000,()=>stream.destroy(Error('Management inspection timed out')));
          stream.once('response',headers=>{status=Number(headers[':status']);});
          stream.on('data',chunk=>{size+=chunk.length;if(size>65536)stream.destroy(Error('Management inspection exceeded its limit'));else chunks.push(chunk);});
          stream.once('error',reject);
          stream.once('aborted',()=>reject(Error('Management inspection was interrupted')));
          stream.once('close',()=>{if(!ended)reject(Error('Management inspection was interrupted'));});
          stream.once('end',()=>{ended=true;resolve({ok:status>=200&&status<300,json:async()=>JSON.parse(Buffer.concat(chunks))});});
          stream.end(options.body);
        });
      };
    `
      : 'const request=fetch;';
    return this.exec(
      target,
      `import fs from 'node:fs/promises';${client}const body=JSON.parse(process.argv[1]);const token=await fs.readFile(process.env.CONTROLLER_TOKEN_FILE||'${service.role === 'host-controller' ? '/web-state/secrets/controller-token' : '/run/secrets/controller-token'}','utf8');try{const response=await request('${agent ? 'https' : 'http'}://127.0.0.1:'+(process.env.PORT||'${service.role === 'instance-controller' ? 8081 : service.role === 'host-controller' ? 8091 : 8080}')+'/management/'+body.operation,{method:body.operation==='status'?'GET':'POST',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token.trim(),'content-type':'application/json'},...(body.operation==='activate'?{body:JSON.stringify({id:body.id,confirm:true})}:{})});if(!response.ok)throw Error('Management maintenance is not ready');console.log(JSON.stringify(await response.json()));}finally{${agent ? 'connection.close();' : ''}}`,
      [JSON.stringify({operation, ...(id ? {id} : {})})],
    );
  }
  async verifyReplacements(plan, {held}) {
    for (const service of plan.services) {
      const info = await this.replacementInfo(service, plan);
      assert(
        info.State.Running &&
          (!info.State.Health || info.State.Health.Status === 'healthy'),
        'Replacement management service is not healthy.',
        409,
      );
      if (service.role !== 'docker-broker') {
        const status = await this.maintenance(
          service,
          'status',
          undefined,
          info.Id,
        );
        assert(
          status.id === plan.id && status.held === held,
          'Management activation identity or hold changed.',
          409,
        );
        if (
          held &&
          ['host-controller', 'instance-controller'].includes(service.role)
        ) {
          const {assertManagementIdle} =
            await import('../core/management-maintenance.js');
          assertManagementIdle(status.workflow);
        }
      }
    }
  }
  async activate(service, plan) {
    const info = await this.replacementInfo(service, plan);
    const status = await this.maintenance(
      service,
      'status',
      undefined,
      info.Id,
    );
    assert(
      status.id === plan.id,
      'Management activation identity changed.',
      409,
    );
    if (!status.held) return;
    if (service.role === 'host-agent-web') {
      await this.storage(plan, 'activate-agent');
      await this.wait(
        async () =>
          !(await this.maintenance(service, 'status', undefined, info.Id)).held,
      );
    } else await this.maintenance(service, 'activate', plan.id, info.Id);
  }
  async removeReplacement(service, plan) {
    const named = await this.inspect(service.name, {optional: true});
    if (!named || named.Id === service.id) return;
    const info = await this.replacementInfo(service, plan);
    if (info.State.Running)
      await this.request('POST', endpoint(info.Id, 'stop?t=30'));
    await this.request('DELETE', '/containers/' + info.Id);
  }
  async restoreOriginal(service) {
    const info = await this.inspect(service.id);
    assert(
      originalHash(info) === service.hash &&
        ['/' + service.name, '/' + service.before].includes(info.Name),
      'Original management service changed.',
      409,
    );
    if (info.Name !== '/' + service.name)
      await this.request(
        'POST',
        endpoint(service.id, 'rename?') +
          new URLSearchParams({name: service.name}),
      );
    if (
      managementHash(info.HostConfig.RestartPolicy) !==
      managementHash(service.info.HostConfig.RestartPolicy)
    )
      await this.request('POST', endpoint(service.id, 'update'), {
        RestartPolicy: service.info.HostConfig.RestartPolicy,
      });
    if (service.info.State.Running && !info.State.Running)
      await this.request('POST', endpoint(service.id, 'start'));
  }
  async publish(plan, terminal) {
    const host = plan.services.find(
      (service) => service.role === 'host-controller',
    );
    const info = await this.inspect(host.name);
    // Use the same implementation in the selected runtime, with bounded public
    // metadata only. No environment, original specification or snapshot is sent.
    await this.exec(
      info.Id,
      "import {publishManagementOutcome} from './fleet/management-outcome.js';await publishManagementOutcome('/fleet',JSON.parse(process.argv[1]));console.log('{}');",
      [
        JSON.stringify({
          id: terminal.id,
          actor: terminal.actor,
          state: terminal.state,
          phase: terminal.phase,
          started: terminal.started,
          finished: terminal.finished,
          operationRecord: terminal.operationRecord,
        }),
      ],
    );
  }
  async reconcilePanelUpdate(result, {profile = 'brokered'} = {}) {
    assert((await this.identity()) === result.engine, 'Operator recovery engine changed.', 409);
    const role = profile === 'legacy' ? 'host-controller' : 'docker-broker';
    const info = await this.inspect((profile === 'legacy' ? 'lobby-goblin-host-' : 'lobby-goblin-docker-broker-') + result.fleet);
    assert(info.Config.Labels?.[fleetKey] === result.fleet && info.Config.Labels?.[roleKey] === role && info.State.Running, 'Recovered manager ownership changed.', 409);
    return this.exec(info.Id,
      "import fs from 'node:fs/promises';let supported=true;try{await fs.access('/app/core/management-panel.js');}catch(error){if(error.code!=='ENOENT')throw error;supported=false;}let result={supported};if(supported){const {publishPanelRecovery}=await import('./core/management-panel.js');result=await publishPanelRecovery(process.env.MODE==='fleet-controller'?(process.env.FLEET_ROOT||'/fleet'):(process.env.BROKER_STATE||'/broker-state'),JSON.parse(process.argv[1]));}console.log(JSON.stringify(result));",
      [JSON.stringify(result)]);
  }
}
