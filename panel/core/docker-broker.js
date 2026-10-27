import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  assert,
  json,
  requestJSON,
  readJSON,
  writeJSON,
  equalSecret,
} from '../common.js';
import {docker as dockerAPI} from './docker.js';
import {ownedDocker} from './owned-docker.js';
import {hostDockerPolicy} from './broker-policy.js';
import {registeredApplications} from '../applications/index.js';
import {resources, validId} from './instance.js';
import {AuditLog} from './audit.js';
import {softwareWorkerDeployment} from './software-worker-policy.js';
import {
  preparationWorker,
  applicationContainer,
  softwareReservedMemory,
  assertPreparationAdmission,
  assertApplicationStart,
} from './software-worker-resources.js';
export {BROKER_PROTOCOL} from './broker-client.js';

const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const safeDirectory = async (directory) => {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  assert(
    (await fs.lstat(directory)).isDirectory() &&
      (await fs.realpath(directory)) === path.resolve(directory),
    'Broker storage must be a real, private directory.',
  );
};
async function privateToken(file) {
  try {
    await fs.writeFile(file, secret(), {flag: 'wx', mode: 0o400});
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  assert(
    (await fs.lstat(file)).isFile() && !(await fs.lstat(file)).isSymbolicLink(),
    'Invalid broker credential file.',
  );
  const value = (await fs.readFile(file, 'utf8')).trim();
  assert(/^[A-Za-z0-9_-]{43}$/.test(value), 'Invalid broker credential.');
  return value;
}
async function staleSocket(socketPath) {
  const stat = await fs.lstat(socketPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!stat) return;
  assert(
    stat.isSocket(),
    'The broker socket path is occupied. Preserve it for review.',
  );
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(Error('A Docker broker is already listening.'));
    });
    probe.once('error', (error) =>
      error.code === 'ECONNREFUSED' ? resolve() : reject(error),
    );
    probe.setTimeout(2000, () =>
      probe.destroy(Error('Cannot verify the existing broker socket.')),
    );
  });
  const current = await fs.lstat(socketPath);
  assert(
    current.ino === stat.ino && current.isSocket(),
    'The broker socket changed.',
  );
  await fs.unlink(socketPath);
}

