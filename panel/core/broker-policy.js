import {storageWorkerCapabilities} from '../fleet/storage-worker.js';
import {assert} from '../common.js';
import {labels, resources, validId} from './instance.js';
import {imageMatch} from './image-policy.js';
import {brokerSocket, brokerToken} from './broker-client.js';
import {
  softwareWorkerKind,
  softwareWorkerScope,
  validateSoftwareWorkerContainer,
  softwareWorkerDeployment,
} from './software-worker-policy.js';

const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = () =>
  assert(
    false,
    'This Docker request is outside the host broker contract.',
    403,
  );
function only(value, keys) {
  assert(exact(value, keys), 'Unreviewed Docker options were refused.', 403);
}
function query(url, keys) {
  assert(
    [...url.searchParams.keys()].every((key) => keys.includes(key)) &&
      new Set(url.searchParams.keys()).size ===
        [...url.searchParams.keys()].length,
    'Unreviewed Docker query options were refused.',
    403,
  );
}
const gid = (value) => /^sha256:[a-f0-9]{64}$/.test(value);
const instanceForVolume = (value, fleet) =>
  typeof value === 'string' && value.startsWith('lobby-goblin-' + fleet + '-')
    ? value.slice(('lobby-goblin-' + fleet + '-').length)
    : '';

