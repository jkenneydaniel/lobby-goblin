import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './rust-software-fixture.mjs';
import {protocolModule} from './fixtures/cli-metadata/protocol.mjs';
import {softwareSelectionKey} from '../core/software-installation.js';
import {createModManager} from '../applications/rust/mods.js';
import {createRustFrameworkChanges} from '../applications/rust/framework-changes.js';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {carbonHookPaths} from '../applications/rust/mod-layout.js';
import {readRecord} from '../providers/steamcmd/files.js';

function carbonArchive() {
  const files = [
      ['libdoorstop.so', 'LOADER'],
      ['carbon/managed/Carbon.Preloader.dll', 'PRELOADER'],
      ...carbonHookPaths.map((name) => [name, 'SYNTHETIC HOOK ' + name]),
    ],
    chunks = [];
  for (const [name, text] of files) {
    const bytes = Buffer.from(text),
      header = Buffer.alloc(512),
      number = (at, length, value) =>
        header.write(
          value.toString(8).padStart(length - 1, '0') + '\0',
          at,
          length,
        );
    header.write(name);
    number(100, 8, 0o644);
    number(124, 12, bytes.length);
    header[156] = 48;
    header.fill(32, 148, 156);
    header.write('ustar\0', 257);
    number(
      148,
      8,
      header.reduce((a, b) => a + b, 0),
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function updates(t, {fetcher = fetch} = {}) {
  const f = await fixture(t, {
    module: (build) =>
      protocolModule({values: [build === '123' ? 2635 : 2636, 289, 1]}),
  });
  await f.software.ensure();
  const world = path.join(
    f.ctx.config.data,
    f.ctx.config.identity,
    'world.sav',
  );
  await fs.writeFile(world, 'BEFORE BUILD 123');
  const mods = createModManager({
    root: f.ctx.config.installRoot,
    state: f.ctx.config.state,
    assertStopped: f.software.maintenance.stopped,
    fetcher,
  });
  await mods.assertReady();
  let failure = null,
    predicate = () => true,
    probes = 0,
    stops = 0;
  const file = path.join(
    f.ctx.config.state,
    'software/rust/framework-changes/current.json',
  );
  f.ctx.host.control = async (action) => {
    assert.equal(action, 'stop');
    f.runtime.running = false;
  };
  const create = () =>
    createRustFrameworkChanges(f.ctx, {
      software: f.software,
      mods,
      fetcher,
      protocol: async () => '2635.289.1',
      validate: async () => {},
      validateSoftware: async (evidence) => {
        assert.equal(evidence.buildId, '124');
        assert.equal(evidence.protocol, '2636.289.1');
        probes++;
      },
      fault: async (phase) => {
        if (
          failure === phase &&
          (await predicate(await readRecord(file, {optional: true})))
        ) {
          failure = null;
          throw Error('Injected ' + phase);
        }
      },
    });
  const stop = async () => {
    stops++;
    f.runtime.running = false;
  };
  const run = async () => {
    assert.equal((await f.software.receipt()).selection.softwareVersion, '124');
    await fs.writeFile(world, 'NEWER BUILD 124 SAVE');
    f.runtime.running = true;
    return 'updated';
  };
  const check = async () => {
    f.runtime.build = '124';
    return create().checkSoftware({id: 'check'});
  };
  return {
    ...f,
    mods,
    world,
    file,
    createChanges: create,
    changes: create(),
    stop,
    run,
    check,
    probes: () => probes,
    stops: () => stops,
    fail: (phase, when = () => true) => {
      failure = phase;
      predicate = when;
    },
  };
}

test('exact Steam review does not stop or alter a running world; update validates and preserves running intent', async (t) => {
  const f = await updates(t);
  f.runtime.running = true;
  const review = await f.check();
  assert.equal(review.target.softwareVersion, '124');
  assert.equal(review.current.softwareVersion, '123');
  assert.equal(review.updateAvailable, true);
  assert.equal(review.pending, false);
  assert.equal(f.runtime.running, true);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
  await f.changes.updateSoftware(
    {planId: review.id, confirm: true},
    {id: 'update'},
    {stop: f.stop, run: f.run},
  );
  assert.equal((await f.software.receipt()).selection.softwareVersion, '124');
  assert.equal(f.runtime.running, true);
  assert.equal(f.stops(), 1);
  assert.equal(f.probes(), 1);
  assert.equal((await f.changes.inspect()).phase, 'complete');
});

test('an originally stopped update returns stopped after a real validation start', async (t) => {
  const f = await updates(t),
    review = await f.check();
  await f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
    stop: f.stop,
    run: f.run,
  });
  assert.equal(f.runtime.running, false);
  assert.equal(f.stops(), 1);
  assert.equal(f.probes(), 1);
});

test('failure to return a stopped installation to its stopped state keeps paired recovery pending', async (t) => {
  const f = await updates(t),
    review = await f.check();
  await assert.rejects(
    f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
      stop: async () => {
        throw Error('Clean final shutdown failed');
      },
      run: f.run,
    }),
    /Clean final shutdown failed/,
  );
  assert.equal((await f.changes.inspect()).pending, true);
  assert.equal(f.runtime.running, false);
  await f.changes.recoverSoftware({
    confirm: true,
    review: (await f.changes.inspect({deep: true})).review,
  });
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
});

