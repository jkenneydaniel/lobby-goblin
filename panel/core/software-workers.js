import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {assert, HttpError} from '../common.js';
import {brokerSocket, brokerToken} from './broker-client.js';
import {syncDirectory} from './storage/files.js';
import {
  withStorageLock,
  inspectStorageLock,
  recoverStorageLock,
} from './storage/coordination.js';
import {
  softwareSelection,
  softwareSelectionKey,
  softwareReceipt,
  softwareInstallation,
} from './software-installation.js';
import {softwareWorkerRequest} from '../providers/steamcmd/worker.js';
import {
  directory,
  readRecord,
  atomicRecord,
} from '../providers/steamcmd/files.js';
import {
  softwareWorkerDeployment as deployment,
  softwareWorkerPaths,
  softwareWorkerId,
  softwareWorkerName,
  softwareWorkerScope,
  softwareWorkerSpec,
  validateSoftwareWorkerImage,
} from './software-worker-policy.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const terminal = new Set(['complete', 'failed', 'closed']);
const phases = new Set([
  'reserved',
  'creating',
  'created',
  'starting',
  'running',
  'exited',
  'attention',
  ...terminal,
]);
const optional = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};

// Trusted controller code supplies the adapter, declaration and root. The
// request protocol cannot select a path, image, credential or executable.
export class SoftwareWorkers {
  constructor({docker, env, declaration, root = '/instance', pollMs = 1000}) {
    assert(
      typeof docker === 'function' &&
        env.DOCKER_BROKER_SOCKET === brokerSocket &&
        env.DOCKER_BROKER_TOKEN_FILE === brokerToken,
      'Software preparation requires an instance broker transport.',
    );
    assert(
      path.isAbsolute(root) &&
        path.resolve(root) === root &&
        root !== '/' &&
        Number.isInteger(pollMs) &&
        pollMs >= 1 &&
        pollMs <= 5000,
      'Invalid controller software storage.',
    );
    this.scope = softwareWorkerScope({
      fleet: env.FLEET_ID,
      instance: env.FLEET_INSTANCE,
      volume: env.FLEET_VOLUME,
      declaration,
    });
    this.root = root;
    this.docker = docker;
    this.pollMs = pollMs;
    this.busy = false;
    this.paths = Object.freeze(
      Object.fromEntries(
        Object.entries(softwareWorkerPaths).map(([key, value]) => [
          key,
          path.join(root, value),
        ]),
      ),
    );
  }
  location(id) {
    assert(softwareWorkerId(id), 'Invalid software request identity.');
    return path.join(this.paths.requests, id);
  }
  async privateDirectory(relative, group = false) {
    await directory(this.root);
    let current = this.root;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      await directory(current, {create: true});
      await syncDirectory(path.dirname(current));
    }
    if (group) {
      const stat = await fs.lstat(current);
      if (stat.uid === process.getuid()) {
        assert(
          stat.gid === process.getgid(),
          'Software claims require the controller group.',
          409,
        );
        await fs.chmod(current, 0o2770);
      } else
        assert(
          stat.uid === 1000 && stat.gid === 0 && !(stat.mode & 0o007),
          'Software claim ownership changed.',
          409,
        );
    }
    return current;
  }
  async initialize() {
    await this.privateDirectory(softwareWorkerPaths.requests);
  }
  async providerClaims() {
    for (const relative of [
      softwareWorkerPaths.software,
      softwareWorkerPaths.software + '/staging',
      softwareWorkerPaths.software + '/releases',
      softwareWorkerPaths.control,
      softwareWorkerPaths.control + '/inventories',
      softwareWorkerPaths.control + '/cached-operations',
    ])
      await this.privateDirectory(relative, true);
    // Activation atomically publishes controller-owned 0600 records. Give only
    // the worker's scoped GID 0 read access before its next admission. Worker-
    // owned records retain their existing mode; no CHOWN/FOWNER is needed.
    for (const name of ['installation.json', 'active.json', 'candidate.json']) {
      let handle;
      try {
        handle = await fs.open(
          path.join(this.paths.control, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      try {
        const stat = await handle.stat();
        assert(
          stat.isFile() && stat.nlink === 1 && stat.size <= 1024 ** 2,
          'Unsafe provider control record.',
          409,
        );
        if (stat.uid === process.getuid()) {
          assert(
            stat.gid === process.getgid(),
            'Provider record group changed.',
            409,
          );
          await handle.chmod(0o640);
          await handle.sync();
        } else
          assert(
            stat.uid === 1000 && stat.gid === 0 && !(stat.mode & 0o007),
            'Provider record ownership changed.',
            409,
          );
      } finally {
        await handle.close();
      }
    }
  }
  async image() {
    const route = '/images/' + encodeURIComponent(deployment.image) + '/json';
    let image = await optional(() => this.docker('GET', route));
    if (!image) {
      const [fromImage, tag] = deployment.image.split('@');
      const output = await this.docker(
        'POST',
        '/images/create?' +
          new URLSearchParams({fromImage, tag, platform: deployment.platform}),
        undefined,
        {raw: true, timeout: 1200000},
      );
      for (const line of output.toString().split('\n').filter(Boolean))
        assert(
          !JSON.parse(line).error,
          'The published software worker could not be downloaded.',
          503,
        );
      image = await this.docker('GET', route);
    }
    return validateSoftwareWorkerImage(image);
  }
  async workers() {
    const filters = {
      label: [
        'io.lobby-goblin.fleet=' + this.scope.fleet,
        'io.lobby-goblin.instance=' + this.scope.instance,
        'io.lobby-goblin.worker=true',
      ],
    };
    const workers = await this.docker(
      'GET',
      '/containers/json?all=1&filters=' +
        encodeURIComponent(JSON.stringify(filters)),
    );
    assert(
      Array.isArray(workers) && workers.length <= 256,
      'Invalid software worker listing.',
      409,
    );
    return workers;
  }
  async record(id) {
    await directory(this.location(id));
    const record = await readRecord(
      path.join(this.location(id), 'operation.json'),
      {max: 4096},
    );
    assert(
      record.format === 1 &&
        record.id === id &&
        ['resolve', 'prepare'].includes(record.action) &&
        phases.has(record.phase) &&
        (record.containerId === null ||
          (typeof record.containerId === 'string' &&
            /^[A-Za-z0-9_-]{1,128}$/.test(record.containerId))) &&
        (record.exitCode === null ||
          (Number.isSafeInteger(record.exitCode) && record.exitCode >= 0)),
      'Invalid private software operation.',
      409,
    );
    return record;
  }
  async history() {
    await directory(this.paths.requests);
    const entries = await fs.readdir(this.paths.requests);
    assert(
      entries.length <= 129 &&
        entries.every(
          (name) => name === '.panel-storage-lock' || softwareWorkerId(name),
        ),
      'Inspect or acknowledge retained software requests before continuing.',
      409,
    );
    return Promise.all(
      entries.filter(softwareWorkerId).map((id) => this.record(id)),
    );
  }
  async request(id) {
    await directory(path.join(this.location(id), 'request'));
    const request = softwareWorkerRequest(
      await readRecord(path.join(this.location(id), 'request/request.json'), {
        max: 64 * 1024,
      }),
    );
    assert(
      request.id === id &&
        same(request.source, this.scope.declaration.source) &&
        same(request.requiredFiles, this.scope.declaration.requiredFiles),
      'Software request declaration changed.',
      409,
    );
    return request;
  }
  response(request, value) {
    assert(
      value?.format === 1 &&
        value.id === request.id &&
        typeof value.ok === 'boolean',
      'Inspect the incomplete software worker result.',
      409,
    );
    if (!value.ok) {
      assert(
        value.error?.code === 'software-worker-failed' &&
          [400, 409, 413, 503, 504, 507].includes(value.error.status) &&
          typeof value.error.message === 'string' &&
          value.error.message.length <= 1000,
        'Invalid software worker failure.',
        409,
      );
      return value;
    }
    assert(
      value.action === request.action,
      'Software result action changed.',
      409,
    );
    const target =
      request.action === 'resolve'
        ? softwareSelection(value.result)
        : softwareReceipt(value.result?.receipt).selection;
    softwareWorkerRequest({
      format: 1,
      id: request.id,
      action: 'prepare',
      source: request.source,
      requiredFiles: request.requiredFiles,
      selection: target,
      confirm: true,
    });
    if (request.action === 'resolve')
      assert(
        target.source.branch === request.initial.channel,
        'Software discovery returned another branch.',
        409,
      );
    if (request.action === 'prepare')
      assert(
        value.result.operationId === request.id &&
          Number.isSafeInteger(value.result.revision) &&
          value.result.revision >= 0 &&
          softwareSelectionKey(target) ===
            softwareSelectionKey(request.selection),
        'Software result differs from its exact request.',
        409,
      );
    return value;
  }
  async inspect(id) {
    const record = await this.record(id),
      request = await this.request(id);
    await directory(path.join(this.location(id), 'result'));
    const worker = await optional(() =>
      this.docker(
        'GET',
        '/containers/' +
          encodeURIComponent(softwareWorkerName(this.scope.instance, id)) +
          '/json',
      ),
    );
    assert(
      !worker ||
        record.containerId === null ||
        worker.Id === record.containerId,
      'Software worker identity changed.',
      409,
    );
    const value = await readRecord(
      path.join(this.location(id), 'result/result.json'),
      {optional: true, max: 256 * 1024},
    );
    return {
      record,
      worker: worker
        ? {
            id: worker.Id,
            running: worker.State?.Running,
            restarting: worker.State?.Restarting === true,
            status: worker.State?.Status,
            exitCode: worker.State?.ExitCode,
            oomKilled: worker.State?.OOMKilled === true,
          }
        : null,
      response: value ? this.response(request, value) : null,
      lease: await inspectStorageLock(this.paths.requests),
    };
  }
  async stopped(id, {stop = false} = {}) {
    const name = softwareWorkerName(this.scope.instance, id),
      route = '/containers/' + encodeURIComponent(name);
    let worker = await optional(() => this.docker('GET', route + '/json'));
    if (!worker) return null;
    if (stop && (worker.State?.Running || worker.State?.Restarting))
      await this.docker('POST', route + '/stop?t=30', undefined, {
        timeout: 45000,
      });
    const deadline = Date.now() + 45000;
    while (
      stop &&
      (worker.State?.Running || worker.State?.Restarting) &&
      Date.now() < deadline
    ) {
      await delay(this.pollMs);
      worker = await this.docker('GET', route + '/json');
    }
    assert(
      worker.State?.Running === false && !worker.State?.Restarting,
      'Software preparation still owns its worker. Inspect before continuing.',
      409,
    );
    return worker;
  }
  async cancel(id, {confirm = false} = {}) {
    assert(confirm === true, 'Confirm cancellation of this software worker.');
    await this.request(id);
    return this.stopped(id, {stop: true});
  }
  async run(
    action,
    input,
    {
      id = crypto.randomUUID(),
      confirm = false,
      signal,
      progress = async () => {},
      timeout = 2400000,
    } = {},
  ) {
    assert(
      ['resolve', 'prepare'].includes(action) &&
        !this.busy &&
        Number.isSafeInteger(timeout) &&
        timeout >= 1 &&
        timeout <= 2400000,
      'Software preparation is already active or has an invalid timeout.',
      409,
    );
    const declaration = this.scope.declaration;
    const request = softwareWorkerRequest({
      format: 1,
      id,
      action,
      source: declaration.source,
      requiredFiles: declaration.requiredFiles,
      ...(action === 'resolve'
        ? {initial: input}
        : {selection: input, confirm}),
    });
    assert(
      Buffer.byteLength(JSON.stringify(request)) <= 64 * 1024,
      'Software request is too large.',
      413,
    );
    this.busy = true;
    try {
      await this.initialize();
      return await withStorageLock(
        this.paths.requests,
        'write',
        async () => {
          const history = await this.history();
          assert(
            history.length < 128 &&
              history.every((value) => terminal.has(value.phase)),
            'Inspect interrupted software requests before new preparation.',
            409,
          );
          assert(
            !history.some((value) => value.id === id),
            'Inspect the existing software request instead of replaying it.',
            409,
          );
          assert(
            !(await this.workers()).length,
            'Finish the existing instance worker before preparing software.',
            409,
          );
          signal?.throwIfAborted();
          const location = this.location(id);
          await fs.mkdir(location, {mode: 0o700});
          await syncDirectory(this.paths.requests);
          for (const child of ['request', 'result'])
            await this.privateDirectory(
              softwareWorkerPaths.requests + '/' + id + '/' + child,
              true,
            );
          await atomicRecord(
            path.join(location, 'request/request.json'),
            request,
          );
          await fs.chmod(path.join(location, 'request/request.json'), 0o640);
          let record = {
            format: 1,
            id,
            action,
            phase: 'reserved',
            containerId: null,
            exitCode: null,
          };
          const checkpoint = async (phase) => {
            const next = {...record, phase};
            await atomicRecord(path.join(location, 'operation.json'), next);
            record = next;
            await progress({id, action, phase});
          };
          try {
            await checkpoint('reserved');
            await this.image();
            signal?.throwIfAborted();
            if (action === 'prepare') await this.providerClaims();
            const name = softwareWorkerName(this.scope.instance, id),
              route = '/containers/' + encodeURIComponent(name);
            await checkpoint('creating');
            const created = await this.docker(
              'POST',
              '/containers/create?' +
                new URLSearchParams({name, platform: deployment.platform}),
              softwareWorkerSpec(this.scope, id, action),
            );
            assert(
              typeof created?.Id === 'string' &&
                /^[A-Za-z0-9_-]{1,128}$/.test(created.Id),
              'Software worker creation needs inspection.',
              409,
            );
            record.containerId = created.Id;
            await checkpoint('created');
            signal?.throwIfAborted();
            await checkpoint('starting');
            await this.docker('POST', route + '/start');
            await checkpoint('running');
            const deadline = Date.now() + timeout;
            let info;
            for (;;) {
              signal?.throwIfAborted();
              info = await this.docker('GET', route + '/json');
              assert(
                info.Id === record.containerId,
                'Software worker identity changed.',
                409,
              );
              if (info.State?.Running === false && !info.State?.Restarting)
                break;
              assert(
                Date.now() < deadline,
                'Software worker timed out. Inspect its retained request.',
                504,
              );
              if (action === 'prepare') {
                const state = await readRecord(
                  path.join(this.paths.control, 'installation.json'),
                  {optional: true, max: 1024 ** 2},
                );
                if (state)
                  await progress({
                    id,
                    action,
                    phase: 'running',
                    installation: softwareInstallation(state),
                  });
              }
              await delay(this.pollMs, undefined, {signal});
            }
            assert(
              info.State.Status === 'exited' &&
                !info.State.OOMKilled &&
                Number.isSafeInteger(info.State.ExitCode),
              'Software worker exit needs inspection.',
              409,
            );
            record.exitCode = info.State.ExitCode;
            await checkpoint('exited');
            const response = this.response(
              request,
              await readRecord(path.join(location, 'result/result.json'), {
                max: 256 * 1024,
              }),
            );
            assert(
              response.ok === (record.exitCode === 0),
              'Software exit and result disagree. Inspect before continuing.',
              409,
            );
            await this.docker('DELETE', route);
            await checkpoint(response.ok ? 'complete' : 'failed');
            if (!response.ok)
              throw new HttpError(
                response.error.status,
                response.error.message,
              );
            return response.result;
          } catch (error) {
            error.workerRequestId = id;
            if (!terminal.has(record.phase)) {
              if (signal?.aborted || error.status === 504)
                await this.stopped(id, {stop: true}).catch(() => {});
              try {
                await checkpoint('attention');
              } catch (failure) {
                failure.workerRequestId = id;
                throw failure;
              }
            }
            throw error;
          }
        },
        {timeout: 0},
      );
    } finally {
      this.busy = false;
    }
  }
  // Closing an observed stopped request never promotes its software or clears
  // provider recovery state. Activation/recovery require separate inspection.
  async close(review, {confirm = false, offline = false} = {}) {
    assert(
      confirm === true && offline === true && !this.busy,
      'Confirm offline review before closing a software request.',
      409,
    );
    const id = review?.record?.id,
      current = await this.inspect(id);
    assert(
      same(review, current) &&
        (!current.worker ||
          (current.worker.running === false && !current.worker.restarting)),
      'Software request observations changed or its worker remains active.',
      409,
    );
    for (const worker of await this.workers()) {
      const info = await this.docker(
        'GET',
        '/containers/' + encodeURIComponent(worker.Id) + '/json',
      );
      assert(
        info.State?.Running === false && !info.State?.Restarting,
        'An instance worker remains active.',
        409,
      );
    }
    if (current.lease)
      await recoverStorageLock(this.paths.requests, current.lease, {
        confirm,
        offline,
      });
    return withStorageLock(
      this.paths.requests,
      'write',
      async () => {
        await this.stopped(id);
        if (current.worker)
          await this.docker(
            'DELETE',
            '/containers/' + encodeURIComponent(current.worker.id),
          );
        const record = {...current.record, phase: 'closed'};
        await atomicRecord(
          path.join(this.location(id), 'operation.json'),
          record,
        );
        return record;
      },
      {timeout: 0},
    );
  }
  async acknowledge(id) {
    assert(
      !this.busy,
      'Wait for software preparation before acknowledging its result.',
      409,
    );
    await directory(this.paths.requests);
    return withStorageLock(
      this.paths.requests,
      'write',
      async () => {
        const record = await this.record(id);
        assert(
          terminal.has(record.phase) && !(await this.workers()).length,
          'Inspect the software request before acknowledging it.',
          409,
        );
        await fs.rm(this.location(id), {recursive: true});
        await syncDirectory(this.paths.requests);
      },
      {timeout: 0},
    );
  }
}
