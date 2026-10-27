import {randomUUID} from 'node:crypto';
import {assert} from '../../common.js';
import {softwareReceipt} from '../../core/software-installation.js';
import {verifyPristineSoftware} from '../../core/software-module.js';
import {
  inspectStorageLock,
  recoverStorageLock,
} from '../../core/storage/coordination.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ids = (value) =>
  ['resolveId', 'prepareId', 'rollbackId']
    .map((key) => value[key])
    .filter(Boolean);

// Parent paired transactions persist intent/result before this helper runs or
// acknowledges a worker. It has no world, execution-publication or start access.
export function rustUpdateProvider(maintenance) {
  const {workers, provider, stopped, target} = maintenance;
  async function inspect() {
    return {
      provider: await provider.inspect(),
      requestLease: await inspectStorageLock(workers.paths.requests),
      requests: await Promise.all(
        (await workers.history()).map((record) => workers.inspect(record.id)),
      ),
    };
  }
  async function check(value, write) {
    value = await write(value, 'checking-software', {resolveId: randomUUID()});
    const selection = target(
      await workers.run(
        'resolve',
        {channel: value.previous.receipt.selection.source.branch},
        {id: value.resolveId},
      ),
    );
    value = await write(value, 'checking-software', {target: selection});
    await workers.acknowledge(value.resolveId);
    return write(value, 'reviewed');
  }
  async function prepare(value, write) {
    await stopped();
    value = await write(value, 'preparing-software', {prepareId: randomUUID()});
    const prepared = await workers.run('prepare', target(value.target), {
      id: value.prepareId,
      confirm: true,
    });
    assert(
      prepared.operationId === value.prepareId &&
        same(target(softwareReceipt(prepared.receipt).selection), value.target),
      'Prepared Rust build differs from the reviewed selection.',
      409,
    );
    value = await write(value, 'software-prepared', {prepared});
    await workers.acknowledge(value.prepareId);
    return value;
  }
  async function activate(value, write) {
    await stopped();
    value = await write(value, 'activating-software');
    await provider.activate(value.prepared, {confirm: true});
    return value;
  }
  async function cancel(value) {
    const known = ids(value);
    for (const record of await workers.history()) {
      assert(
        known.includes(record.id),
        'An unknown preparation request needs separate inspection.',
        409,
      );
      await workers.cancel(record.id, {confirm: true});
    }
    return 'Known preparation workers stopped. Inspect paired software recovery before making further changes.';
  }
  async function restore(value, write, reviewed, {metadataOnly = false} = {}) {
    const known = ids(value);
    for (const request of reviewed.requests) {
      assert(
        known.includes(request.record.id) &&
          (!request.worker ||
            (request.worker.running === false && !request.worker.restarting)),
        'An unknown or active preparation worker still owns this installation.',
        409,
      );
      // Retain a completed rollback result even if its response was lost before
      // the parent checkpoint. It can activate once; workers are never replayed.
      if (
        request.record.id === value.rollbackId &&
        !value.rollback &&
        request.response?.ok &&
        request.response.action === 'prepare'
      ) {
        const result = request.response.result;
        assert(
          result.operationId === value.rollbackId &&
            same(softwareReceipt(result.receipt), value.previous.receipt),
          'Rollback preparation differs from retained previous software.',
          409,
        );
        value = await write(value, 'recovering', {rollback: result});
      }
      if (
        !['complete', 'failed', 'closed'].includes(request.record.phase) ||
        request.worker ||
        request.lease
      )
        await workers.close(await workers.inspect(request.record.id), {
          confirm: true,
          offline: true,
        });
      await workers.acknowledge(request.record.id);
    }
    if (!metadataOnly) await stopped();
    const lease = await inspectStorageLock(workers.paths.requests);
    if (lease) {
      assert(
        same(lease, reviewed.requestLease),
        'Preparation coordination changed. Inspect again.',
        409,
      );
      await recoverStorageLock(workers.paths.requests, lease, {
        confirm: true,
        offline: true,
      });
    }
    let observed = await provider.inspect();
    assert(
      same(observed, reviewed.provider),
      'Private software observations changed. Inspect again.',
      409,
    );
    if (metadataOnly) {
      assert(
        !observed.lease && (await provider.installed(value.previous.receipt)),
        'Software changed during metadata discovery. Preserve recovery evidence.',
        409,
      );
      return value;
    }
    if (observed.lease) {
      await recoverStorageLock(workers.paths.control, observed.lease, {
        confirm: true,
        offline: true,
      });
      observed = await provider.inspect();
    }
    if (
      value.rollback &&
      observed.state.state === 'validating' &&
      observed.state.operationId === value.rollbackId &&
      observed.state.revision === value.rollback.revision
    ) {
      await provider.activate(value.rollback, {confirm: true});
      return value;
    }
    if (!(await provider.installed(value.previous.receipt))) {
      assert(
        observed.observation.state === 'installed',
        'Private software identity is uncertain. Preserve recovery evidence.',
        409,
      );
      assert(
        same(observed.observation.receipt, value.previous.receipt) ||
          (value.prepared &&
            same(observed.observation.receipt, value.prepared.receipt)),
        'Private software belongs to another transaction.',
        409,
      );
      if (observed.state.state !== 'installed')
        await provider.recover(observed, {confirm: true, offline: true});
    }
    if (await provider.installed(value.previous.receipt)) return value;
    // Previous software must come from this instance's verified exact cache.
    // prepare never resolves a channel or downloads a substituted build.
    await verifyPristineSoftware({
      ...workers.paths,
      receipt: value.previous.receipt,
    });
    value = await write(value, 'recovering', {
      rollbackId: randomUUID(),
      rollback: null,
    });
    const rollback = await workers.run(
      'prepare',
      value.previous.receipt.selection,
      {id: value.rollbackId, confirm: true},
    );
    assert(
      same(softwareReceipt(rollback.receipt), value.previous.receipt),
      'Cached rollback changed the retained previous receipt.',
      409,
    );
    value = await write(value, 'recovering', {rollback});
    await workers.acknowledge(value.rollbackId);
    await stopped();
    await provider.activate(rollback, {confirm: true});
    return value;
  }
  return {inspect, check, prepare, activate, restore, cancel};
}