test('changed software or framework is rejected before stopping a running installation', async (t) => {
  const f = await updates(t),
    review = await f.check();
  f.runtime.running = true;
  const installedFile = path.join(f.ctx.config.state, 'mods/installed.json');
  await fs.writeFile(
    installedFile,
    JSON.stringify({
      format: 1,
      framework: 'none',
      files: [],
      installed: 'changed after review',
    }),
  );
  await assert.rejects(
    f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /reviewed software or framework changed/,
  );
  assert.equal(f.runtime.running, true);
  assert.equal(f.stops(), 0);
});

for (const phase of [
  'reserved',
  'snapshotting',
  'staging',
  'preparing-software',
  'software-prepared',
  'activating-software',
  'software-activated',
  'publishing',
  'previous-engine-held',
  'candidate-published',
  'prepared',
  'validating',
  'before-framework-commit',
]) {
  test(
    'Steam interruption at ' +
      phase +
      ' retains or restores exact previous software and its matching world',
    async (t) => {
      const f = await updates(t),
        review = await f.check();
      f.fail(phase);
      await assert.rejects(
        f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
          stop: f.stop,
          run: f.run,
        }),
        /Injected/,
      );
      const changes = f.createChanges(),
        inspection = await changes.inspect({deep: true});
      assert.equal(inspection.pending, true);
      await assert.rejects(changes.guard('plugin'), /validation or recovery/);
      await assert.rejects(
        changes.recover({confirm: true, review: inspection.review}),
        /software recovery/,
      );
      await changes.recoverSoftware({confirm: true, review: inspection.review});
      assert.equal(
        (await f.software.receipt()).selection.softwareVersion,
        '123',
      );
      assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
      assert.equal(f.runtime.running, false);
      assert.equal((await changes.inspect()).phase, 'recovered');
      if (phase === 'before-framework-commit') {
        const record = await readRecord(f.file),
          retained = path.join(
            path.dirname(f.file),
            'history',
            record.id,
            'quarantine-world',
            f.ctx.config.identity,
            'world.sav',
          );
        assert.equal(
          await fs.readFile(retained, 'utf8'),
          'NEWER BUILD 124 SAVE',
        );
        assert.equal(
          f.runtime.calls.filter((args) => args.includes('+app_update')).length,
          2,
          'Rollback uses cached old software without a third Steam download',
        );
      }
    },
  );
}

test('lost metadata response is closed without stopping a running application or changing its files', async (t) => {
  const f = await updates(t);
  f.runtime.running = true;
  f.runtime.workerFault = 'resolve';
  await assert.rejects(f.check(), /Lost worker response/);
  const review = await f.changes.inspect({deep: true});
  await f.changes.recoverSoftware({confirm: true, review: review.review});
  assert.equal(f.runtime.running, true);
  assert.equal(f.retained.size, 0);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
});

test('lost target prepare response abandons the candidate using the verified old active pointer', async (t) => {
  const f = await updates(t),
    review = await f.check();
  f.runtime.workerFault = 'prepare';
  await assert.rejects(
    f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Lost worker response/,
  );
  const inspection = await f.changes.inspect({deep: true});
  await f.changes.recoverSoftware({confirm: true, review: inspection.review});
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  assert.equal(f.retained.size, 0);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
});

