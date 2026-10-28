import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../common.js';
import {recordOperation, describeOperation} from '../core/operation-record.js';
import {assertManagementIdle} from '../core/management-maintenance.js';
import {withStorageLock} from '../core/storage/coordination.js';
import {
  managementDirectory,
  managementHash,
  managementOverlay,
  privateManagementDirectory,
  readManagementJSON,
  saveManagementJSON,
} from '../core/management-installation.js';

export const managementDescriptor = (record) => ({
  source: 'management-updates',
  action: 'update-management',
  kind: 'update',
  state: record.state,
  phase: record.phase,
  message:
    record.state === 'succeeded'
      ? 'Management services were updated; application containers and storage were preserved.'
      : record.phase === 'rolled-back'
        ? 'Previous management services and metadata were restored. The update did not complete.'
        : 'Management update needs local operator recovery. No application operation is replayed from history.',
  recovery: {
    required: record.state === 'interrupted',
    actions:
      record.state === 'interrupted'
        ? [{id: 'inspect', label: 'Review operator update'}]
        : [],
  },
});

// One workflow-specific recovery record, using the same public operation model
// as ordinary jobs. Before every effect it saves intent; every retry inspects
// the real resource first. Original specifications stay in a separate private file.
export class ManagementUpdate {
  constructor({
    directory,
    installation,
    engine,
    actor = 'local-operator',
    save = saveManagementJSON,
  }) {
    Object.assign(this, {directory, installation, engine, actor, save});
    this.root = managementDirectory(directory);
  }
  async locked(work) {
    return withStorageLock(
      this.directory,
      'write',
      async () => {
        assert(
          !(await fs
            .lstat(path.join(this.directory, '.start.lock'))
            .catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            })),
          'The installation is starting. Wait before updating management.',
          409,
        );
        return work();
      },
      {timeout: 0},
    );
  }
  async load(id) {
    assert(
      /^[a-f0-9]{32}$/.test(id || ''),
      'Choose the retained management update ID.',
    );
    await privateManagementDirectory(this.root);
    const root = path.join(this.root, id);
    await privateManagementDirectory(root);
    const record = await readManagementJSON(path.join(root, 'operation.json'));
    const plan = await readManagementJSON(path.join(root, 'originals.json'));
    assert(
      record.version === 1 &&
        record.id === id &&
        record.fleet === this.installation.id &&
        record.installationHash === managementHash(this.installation) &&
        record.planHash === managementHash(plan),
      'Management update scope changed. Preserve its private records for review.',
      409,
    );
    assert(
      (await this.engine.identity()) === record.engine,
      'The selected Docker engine identity changed.',
      409,
    );
    return {record, plan, root};
  }
  async checkpoint(context, patch) {
    Object.assign(context.record, patch);
    recordOperation(context.record, managementDescriptor(context.record));
    await this.save(path.join(context.root, 'operation.json'), context.record);
  }
  async intent(context, pending, work) {
    await this.checkpoint(context, {pending, state: 'running'});
    const result = await work();
    await this.checkpoint(context, {pending: null});
    return result;
  }
  async plan(image, {id = crypto.randomBytes(16).toString('hex')} = {}) {
    assert(/^[a-f0-9]{32}$/.test(id), 'Invalid management review identity.');
    return this.locked(async () => {
      const stat = await fs.lstat(this.root).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) await privateManagementDirectory(this.root, {create: true});
      else await privateManagementDirectory(this.root);
      const retained = [];
      for (const name of await fs.readdir(this.root))
        if (/^[a-f0-9]{32}$/.test(name)) {
          const value = await this.load(name);
          assert(
            ['complete', 'rolled-back'].includes(value.record.phase) &&
              value.record.pending === null,
            'Recover the unfinished management update before planning another.',
            409,
          );
          retained.push({id: name, services: value.plan.services});
        }
      const plan = await this.engine.plan({
        fleet: this.installation.id,
        image,
        id,
        installation: this.installation,
        retained,
      });
      const root = path.join(this.root, id);
      await privateManagementDirectory(root, {create: true});
      await this.save(path.join(root, 'originals.json'), plan);
      const context = {
        root,
        plan,
        record: {
          version: 1,
          id,
          fleet: this.installation.id,
          engine: plan.engine,
          image: plan.image,
          actor: this.actor,
          installationHash: managementHash(this.installation),
          planHash: managementHash(plan),
          state: 'queued',
          phase: 'planned',
          started: new Date().toISOString(),
          commit: false,
          snapshotHash: null,
          pending: null,
        },
      };
      await this.checkpoint(context, {});
      return this.summary(context.record);
    });
  }
  summary(record) {
    return {
      id: record.id,
      fleet: record.fleet,
      engine: record.engine,
      image: record.image,
      commit: record.commit,
      pending: record.pending,
      operation: describeOperation(record, managementDescriptor(record)),
    };
  }
  async status(id) {
    return this.summary((await this.load(id)).record);
  }
  async verifyGames(context) {
    await this.engine.verifyGames(context.plan.games);
  }
  async receipt(context, complete) {
    const value = {
      version: 1,
      id: context.record.id,
      fleet: context.record.fleet,
      engine: context.record.engine,
      image: context.record.image,
      installationHash: context.record.installationHash,
      complete,
    };
    // The desired image becomes durable before any activation. Ordinary starts
    // refuse a pending receipt instead of reverting to the original Compose image.
    await this.save(path.join(this.root, 'active.json'), value);
    if (complete)
      await this.save(
        path.join(this.root, 'runtime.compose.json'),
        managementOverlay(this.installation, value),
      );
  }
  async run(id, {confirm = false, rollback = false} = {}) {
    assert(
      confirm === true,
      'Confirm the reviewed management update or recovery.',
    );
    return this.locked(async () => {
      const context = await this.load(id);
      const {record, plan} = context;
      if (['complete', 'rolled-back'].includes(record.phase)) {
        return this.release(plan, record);
      }
      assert(
        !rollback || !record.commit,
        'Management activation was committed. Resume forward; metadata rollback is no longer safe.',
        409,
      );
      try {
        await this.verifyGames(context);
        await this.intent(context, 'claim-fleet', () =>
          this.engine.acquire?.(plan),
        );
        if (
          rollback ||
          [
            'rolling-back',
            'restarting-originals',
            'publishing-rollback',
          ].includes(record.phase)
        )
          await this.rollback(context);
        else await this.forward(context);
        return this.release(plan, record);
      } catch (error) {
        await this.checkpoint(context, {state: 'interrupted'}).catch(() => {});
        // Do not expose original environment values or upstream Docker payloads.
        throw new Error(
          'Management update needs recovery. Keep the private record and snapshot; inspect update ' +
            id +
            ' before resuming or rolling back.',
          {cause: error},
        );
      } finally {
        await this.engine.close?.(plan);
      }
    });
  }
  async forward(context) {
    const {record, plan} = context;
    // Resuming after commit only inspects/activates/publishes. It can never enter
    // the snapshot, replacement or restore path again.
    if (!record.commit) {
      if (record.phase === 'planned') {
        await this.engine.verifyOriginals(plan);
        for (const service of plan.services)
          if (['host-controller', 'instance-controller'].includes(service.role))
            assertManagementIdle(
              (await this.engine.maintenance(service, 'status')).workflow,
            );
        await this.checkpoint(context, {phase: 'stopping'});
      }
      if (record.phase === 'stopping') {
        // Ingress first, then controller writers, and the broker last.
        for (const service of [...plan.services].sort(
          (a, b) => stopOrder(a) - stopOrder(b),
        )) {
          await this.intent(context, 'stop-' + service.name, () =>
            this.engine.stopOriginal(service),
          );
          await this.verifyGames(context);
        }
        await this.engine.assertQuiet(plan);
        await this.checkpoint(context, {phase: 'snapshot'});
      }
      if (record.phase === 'snapshot') {
        const snapshot = await this.intent(context, 'snapshot', () =>
          this.engine.storage(plan, 'backup'),
        );
        await this.checkpoint(context, {
          snapshotHash: snapshot.manifestHash,
          phase: 'replacing',
        });
      }
      if (record.phase === 'replacing') {
        await this.engine.storage(plan, 'verify', record.snapshotHash);
        for (const service of [...plan.services].sort(
          (a, b) => startOrder(a) - startOrder(b),
        )) {
          await this.intent(context, 'replace-' + service.name, () =>
            this.engine.replace(service, plan),
          );
          await this.verifyGames(context);
        }
        await this.checkpoint(context, {phase: 'verifying'});
      }
      assert(record.phase === 'verifying', 'Unknown management update phase.');
      await this.engine.verifyReplacements(plan, {held: true});
      await this.verifyGames(context);
      await this.checkpoint(context, {commit: true, phase: 'activating'});
    }
    for (const service of [...plan.services].sort(
      (a, b) => startOrder(a) - startOrder(b),
    ))
      if (this.engine.ensureReplacement)
        await this.intent(context, 'ensure-' + service.name, () =>
          this.engine.ensureReplacement(service, plan),
        );
    if (record.phase === 'activating') {
      await this.receipt(context, false);
      for (const service of [...plan.services].sort(
        (a, b) => startOrder(a) - startOrder(b),
      ))
        if (service.role !== 'docker-broker' && service.role !== 'host-gateway')
          await this.intent(context, 'activate-' + service.name, () =>
            this.engine.activate(service, plan),
          );
      await this.engine.verifyReplacements(plan, {held: false});
      await this.verifyGames(context);
      await this.checkpoint(context, {phase: 'publishing'});
    }
    assert(
      record.phase === 'publishing',
      'Unknown committed management update phase.',
    );
    await this.engine.verifyReplacements(plan, {held: false});
    await this.verifyGames(context);
    const terminal = structuredClone(record);
    Object.assign(terminal, {
      state: 'succeeded',
      phase: 'complete',
      pending: null,
      finished: new Date().toISOString(),
    });
    recordOperation(terminal, managementDescriptor(terminal));
    await this.intent(context, 'publish', () =>
      this.engine.publish(plan, terminal),
    );
    await this.receipt(context, true);
    await this.checkpoint(context, terminal);
  }
  async release(plan, record) {
    const context = {record, plan, root: path.join(this.root, record.id)};
    try {
      await this.checkpoint(context, {pending: 'cleanup'});
      await this.engine.release?.(plan, {
        removeOriginals: record.state === 'succeeded',
      });
      await this.checkpoint(context, {pending: null});
      return this.summary(record);
    } catch {
      return {...this.summary(record), cleanupRequired: true};
    }
  }
  async rollback(context) {
    const {record, plan} = context;
    assert(
      !record.commit,
      'Committed management updates recover forward only.',
      409,
    );
    if (
      !['restarting-originals', 'publishing-rollback'].includes(record.phase)
    ) {
      const untouched = record.phase === 'planned';
      await this.checkpoint(context, {phase: 'rolling-back'});
      if (!untouched) {
        for (const service of [...plan.services].sort(
          (a, b) => stopOrder(a) - stopOrder(b),
        )) {
          await this.intent(context, 'remove-replacement-' + service.name, () =>
            this.engine.removeReplacement(service, plan),
          );
          await this.intent(context, 'stop-original-' + service.name, () =>
            this.engine.stopOriginal(service),
          );
        }
        await this.engine.assertQuiet(plan);
        if (record.snapshotHash)
          await this.intent(context, 'restore-metadata', () =>
            this.engine.storage(plan, 'restore', record.snapshotHash),
          );
      }
      // Once originals restart, later recovery only completes starts/publication;
      // an old snapshot cannot overwrite newly resumed management activity.
      await this.checkpoint(context, {phase: 'restarting-originals'});
    }
    if (record.phase === 'restarting-originals') {
      for (const service of [...plan.services].sort(
        (a, b) => startOrder(a) - startOrder(b),
      ))
        await this.intent(context, 'restore-' + service.name, () =>
          this.engine.restoreOriginal(service),
        );
      await this.checkpoint(context, {phase: 'publishing-rollback'});
    }
    await this.engine.verifyOriginals(plan);
    await this.verifyGames(context);
    const terminal = structuredClone(record);
    Object.assign(terminal, {
      state: 'failed',
      phase: 'rolled-back',
      pending: null,
      finished: new Date().toISOString(),
    });
    recordOperation(terminal, managementDescriptor(terminal));
    await this.intent(context, 'publish-rollback', () =>
      this.engine.publish(plan, terminal),
    );
    await this.checkpoint(context, terminal);
  }
}
const stopOrder = (service) =>
  ({
    'host-gateway': 0,
    'host-web': 1,
    'host-agent-web': 1,
    'instance-controller': 2,
    'host-controller': 3,
    'docker-broker': 4,
  })[service.role];
const startOrder = (service) =>
  ({
    'docker-broker': 0,
    'host-controller': 1,
    'instance-controller': 2,
    'host-web': 3,
    'host-agent-web': 3,
    'host-gateway': 4,
  })[service.role];
