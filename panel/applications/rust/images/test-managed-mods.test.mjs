import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  prepareFrameworkLayout,
  prepareCarbonConfig,
  carbonDataDirectories,
  carbonDataFiles,
  oxideNativeConfigPath,
  oxideNativeConfig,
  carbonConflicts,
} from './mod-layout.js';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-managed-mods-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const engine = path.join(root, 'engine'),
    worldRoot = path.join(root, 'server'),
    identity = 'lobby-goblin-rust';
  await fs.mkdir(engine);
  await fs.mkdir(worldRoot);
  await fs.mkdir(path.join(engine, 'carbon/managed'), {recursive: true});
  await fs.writeFile(
    path.join(engine, 'carbon/managed/Carbon.Preloader.dll'),
    'sealed synthetic loader',
  );
  await fs.mkdir(path.join(engine, 'RustDedicated_Data/Managed'), {
    recursive: true,
  });
  return {root, engine, worldRoot, identity};
}
test('Carbon data links point only to stable world storage while framework code stays sealed', async (t) => {
  const f = await fixture(t),
    code = path.join(f.engine, 'carbon/managed/Carbon.Preloader.dll'),
    before = await fs.stat(code);
  const result = await prepareFrameworkLayout({...f, framework: 'carbon'});
  for (const name of carbonDataDirectories)
    assert.equal(
      await fs.realpath(path.join(f.engine, 'carbon', name)),
      path.join(result.mutable, name),
    );
  for (const name of carbonDataFiles)
    assert.equal(
      await fs.readlink(path.join(f.engine, 'carbon', name)),
      path.relative(
        path.join(f.engine, 'carbon'),
        path.join(result.mutable, name),
      ),
    );
  await fs.writeFile(
    path.join(result.mutable, 'data/plugin.json'),
    '{"preserved":true}',
  );
  await prepareFrameworkLayout({...f, framework: 'carbon'});
  assert.equal(
    await fs.readFile(path.join(f.engine, 'carbon/data/plugin.json'), 'utf8'),
    '{"preserved":true}',
  );
  assert.equal((await fs.stat(code)).uid, before.uid);
  assert.equal((await fs.stat(code)).mode, before.mode);
  assert.equal(await fs.readFile(code, 'utf8'), 'sealed synthetic loader');
  assert.equal(
    (await fs.lstat(path.join(f.engine, 'carbon'))).isSymbolicLink(),
    false,
  );
});
test('game-user Carbon configuration preserves values and disables both automatic update paths', async (t) => {
  const f = await fixture(t),
    layout = await prepareFrameworkLayout({...f, framework: 'carbon'});
  await fs.writeFile(
    layout.carbonConfig,
    JSON.stringify({
      Unrelated: {preserve: true},
      SelfUpdating: {Enabled: true, HookUpdates: true, Other: 'preserve'},
    }),
  );
  const automatic = path.join(layout.mutable, 'config.auto.json'),
    web = path.join(layout.mutable, 'config.webpanel.json');
  await fs.writeFile(automatic, 'c.showstatusbar "false"\n', {mode: 0o640});
  await prepareCarbonConfig(layout.mutable);
  const value = JSON.parse(await fs.readFile(layout.carbonConfig, 'utf8'));
  assert.deepEqual(value, {
    Unrelated: {preserve: true},
    SelfUpdating: {Enabled: false, HookUpdates: false, Other: 'preserve'},
  });
  assert.equal((await fs.stat(layout.carbonConfig)).mode & 0o777, 0o600);
  assert.equal(
    await fs.readFile(automatic, 'utf8'),
    'c.showstatusbar "false"\n',
  );
  assert.equal((await fs.stat(automatic)).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(await fs.readFile(web, 'utf8')), {
    Enabled: false,
  });
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(layout.mutable, 'oxide.config.json'), 'utf8'),
    ),
    {},
  );
  await fs.writeFile(web, '{"Enabled":true,"preserved":true}\n');
  await prepareCarbonConfig(layout.mutable);
  assert.equal(
    await fs.readFile(web, 'utf8'),
    '{"Enabled":true,"preserved":true}\n',
  );
});
test('missing Carbon configuration initialization refuses redirected existing targets', async (t) => {
  const f = await fixture(t),
    layout = await prepareFrameworkLayout({...f, framework: 'carbon'}),
    outside = path.join(f.root, 'outside.json'),
    target = path.join(layout.mutable, 'config.webpanel.json');
  await fs.writeFile(outside, '{"untouched":true}');
  await fs.symlink(outside, target);
  await assert.rejects(
    prepareCarbonConfig(layout.mutable),
    /Invalid mutable Carbon configuration/,
  );
  assert.equal(
    await fs.readFile(path.join(layout.mutable, 'config.auto.json'), 'utf8'),
    '',
  );
  assert.equal(await fs.readFile(outside, 'utf8'), '{"untouched":true}');
  await fs.unlink(target);
  await fs.link(outside, target);
  await assert.rejects(
    prepareCarbonConfig(layout.mutable),
    /Invalid mutable Carbon configuration/,
  );
  assert.equal(await fs.readFile(outside, 'utf8'), '{"untouched":true}');
});
test('Oxide data remains independent and native bindings are prepared before image startup', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareFrameworkLayout({...f, framework: 'oxide'}),
    /native bindings/,
  );
  const result = await prepareFrameworkLayout({
    ...f,
    framework: 'oxide',
    initializeNative: true,
  });
  assert.equal(await fs.realpath(path.join(f.engine, 'oxide')), result.mutable);
  assert.equal(
    await fs.readFile(path.join(f.engine, oxideNativeConfigPath), 'utf8'),
    oxideNativeConfig(),
  );
  await fs.mkdir(path.join(result.mutable, 'data'));
  await fs.writeFile(
    path.join(result.mutable, 'data/plugin.json'),
    'preserved',
  );
  await prepareFrameworkLayout({...f, framework: 'oxide'});
  assert.equal(
    await fs.readFile(path.join(f.engine, 'oxide/data/plugin.json'), 'utf8'),
    'preserved',
  );
});
test('existing framework data in code directories is preserved for explicit migration', async (t) => {
  const f = await fixture(t),
    original = path.join(f.engine, 'carbon/configs');
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, 'owned.json'), 'do not discard');
  await assert.rejects(
    prepareFrameworkLayout({...f, framework: 'carbon'}),
    /data remains/,
  );
  assert.equal(
    await fs.readFile(path.join(original, 'owned.json'), 'utf8'),
    'do not discard',
  );
});
test('Carbon compiler conflicts are retained until the controller prepares a private execution candidate', async (t) => {
  const f = await fixture(t),
    target = path.join(f.engine, carbonConflicts[0]);
  await fs.writeFile(target, 'pristine vanilla compiler library');
  await assert.rejects(
    prepareFrameworkLayout({...f, framework: 'carbon'}),
    /compiler libraries privately/,
  );
  assert.equal(
    await fs.readFile(target, 'utf8'),
    'pristine vanilla compiler library',
  );
});
test('world and configuration escape links or hardlinks cannot redirect setup writes', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.worldRoot, f.identity));
  await assert.rejects(
    prepareFrameworkLayout({...f, framework: 'carbon'}),
    /linked parents/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.worldRoot, f.identity));
  const layout = await prepareFrameworkLayout({...f, framework: 'carbon'}),
    sentinel = path.join(outside, 'sentinel.json');
  await fs.writeFile(sentinel, '{"keep":true}');
  await fs.symlink(sentinel, layout.carbonConfig);
  await assert.rejects(
    prepareFrameworkLayout({...f, framework: 'carbon'}),
    /bounded ordinary/,
  );
  await assert.rejects(prepareCarbonConfig(layout.mutable));
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":true}');
  await fs.unlink(layout.carbonConfig);
  await fs.link(sentinel, layout.carbonConfig);
  await assert.rejects(prepareCarbonConfig(layout.mutable), /Invalid mutable/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":true}');
});
