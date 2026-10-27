import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './rust-software-fixture.mjs';
import {createModManager} from '../applications/rust/mods.js';
import {createRustFrameworkChanges} from '../applications/rust/framework-changes.js';

async function paired(t) {
  const f = await fixture(t);
  await f.software.ensure();
  const world = path.join(
    f.ctx.config.data,
    f.ctx.config.identity,
    'world.sav',
  );
  await fs.writeFile(world, 'BEFORE FRAMEWORK CHANGE');
  const mods = createModManager({
    root: f.ctx.config.installRoot,
    state: f.ctx.config.state,
    assertStopped: f.software.maintenance.stopped,
  });
  let failure = null;
  f.ctx.host.control = async (action) => {
    assert.equal(action, 'stop');
    f.runtime.running = false;
  };
  const create = () =>
    createRustFrameworkChanges(f.ctx, {
      software: f.software,
      mods,
      protocol: async () => '2635.289.1',
      validate: async () => {},
      fault: async (phase) => {
        if (failure === phase) {
          failure = null;
          throw Error('Injected ' + phase);
        }
      },
    });
  return {
    ...f,
    mods,
    world,
    createChanges: create,
    changes: create(),
    fail: (phase) => {
      failure = phase;
    },
    plan: async () => (await create().plan('none')).id,
  };
}
test('paired framework preparation keeps a complete independent world and requires explicit validation before other changes', async (t) => {
  const f = await paired(t);
  await f.changes.prepare(await f.plan(), {id: 'actor-job'});
  assert.equal((await f.changes.inspect()).phase, 'prepared');
  await assert.rejects(
    f.changes.guard('save-settings'),
    /validation or recovery/,
  );
  await f.changes.guard('start');
  assert.equal(f.runtime.running, false);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE FRAMEWORK CHANGE');
  await f.changes.start(async () => {
    f.runtime.running = true;
    return 'ready';
  });
  assert.equal((await f.changes.inspect()).phase, 'complete');
  await f.changes.guard('save-settings');
  await f.create().ensure();
});
for (const phase of [
  'reserved',
  'snapshotting',
  'staging',
  'publishing',
  'previous-engine-held',
  'previous-mods-held',
  'candidate-published',
  'prepared',
]) {
  test(
    'paired framework interruption at ' +
      phase +
      ' restores or retains the previous pair',
    async (t) => {
      const f = await paired(t),
        plan = await f.plan();
      f.fail(phase);
      await assert.rejects(f.changes.prepare(plan), /Injected/);
      const changes = f.createChanges(),
        review = await changes.inspect();
      await assert.rejects(changes.guard('plugin'), /validation or recovery/);
      await changes.recover({confirm: true, review: review.review});
      assert.equal((await changes.inspect()).phase, 'recovered');
      assert.equal(
        await fs.readFile(f.world, 'utf8'),
        'BEFORE FRAMEWORK CHANGE',
      );
      await f.create().ensure();
    },
  );
}
for (const step of [
  'quarantine-world',
  'restore-world',
  'quarantine-mods',
  'restore-mods',
  'quarantine-engine',
  'restore-engine',
]) {
  test(
    'paired recovery resumes after rename ' + step + ' and retains newer data',
    async (t) => {
      const f = await paired(t);
      await f.changes.prepare(await f.plan());
      await fs.writeFile(f.world, 'NEWER SAVED WORLD');
      f.fail('moved-' + step);
      const reviewed = await f.changes.inspect();
      await assert.rejects(
        f.changes.recover({confirm: true, review: reviewed.review}),
        /Injected/,
      );
      const changes = f.createChanges(),
        next = await changes.inspect();
      await changes.recover({confirm: true, review: next.review});
      assert.equal(
        await fs.readFile(f.world, 'utf8'),
        'BEFORE FRAMEWORK CHANGE',
      );
      const quarantine = path.join(
        f.ctx.config.state,
        'software/rust/framework-changes/history',
        next.observation.record.id,
        'quarantine-world',
        f.ctx.config.identity,
        'world.sav',
      );
      assert.equal(await fs.readFile(quarantine, 'utf8'), 'NEWER SAVED WORLD');
      await f.create().ensure();
    },
  );
}
test('paired recovery refuses changed observations and damaged backups before world replacement', async (t) => {
  const f = await paired(t);
  await f.changes.prepare(await f.plan());
  let review = await f.changes.inspect();
  await assert.rejects(
    f.changes.recover({confirm: true, review: 'a'.repeat(64)}),
    /observations changed/,
  );
  const backup = path.join(
    f.ctx.config.state,
    'software/rust/framework-changes/history',
    review.observation.record.id,
    'world',
    f.ctx.config.identity,
    'world.sav',
  );
  await fs.writeFile(backup, 'DAMAGED');
  review = await f.changes.inspect();
  await assert.rejects(
    f.changes.recover({confirm: true, review: review.review}),
    /verification/,
  );
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE FRAMEWORK CHANGE');
});

test('a failed post-start validation stops the new server and restores its pre-start world', async (t) => {
  const f = await paired(t);
  await f.changes.prepare(await f.plan());
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.start(async () => {
      f.runtime.running = true;
      await fs.writeFile(f.world, 'NEW SAVE FROM VALIDATION');
    }),
    /Injected/,
  );
  assert.equal(f.runtime.running, false);
  assert.equal((await f.changes.inspect()).phase, 'validating');
  const review = await f.changes.inspect();
  await f.changes.recover({confirm: true, review: review.review});
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE FRAMEWORK CHANGE');
});

test('an interrupted recovery copy is retained and a fresh verified copy can finish recovery', async (t) => {
  const f = await paired(t);
  await f.changes.prepare(await f.plan());
  await fs.writeFile(f.world, 'NEWER WORLD');
  f.fail('data-file');
  let review = await f.changes.inspect();
  await assert.rejects(
    f.changes.recover({confirm: true, review: review.review}),
    /Injected/,
  );
  const changes = f.createChanges();
  review = await changes.inspect();
  await changes.recover({confirm: true, review: review.review});
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE FRAMEWORK CHANGE');
  const directory = path.join(
    f.ctx.config.state,
    'software/rust/framework-changes/history',
    review.observation.record.id,
  );
  assert.ok(
    (await fs.readdir(directory)).some((name) =>
      name.startsWith('partial-world-'),
    ),
  );
});