test('rollback preparation can be recovered after its result checkpoint without replaying the worker', async (t) => {
  const f = await updates(t),
    review = await f.check();
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: review.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Injected/,
  );
  f.fail('recovering', (value) => !!value.rollback);
  await assert.rejects(
    f.changes.recoverSoftware({
      confirm: true,
      review: (await f.changes.inspect({deep: true})).review,
    }),
    /Injected/,
  );
  const first = await readRecord(f.file),
    requests = f.runtime.calls.length;
  await f.createChanges().recoverSoftware({
    confirm: true,
    review: (await f.createChanges().inspect({deep: true})).review,
  });
  assert.equal((await readRecord(f.file)).rollbackId, first.rollbackId);
  assert.equal(f.runtime.calls.length, requests);
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
});

test('missing old private software blocks rollback before any worker, download or world replacement', async (t) => {
  const f = await updates(t),
    plan = await f.check();
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Injected/,
  );
  const value = await readRecord(f.file),
    previous = value.previous.receipt,
    key =
      softwareSelectionKey(previous.selection) +
      '-' +
      previous.inventory.sha256;
  const source = path.join(f.paths.software, 'releases', key),
    held = source + '-retained';
  await fs.rename(source, held);
  const calls = f.runtime.calls.length;
  await assert.rejects(
    f.changes.recoverSoftware({
      confirm: true,
      review: (await f.changes.inspect({deep: true})).review,
    }),
    /ENOENT|verification/,
  );
  assert.equal(f.runtime.calls.length, calls);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'NEWER BUILD 124 SAVE');
  await fs.rename(held, source);
  await f.changes.recoverSoftware({
    confirm: true,
    review: (await f.changes.inspect({deep: true})).review,
  });
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
});

test('orphan preparation coordination requires an unchanged explicit recovery review', async (t) => {
  const f = await updates(t),
    plan = await f.check();
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Injected/,
  );
  const providerLock = path.join(f.paths.control, '.panel-storage-lock'),
    requestLock = path.join(f.paths.requests, '.panel-storage-lock');
  await fs.mkdir(providerLock);
  await fs.mkdir(requestLock);
  const review = (await f.changes.inspect({deep: true})).review;
  await fs.writeFile(
    path.join(providerLock, 'owner.json'),
    'incomplete owner bytes',
  );
  await assert.rejects(
    f.changes.recoverSoftware({confirm: true, review}),
    /observations changed/,
  );
  assert.equal(await fs.readFile(f.world, 'utf8'), 'NEWER BUILD 124 SAVE');
  await f.changes.recoverSoftware({
    confirm: true,
    review: (await f.changes.inspect({deep: true})).review,
  });
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  await assert.rejects(fs.access(providerLock));
  await assert.rejects(fs.access(requestLock));
});

test('an unrelated retained request prevents paired recovery without erasing its evidence', async (t) => {
  const f = await updates(t),
    plan = await f.check();
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Injected/,
  );
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  f.retained.set(id, {
    record: {id, action: 'resolve', phase: 'complete'},
    worker: null,
    lease: null,
  });
  await assert.rejects(
    f.changes.recoverSoftware({
      confirm: true,
      review: (await f.changes.inspect({deep: true})).review,
    }),
    /unknown or active/,
  );
  assert.equal(f.retained.has(id), true);
  assert.equal(await fs.readFile(f.world, 'utf8'), 'NEWER BUILD 124 SAVE');
  f.retained.delete(id);
  await f.changes.recoverSoftware({
    confirm: true,
    review: (await f.changes.inspect({deep: true})).review,
  });
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
});

