import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './rust-software-fixture.mjs';
import {createModManager} from '../applications/rust/mods.js';
import {createRust} from '../applications/rust/controller.js';
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

test('the Mods endpoint exposes paired recovery while execution storage is held privately', async (t) => {
  const f = await paired(t);
  f.fail('previous-engine-held');
  await assert.rejects(f.changes.prepare(await f.plan()), /Injected/);
  await assert.rejects(fs.access(f.ctx.config.installRoot));
  f.ctx.docker = async (method, route) => {
    assert.equal(method, 'GET');
    assert.match(route, /^\/images\//);
    return {
      Config: {
        Labels: {
          'io.lobby-goblin.rust-mods': '1',
          'io.lobby-goblin.mod-data': '1',
        },
      },
    };
  };
  const game = await createRust(f.ctx);
  let result;
  await game.handle(
    {method: 'GET'},
    {
      writeHead: (code) => assert.equal(code, 200),
      end: (body) => {
        result = JSON.parse(body);
      },
    },
    new URL('http://localhost/mods'),
  );
  assert.equal(result.available, true);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.pairedRecovery, true);
  assert.equal(result.pairedPending, true);
  assert.equal(result.editable, false);
  assert.match(result.message, /recover the previous software and world/);
});

test('orphan software coordination blocks framework preparation before a paired journal is opened', async (t) => {
  const f = await paired(t),
    plan = await f.plan();
  await fs.mkdir(
    path.join(f.ctx.config.state, 'software/rust/.panel-storage-lock'),
  );
  await assert.rejects(f.changes.prepare(plan), /coordination/);
  assert.equal((await f.changes.inspect()).pending, false);
});

test('outside framework edits and unmanaged loaders fail before paired publication and remain intact', async (t) => {
  for (const managed of [false, true]) {
    const f = await paired(t),
      name = managed ? 'carbon/managed/Carbon.Preloader.dll' : 'libdoorstop.so';
    const target = path.join(f.ctx.config.installRoot, name);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, 'OUTSIDE EDIT');
    if (managed) {
      await fs.mkdir(path.join(f.ctx.config.state, 'mods'), {recursive: true});
      await fs.writeFile(
        path.join(f.ctx.config.state, 'mods/installed.json'),
        JSON.stringify({
          format: 1,
          framework: 'carbon',
          files: [{name, sha256: 'a'.repeat(64), original: null}],
        }),
      );
    }
    await assert.rejects(
      f.changes.prepare(await f.plan()),
      managed ? /changed outside the panel/ : /unmanaged framework/,
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'OUTSIDE EDIT');
    assert.equal((await f.changes.inspect()).pending, false);
  }
});

test('framework publication preserves plugin-library identities and history; recovery restores the matching metadata', async (t) => {
  const f = await paired(t),
    library = path.join(f.ctx.config.state, 'mods/mod-library');
  const tracked = {
    'carbon/example': {
      id: 'example',
      name: 'Example.cs',
      source: 'umod',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
    },
  };
  await fs.mkdir(path.join(library, 'history'), {recursive: true, mode: 0o700});
  await fs.writeFile(
    path.join(library, 'installed.json'),
    JSON.stringify(tracked),
    {mode: 0o600},
  );
  await fs.writeFile(
    path.join(library, 'history/stable-record.json'),
    'LIBRARY HISTORY',
    {mode: 0o600},
  );
  await f.changes.prepare(await f.plan());
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(library, 'installed.json'))),
    tracked,
  );
  assert.equal(
    await fs.readFile(path.join(library, 'history/stable-record.json'), 'utf8'),
    'LIBRARY HISTORY',
  );
  const review = await f.changes.inspect(),
    previous = path.join(
      f.ctx.config.state,
      'software/rust/framework-changes/history',
      review.observation.record.id,
      'previous-mods/mod-library/installed.json',
    );
  assert.notEqual(
    (await fs.stat(previous)).ino,
    (await fs.stat(path.join(library, 'installed.json'))).ino,
  );
  await fs.writeFile(
    path.join(library, 'installed.json'),
    '{"newer":"controller metadata"}',
  );
  const next = await f.changes.inspect();
  await f.changes.recover({confirm: true, review: next.review});
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(library, 'installed.json'))),
    tracked,
  );
});
