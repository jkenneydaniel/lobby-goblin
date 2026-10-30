import {assert} from '../common.js';
import {validId} from './instance.js';
import {
  softwareWorkerKind,
  softwareWorkerDeployment,
  softwareWorkerScope,
  validateSoftwareWorkerImage,
  validateSoftwareWorkerCreate,
  validateSoftwareWorkerContainer,
} from './software-worker-policy.js';
// Every child controller is fenced to its declared game/volume and its own workers.
// This also scopes legacy preview cleanup queries; unrelated installations are invisible.
export function ownedDocker(
  request,
  env,
  {
    container: game,
    dataTarget: target,
    previewWorker,
    softwareWorker,
    archiveReadPaths = [],
    execCommands = [],
    enforceBoundary = false,
    stopTimeout = 120,
  } = {},
) {
  const fleet = env.FLEET_ID,
    id = env.FLEET_INSTANCE,
    volume = env.FLEET_VOLUME;
  assert(
    validId(fleet) && validId(id) && volume === `lobby-goblin-${fleet}-${id}`,
    'Invalid managed installation.',
  );
  const marker = {
    'io.lobby-goblin.fleet': fleet,
    'io.lobby-goblin.instance': id,
  };
  const execIds = new Map();
  const declaredCommand = (cmd) => Array.isArray(cmd) && execCommands.some(command =>
    cmd[0] === command.executable && cmd.length === command.arguments + 1 &&
    cmd.slice(1).every(value => typeof value === 'string' && Buffer.byteLength(value) <= command.maxArgumentBytes));
  const softwareStarts = new Set();
  const softwareScope = softwareWorker
    ? softwareWorkerScope({
        fleet,
        instance: id,
        volume,
        declaration: softwareWorker,
      })
    : null;
  const workerList = () =>
    request(
      'GET',
      '/containers/json?all=1&filters=' +
        encodeURIComponent(
          JSON.stringify({
            label: [
              ...Object.entries(marker).map(
                ([key, value]) => key + '=' + value,
              ),
              'io.lobby-goblin.worker=true',
            ],
          }),
        ),
    );
  async function softwareImage() {
    return validateSoftwareWorkerImage(
      await request(
        'GET',
        '/images/' +
          encodeURIComponent(softwareWorkerDeployment.imageId) +
          '/json',
      ),
    );
  }
  async function stoppedForPreparation(owner) {
    assert(
      owner.State?.Running === false && owner.State?.Restarting !== true,
      'Stop the application before preparing software.',
      409,
    );
    assert(
      owner.HostConfig?.Memory >= 2 * 1024 ** 3,
      'This application allocation cannot support the software worker.',
      409,
    );
  }
  function softwareMount(mounts) {
    if (mounts.length === 1) return true;
    const extra = mounts[1],
      first = mounts[0];
    return (
      mounts.length === 2 &&
      previewWorker?.softwareTarget &&
      Object.keys(extra).every((key) =>
        ['Type', 'Source', 'Target', 'ReadOnly', 'VolumeOptions'].includes(key),
      ) &&
      Object.keys(extra.VolumeOptions || {}).every((key) =>
        ['Subpath', 'NoCopy'].includes(key),
      ) &&
      extra.Type === 'volume' &&
      extra.Source === volume &&
      extra.Target === previewWorker.softwareTarget &&
      extra.ReadOnly === true &&
      extra.VolumeOptions?.NoCopy === true &&
      extra.VolumeOptions?.Subpath === first.VolumeOptions?.Subpath + '/engine'
    );
  }
  async function owned(ref, {legacyCleanup = false} = {}) {
    const info = await request(
      'GET',
      `/containers/${encodeURIComponent(ref)}/json`,
    );
    assert(
      Object.entries(marker).every(([k, v]) => info.Config?.Labels?.[k] === v),
      'Container belongs to a different installation.',
      409,
    );
    if (ref === game || info.Name === '/' + game) {
      assert(
        info.Mounts?.some(
          (m) =>
            m.Type === 'volume' &&
            m.Name === volume &&
            m.Destination === target,
        ) &&
          info.HostConfig?.Mounts?.some(
            (m) =>
              m.Type === 'volume' &&
              m.Source === volume &&
              m.Target === target &&
              m.VolumeOptions?.Subpath === 'data',
          ),
        'Managed game storage does not match.',
        409,
      );
      if (enforceBoundary) {
        const host = info.HostConfig || {};
        assert(
          info.Mounts?.length === 1 &&
            host.Mounts?.length === 1 &&
            !host.Privileged &&
            !host.Binds?.length &&
            !host.Devices?.length &&
            host.PidMode !== 'host' &&
            host.IpcMode !== 'host' &&
            host.NetworkMode === volume &&
            !host.CapAdd?.some((value) =>
              ['SYS_ADMIN', 'NET_ADMIN', 'ALL'].includes(value),
            ),
          'Unreviewed game privileges or mounts were refused.',
          403,
        );
        const stored = await request(
          'GET',
          '/volumes/' + encodeURIComponent(volume),
        );
        assert(
          stored.Driver === 'local' &&
            (!stored.Options || Object.keys(stored.Options).length === 0) &&
            Object.entries(marker).every(
              ([key, value]) => stored.Labels?.[key] === value,
            ),
          'Game storage driver or ownership changed.',
          403,
        );
      }
    } else {
      assert(
        info.Config?.Labels?.['io.lobby-goblin.worker'] === 'true',
        'Not an owned worker.',
        409,
      );
      if (
        softwareScope &&
        info.Config.Labels['io.lobby-goblin.worker-kind'] === softwareWorkerKind
      ) {
        validateSoftwareWorkerContainer(
          info,
          softwareScope,
          await softwareImage(),
        );
        return info;
      }
      if (enforceBoundary) {
        const owner = await owned(game);
        const mounts = info.HostConfig?.Mounts || [],
          mount = mounts[0],
          subpath = mount?.VolumeOptions?.Subpath || '';
        const roots = [
          previewWorker?.root,
          ...(legacyCleanup && previewWorker?.root?.startsWith('state/')
            ? [previewWorker.root.replace(/^state\//, 'data/')]
            : []),
        ].filter(Boolean);
        const legacyRoot =
          legacyCleanup &&
          previewWorker?.root?.startsWith('state/') &&
          subpath.startsWith(
            previewWorker.root.replace(/^state\//, 'data/') + '/',
          );
        assert(
          previewWorker &&
            (info.Config?.Labels?.['io.lobby-goblin.worker-kind'] ===
              'game-preview' ||
              (legacyRoot &&
                info.Config?.Labels?.['io.lobby-goblin.worker-kind'] ===
                  undefined)) &&
            [owner.Image, owner.Config.Image].includes(info.Image) &&
            softwareMount(mounts) &&
            mount.Type === 'volume' &&
            mount.Source === volume &&
            mount.Target === previewWorker.target &&
            roots.some(
              (root) =>
                subpath.startsWith(root + '/') &&
                /^[A-Za-z0-9_.-]+$/.test(subpath.slice(root.length + 1)) &&
                !['.', '..'].includes(subpath.slice(root.length + 1)),
            ),
          'This is not an owned game-preview worker.',
          403,
        );
      }
    }
    return info;
  }
  const dispatch = async (method, route, data, options) => {
    assert(
      ['GET', 'POST', 'DELETE'].includes(method) &&
        typeof route === 'string' &&
        route.startsWith('/') &&
        !route.startsWith('//') &&
        !/[\r\n\\]/.test(route),
      'Unsupported managed Docker request.',
      409,
    );
    const url = new URL(route, 'http://docker');
    if (enforceBoundary) {
      assert(
        (method === 'POST' || data === undefined) &&
          new Set(url.searchParams.keys()).size ===
            [...url.searchParams.keys()].length,
        'Invalid Docker request body or query.',
        403,
      );
    }
    const bits = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (softwareScope)
      assert(
        new Set(url.searchParams.keys()).size ===
          [...url.searchParams.keys()].length,
        'Duplicate software worker query options.',
        403,
      );
    if (
      softwareScope &&
      method === 'POST' &&
      url.pathname === '/images/create'
    ) {
      const from = url.searchParams.get('fromImage'),
        tag = url.searchParams.get('tag'),
        reference = from + (tag ? '@' + tag : '');
      assert(
        data === undefined &&
          reference === softwareWorkerDeployment.image &&
          url.searchParams.get('platform') ===
            softwareWorkerDeployment.platform &&
          [...url.searchParams.keys()].every((key) =>
            ['fromImage', 'tag', 'platform'].includes(key),
          ),
        'Software image download is outside its published contract.',
        403,
      );
      return request(method, route, undefined, options);
    }
    if (
      softwareScope &&
      method === 'GET' &&
      bits[0] === 'images' &&
      bits.at(-1) === 'json' &&
      [
        softwareWorkerDeployment.image,
        softwareWorkerDeployment.imageId,
      ].includes(bits.slice(1, -1).join('/'))
    ) {
      assert(!url.searchParams.size, 'Unreviewed software image query.', 403);
      const image = await request(method, route, undefined, options);
      return validateSoftwareWorkerImage(image);
    }
    if (url.pathname === '/containers/json') {
      assert(method === 'GET', 'Unsupported managed container operation.', 409);
      if (enforceBoundary)
        assert(
          [...url.searchParams.keys()].every((key) =>
            ['all', 'filters'].includes(key),
          ),
          'Unsupported container list query.',
          403,
        );
      const filters = JSON.parse(url.searchParams.get('filters') || '{}');
      filters.label = [
        ...(filters.label || []),
        ...Object.entries(marker).map(([k, v]) => k + '=' + v),
      ];
      url.searchParams.set('filters', JSON.stringify(filters));
      return request(method, url.pathname + url.search, data, options);
    }
    if (url.pathname === '/containers/create') {
      const owner = await owned(game);
      if (
        softwareScope &&
        data?.Labels?.['io.lobby-goblin.worker-kind'] === softwareWorkerKind
      ) {
        assert(
          method === 'POST' &&
            url.searchParams.get('platform') ===
              softwareWorkerDeployment.platform &&
            [...url.searchParams.keys()].every((key) =>
              ['name', 'platform'].includes(key),
            ),
          'Unreviewed software worker query.',
          403,
        );
        const {action} = validateSoftwareWorkerCreate(
          data,
          url.searchParams.get('name'),
          softwareScope,
        );
        await softwareImage();
        assert(
          owner.HostConfig?.NetworkMode === softwareScope.network,
          'Software preparation requires its owned application network.',
          409,
        );
        const network = await request(
          'GET',
          '/networks/' + encodeURIComponent(softwareScope.network),
        );
        assert(
          network.Driver === 'bridge' &&
            Object.entries({
              ...marker,
              'io.lobby-goblin.game':
                softwareScope.declaration.source.application,
            }).every(([key, value]) => network.Labels?.[key] === value),
          'Software worker network is outside its installation.',
          403,
        );
        if (action === 'prepare') await stoppedForPreparation(owner);
        assert(
          (await workerList()).length === 0,
          'Finish the existing game worker before preparing software.',
          429,
        );
        return request(method, route, data, options);
      }
      if (softwareScope)
        assert(
          !(await workerList()).some(
            (worker) =>
              worker.Labels?.['io.lobby-goblin.worker-kind'] ===
              softwareWorkerKind,
          ),
          'Wait for software preparation before creating a game worker.',
          409,
        );
      assert(
        method === 'POST' &&
          data &&
          [owner.Image, owner.Config.Image].includes(data.Image),
        'Worker image must match its game.',
        409,
      );
      const host = data.HostConfig || {};
      assert(
        !data.NetworkingConfig &&
          !data.Volumes &&
          Object.keys(host).every((key) =>
            [
              'NetworkMode',
              'Memory',
              'NanoCpus',
              'CpuShares',
              'Mounts',
              'CapDrop',
              'SecurityOpt',
            ].includes(key),
          ),
        'Worker configuration includes unreviewed host access.',
        409,
      );
      assert(
        host.NetworkMode === 'none' &&
          !host.Privileged &&
          !host.Binds &&
          !host.VolumesFrom &&
          !host.Devices &&
          !host.CapAdd &&
          Array.isArray(host.Mounts) &&
          softwareMount(host.Mounts),
        'Workers require isolated storage and networking.',
        409,
      );
      const mount = host.Mounts[0],
        subpath = mount.VolumeOptions?.Subpath || '',
        relative =
          previewWorker && subpath.startsWith(previewWorker.root + '/')
            ? subpath.slice(previewWorker.root.length + 1)
            : '';
      assert(
        previewWorker &&
          Object.keys(mount).every((key) =>
            ['Type', 'Source', 'Target', 'VolumeOptions', 'ReadOnly'].includes(
              key,
            ),
          ) &&
          Object.keys(mount.VolumeOptions || {}).every((key) =>
            ['Subpath', 'NoCopy'].includes(key),
          ) &&
          (mount.VolumeOptions?.NoCopy === undefined ||
            typeof mount.VolumeOptions.NoCopy === 'boolean') &&
          mount.Type === 'volume' &&
          mount.Source === volume &&
          mount.Target === previewWorker.target &&
          /^[A-Za-z0-9_.-]+$/.test(relative) &&
          relative !== '.' &&
          relative !== '..',
        'Worker mount is outside its installation.',
        409,
      );
      assert(
        Number.isSafeInteger(host.Memory) &&
          host.Memory > 0 &&
          host.Memory <= 2 * 1024 ** 3 &&
          (host.NanoCpus === undefined ||
            (Number.isSafeInteger(host.NanoCpus) && host.NanoCpus > 0)),
        'Worker memory limit is required.',
      );
      if (enforceBoundary) {
        assert(
          host.Memory <= 1024 ** 3 &&
            (!data.Entrypoint ||
              [previewWorker.entrypoint,...(previewWorker.entrypoints||[])].some(entry=>JSON.stringify(data.Entrypoint)===JSON.stringify(entry))) &&
            (!data.Cmd ||
              (Array.isArray(data.Cmd) &&
                data.Cmd.length <= 32 &&
                data.Cmd.every(
                  (value) => typeof value === 'string' && value.length <= 4096,
                ))),
          'Unreviewed game-preview command or memory limit.',
          403,
        );
        assert(
          Object.keys(data).every((key) =>
            [
              'Image',
              'Entrypoint',
              'Cmd',
              'Env',
              'Labels',
              'HostConfig',
            ].includes(key),
          ),
          'Unreviewed worker configuration.',
          403,
        );
        assert(
          [...url.searchParams.keys()].every((key) =>
            ['name', 'platform'].includes(key),
          ) &&
            previewWorker.namePrefixes?.some((prefix) => {
              const name = url.searchParams.get('name') || '';
              return (
                name.startsWith(prefix) &&
                /^[a-f0-9-]{36}$/.test(name.slice(prefix.length))
              );
            }) &&
            (!url.searchParams.has('platform') ||
              url.searchParams.get('platform') === 'linux/amd64'),
          'Invalid game-preview worker identity.',
          403,
        );
        const filters = encodeURIComponent(
          JSON.stringify({
            label: [
              ...Object.entries(marker).map(
                ([key, value]) => key + '=' + value,
              ),
              'io.lobby-goblin.worker=true',
            ],
          }),
        );
        const workers = await request(
          'GET',
          '/containers/json?all=1&filters=' + filters,
        );
        assert(
          Array.isArray(workers) && workers.length < 2,
          'This server already has the maximum number of game workers.',
          429,
        );
      }
      data = {
        ...data,
        Labels: {
          ...data.Labels,
          ...marker,
          'io.lobby-goblin.worker': 'true',
          'io.lobby-goblin.worker-kind': 'game-preview',
        },
        HostConfig: {
          ...host,
          NanoCpus: Math.min(Number(host.NanoCpus) || 1000000000, 1000000000),
          PidsLimit: 256,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
          SecurityOpt: ['no-new-privileges:true'],
        },
      };
      return request(method, route, data, options);
    }
    if (bits[0] === 'containers' && bits.length >= 2) {
      // Old game-writable scratch mounts are admitted only for inspection and
      // teardown during an upgrade, never start/restart/exec or new creation.
      const info = await owned(bits[1], {
        legacyCleanup:
          (method === 'GET' && bits[2] === 'json') ||
          (method === 'DELETE' && bits.length === 2) ||
          (method === 'POST' && bits[2] === 'stop'),
      });
      const software =
        softwareScope &&
        info.Config?.Labels?.['io.lobby-goblin.worker-kind'] ===
          softwareWorkerKind;
      if (software) {
        assert(
          data === undefined,
          'Software worker control cannot include a request body.',
          403,
        );
        const operation = bits[2];
        assert(
          (method === 'DELETE' &&
            bits.length === 2 &&
            !url.searchParams.size &&
            info.State?.Running === false &&
            !info.State?.Restarting) ||
            (bits.length === 3 &&
              {
                json: 'GET',
                logs: 'GET',
                start: 'POST',
                stop: 'POST',
                wait: 'POST',
              }[operation] === method),
          'Software workers cannot replay, execute commands or access archives.',
          403,
        );
        const queries = {
          json: [],
          logs: ['stdout', 'stderr', 'tail'],
          start: [],
          stop: ['t'],
          wait: ['condition'],
        };
        assert(
          [...url.searchParams.keys()].every((key) =>
            (queries[operation] || []).includes(key),
          ),
          'Unreviewed software worker query.',
          403,
        );
        if (operation === 'start') {
          assert(
            info.State?.Status === 'created' && !softwareStarts.has(info.Id),
            'Software worker execution cannot be replayed.',
            409,
          );
          if (info.Config.Labels['io.lobby-goblin.worker-action'] === 'prepare')
            await stoppedForPreparation(await owned(game));
          softwareStarts.add(info.Id);
        }
        if (operation === 'stop')
          assert(
            /^\d{1,2}$/.test(url.searchParams.get('t') || '') &&
              Number(url.searchParams.get('t')) <= 30,
            'Invalid software worker stop timeout.',
            403,
          );
        if (operation === 'wait')
          assert(
            url.searchParams.get('condition') === 'not-running',
            'Invalid software worker wait.',
            403,
          );
        if (operation === 'logs')
          assert(
            /^[1-9]\d{0,2}$/.test(url.searchParams.get('tail') || '') &&
              Number(url.searchParams.get('tail')) <= 300 &&
              ['stdout', 'stderr'].every(
                (key) =>
                  !url.searchParams.has(key) ||
                  ['0', '1'].includes(url.searchParams.get(key)),
              ),
            'Software worker logs require a bounded tail.',
            403,
          );
        const result = await request(
          method,
          '/containers/' +
            encodeURIComponent(info.Id) +
            (operation ? '/' + operation : '') +
            url.search,
          data,
          options,
        );
        if (method === 'DELETE') softwareStarts.delete(info.Id);
        return result;
      }
      if (
        softwareScope &&
        info.Name === '/' + game &&
        method === 'POST' &&
        ['start', 'restart'].includes(bits[2])
      )
        assert(
          !(await workerList()).some(
            (worker) =>
              worker.Labels?.['io.lobby-goblin.worker-kind'] ===
                softwareWorkerKind &&
              worker.Labels?.['io.lobby-goblin.worker-action'] === 'prepare',
          ),
          'Finish software preparation before starting the application.',
          409,
        );
      assert(
        (bits.length === 3 &&
          {
            json: 'GET',
            archive: 'GET',
            logs: 'GET',
            stats: 'GET',
            start: 'POST',
            stop: 'POST',
            restart: 'POST',
            wait: 'POST',
            exec: 'POST',
          }[bits[2]] === method) ||
          (method === 'DELETE' &&
            bits.length === 2 &&
            info.Config?.Labels?.['io.lobby-goblin.worker'] === 'true'),
        'Unsupported managed container operation.',
        409,
      );
      if (bits[2] === 'archive')
        assert(
          method === 'GET' &&
            url.searchParams.size === 1 &&
            archiveReadPaths.includes(url.searchParams.get('path')),
          'Only the installed game settings example can be read through Docker.',
          403,
        );
      if (enforceBoundary) {
        const queries = {
          json: [],
          logs: ['stdout', 'stderr', 'tail', 'since', 'timestamps'],
          stats: ['stream', 'one-shot'],
          start: [],
          stop: ['t'],
          restart: ['t'],
          wait: ['condition'],
          exec: [],
          archive: ['path'],
        };
        assert(
          [...url.searchParams.keys()].every((key) =>
            (queries[bits[2]] || []).includes(key),
          ),
          'Unsupported managed Docker query.',
          403,
        );
        if (['stop', 'restart'].includes(bits[2]) && url.searchParams.has('t'))
          assert(
            (url.searchParams.get('t') === '-1' &&
              stopTimeout === -1 &&
              info.Name === '/' + game) ||
              (/^\d{1,3}$/.test(url.searchParams.get('t')) &&
                Number(url.searchParams.get('t')) <= 120),
            'Invalid shutdown timeout.',
            403,
          );
        if (bits[2] === 'exec') {
          for (const [key, record] of execIds)
            if (Date.now() - record.at > 300000) execIds.delete(key);
          assert(execIds.size < 128, 'Too many pending game commands.', 429);
        }
        if (bits[2] === 'exec')
          assert(
            data &&
              Object.keys(data).every((key) =>
                ['Cmd', 'AttachStdout', 'AttachStderr'].includes(key),
              ) &&
              declaredCommand(data.Cmd),
            'Only a declared game command helper may be executed.',
            403,
          );
      }
      if (bits[2] === 'exec')
        assert(
          (info.Name === '/' + game ||
            bits[1] === game ||
            (info.Config?.Labels?.['io.lobby-goblin.worker-kind'] ===
                'game-preview' && declaredCommand(data?.Cmd))) &&
            data &&
            Array.isArray(data.Cmd) &&
            data.Cmd.every((value) => typeof value === 'string') &&
            !data.Privileged &&
            !data.AttachStdin &&
            !data.User &&
            !data.Env &&
            !data.WorkingDir,
          'Exec is limited to non-privileged commands in this game.',
          409,
        );
      assert(
        typeof info.Id === 'string' && !info.Id.includes('/'),
        'Container inspection did not return an immutable identity.',
        409,
      );
      const suffix = bits.length === 3 ? '/' + bits[2] : '';
      const result = await request(
        method,
        '/containers/' + encodeURIComponent(info.Id) + suffix + url.search,
        data,
        options,
      );
      if (enforceBoundary && bits[2] === 'exec') {
        assert(
          typeof result?.Id === 'string',
          'The game command has no identity.',
          502,
        );
        execIds.set(result.Id, {at: Date.now(), started: false});
      }
      return result;
    }
    if (bits[0] === 'exec' && bits.length === 3) {
      if (enforceBoundary)
        assert(
          execIds.has(bits[1]) &&
            Date.now() - execIds.get(bits[1]).at <= 300000 &&
            !url.searchParams.size &&
            (!data ||
              Object.keys(data).every((key) =>
                ['Detach', 'Tty'].includes(key),
              )),
          'This command was not issued by this broker capability.',
          403,
        );
      const info = await request(
        'GET',
        `/exec/${encodeURIComponent(bits[1])}/json`,
      );
      await owned(info.ContainerID);
      assert(
        (bits[2] === 'json' && method === 'GET') ||
          (bits[2] === 'start' &&
            method === 'POST' &&
            data?.Detach === false &&
            data?.Tty === false),
        'Unsupported exec operation.',
      );
      if (enforceBoundary && bits[2] === 'start') {
        const record = execIds.get(bits[1]);
        assert(
          !record.started,
          'This game command was already started. Check its outcome.',
          409,
        );
        record.started = true;
      }
      const result = await request(method, route, data, options);
      if (
        enforceBoundary &&
        bits[2] === 'json' &&
        result?.Running !== true &&
        result?.ExitCode !== null &&
        result?.ExitCode !== undefined
      )
        execIds.delete(bits[1]);
      return result;
    }
    if (
      bits[0] === 'images' &&
      method === 'GET' &&
      url.pathname.endsWith('/json')
    ) {
      const owner = await owned(game);
      assert(
        [owner.Image, owner.Config.Image].includes(bits.slice(1, -1).join('/')),
        'Image inspection is limited to this game.',
        409,
      );
      return request(method, route, data, options);
    }
    assert(
      false,
      'This controller cannot operate other Docker resources.',
      409,
    );
  };
  let mutations = Promise.resolve();
  return (method, route, ...args) => {
    if (
      softwareScope &&
      ((method === 'POST' &&
        (/^\/containers\/create(?:\?|$)/.test(route) ||
          /\/(start|restart)(?:\?|$)/.test(route))) ||
        method === 'DELETE')
    ) {
      const next = mutations.then(() => dispatch(method, route, ...args));
      mutations = next.catch(() => {});
      return next;
    }
    return dispatch(method, route, ...args);
  };
}