test('changed review observations, superseded plans and already installed exact selections cannot change software', async (t) => {
  const f = await updates(t),
    old = await f.check(),
    current = await f.check();
  await assert.rejects(
    f.changes.updateSoftware({planId: old.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /expired or changed/,
  );
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: current.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /Injected/,
  );
  const review = await f.changes.inspect({deep: true});
  await assert.rejects(
    f.changes.recoverSoftware({confirm: true, review: 'a'.repeat(64)}),
    /observations changed/,
  );
  await f.changes.recoverSoftware({confirm: true, review: review.review});
  f.runtime.build = '123';
  const same = await f.changes.checkSoftware();
  assert.equal(same.updateAvailable, false);
  await assert.rejects(
    f.changes.updateSoftware({planId: same.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /already installed/,
  );
});

for (const move of ['restore-world', 'restore-engine'])
  test(
    'paired Steam recovery resumes after moving ' +
      move +
      ' without replaying rollback preparation',
    async (t) => {
      const f = await updates(t),
        plan = await f.check();
      f.fail('before-framework-commit');
      await assert.rejects(
        f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
          stop: f.stop,
          run: f.run,
        }),
        /Injected/,
      );
      f.fail('moved-' + move);
      await assert.rejects(
        f.changes.recoverSoftware({
          confirm: true,
          review: (await f.changes.inspect({deep: true})).review,
        }),
        /Injected/,
      );
      const rollback = (await readRecord(f.file)).rollbackId,
        calls = f.runtime.calls.length;
      await f.createChanges().recoverSoftware({
        confirm: true,
        review: (await f.createChanges().inspect({deep: true})).review,
      });
      assert.equal((await readRecord(f.file)).rollbackId, rollback);
      assert.equal(f.runtime.calls.length, calls);
      assert.equal(
        (await f.software.receipt()).selection.softwareVersion,
        '123',
      );
      assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
    },
  );

test('a moved upstream branch cannot install a different build from its retained review', async (t) => {
  const f = await updates(t),
    plan = await f.check();
  f.runtime.build = '125';
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /branch moved/i,
  );
  await f.changes.recoverSoftware({
    confirm: true,
    review: (await f.changes.inspect({deep: true})).review,
  });
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  assert.equal(await fs.readFile(f.world, 'utf8'), 'BEFORE BUILD 123');
});

test('modded Steam update and paired recovery cannot use vanilla or framework-only authority; plugin data and framework return with the old build', async (t) => {
  const archive = carbonArchive(),
    sha = createHash('sha256').update(archive).digest('hex');
  const fetcher = async (url) =>
    new Response(
      url.startsWith('https://api.github.com/')
        ? JSON.stringify({
            tag_name: 'fixture-v1',
            assets: [
              {
                name: 'Carbon.Linux.Release.tar.gz',
                state: 'uploaded',
                size: archive.length,
                digest: 'sha256:' + sha,
                browser_download_url:
                  'https://github.com/CarbonCommunity/Carbon/releases/download/fixture-v1/Carbon.Linux.Release.tar.gz',
              },
            ],
          })
        : archive,
    );
  const f = await updates(t, {fetcher}),
    framework = await f.changes.plan('carbon');
  await f.changes.prepare(framework.id);
  await f.changes.start(async () => {
    f.runtime.running = true;
    return 'original modded build ready';
  });
  await f.stop();
  const pluginData = path.join(
    f.ctx.config.data,
    f.ctx.config.identity,
    'mods/carbon/data/UserData.json',
  );
  await fs.writeFile(pluginData, '{"oldBuild":123}');
  f.runtime.build = '124';
  await assert.rejects(f.changes.checkSoftware(), /executable-mod/);
  const plan = await f.changes.checkSoftware(null, {modded: true});
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      stop: f.stop,
      run: f.run,
    }),
    /executable-mod/,
  );
  f.fail('before-framework-commit');
  await assert.rejects(
    f.changes.updateSoftware({planId: plan.id, confirm: true}, null, {
      modded: true,
      stop: f.stop,
      run: async () => {
        await f.run();
        await fs.writeFile(pluginData, '{"newBuild":124}');
        return 'new modded';
      },
    }),
    /Injected/,
  );
  const review = (await f.changes.inspect({deep: true})).review;
  await assert.rejects(
    f.changes.recoverSoftware({confirm: true, review}),
    /matching software recovery authority/,
  );
  await assert.rejects(
    f.changes.recover({confirm: true, review}),
    /software recovery/,
  );
  await f.changes.recoverSoftware({confirm: true, review}, {modded: true});
  assert.equal((await f.software.receipt()).selection.softwareVersion, '123');
  assert.equal(await fs.readFile(pluginData, 'utf8'), '{"oldBuild":123}');
  assert.equal(
    (await readRecord(path.join(f.ctx.config.state, 'mods/installed.json')))
      .framework,
    'carbon',
  );
});
