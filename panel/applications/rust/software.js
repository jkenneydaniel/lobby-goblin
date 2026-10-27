import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../../common.js';
import {
  directory,
  readRecord,
  atomicRecord,
  softwareInventory,
} from '../../providers/steamcmd/files.js';
import {createSteamProvider} from '../../providers/steamcmd/provider.js';
import {
  softwareSelection,
  softwareReceipt,
} from '../../core/software-installation.js';
import {
  stageExecution,
  executionProjection,
  executionBinary,
  publishExecutionReceipt,
  readExecutionReceipt,
} from '../../core/software-execution.js';
import {
  withStorageLock,
  inspectStorageLock,
  recoverStorageLock,
} from '../../core/storage/coordination.js';
import {syncDirectory} from '../../core/storage/files.js';
import {describeOperation} from '../../core/operation-record.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const missing = async (file) => {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const phases = [
  'reserved',
  'resolving',
  'selected',
  'preparing',
  'prepared',
  'copying',
  'copy-ready',
  'holding-data',
  'activating',
  'publishing',
  'restoring-data',
  'publishing-receipt',
  'complete',
];

// Initial installation only. Existing worlds cannot authorize latest software.
// The private pristine provider, execution publication and bootstrap data remain
// separate authorities. Updates/adoption must use a paired software/data flow.
export function createRustSoftware(ctx, {fault = async () => {}} = {}) {
  if (!ctx.config.softwareManaged) return null;
  const {config, softwareWorkers: workers} = ctx;
  assert(
    workers,
    'Managed Rust software requires an updated brokered controller.',
    409,
  );
  const data = path.dirname(config.data),
    engine = path.join(data, 'engine'),
    root = path.join(config.state, 'software/rust'),
    journalFile = path.join(root, 'installation.json'),
    bootstrapFile = path.join(
      workers.root,
      'control/managed-rust-bootstrap.json',
    );
  assert(
    config.data === path.join(workers.root, 'data/server') &&
      config.installRoot === engine &&
      config.state === path.join(workers.root, 'state'),
    'Managed Rust storage differs from its private claims.',
    409,
  );
  assert(
    config.instance === workers.scope.instance &&
      config.managedVolume === workers.scope.volume,
    'Managed Rust software belongs to a different volume.',
    409,
  );
  let busy = false;
  const leaseAt = async (location) => {
    if (!(await missing(location))) return null;
    await directory(location);
    return inspectStorageLock(location);
  };
  const stopped = async () => {
    const info = await ctx.host.info();
    assert(
      info.Config?.Labels?.['io.lobby-goblin.instance'] === config.instance &&
        info.Config.Labels['io.lobby-goblin.game'] === 'rust' &&
        info.Config.Image === config.image &&
        info.State?.Running === false &&
        !info.State.Restarting,
      'Rust must remain stopped during software publication.',
      409,
    );
    assert(
      info.Mounts?.length === 1 &&
        info.Mounts[0].Type === 'volume' &&
        info.Mounts[0].Name === config.managedVolume &&
        info.Mounts[0].Destination === '/steamcmd/rust' &&
        info.Mounts[0].RW === true &&
        info.HostConfig?.Mounts?.length === 1 &&
        info.HostConfig.Mounts[0].Source === config.managedVolume &&
        info.HostConfig.Mounts[0].Target === '/steamcmd/rust' &&
        info.HostConfig.Mounts[0].VolumeOptions?.Subpath === 'data' &&
        info.HostConfig.Mounts[0].VolumeOptions.NoCopy === true,
      'Rust execution mount differs from this instance data claim.',
      409,
    );
    assert(
      (await workers.workers()).length === 0,
      'An instance worker still owns preparation.',
      409,
    );
    return true;
  };
  const provider = createSteamProvider({
    source: workers.scope.declaration.source,
    requiredFiles: workers.scope.declaration.requiredFiles,
    software: workers.paths.software,
    control: workers.paths.control,
    command: async () => {
      throw Error('The controller cannot execute SteamCMD.');
    },
    isApplicationStopped: stopped,
    isApplicationEmpty: async () => (await fs.readdir(data)).length === 0,
  });
  function target(value) {
    const selected = softwareSelection(value),
      source = workers.scope.declaration.source;
    assert(
      selected.provider === 'steamcmd' &&
        selected.application === 'rust' &&
        selected.platform === source.platform &&
        selected.source.kind === 'steam' &&
        selected.source.appId === source.appId &&
        source.branches.includes(selected.source.branch),
      'Rust software identity differs from its reviewed source.',
      409,
    );
    return selected;
  }
  async function record() {
    if (!(await missing(root))) return null;
    await directory(root);
    const value = await readRecord(journalFile, {optional: true, max: 65536});
    if (!value) return null;
    assert(
      Object.keys(value).every((key) =>
        [
          'format',
          'id',
          'instance',
          'parentId',
          'phase',
          'started',
          'target',
          'prepared',
          'binary',
          'bootstrap',
          'resolveId',
          'prepareId',
        ].includes(key),
      ) &&
        value.format === 1 &&
        uuid(value.id) &&
        value.instance === config.instance &&
        phases.includes(value.phase) &&
        typeof value.started === 'string' &&
        Number.isFinite(Date.parse(value.started)),
      'Invalid Rust software journal. Preserve it for inspection.',
      409,
    );
    for (const key of ['resolveId', 'prepareId'])
      assert(
        value[key] === undefined || uuid(value[key]),
        'Invalid retained software request.',
        409,
      );
    if (value.target) target(value.target);
    if (value.prepared) {
      const receipt = softwareReceipt(value.prepared.receipt);
      assert(
        same(target(receipt.selection), value.target) &&
          value.prepared.operationId === value.prepareId &&
          Number.isSafeInteger(value.prepared.revision),
        'Prepared Rust identity changed.',
        409,
      );
    }
    if (value.binary)
      assert(
        value.binary.name === 'RustDedicated' &&
          /^[a-f0-9]{64}$/.test(value.binary.sha256) &&
          value.binary.executable === true,
        'Invalid Rust execution binary.',
        409,
      );
    return value;
  }
  async function checkpoint(value, phase, extra = {}) {
    const next = {...value, ...extra, phase};
    await atomicRecord(journalFile, next);
    await fault(phase);
    return next;
  }
  async function stageMessage(job, message, phase) {
    if (job) await ctx.stageMessage(job, message, phase);
  }
  async function fresh() {
    await directory(data);
    await directory(engine);
    await directory(config.data);
    for (const location of [data, engine, config.data]) {
      const stat = await fs.lstat(location);
      assert(
        stat.uid === process.getuid() && !(stat.mode & 0o022),
        'New Rust storage must be controller-owned.',
        409,
      );
    }
    assert(
      same((await fs.readdir(data)).sort(), ['engine', 'server']) &&
        (await fs.readdir(engine)).length === 0 &&
        !(await readExecutionReceipt(data)),
      'Existing application data requires adoption or paired recovery.',
      409,
    );
    const marker = await readRecord(bootstrapFile, {max: 65536});
    assert(
      marker &&
        Object.keys(marker).every((key) =>
          ['format', 'instance', 'game', 'inventory', 'selection'].includes(
            key,
          ),
        ) &&
        marker.format === 1 &&
        marker.instance === config.instance &&
        marker.game === 'rust',
      'Only a newly provisioned Rust instance can authorize initial installation.',
      409,
    );
    const inventory = await softwareInventory(config.data, {
      maxFiles: 20000,
      maxBytes: 64 * 1024 ** 3,
    });
    assert(
      same(inventory.inventory, marker.inventory),
      'Provisioned bootstrap data changed before installation.',
      409,
    );
    if (!marker.selection)
      assert(
        same(
          inventory.files.map((file) => file.name),
          ['.lobby-goblin-rust.json', 'lobby-goblin-rust/cfg/server.cfg'],
        ),
        'Existing worlds or player data cannot authorize initial installation.',
        409,
      );
    return {
      inventory: inventory.inventory,
      ...(marker.selection ? {target: target(marker.selection)} : {}),
    };
  }
  async function verified(value) {
    assert(
      value?.phase === 'complete' && value.prepared && value.binary,
      'Initial software publication needs recovery.',
      409,
    );
    const receipt = softwareReceipt(value.prepared.receipt);
    assert(
      await provider.installed(receipt),
      'Private Rust software changed. Recover it before starting.',
      409,
    );
    const projected = executionProjection(receipt, value.binary, 'rust');
    assert(
      same(await readExecutionReceipt(data), projected),
      'Execution receipt changed. No upstream software was selected.',
      409,
    );
    await executionBinary(engine, 'RustDedicated', value.binary.sha256);
    return receipt;
  }
  async function finish(value, job, recovering = false) {
    await stopped();
    const held = path.join(root, 'bootstrap-' + value.id),
      staging = path.join(root, 'execution-' + value.id);
    if (!value.target) {
      const id = crypto.randomUUID();
      value = await checkpoint(value, 'resolving', {resolveId: id});
      await stageMessage(
        job,
        'Checking the reviewed Rust public build…',
        'resolving-software',
      );
      const selected = target(
        await workers.run('resolve', {channel: 'public'}, {id}),
      );
      value = await checkpoint(value, 'selected', {target: selected});
      await workers.acknowledge(id);
    }
    if (!value.prepared) {
      const id = crypto.randomUUID();
      value = await checkpoint(value, 'preparing', {prepareId: id});
      await stageMessage(
        job,
        'Preparing exact Rust build ' +
          value.target.softwareVersion +
          ' privately…',
        'preparing-software',
      );
      const prepared = await workers.run('prepare', value.target, {
        id,
        confirm: true,
      });
      value = await checkpoint(value, 'prepared', {prepared});
      await workers.acknowledge(id);
    }
    await stopped();
    const receipt = softwareReceipt(value.prepared.receipt);
    const published = await readExecutionReceipt(data);
    if (published) {
      assert(
        recovering &&
          value.binary &&
          same(published, executionProjection(receipt, value.binary, 'rust')),
        'Existing execution receipt cannot be replaced by initial installation.',
        409,
      );
      const completed = {...value, phase: 'complete'};
      await verified(completed);
      return checkpoint(value, 'complete');
    }
    const engineStat = await missing(engine),
      executionPublished = engineStat && (await fs.readdir(engine)).length > 0;
    if (!executionPublished) {
      if (!(await missing(held)))
        assert(
          same((await fresh()).inventory, value.bootstrap),
          'Bootstrap data changed during preparation.',
          409,
        );
      value = await checkpoint(value, 'copying');
      await stageMessage(
        job,
        'Verifying and copying Rust into its independent execution directory…',
        'copying-software',
      );
      const binary = await stageExecution({
        software: workers.paths.software,
        staging,
        receipt,
        executable: 'RustDedicated',
        discardPartial: recovering,
        fault,
      });
      value = await checkpoint(value, 'copy-ready', {binary});
      await stopped();
      if (!(await missing(held))) {
        assert(
          same(
            (
              await softwareInventory(config.data, {
                maxFiles: 20000,
                maxBytes: 64 * 1024 ** 3,
              })
            ).inventory,
            value.bootstrap,
          ),
          'Bootstrap data changed before activation.',
          409,
        );
        value = await checkpoint(value, 'holding-data');
        await fs.rename(config.data, held);
        await syncDirectory(data);
        await syncDirectory(root);
      }
      assert(
        !(await missing(config.data)) &&
          same(
            (
              await softwareInventory(held, {
                maxFiles: 20000,
                maxBytes: 64 * 1024 ** 3,
              })
            ).inventory,
            value.bootstrap,
          ),
        'Held bootstrap data changed. No world was overwritten.',
        409,
      );
      if (await missing(engine)) {
        await fs.rmdir(engine);
        await syncDirectory(data);
      }
      await stopped();
      value = await checkpoint(value, 'activating');
      let state = await provider.read();
      if (state.state !== 'installed') {
        assert(
          state.state === 'validating' &&
            state.operationId === value.prepared.operationId,
          'Private preparation needs inspection before activation.',
          409,
        );
        await provider.activate(
          {...value.prepared, revision: state.revision},
          {confirm: true},
        );
      } else
        assert(
          same(state.installed, receipt) && (await provider.installed(receipt)),
          'Active software differs from the initial target.',
          409,
        );
      value = await checkpoint(value, 'publishing');
      await stopped();
      assert(
        (await fs.readdir(data)).length === 0,
        'Application data changed before execution publication.',
        409,
      );
      await fs.rename(staging, engine);
      await syncDirectory(root);
      await syncDirectory(data);
    } else {
      assert(
        recovering &&
          value.binary &&
          (await provider.installed(receipt)) &&
          same((await softwareInventory(engine)).inventory, receipt.inventory),
        'Unexpected execution files require offline recovery.',
        409,
      );
    }
    await stopped();
    value = await checkpoint(value, 'restoring-data');
    if (await missing(held)) {
      assert(
        !(await missing(config.data)) &&
          same(
            (
              await softwareInventory(held, {
                maxFiles: 20000,
                maxBytes: 64 * 1024 ** 3,
              })
            ).inventory,
            value.bootstrap,
          ),
        'Bootstrap data cannot be restored over existing data.',
        409,
      );
      await fs.rename(held, config.data);
      await syncDirectory(root);
      await syncDirectory(data);
    } else
      assert(
        same(
          (
            await softwareInventory(config.data, {
              maxFiles: 20000,
              maxBytes: 64 * 1024 ** 3,
            })
          ).inventory,
          value.bootstrap,
        ),
        'Restored bootstrap data changed.',
        409,
      );
    value = await checkpoint(value, 'publishing-receipt');
    await stopped();
    await executionBinary(engine, 'RustDedicated', value.binary.sha256);
    await publishExecutionReceipt(
      data,
      executionProjection(receipt, value.binary, 'rust'),
    );
    value = await checkpoint(value, 'complete');
    await verified(value);
    return value;
  }
  async function ensure(job) {
    assert(!busy, 'Rust software installation is already active.', 409);
    busy = true;
    try {
      const current = await record();
      if (current?.phase === 'complete') {
        assert(
          !(await leaseAt(root)) &&
            !(await leaseAt(workers.paths.control)) &&
            !(await leaseAt(workers.paths.requests)),
          'Inspect and recover retained software coordination before starting.',
          409,
        );
        return verified(current);
      }
      assert(
        !current,
        'Inspect and recover the interrupted Rust installation before starting.',
        409,
      );
      await stopped();
      const bootstrap = await fresh();
      await directory(root, {create: true});
      return await withStorageLock(
        root,
        'write',
        async () => {
          assert(
            !(await record()),
            'Another software installation owns this instance.',
            409,
          );
          const value = {
            format: 1,
            id: crypto.randomUUID(),
            instance: config.instance,
            ...(job?.id ? {parentId: job.id} : {}),
            started: new Date().toISOString(),
            phase: 'reserved',
            bootstrap: bootstrap.inventory,
            ...(bootstrap.target ? {target: bootstrap.target} : {}),
          };
          await atomicRecord(journalFile, value);
          return softwareReceipt((await finish(value, job)).prepared.receipt);
        },
        {timeout: 0},
      );
    } finally {
      busy = false;
    }
  }
  async function inspect() {
    const value = await record();
    if (!value)
      return {installed: false, recoveryRequired: false, review: null};
    const history = await fs.lstat(workers.paths.requests).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const requests = history
      ? await Promise.all(
          (await workers.history()).map((item) => workers.inspect(item.id)),
        )
      : [];
    const observation = {
      record: value,
      lease: await leaseAt(root),
      requestLease: await leaseAt(workers.paths.requests),
      provider: await provider.inspect(),
      requests,
    };
    return {
      installed: value.phase === 'complete',
      recoveryRequired:
        value.phase !== 'complete' ||
        !!observation.lease ||
        !!observation.requestLease ||
        !!observation.provider.lease ||
        requests.length > 0,
      buildId: value.target?.softwareVersion || null,
      phase: value.phase,
      review: crypto
        .createHash('sha256')
        .update(JSON.stringify(observation))
        .digest('hex'),
      observation,
    };
  }
  async function recover(params, job) {
    assert(
      params?.confirm === true &&
        /^[a-f0-9]{64}$/.test(params.review || '') &&
        !busy,
      'Inspect and confirm this exact Rust installation recovery.',
      409,
    );
    busy = true;
    try {
      const reviewed = await inspect();
      assert(
        reviewed.review === params.review && reviewed.recoveryRequired,
        'Rust recovery observations changed. Inspect again.',
        409,
      );
      const info = await ctx.host.info();
      assert(
        info.State?.Running === false && !info.State.Restarting,
        'Stop Rust before recovering its installation.',
        409,
      );
      let value = reviewed.observation.record;
      for (const request of reviewed.observation.requests) {
        assert(
          !request.worker ||
            (request.worker.running === false && !request.worker.restarting),
          'Wait for or cancel the private preparation worker before recovery.',
          409,
        );
        if (
          !value.target &&
          request.record.id === value.resolveId &&
          request.response?.ok === true &&
          request.response.action === 'resolve'
        )
          value = await checkpoint(value, 'selected', {
            target: target(request.response.result),
          });
        if (
          !value.prepared &&
          request.record.id === value.prepareId &&
          request.response?.ok === true &&
          request.response.action === 'prepare'
        ) {
          assert(
            same(
              target(request.response.result.receipt.selection),
              value.target,
            ),
            'Recovered preparation changed the selected build.',
            409,
          );
          value = await checkpoint(value, 'prepared', {
            prepared: request.response.result,
          });
        }
        if (
          !['complete', 'failed', 'closed'].includes(request.record.phase) ||
          request.worker ||
          request.lease
        )
          await workers.close(request, {confirm: true, offline: true});
        await workers.acknowledge(request.record.id);
      }
      await stopped();
      const requestLease = await leaseAt(workers.paths.requests);
      if (requestLease) {
        assert(
          same(requestLease, reviewed.observation.requestLease),
          'Software request coordination changed. Inspect again.',
          409,
        );
        await recoverStorageLock(workers.paths.requests, requestLease, {
          confirm: true,
          offline: true,
        });
      }
      const observed = await provider.inspect();
      assert(
        same(observed, reviewed.observation.provider),
        'Private software observations changed. Inspect again.',
        409,
      );
      if (
        observed.lease &&
        ['uninstalled', 'installed'].includes(observed.state.state)
      ) {
        if (observed.state.state === 'installed')
          assert(
            value.prepared &&
              same(observed.state.installed, value.prepared.receipt) &&
              (await provider.installed(value.prepared.receipt)),
            'Completed private software changed before coordination recovery.',
            409,
          );
        await recoverStorageLock(workers.paths.control, observed.lease, {
          confirm: true,
          offline: true,
        });
      } else if (
        observed.lease ||
        !['uninstalled', 'failed', 'installed'].includes(observed.state.state)
      )
        await provider.recover(observed, {confirm: true, offline: true});
      const state = await provider.read();
      if (!value.prepared && state.state === 'validating') {
        const inspected = await provider.inspect();
        assert(
          inspected.observation.state === 'staged' &&
            same(target(inspected.observation.receipt.selection), value.target),
          'Staged Rust build differs from the retained initial target.',
          409,
        );
        value = await checkpoint(value, 'prepared', {
          prepareId: state.operationId,
          prepared: {
            operationId: state.operationId,
            revision: state.revision,
            receipt: inspected.observation.receipt,
          },
        });
      }
      if (reviewed.observation.lease)
        await recoverStorageLock(root, reviewed.observation.lease, {
          confirm: true,
          offline: true,
        });
      return await withStorageLock(
        root,
        'write',
        () => finish(value, job, true),
        {timeout: 0},
      );
    } finally {
      busy = false;
    }
  }
  async function cancel(params) {
    assert(
      params?.confirm === true && !busy,
      'Confirm stopping the retained private preparation.',
      409,
    );
    const inspected = await inspect();
    assert(
      inspected.recoveryRequired,
      'No interrupted preparation requires cancellation.',
      409,
    );
    for (const request of inspected.observation.requests)
      if (request.worker?.running || request.worker?.restarting)
        await workers.cancel(request.record.id, {confirm: true});
    return 'Private preparation stopped. Inspect it again before recovery; Rust remains stopped.';
  }
  async function status() {
    const value = await record();
    const retained =
      value &&
      ((await leaseAt(root)) ||
        (await leaseAt(workers.paths.control)) ||
        (await leaseAt(workers.paths.requests)));
    return {
      mode: 'runtime',
      provider: 'steamcmd',
      managed: true,
      version:
        value?.phase === 'complete' ? value.target.softwareVersion : null,
      phase: value?.phase || 'uninstalled',
      recoveryRequired:
        !!value && (value.phase !== 'complete' || !!retained) && !busy,
    };
  }
  const operationSource = {
    id: 'rust-software',
    label: 'Rust software installation',
    async read() {
      const value = await record();
      if (!value) return [];
      const current = await status(),
        settled = value.phase === 'complete' && !current.recoveryRequired;
      return [
        describeOperation(value, {
          source: 'rust-software',
          action: 'initial-installation',
          kind: 'provisioning',
          state: settled ? 'succeeded' : busy ? 'running' : 'interrupted',
          message: settled
            ? 'Exact software published. The parent start job owns game readiness.'
            : 'Initial installation remains incomplete; inspect it before recovery.',
          recovery: {
            required: current.recoveryRequired,
            actions: [{id: 'inspect', label: 'Inspect installation'}],
          },
        }),
      ];
    },
    async inspectJob(job) {
      const value = await record();
      return value?.parentId === job.id
        ? {
            message:
              'Inspect Rust software state and its parent start job. No installation was replayed.',
          }
        : null;
    },
  };
  return {
    ensure,
    inspect,
    recover,
    cancel,
    status,
    operationSource,
    receipt: async () => verified(await record()),
  };
}
