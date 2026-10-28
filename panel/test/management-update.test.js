import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ManagementUpdate} from '../fleet/management-update.js';
import {
  publishManagementOutcome,
  managementUpdateSource,
} from '../fleet/management-outcome.js';
import {
  assertManagementStartAllowed,
  managementInstallationRuntime,
  saveManagementJSON,
  readManagementJSON,
} from '../core/management-installation.js';
import {AuditLog} from '../core/audit.js';

async function fixture(t, options = {}) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-management-update-')),
  );
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const installation = {
    id: 'a'.repeat(32),
    options: {image: 'original-runtime'},
  };
  const image = 'sha256:' + 'b'.repeat(64),
    engineId = crypto.randomUUID();
  const services = [
    'docker-broker',
    'host-controller',
    'instance-controller',
    'host-web',
  ].map((role, index) => ({
    id: 'original-' + index,
    name: 'service-' + index,
    role,
    privateEnvironment: 'never-public-controller-token',
  }));
  const originals = new Set(services.map((service) => service.id));
  const replacements = new Set(),
    active = new Set(),
    mutations = [];
  let saved,
    snapshot = false,
    changedGame = false;
  const fail = async (point) => {
    await options.at?.(point, {
      directory,
      saved,
      originals,
      replacements,
      active,
      mutations,
    });
  };
  const engine = {
    identity: async () => engineId,
    plan: async ({id}) => ({
      id,
      fleet: installation.id,
      engine: engineId,
      image,
      services,
      games: [{id: 'protected-game', bytes: 'unchanged-world'}],
    }),
    verifyGames: async () => {
      assert.equal(changedGame, false);
    },
    verifyOriginals: async () => {
      assert.equal(originals.size, services.length);
    },
    maintenance: async () => ({
      workflow: {version: 1, sources: [{available: true}], operations: []},
    }),
    stopOriginal: async (service) => {
      if (originals.delete(service.id)) mutations.push('stop:' + service.role);
    },
    assertQuiet: async () => assert.equal(originals.size, 0),
    storage: async (_plan, operation) => {
      if (operation === 'backup' && !snapshot) {
        mutations.push('snapshot');
        snapshot = true;
      }
      if (operation === 'restore') mutations.push('restore-metadata');
      await fail(operation);
      return {manifestHash: 'd'.repeat(64)};
    },
    replace: async (service) => {
      if (!replacements.has(service.id)) {
        replacements.add(service.id);
        mutations.push('replace:' + service.role);
        await fail('replace:' + service.role);
      }
    },
    verifyReplacements: async (_plan, {held}) => {
      assert.equal(replacements.size, services.length);
      if (!held) assert.equal(active.size, 3);
      await fail(held ? 'verify-held' : 'verify-active');
    },
    activate: async (service) => {
      const record = await readManagementJSON(
        path.join(directory, '.management-updates', saved.id, 'operation.json'),
      );
      assert.equal(record.commit, true);
      const receipt = await readManagementJSON(
        path.join(directory, '.management-updates', 'active.json'),
      );
      assert.equal(receipt.complete, false);
      if (!active.has(service.id)) {
        active.add(service.id);
        mutations.push('activate:' + service.role);
        await fail('activate:' + service.role);
      }
    },
    removeReplacement: async (service) => {
      replacements.delete(service.id);
      active.delete(service.id);
    },
    restoreOriginal: async (service) => {
      if (!originals.has(service.id)) {
        originals.add(service.id);
        mutations.push('restart:' + service.role);
      }
    },
    publish: async (_plan, record) => {
      await fail('publish');
      mutations.push('publish:' + record.phase);
    },
  };
  const workflow = new ManagementUpdate({
    directory,
    installation,
    engine,
    ...(options.save ? {save: options.save} : {}),
  });
  saved = await workflow.plan(image);
  return {
    directory,
    installation,
    engine,
    workflow,
    id: saved.id,
    mutations,
    image,
    changeGame: () => {
      changedGame = true;
    },
  };
}