// This is the only socket-owning service in a new managed installation. It has
// no TCP listener and never reads policy or capability records from game storage.
export async function startDockerBroker({
  env = process.env,
  docker = dockerAPI,
  root = env.BROKER_STATE || '/broker-state',
  transport = env.BROKER_TRANSPORT || '/broker-transport',
  modules = registeredApplications(),
  runtimeImage,
} = {}) {
  const fleet = env.FLEET_ID,
    project = 'lobby-goblin-fleet-' + fleet,
    hostContainer = 'lobby-goblin-host-' + fleet;
  assert(validId(fleet), 'Configure a valid broker fleet identity.');
  assert(
    path.resolve(root) !== path.resolve(transport) &&
      !path.resolve(root).startsWith(path.resolve(transport) + '/') &&
      !path.resolve(transport).startsWith(path.resolve(root) + '/'),
    'Broker state and transport require separate private roots.',
  );
  async function claim(directory, kind) {
    await safeDirectory(directory);
    const marker = path.join(directory, '.docker-broker-owner.json'),
      owner = await readJSON(marker, null);
    if (!owner) {
      assert(
        (await fs.readdir(directory)).length === 0,
        'Choose fresh broker storage; an existing directory was preserved.',
        409,
      );
      await writeJSON(marker, {version: 1, fleet, kind});
    } else
      assert(
        owner.version === 1 && owner.fleet === fleet && owner.kind === kind,
        'Broker storage belongs to another installation.',
        409,
      );
    await fs.chmod(directory, 0o700);
  }
  await claim(root, 'state');
  await claim(transport, 'transport');
  for (const directory of [
    path.join(transport, 'socket'),
    path.join(transport, 'host'),
    path.join(transport, 'instances'),
  ])
    await safeDirectory(directory);
  // Read-only subdirectory mounts hide host credentials and every other instance.
  await fs.chmod(path.join(transport, 'socket'), 0o755);
  const hostToken = await privateToken(path.join(transport, 'host/token')),
    file = path.join(root, 'capabilities.json');
  let state = await readJSON(file, null);
  if (!state) {
    state = {version: 1, fleet, host: digest(hostToken), instances: {}};
    await writeJSON(file, state);
  }
  assert(
    state.version === 1 &&
      state.fleet === fleet &&
      equalSecret(state.host, digest(hostToken)) &&
      state.instances &&
      typeof state.instances === 'object' &&
      !Array.isArray(state.instances),
    'Broker identity changed. Preserve its state for review.',
  );
  for (const [id, value] of Object.entries(state.instances))
    assert(
      validId(id) &&
        modules.some((module) => module.id === value.game) &&
        /^[a-f0-9]{64}$/.test(value.token) &&
        typeof value.revoked === 'boolean',
      'Invalid broker capability state.',
    );
  if (!runtimeImage) {
    const own = await docker(
      'GET',
      '/containers/' +
        encodeURIComponent('lobby-goblin-docker-broker-' + fleet) +
        '/json',
    );
    assert(
      own.Config?.Labels?.['io.lobby-goblin.fleet'] === fleet &&
        own.Config.Labels['io.lobby-goblin.role'] === 'docker-broker',
      'Docker broker container identity changed.',
    );
    runtimeImage = own.Image;
  }
  const engine = docker;
  async function instanceContainers() {
    const filters = encodeURIComponent(
      JSON.stringify({label: ['io.lobby-goblin.fleet=' + fleet]}),
    );
    const existing = (
      await engine('GET', '/containers/json?all=1&filters=' + filters)
    ).filter((value) => value.Labels?.['io.lobby-goblin.instance']);
    return Promise.all(
      existing.map((value) =>
        engine('GET', '/containers/' + encodeURIComponent(value.Id) + '/json'),
      ),
    );
  }
  async function admittedRequest(method, route, data, options) {
    const url = new URL(route, 'http://docker'),
      bits = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'POST' && url.pathname === '/containers/create') {
      const specs = await instanceContainers(),
        capacity = await engine('GET', '/info');
      assert(specs.length < 256, 'Broker container limit reached.', 429);
      const candidate = {
        Name: '/' + url.searchParams.get('name'),
        Image:
          data.Image === softwareWorkerDeployment.image
            ? softwareWorkerDeployment.imageId
            : data.Image,
        Config: {Image: data.Image, Labels: data.Labels},
        HostConfig: data.HostConfig,
        State: {Running: false, Restarting: false, Status: 'created'},
      };
      assertPreparationAdmission(specs, candidate, fleet);
      const memory = softwareReservedMemory([...specs, candidate], fleet);
      assert(
        Number.isFinite(capacity.MemTotal) &&
          memory <= capacity.MemTotal - 2 * 1024 ** 3,
        'The broker reserves host memory headroom before provisioning.',
        409,
      );
    }
    if (
      method === 'POST' &&
      bits[0] === 'containers' &&
      bits.length === 3 &&
      ['start', 'restart'].includes(bits[2])
    ) {
      const target = await engine(
        'GET',
        '/containers/' + encodeURIComponent(bits[1]) + '/json',
      );
      if (applicationContainer(target, fleet))
        assertApplicationStart(await instanceContainers(), target, fleet);
      if (preparationWorker(target, fleet)) {
        assert(
          bits[2] === 'start' && target.State?.Status === 'created',
          'Software preparation cannot be replayed.',
          409,
        );
        const specs = await instanceContainers();
        assertPreparationAdmission(
          specs.filter((info) => info.Id !== target.Id),
          target,
          fleet,
        );
      }
    }
    return engine(method, route, data, options);
  }
  let resourceChanges = Promise.resolve();
  docker = (method, route, data, options) => {
    const pathname = new URL(route, 'http://docker').pathname;
    if (
      (method === 'POST' &&
        (pathname === '/containers/create' ||
          /^\/containers\/[^/]+\/(start|restart)$/.test(pathname))) ||
      (method === 'DELETE' && /^\/containers\/[^/]+$/.test(pathname))
    ) {
      const next = resourceChanges.then(() =>
        admittedRequest(method, route, data, options),
      );
      resourceChanges = next.catch(() => {});
      return next;
    }
    return admittedRequest(method, route, data, options);
  };
  const audit = new AuditLog(root),
    host = hostDockerPolicy(docker, {
      fleet,
      hostContainer,
      runtimeImage,
      transportVolume: project + '-broker-transport',
      modules,
    }),
    policies = new Map(),
    inflight = new Map(),
    rates = new Map(),
    creationQueues = new Map();
  let changes = Promise.resolve();
  const change = (fn) => {
    const next = changes.then(fn);
    changes = next.catch(() => {});
    return next;
  };
  function authenticate(req) {
    const authorization = req.headers.authorization;
    assert(
      typeof authorization === 'string' &&
        /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization),
      'Docker broker authentication is required.',
      401,
    );
    const hash = digest(authorization.slice(7));
    if (equalSecret(hash, state.host)) return {role: 'host', key: 'host'};
    const entry = Object.entries(state.instances).find(
      ([, record]) => !record.revoked && equalSecret(hash, record.token),
    );
    assert(entry, 'Docker broker access was revoked or is invalid.', 401);
    return {role: 'instance', key: entry[0], record: entry[1]};
  }
  function instancePolicy(principal) {
    if (!policies.has(principal.key)) {
      const module = modules.find(
          (value) => value.id === principal.record.game,
        ),
        owned = resources(fleet, principal.key, module.id);
      const scoped = ownedDocker(
        docker,
        {
          FLEET_ID: fleet,
          FLEET_INSTANCE: principal.key,
          FLEET_VOLUME: owned.volume,
        },
        {
          container: owned.container,
          ...module.managed,
          enforceBoundary: true,
          stopTimeout: module.stopTimeout ?? 120,
        },
      );
      policies.set(principal.key, async (method, route, data, options) => {
        if (method === 'GET' && route === '/info' && data === undefined) {
          const {OSType, Architecture, ServerVersion} = await docker(
            'GET',
            '/info',
          );
          return {OSType, Architecture, ServerVersion};
        }
        return scoped(method, route, data, options);
      });
    }
    return policies.get(principal.key);
  }
  async function grant(input) {
    assert(
      input &&
        validId(input.id) &&
        modules.some((module) => module.id === input.game) &&
        Object.keys(input).every((key) => ['id', 'game'].includes(key)),
      'Choose a supported instance capability.',
    );
    const old = state.instances[input.id];
    assert(
      !old || (old.game === input.game && !old.revoked),
      'This capability requires explicit operator review; it cannot be silently reissued.',
      409,
    );
    assert(
      old || Object.keys(state.instances).length < 1024,
      'Broker instance limit reached.',
      409,
    );
    const directory = path.join(transport, 'instances', input.id);
    await safeDirectory(directory);
    const token = await privateToken(path.join(directory, 'token'));
    assert(
      !old || equalSecret(old.token, digest(token)),
      'Instance broker credential changed.',
    );
    const next = {
      ...state,
      instances: {
        ...state.instances,
        [input.id]: {game: input.game, token: digest(token), revoked: false},
      },
    };
    await writeJSON(file, next);
    state = next;
    return {id: input.id, game: input.game};
  }
  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/health')
      return json(res, 200, {ok: true, protocol: 1});
    const principal = authenticate(req); // Authenticate before reading any body.
    assert(
      req.method === 'POST' &&
        ['/v1/docker', '/v1/grants', '/v1/revoke'].includes(req.url),
      'Docker broker route not found.',
      404,
    );
    const now = Date.now();
    let rate = rates.get(principal.key);
    if (!rate || rate.expires <= now) {
      rate = {count: 0, expires: now + 60000};
      rates.set(principal.key, rate);
    }
    assert(
      ++rate.count <= 600,
      'Docker broker request limit reached. Check current operations before retrying.',
      429,
    );
    const count = inflight.get(principal.key) || 0;
    assert(
      count < 4 && [...inflight.values()].reduce((a, b) => a + b, 0) < 32,
      'Docker broker is busy. Retry after checking current status.',
      429,
    );
    inflight.set(principal.key, count + 1);
    try {
      const input = await requestJSON(req),
        event = {
          requestId: crypto.randomUUID(),
          actor:
            principal.role === 'host'
              ? 'host-manager'
              : 'instance:' + principal.key,
          scope:
            principal.role === 'host'
              ? 'host:' + fleet
              : '/servers/' + principal.key,
          action: 'broker.' + req.url.slice(4),
        };
      let result, error;
      const mutating = req.url !== '/v1/docker' || input?.method !== 'GET';
      if (mutating) await audit.append({...event, outcome: 'started'});
      try {
        if (req.url !== '/v1/docker') {
          assert(
            principal.role === 'host',
            'Only host management can issue capabilities.',
            403,
          );
          result = await change(async () => {
            if (req.url === '/v1/grants') return grant(input);
            assert(
              input &&
                validId(input.id) &&
                Object.keys(input).length === 1 &&
                state.instances[input.id],
              'Choose a known capability.',
            );
            const next = {
              ...state,
              instances: {
                ...state.instances,
                [input.id]: {...state.instances[input.id], revoked: true},
              },
            };
            await writeJSON(file, next);
            state = next;
            policies.delete(input.id);
            return {revoked: true};
          });
        } else {
          assert(
            input &&
              Object.keys(input).every((key) =>
                ['method', 'route', 'data', 'raw', 'timeout'].includes(key),
              ) &&
              ['GET', 'POST', 'DELETE'].includes(input.method) &&
              (input.method === 'POST' || input.data === undefined) &&
              typeof input.route === 'string' &&
              input.route.startsWith('/') &&
              !input.route.startsWith('//') &&
              !/[\x00-\x20\\#]/.test(input.route) &&
              typeof input.raw === 'boolean' &&
              Number.isSafeInteger(input.timeout) &&
              input.timeout >= 100 &&
              input.timeout <= 1200000,
            'Invalid Docker broker request.',
          );
          const decoded = decodeURIComponent(input.route.split('?')[0]);
          assert(
            !decoded.includes('..') &&
              !decoded.includes('%') &&
              !decoded.includes('\\') &&
              !decoded.includes('\0'),
            'Invalid Docker path.',
          );
          const policy =
              principal.role === 'host' ? host : instancePolicy(principal),
            operation = () => {
              assert(
                principal.role === 'host' ||
                  !state.instances[principal.key].revoked,
                'Docker broker access was revoked.',
                401,
              );
              return policy(input.method, input.route, input.data, {
                raw: input.raw,
                timeout: input.timeout,
              });
            };
          if (
            input.method === 'POST' &&
            input.route.startsWith('/containers/create')
          ) {
            const previous =
                creationQueues.get('containers') || Promise.resolve(),
              next = previous.then(operation);
            const queued = next.catch(() => {});
            creationQueues.set('containers', queued);
            try {
              result = await next;
            } finally {
              if (creationQueues.get('containers') === queued)
                creationQueues.delete('containers');
            }
          } else result = await operation();
        }
      } catch (failure) {
        error = failure;
      }
      try {
        if (mutating || error)
          await audit.append({
            ...event,
            outcome: error
              ? [401, 403].includes(error.status)
                ? 'denied'
                : 'failed'
              : 'succeeded',
            status: error ? error.status || 502 : 200,
          });
      } catch {
        return json(res, 503, {
          error:
            'The Docker request may have completed, but its audit outcome could not be saved. Check status before retrying.',
        });
      }
      if (error) throw error;
      if (Buffer.isBuffer(result)) {
        res.writeHead(200, {'content-type': 'application/octet-stream'});
        res.end(result);
      } else json(res, 200, result);
    } finally {
      inflight.set(principal.key, (inflight.get(principal.key) || 1) - 1);
    }
  }
  const socketPath = path.join(transport, 'socket/docker.sock');
  assert(
    Buffer.byteLength(socketPath) < 104,
    'Choose a shorter broker transport path for the Unix socket.',
  );
  await staleSocket(socketPath);
  const server = http.createServer((req, res) =>
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        json(res, error.status || 503, {
          error: error.status
            ? error.message
            : 'The Docker broker could not safely complete this request. Check its private state and audit history.',
        });
      else res.destroy();
    }),
  );
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = 1250000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o666);
  return {server, socketPath, audit};
}
