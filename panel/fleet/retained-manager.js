import fs from 'node:fs/promises';
import {hostWorkerLifecycle} from './worker-lifecycle.js';
import {retainOperationDiagnostic} from '../core/operation-diagnostics.js';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert, readJSON, writeJSON} from '../common.js';
import {resources, labels, validateCreation} from './catalog.js';
import {regularFile, parseStorageJSON} from '../core/storage/files.js';
import {storageWorkerError} from './storage-worker.js';

const digest = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class RetainedStorage {
  constructor(manager) {
    this.manager = manager;
  }
  source(id) {
    const item = this.manager.server(id);
    assert(
      item.state === 'removed',
      'Storage management is limited to removed servers.',
      409,
    );
    return item;
  }
  async available(item) {
    const m = this.manager,
      expected = resources(m.fleet, item.id, item.game);
    assert(
      item.volume === expected.volume,
      'Retained volume identity requires manual review.',
      409,
    );
    const info = await m.ownedVolume(item.volume, item.id);
    assert(
      info.Name === item.volume &&
        info.Driver === 'local' &&
        info.Scope === 'local' &&
        (!info.Options || !Object.keys(info.Options).length) &&
        info.Labels?.['io.lobby-goblin.game'] === item.game &&
        typeof info.CreatedAt === 'string',
      'Retained storage ownership or driver requires manual review.',
      409,
    );
    for (const name of [expected.container, expected.controller]) {
      let found = false;
      try {
        await m.ownedContainer(name, item.id);
        found = true;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      assert(
        !found,
        'A server container still exists. Complete removal before managing its storage.',
        409,
      );
    }
    const refs = await m.docker(
      'GET',
      '/containers/json?' +
        new URLSearchParams({
          all: '1',
          filters: JSON.stringify({volume: [item.volume]}),
        }),
    );
    assert(
      !refs.length,
      'A container still uses this volume. Storage was preserved.',
      409,
    );
    return digest({
      Name: info.Name,
      Driver: info.Driver,
      Scope: info.Scope,
      Options: info.Options || {},
      Labels: info.Labels,
      CreatedAt: info.CreatedAt,
    });
  }
  review(item, input) {
    const review = item.storageReview;
    assert(
      input.confirm === true && input.name === item.name,
      'Type the removed server name to confirm this storage operation.',
    );
    assert(
      review?.token &&
        input.reviewToken === review.token &&
        Date.now() - Date.parse(review.inspectedAt) < 15 * 60 * 1000,
      'Inspect the retained storage again before continuing.',
      409,
    );
    return review;
  }
  async helper(item, config, target = null) {
    const m = this.manager,
      requestId = crypto.randomBytes(16).toString('hex'),
      directory = path.join(m.root, 'requests', requestId),
      name = 'lobby-goblin-worker-' + requestId;
    await fs.mkdir(directory, {recursive: true});
    await writeJSON(path.join(directory, 'request.json'), {
      ...config,
      fleet: m.fleet,
      sourceId: item.id,
      game: item.game,
      seed: item.seed,
      worldSize: item.worldSize,
      softwareMode: item.softwareMode,
    });
    const mounts = [
      {
        Type: 'volume',
        Source: m.stateVolume,
        Target: '/setup',
        VolumeOptions: {Subpath: 'requests/' + requestId},
      },
      {Type: 'volume', Source: item.volume, Target: '/source', ReadOnly: true},
    ];
    if (target)
      mounts.push({Type: 'volume', Source: target.volume, Target: '/instance'});
    const lifecycle = await hostWorkerLifecycle(m,name,target?.id || item.id);
    let createdId = null, retainRequest = false, creationAttempted = false;
    try {
      creationAttempted = true;
      const reservation = await m.docker(
        'POST',
        '/containers/create?' + new URLSearchParams({name}),
        {
          Image: m.runtimeImage || m.image,
          User: '0:0',
          Entrypoint: ['node', '/app/fleet/retained-worker.js'],
          Labels: {
            ...labels(m.fleet, target?.id || item.id, item.game),
            'io.lobby-goblin.worker': 'true',
            'io.lobby-goblin.retained-source': item.id,
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            CapAdd: target
              ? ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']
              : ['DAC_OVERRIDE'],
            SecurityOpt: ['no-new-privileges:true'],
            Memory: 512 * 1024 ** 2,
            NanoCpus: 1e9,
            Mounts: mounts,
          },
        },
      );
      await lifecycle.created(reservation.Id);
      createdId = reservation.Id;
      await m.docker('POST', `/containers/${name}/start`);
      const result = await m.docker(
        'POST',
        `/containers/${name}/wait?condition=not-running`,
        undefined,
        {timeout: 3600000},
      );
      if (result.StatusCode !== 0) {
        const worker = await m.ownedContainer(name, target?.id || item.id);
        let failure = null;
        try {
          const bytes = await regularFile(
            path.join(directory, 'failure.json'),
            {optional: true, max: 65536},
          );
          if (bytes) failure = parseStorageJSON(bytes);
        } catch {}
        await lifecycle.collected(result.StatusCode);
        throw storageWorkerError(failure, {oomKilled: worker.State?.OOMKilled, exitCode: result.StatusCode});
      }
      const output = await readJSON(path.join(directory, 'result.json'), null);
      await lifecycle.collected(result.StatusCode);
      return output;
    } catch(error) {
      const diagnostic = await retainOperationDiagnostic(m.root,error,{id:m.active.id,source:'host-operations',phase:m.active.phase||'executing'});
      retainRequest = !diagnostic.retained;
      throw error;
    } finally {
      await lifecycle.teardown(async()=>{if (createdId) {
        const worker = await m.ownedContainer(createdId, target?.id || item.id);
        if (worker.State?.Running)
          await m.docker('POST', `/containers/${createdId}/stop?t=15`);
        await m.docker('DELETE', `/containers/${createdId}`);
        await lifecycle.removed();
      } else if (creationAttempted) {retainRequest = true;await lifecycle.review();}
      });
      if (!retainRequest) await fs.rm(directory, {recursive: true, force: true});
    }
  }
  async inspect(input, job) {
    const m = this.manager,
      item = this.source(input.serverId);
    delete item.storageReview;
    await m.persist();
    await m.stage(
      job,
      'Inspecting retained storage without changing its contents…',
      'inspecting-storage',
      {serverId: item.id},
    );
    let identity;
    try {
      identity = await this.available(item);
    } catch (error) {
      item.storageStatus = {
        state: error.status === 404 ? 'missing' : 'unavailable',
        message:
          error.status === 404
            ? 'The volume is absent from this host.'
            : error.message,
        checkedAt: new Date().toISOString(),
      };
      await m.persist();
      throw error;
    }
    const result = await this.helper(item, {action: 'inspect'});
    assert(
      identity === (await this.available(item)),
      'Storage ownership changed during inspection. Inspect it again.',
      409,
    );
    item.storageStatus = {
      state: 'retained',
      checkedAt: new Date().toISOString(),
    };
    item.storageReview = {
      ...result,
      identity,
      token: crypto.randomBytes(32).toString('hex'),
      inspectedAt: new Date().toISOString(),
    };
    await m.persist();
    return {
      serverId: item.id,
      message:
        'Retained storage inspected. Review recovery or permanent deletion in Storage.',
    };
  }
  async current(item, input) {
    const review = this.review(item, input);
    assert(
      (await this.available(item)) === review.identity,
      'Storage ownership changed. Inspect it again.',
      409,
    );
    const latest = await this.helper(item, {action: 'inspect'});
    assert(
      latest.fingerprint === review.fingerprint,
      'Storage contents changed. Inspect them again.',
      409,
    );
    assert(
      (await this.available(item)) === review.identity,
      'Storage ownership changed. Inspect it again.',
      409,
    );
    return {...review, recovery: latest.recovery};
  }
  async remove(input, job) {
    const m = this.manager,
      item = this.source(input.serverId);
    await this.current(item, input);
    await m.stage(
      job,
      'Permanently deleting only the reviewed retained volume…',
      'deleting-storage',
      {serverId: item.id},
    );
    await m.docker('DELETE', '/volumes/' + encodeURIComponent(item.volume));
    item.storageDeletedAt = new Date().toISOString();
    item.storageStatus = {state: 'deleted', checkedAt: item.storageDeletedAt};
    delete item.storageReview;
    await m.persist();
    return {
      serverId: item.id,
      message:
        'Retained volume permanently deleted. Shared snapshots were kept.',
    };
  }
  async recover(input, job) {
    const m = this.manager,
      item = this.source(input.serverId),
      review = await this.current(item, input);
    assert(
      review.recovery.ready,
      review.recovery.reason || 'This storage needs manual recovery review.',
      409,
    );
    const creation = validateCreation(
      {
        ...item,
        name: input.newName,
        seed: review.recovery.seed ?? item.seed,
        snapshotId: null,
        autoStart: false,
      },
      [...m.modules.values()],
    );
    return m.create(creation, job, {
      source: item,
      review,
      nonce: crypto.randomBytes(32).toString('hex'),
    });
  }
}