test('operator management update preserves the application and records a restart-safe runtime without modifying installer files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.directory, 'installation-sentinel'),
    'original installer bytes',
  );
  const result = await f.workflow.run(f.id, {confirm: true});
  assert.equal(result.operation.state, 'succeeded');
  assert.equal(result.commit, true);
  assert.ok(
    f.mutations.indexOf('stop:host-web') <
      f.mutations.indexOf('stop:host-controller'),
  );
  assert.ok(
    f.mutations.indexOf('replace:docker-broker') <
      f.mutations.indexOf('replace:host-controller'),
  );
  assert.equal(
    (await managementInstallationRuntime(f.directory, f.installation)).image,
    f.image,
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, 'installation-sentinel'), 'utf8'),
    'original installer bytes',
  );
  const before = [...f.mutations];
  await f.workflow.run(f.id, {confirm: true});
  assert.deepEqual(f.mutations, before);
  assert.ok(!JSON.stringify(result).includes('never-public'));
  assert.equal(
    (
      await fs.stat(
        path.join(f.directory, '.management-updates', f.id, 'originals.json'),
      )
    ).mode & 0o777,
    0o600,
  );
});

test('lost replacement response is reconciled before continuing and never creates the same service twice', async (t) => {
  let once = true;
  const f = await fixture(t, {
    at: (point) => {
      if (point === 'replace:host-controller' && once) {
        once = false;
        throw Error('lost response');
      }
    },
  });
  await assertManagementStartAllowed(f.directory);
  await assert.rejects(f.workflow.run(f.id, {confirm: true}), /needs recovery/);
  assert.equal((await f.workflow.status(f.id)).commit, false);
  await assert.rejects(
    assertManagementStartAllowed(f.directory),
    /retained management update/,
  );
  const recovered = new ManagementUpdate({
    directory: f.directory,
    installation: f.installation,
    engine: f.engine,
  });
  assert.equal(
    (await recovered.run(f.id, {confirm: true})).operation.state,
    'succeeded',
  );
  assert.equal(
    f.mutations.filter((value) => value === 'replace:host-controller').length,
    1,
  );
  await assertManagementStartAllowed(f.directory);
});

test('pre-activation failure restores original metadata once; failed rollback publication never restores over resumed writes', async (t) => {
  let verification = true,
    publication = true;
  const f = await fixture(t, {
    at: (point) => {
      if (point === 'verify-held' && verification) {
        verification = false;
        throw Error('failed verification');
      }
      if (point === 'publish' && publication) {
        publication = false;
        throw Error('failed publication');
      }
    },
  });
  await assert.rejects(f.workflow.run(f.id, {confirm: true}));
  await assert.rejects(f.workflow.run(f.id, {confirm: true, rollback: true}));
  assert.equal(
    (await f.workflow.status(f.id)).operation.phase,
    'publishing-rollback',
  );
  assert.equal(
    (await f.workflow.run(f.id, {confirm: true})).operation.state,
    'failed',
  );
  assert.equal(
    f.mutations.filter((value) => value === 'restore-metadata').length,
    1,
  );
  for (const role of [
    'docker-broker',
    'host-controller',
    'instance-controller',
    'host-web',
  ])
    assert.equal(
      f.mutations.filter((value) => value === 'restart:' + role).length,
      1,
    );
});

test('committed activation only recovers forward, with no repeated snapshot, replacement or activation after a lost response', async (t) => {
  let once = true;
  const f = await fixture(t, {
    at: (point) => {
      if (point === 'activate:host-controller' && once) {
        once = false;
        throw Error('lost activation reply');
      }
    },
  });
  await assert.rejects(f.workflow.run(f.id, {confirm: true}));
  const pending = await f.workflow.status(f.id);
  assert.equal(pending.commit, true);
  await assert.rejects(
    f.workflow.run(f.id, {confirm: true, rollback: true}),
    /Resume forward/,
  );
  await assert.rejects(
    managementInstallationRuntime(f.directory, f.installation),
    /operator recovery/,
  );
  assert.equal(
    (await f.workflow.run(f.id, {confirm: true})).operation.state,
    'succeeded',
  );
  assert.equal(
    f.mutations.filter((value) => value === 'activate:host-controller').length,
    1,
  );
  assert.equal(f.mutations.filter((value) => value === 'snapshot').length, 1);
  assert.equal(
    f.mutations.filter((value) => value === 'restore-metadata').length,
    0,
  );
});

test('publication recovery repairs metadata without replaying an activated update', async (t) => {
  let once = true;
  const f = await fixture(t, {
    at: (point) => {
      if (point === 'publish' && once) {
        once = false;
        throw Error('disk full');
      }
    },
  });
  await assert.rejects(f.workflow.run(f.id, {confirm: true}));
  const before = f.mutations.filter((value) => !value.startsWith('publish:'));
  assert.equal(
    (await f.workflow.run(f.id, {confirm: true})).operation.state,
    'succeeded',
  );
  assert.deepEqual(
    f.mutations.filter((value) => !value.startsWith('publish:')),
    before,
  );
});