// The host manager can provision owned resources, but cannot submit general
// Docker create/update/exec specifications or mount the broker's private state.
export function hostDockerPolicy(
  request,
  {fleet, hostContainer, runtimeImage, transportVolume, modules},
) {
  const project = 'lobby-goblin-fleet-' + fleet;
  assert(
    validId(fleet) &&
      gid(runtimeImage) &&
      transportVolume === project + '-broker-transport',
    'Invalid host broker configuration.',
  );
  function definition(data) {
    const marker = data?.Labels || data?.Config?.Labels || {},
      id = marker['io.lobby-goblin.instance'],
      game = marker['io.lobby-goblin.game'],
      module = modules.find((value) => value.id === game);
    assert(
      marker['io.lobby-goblin.fleet'] === fleet && validId(id) && module,
      'Docker resource is outside this fleet.',
      403,
    );
    return {id, game, module, ...resources(fleet, id, game)};
  }
  const gameImageAllowed = (module, image) =>
    typeof image === 'string' &&
    (image === module.managed.catalog.image ||
      (!module.managed.catalog.image.includes('@') &&
        image.startsWith(module.managed.catalog.image) &&
        /^@sha256:[a-f0-9]{64}$/.test(
          image.slice(module.managed.catalog.image.length),
        )) ||
      imageMatch(module.imagePolicy, image) || module.managed.runtime && imageMatch(module.managed.runtime.imagePolicy,image));
  const imageAllowed = (image) =>
    image === runtimeImage ||
    modules.some((module) => gameImageAllowed(module, image));
  function mount(value, expected) {
    only(value, ['Type', 'Source', 'Target', 'ReadOnly', 'VolumeOptions']);
    only(value.VolumeOptions || {}, ['Subpath', 'NoCopy']);
    assert(
      value.Type === 'volume' &&
        value.Source === expected.source &&
        value.Target === expected.target &&
        (value.ReadOnly === true) === !!expected.readOnly &&
        (value.VolumeOptions?.Subpath || '') === (expected.subpath || '') &&
        (value.VolumeOptions?.NoCopy === undefined ||
          typeof value.VolumeOptions.NoCopy === 'boolean'),
      'Docker mount is outside its declared storage.',
      403,
    );
  }
  function specification(data, name) {
    only(data, [
      'Image',
      'User',
      'Entrypoint',
      'Cmd',
      'Env',
      'Labels',
      'ExposedPorts',
      'HostConfig',
      'NetworkingConfig',
    ]);
    const item = definition(data),
      role = data.Labels['io.lobby-goblin.role'],
      worker = data.Labels['io.lobby-goblin.worker'] === 'true',
      host = data.HostConfig;
    only(data.Labels, [
      ...Object.keys(labels(fleet, item.id, item.game)),
      'io.lobby-goblin.role',
      'io.lobby-goblin.worker',
    ]);
    only(host, [
      'RestartPolicy',
      'NetworkMode',
      'Memory',
      'NanoCpus',
      'Mounts',
      'PortBindings',
      'LogConfig',
      'CapDrop',
      'CapAdd',
      'SecurityOpt',
      'PidsLimit',
    ]);
    assert(
      Number.isSafeInteger(host.Memory) &&
        host.Memory >= 64 * 1024 ** 2 &&
        host.Memory <= 32 * 1024 ** 3 &&
        Number.isSafeInteger(host.NanoCpus) &&
        host.NanoCpus > 0 &&
        host.NanoCpus <= 8e9 &&
        Array.isArray(host.Mounts),
      'Docker resource limits are required.',
      403,
    );
    if (host.RestartPolicy) {
      only(host.RestartPolicy, ['Name']);
      assert(
        ['no', 'unless-stopped'].includes(host.RestartPolicy.Name),
        'Unsupported restart policy.',
        403,
      );
    }
    if (host.LogConfig) {
      assert(
        host.LogConfig.Type === 'json-file',
        'Unsupported logging driver.',
        403,
      );
      only(host.LogConfig, ['Type', 'Config']);
      only(host.LogConfig.Config, ['max-size', 'max-file']);
      assert(
        ['2m', '5m', '10m'].includes(host.LogConfig.Config['max-size']) &&
          ['2', '3'].includes(host.LogConfig.Config['max-file']),
        'Log storage must be bounded.',
        403,
      );
    }
    if (worker) {
      assert(
        !role &&
          /^lobby-goblin-worker-[a-f0-9]{32}$/.test(name) &&
          data.Image === runtimeImage &&
          data.User === '0:0' &&
          same(data.Entrypoint, ['node', '/app/fleet/worker.js']) &&
          !data.Cmd &&
          !data.Env &&
          !data.ExposedPorts &&
          !data.NetworkingConfig &&
          !host.PortBindings &&
          host.NetworkMode === 'none' &&
          host.Mounts.length === 3 &&
          host.Memory <= 512 * 1024 ** 2 &&
          host.NanoCpus <= 1e9,
        'Unsupported storage worker.',
        403,
      );
      const requestId = name.slice('lobby-goblin-worker-'.length);
      mount(host.Mounts[0], {
        source: project + '-state',
        target: '/setup',
        subpath: 'requests/' + requestId,
      });
      mount(host.Mounts[1], {
        source: item.volume,
        target: '/instance',
        readOnly: host.Mounts[1].ReadOnly === true,
      });
      mount(host.Mounts[2], {
        source: project + '-library',
        target: '/library',
        readOnly: host.Mounts[2].ReadOnly === true,
      });
      host.CapAdd = [...storageWorkerCapabilities];
    } else {
      assert(
        host.NetworkMode === item.network &&
          !data.Entrypoint &&
          !data.Cmd &&
          Array.isArray(data.Env) &&
          data.Env.length <= 100 &&
          data.Env.every(
            (value) =>
              typeof value === 'string' &&
              value.length <= 4096 &&
              /^[A-Z][A-Z0-9_]*=[^\x00\r\n]*$/.test(value),
          ) &&
          new Set(data.Env.map((value) => value.split('=')[0])).size ===
            data.Env.length,
        'Unsupported game/controller configuration.',
        403,
      );
      const network = data.NetworkingConfig;
      assert(
        exact(network, ['EndpointsConfig']) &&
          exact(network.EndpointsConfig, [item.network]) &&
          same(network.EndpointsConfig[item.network], {Aliases: [name]}),
        'The container requires its own network.',
        403,
      );
      if (role === 'instance-controller') {
        assert(
          name === item.controller &&
            data.Image === runtimeImage &&
            data.User === '0:0' &&
            !host.PortBindings &&
            !data.ExposedPorts &&
            host.Mounts.length === 3 &&
            host.Memory <= 1024 ** 3 &&
            host.NanoCpus <= 1e9,
          'Unsupported instance controller.',
          403,
        );
        mount(host.Mounts[0], {source: item.volume, target: '/instance'});
        mount(host.Mounts[1], {
          source: transportVolume,
          target: '/broker/socket',
          subpath: 'socket',
          readOnly: true,
        });
        mount(host.Mounts[2], {
          source: transportVolume,
          target: '/broker/credential',
          subpath: 'instances/' + item.id,
          readOnly: true,
        });
        const env = Object.fromEntries(
          data.Env.map((value) => {
            const at = value.indexOf('=');
            return [value.slice(0, at), value.slice(at + 1)];
          }),
        );
        assert(
          env.MODE === 'controller' &&
            env.FLEET_ID === fleet &&
            env.FLEET_INSTANCE === item.id &&
            env.FLEET_VOLUME === item.volume &&
            env.GAME_MODULE === item.game &&
            env.DOCKER_BROKER_SOCKET === brokerSocket &&
            env.DOCKER_BROKER_TOKEN_FILE === brokerToken &&
            !env.DOCKER_SOCKET &&
            !env.DOCKER_HOST &&
            !env.NODE_OPTIONS,
          'Invalid controller broker scope.',
          403,
        );
        host.CapAdd = ['DAC_OVERRIDE'];
      } else {
        assert(
          !role &&
            name === item.container &&
            !data.User &&
            gameImageAllowed(item.module, data.Image) &&
            host.Mounts.length === 1,
          'Unsupported game image or identity.',
          403,
        );
        mount(host.Mounts[0], {
          source: item.volume,
          target: item.module.managed.dataTarget,
          subpath: 'data',
        });
        const ports = item.module.managed.ports.map(
          (port) => port.containerPort + '/' + port.protocol,
        );
        only(data.ExposedPorts, ports);
        only(host.PortBindings, ports);
        assert(
          Object.keys(data.ExposedPorts).length === ports.length &&
            Object.keys(host.PortBindings).length === ports.length &&
            ports.every(
              (port) =>
                same(data.ExposedPorts[port], {}) &&
                Array.isArray(host.PortBindings[port]) &&
                host.PortBindings[port].length === 1 &&
                exact(host.PortBindings[port][0], ['HostIp', 'HostPort']) &&
                ['0.0.0.0', '127.0.0.1'].includes(
                  host.PortBindings[port][0].HostIp,
                ) &&
                /^\d+$/.test(host.PortBindings[port][0].HostPort) &&
                Number(host.PortBindings[port][0].HostPort) >= 1024 &&
                Number(host.PortBindings[port][0].HostPort) < 65000,
            ),
          'Only game ports may be published.',
          403,
        );
        host.CapAdd = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];
      }
    }
    // Security values are generated here, never inherited from the caller.
    host.CapDrop = ['ALL'];
    host.SecurityOpt = ['no-new-privileges:true'];
    host.PidsLimit = worker ? 128 : 1024;
    return item;
  }
  function safeVolume(info) {
    assert(
      info.Driver === 'local' &&
        (!info.Options || Object.keys(info.Options).length === 0),
      'Host-backed volume drivers require explicit operator review.',
      403,
    );
  }
  async function storage(name, item) {
    const info = await request('GET', '/volumes/' + encodeURIComponent(name));
    safeVolume(info);
    assert(
      info.Labels?.['io.lobby-goblin.fleet'] === fleet,
      'Storage belongs to another fleet.',
      403,
    );
    if (name === item.volume) {
      const owner = definition(info);
      assert(
        owner.id === item.id && owner.game === item.game,
        'Storage belongs to another instance.',
        403,
      );
    }
    return info;
  }
  async function ownedContainer(ref) {
    const info = await request(
      'GET',
      '/containers/' + encodeURIComponent(ref) + '/json',
    );
    const marker = info.Config?.Labels || {};
    if (ref === hostContainer || info.Name === '/' + hostContainer) {
      assert(
        marker['io.lobby-goblin.fleet'] === fleet &&
          marker['io.lobby-goblin.role'] === 'host-controller',
        'Host container ownership changed.',
        403,
      );
      return {info, management: true};
    }
    const item = definition(info);
    if (marker['io.lobby-goblin.worker-kind'] === softwareWorkerKind) {
      assert(
        item.module.managed.softwareWorker,
        'Unregistered software worker.',
        403,
      );
      const scope = softwareWorkerScope({
        fleet,
        instance: item.id,
        volume: item.volume,
        declaration: item.module.managed.softwareWorker,
      });
      const image = await request(
        'GET',
        '/images/' +
          encodeURIComponent(softwareWorkerDeployment.imageId) +
          '/json',
      );
      validateSoftwareWorkerContainer(info, scope, image);
      return {info, item, software: true};
    }
    assert(
      [item.container, item.controller].includes(info.Name?.slice(1)) ||
        (marker['io.lobby-goblin.worker'] === 'true' &&
          /^\/lobby-goblin-worker-[a-f0-9]{32}$/.test(info.Name)),
      'Container identity is outside the broker contract.',
      403,
    );
    assert(
      typeof info.Id === 'string' && !info.Id.includes('/'),
      'Container identity is unavailable.',
      403,
    );
    return {info, item};
  }
  return async (method, route, data, options) => {
    const url = new URL(route, 'http://docker'),
      bits = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && url.pathname === '/info') {
      query(url, []);
      const {OSType, Architecture, ServerVersion, MemTotal} = await request(
        method,
        '/info',
      );
      return {OSType, Architecture, ServerVersion, MemTotal};
    }
    if (method === 'GET' && url.pathname === '/containers/json') {
      query(url, ['all', 'filters']);
      if (!url.searchParams.has('filters'))
        return (await request(method, '/containers/json?all=1')).map(
          ({Ports}) => ({Ports}),
        );
      const filters = JSON.parse(url.searchParams.get('filters'));
      only(filters, ['label']);
      assert(
        Array.isArray(filters.label) &&
          filters.label.every((value) => typeof value === 'string'),
        'Invalid resource filters.',
        403,
      );
      filters.label.push('io.lobby-goblin.fleet=' + fleet);
      url.searchParams.set('filters', JSON.stringify(filters));
      return request(method, url.pathname + url.search, undefined, options);
    }
    if (bits[0] === 'images') {
      if (method === 'GET' && bits.length === 3 && bits[2] === 'json') {
        query(url, []);
        assert(
          imageAllowed(bits[1]),
          'Image is outside the reviewed catalogue.',
          403,
        );
        return request(method, route, data, options);
      }
      if (
        method === 'POST' &&
        url.pathname === '/images/create' &&
        data === undefined
      ) {
        query(url, ['fromImage', 'tag', 'platform']);
        const reference =
          url.searchParams.get('fromImage') +
          (url.searchParams.has('tag')
            ? (url.searchParams.get('tag').startsWith('sha256:') ? '@' : ':') +
              url.searchParams.get('tag')
            : '');
        assert(
          imageAllowed(reference) &&
            reference !== runtimeImage &&
            url.searchParams.get('platform') === 'linux/amd64',
          'Image download is outside the reviewed catalogue.',
          403,
        );
        return request(method, route, data, options);
      }
      return failure();
    }
    if (
      method === 'POST' &&
      ['/volumes/create', '/networks/create'].includes(url.pathname)
    ) {
      query(url, []);
      const item = definition(data);
      only(data.Labels, Object.keys(labels(fleet, item.id, item.game)));
      if (bits[0] === 'volumes') {
        only(data, ['Name', 'Labels']);
        assert(data.Name === item.volume, 'Invalid volume identity.', 403);
      } else {
        only(data, ['Name', 'Labels', 'Driver', 'CheckDuplicate']);
        assert(
          data.Name === item.network &&
            data.Driver === 'bridge' &&
            data.CheckDuplicate === true,
          'Invalid network identity.',
          403,
        );
      }
      // Docker volume-create can return an existing volume. Never adopt one.
      let existing;
      try {
        existing = await request(
          'GET',
          '/' + bits[0] + '/' + encodeURIComponent(data.Name),
        );
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (existing) {
        if (bits[0] === 'volumes') safeVolume(existing);
        else
          assert(
            existing.Driver === 'bridge',
            'Network driver requires manual review.',
            403,
          );
        const owner = definition(existing);
        assert(
          owner.id === item.id && owner.game === item.game,
          'Resource name is already in use.',
          409,
        );
      }
      return request(method, route, data, options);
    }
    if (['volumes', 'networks'].includes(bits[0]) && bits.length >= 2) {
      if (bits[0] === 'volumes')
        assert(
          method === 'GET' && bits.length === 2,
          'Volume removal and changes are outside the broker contract.',
          403,
        );
      const id = instanceForVolume(bits[1], fleet);
      assert(validId(id), 'Resource is outside this fleet.', 403);
      const info = await request(
          'GET',
          '/' + bits[0] + '/' + encodeURIComponent(bits[1]),
        ),
        item = definition(info);
      assert(item.id === id, 'Resource ownership changed.', 403);
      if (method === 'GET' && bits.length === 2) {
        query(url, []);
        return info;
      }
      if (bits[0] === 'networks') {
        if (method === 'DELETE' && bits.length === 2) {
          query(url, []);
          return request(method, route, data, options);
        }
        if (
          method === 'POST' &&
          bits.length === 3 &&
          ['connect', 'disconnect'].includes(bits[2])
        ) {
          query(url, []);
          only(data, ['Container', 'EndpointConfig']);
          const target = await ownedContainer(data.Container);
          assert(
            target.management || target.item.id === item.id,
            'Cross-instance network access was refused.',
            403,
          );
          if (data.EndpointConfig)
            assert(
              same(data.EndpointConfig, {Aliases: []}),
              'Unreviewed network settings.',
              403,
            );
          return request(
            method,
            '/networks/' +
              encodeURIComponent(info.Id || bits[1]) +
              '/' +
              bits[2],
            {...data, Container: target.info.Id},
            options,
          );
        }
      }
      return failure();
    }
    if (method === 'POST' && url.pathname === '/containers/create') {
      query(url, ['name', 'platform']);
      assert(
        !url.searchParams.has('platform') ||
          url.searchParams.get('platform') === 'linux/amd64',
        'Unsupported platform.',
        403,
      );
      const item = specification(data, url.searchParams.get('name'));
      for (const mount of data.HostConfig.Mounts)
        await storage(mount.Source, item);
      if (data.HostConfig.NetworkMode !== 'none') {
        const network = await request(
            'GET',
            '/networks/' + encodeURIComponent(item.network),
          ),
          owner = definition(network);
        assert(
          network.Driver === 'bridge' &&
            owner.id === item.id &&
            owner.game === item.game,
          'Network belongs to another instance or driver.',
          403,
        );
      }
      if (data.Labels['io.lobby-goblin.worker'] === 'true') {
        const filters = encodeURIComponent(
          JSON.stringify({
            label: [
              'io.lobby-goblin.fleet=' + fleet,
              'io.lobby-goblin.worker=true',
            ],
          }),
        );
        const existing = await request(
          'GET',
          '/containers/json?all=1&filters=' + filters,
        );
        assert(
          existing.filter(
            (value) =>
              value.Labels?.['io.lobby-goblin.worker-kind'] !== 'game-preview',
          ).length < 2,
          'A storage operation is already using the host worker allowance.',
          429,
        );
      }
      // Mounts are validated independently of mutable manager records.
      assert(item.id, 'Missing instance identity.', 403);
      return request(method, route, data, options);
    }
    if (bits[0] === 'containers' && bits.length >= 2) {
      const target = await ownedContainer(bits[1]);
      if (target.software) {
        assert(
          data === undefined,
          'Software worker control cannot include a body.',
          403,
        );
        const operation = bits[2];
        assert(
          (method === 'GET' && bits.length === 3 && operation === 'json') ||
            (method === 'POST' && bits.length === 3 && operation === 'stop') ||
            (method === 'DELETE' &&
              bits.length === 2 &&
              target.info.State?.Running === false &&
              !target.info.State?.Restarting),
          'The host can only inspect or tear down its software workers.',
          403,
        );
        query(url, operation === 'stop' ? ['t'] : []);
        if (operation === 'stop')
          assert(
            /^\d{1,2}$/.test(url.searchParams.get('t') || '') &&
              Number(url.searchParams.get('t')) <= 30,
            'Invalid software worker stop deadline.',
            403,
          );
        if (operation === 'json') return target.info;
        return request(
          method,
          '/containers/' +
            encodeURIComponent(target.info.Id) +
            (operation ? '/' + operation : '') +
            url.search,
          undefined,
          options,
        );
      }
      if (method === 'GET' && bits.length === 3 && bits[2] === 'json') {
        query(url, []);
        return target.info;
      }
      assert(
        !target.management,
        'The manager cannot replace host management through this broker.',
        403,
      );
      if (
        method === 'POST' &&
        bits.length === 3 &&
        ['start', 'stop', 'wait'].includes(bits[2]) &&
        data === undefined
      ) {
        query(
          url,
          bits[2] === 'stop' ? ['t'] : bits[2] === 'wait' ? ['condition'] : [],
        );
        if (bits[2] === 'stop')
          assert(
            /^\d{1,3}$/.test(url.searchParams.get('t')) &&
              Number(url.searchParams.get('t')) <= 120,
            'Invalid stop deadline.',
            403,
          );
        if (bits[2] === 'wait')
          assert(
            url.searchParams.get('condition') === 'not-running',
            'Unsupported wait condition.',
            403,
          );
        return request(
          method,
          '/containers/' +
            encodeURIComponent(target.info.Id) +
            '/' +
            bits[2] +
            url.search,
          data,
          options,
        );
      }
      if (method === 'DELETE' && bits.length === 2) {
        query(url, []);
        return request(
          method,
          '/containers/' + encodeURIComponent(target.info.Id),
          undefined,
          options,
        );
      }
    }
    return failure();
  };
}