test('a failed durable intent prevents its effect; changed private plans, engines and application identity fail closed', async (t) => {
  let refuse = false;
  const f = await fixture(t, {
    save: async (file, value) => {
      if (refuse && value.pending?.startsWith('stop-'))
        throw Error('disk full');
      await saveManagementJSON(file, value);
    },
  });
  refuse = true;
  await assert.rejects(f.workflow.run(f.id, {confirm: true}));
  assert.deepEqual(f.mutations, []);
  refuse = false;
  f.changeGame();
  await assert.rejects(f.workflow.run(f.id, {confirm: true}));
  assert.deepEqual(f.mutations, []);
  const file = path.join(
    f.directory,
    '.management-updates',
    f.id,
    'originals.json',
  );
  const value = await readManagementJSON(file);
  value.image = 'changed';
  await saveManagementJSON(file, value);
  await assert.rejects(f.workflow.status(f.id), /scope changed/);
});

test('concurrent operators are excluded by the existing coordination lease', async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const f = await fixture(t, {
    at: async (point) => {
      if (point === 'backup') {
        entered();
        await gate;
      }
    },
  });
  const running = f.workflow.run(f.id, {confirm: true});
  await ready;
  try {
    await assert.rejects(
      f.workflow.run(f.id, {confirm: true}),
      /busy|interrupted writer/,
    );
  } finally {
    release();
  }
  await running;
});

test('public outcome publication retains uncertainty on audit failure, deduplicates retry and excludes private operator data', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-management-outcome-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const id = 'e'.repeat(32),
    audit = new AuditLog(root),
    value = {
      id,
      actor: 'operator',
      state: 'succeeded',
      phase: 'complete',
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
    };
  let once = true;
  const append = audit.append.bind(audit);
  audit.append = async (...args) => {
    if (once) {
      once = false;
      throw Error('full disk');
    }
    return append(...args);
  };
  await assert.rejects(
    publishManagementOutcome(root, structuredClone(value), {audit}),
  );
  const source = managementUpdateSource(root);
  assert.equal((await source.read())[0].state, 'interrupted');
  await publishManagementOutcome(root, structuredClone(value), {audit});
  await publishManagementOutcome(root, structuredClone(value), {audit});
  assert.equal((await source.read())[0].state, 'succeeded');
  assert.equal((await audit.list()).events.length, 1);
  await assert.rejects(
    publishManagementOutcome(root, {...value, environment: 'never-public'}),
  );
  await assert.rejects(
    source.recover({id, operation: 'acknowledge'}),
    /local operator/,
  );
});

test('a retained engine claim cannot replace a confirmed outcome with failure', async (t) => {
  const f = await fixture(t);
  let fail = true;
  f.engine.release = async () => {
    if (fail) throw Error('Lost cleanup reply');
  };
  const result = await f.workflow.run(f.id, {confirm: true});
  assert.equal(result.operation.state, 'succeeded');
  assert.equal(result.cleanupRequired, true);
  await assert.rejects(assertManagementStartAllowed(f.directory), /cleanup/);
  await assert.rejects(f.workflow.plan(f.image), /unfinished management update/);
  assert.equal(
    (await managementInstallationRuntime(f.directory, f.installation)).image,
    f.image,
  );
  fail = false;
  assert.equal(
    (await f.workflow.run(f.id, {confirm: true})).cleanupRequired,
    undefined,
  );
  await assertManagementStartAllowed(f.directory);
});

test('an interrupted update retains a safe reason and phase through restart without exposing its cause',async t=>{
  const {ManagementFailure}=await import('../core/management-errors.js');
  const f=await fixture(t,{at:async point=>{if(point==='backup')throw new ManagementFailure('docker-socket-unverified',{cause:Error('private-token /operator/secret')});}});
  await assert.rejects(f.workflow.run(f.id,{confirm:true}),/needs recovery/);
  const status=await f.workflow.status(f.id);
  assert.equal(status.diagnostic.code,'docker-socket-unverified');
  assert.doesNotMatch(JSON.stringify(status),/private-token|operator\/secret/);
  assert.equal(status.operation.state,'interrupted');
  assert.equal(status.operation.phase,'snapshot');
});
