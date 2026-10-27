// One public fixture in the fresh managed image; no daemon or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
  prepareFrameworkLayout,
  oxideCompiler,
  carbonConflicts,
  carbonHooksReceipt,
} from '/app/mod-layout.js';
assert.equal(process.env.LOBBY_MANAGED_MOD_ACCEPTANCE, 'disposable');
assert.equal(process.getuid(), 0);
const engine = '/game/engine',
  world = '/game/server/lobby-goblin-rust',
  mode = process.argv[2],
  framework = process.argv[3];
assert.equal(await fs.realpath('/game'), '/game');
assert.equal(await fs.realpath('/scratch'), '/scratch');
const ordinary = async (location) => {
  const stat = await fs.lstat(location);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await fs.realpath(location), location);
};
if (mode === 'base') {
  assert.deepEqual(await fs.readdir('/scratch'), []);
  assert.equal(await fs.readlink(engine + '/server'), '../server');
  await fs.cp(engine, '/scratch/base', {
    recursive: true,
    dereference: false,
    filter: (name) => name !== engine + '/server',
  });
  await fs.copyFile(
    '/game/.lobby-goblin-runtime.json',
    '/scratch/base-receipt.json',
    fs.constants.COPYFILE_EXCL,
  );
} else if (mode === 'stage') {
  assert.ok(['carbon', 'oxide'].includes(framework));
  await ordinary(engine);
  await ordinary('/scratch/base');
  assert.equal(
    await fs.readFile(world + '/copied-world.txt', 'utf8'),
    'new disposable fixture only',
  );
  // This run's game is stopped by the trusted orchestrator. Removing nested
  // code unlinks fixed world/data links, never their stable targets.
  await fs.rm(engine, {recursive: true});
  await fs.cp('/scratch/base', engine, {recursive: true, dereference: false});
  const manifest = JSON.parse(
    await fs.readFile('/package/manifest.json', 'utf8'),
  );
  assert.equal(manifest.framework, framework);
  assert.ok(manifest.files.length > 0 && manifest.files.length < 10000);
  if (framework === 'carbon') {
    const receipt = carbonHooksReceipt(manifest.carbonHooks),
      current = JSON.parse(
        await fs.readFile('/game/.lobby-goblin-runtime.json', 'utf8'),
      );
    assert.equal(receipt.buildId, current.buildId);
    for (const name of carbonConflicts) {
      const target = path.join(engine, name),
        stat = await fs.lstat(target).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
      if (stat) {
        assert.ok(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1 &&
            stat.uid === 0 &&
            !(stat.mode & 0o022),
        );
        assert.equal(await fs.realpath(target), target);
        // The complete pristine baseline remains in this run's private scratch.
        await fs.unlink(target);
      }
    }
  }
  let total = 0;
  for (const file of manifest.files) {
    assert.ok(
      typeof file.name === 'string' &&
        !file.name.startsWith('/') &&
        !file.name.includes('\\') &&
        file.name
          .split('/')
          .every((part) => part && part !== '.' && part !== '..'),
    );
    const source = path.join('/package', file.name),
      stat = await fs.lstat(source);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        (await fs.realpath(source)) === source,
    );
    assert.equal(stat.size, file.size);
    total += stat.size;
    assert.ok(total <= 512 * 1024 ** 2);
    const bytes = await fs.readFile(source);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    const target = path.join(engine, file.name);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(source, target);
    await fs.chmod(target, file.mode);
  }
  if (framework === 'oxide')
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(engine + '/Oxide.Compiler'))
        .digest('hex'),
      oxideCompiler.sha256,
    );
  await prepareFrameworkLayout({
    engine,
    worldRoot: '/game/server',
    identity: 'lobby-goblin-rust',
    framework,
    initializeNative: true,
  });
  await fs.writeFile(
    engine + '/.lobby-goblin-mods.json',
    JSON.stringify({
      format: 1,
      status: 'complete',
      framework,
      ...(manifest.carbonHooks ? {hooks: manifest.carbonHooks} : {}),
    }),
    {mode: 0o644},
  );
  assert.deepEqual(
    await fs.readFile('/game/.lobby-goblin-runtime.json'),
    await fs.readFile('/scratch/base-receipt.json'),
  );
  const mutable = world + '/mods/' + framework;
  await fs.mkdir(mutable + '/plugins', {recursive: true});
  const plugin =
    'using Oxide.Core; namespace Oxide.Plugins { [Info("LobbyGoblinProbe", "Lobby Goblin", "1.0.0")] public class LobbyGoblinProbe : RustPlugin { protected override void LoadDefaultConfig() { Config["marker"] = "LG_STABLE_CONFIG"; SaveConfig(); } [ConsoleCommand("lg.probe")] void Probe(ConsoleSystem.Arg arg) { int count = Interface.Oxide.DataFileSystem.ReadObject<int>("LobbyGoblinProbe") + 1; Interface.Oxide.DataFileSystem.WriteObject("LobbyGoblinProbe", count); arg.ReplyWith("LG_MOD_PROBE_OK:" + count); } } }';
  await fs.writeFile(mutable + '/plugins/LobbyGoblinProbe.cs', plugin, {
    mode: 0o644,
  });
} else if (mode === 'inspect') {
  assert.ok(['carbon', 'oxide'].includes(framework));
  const mutable = world + '/mods/' + framework,
    config = JSON.parse(
      await fs.readFile(
        mutable +
          '/' +
          (framework === 'carbon' ? 'configs' : 'config') +
          '/LobbyGoblinProbe.json',
        'utf8',
      ),
    );
  assert.equal(config.marker, 'LG_STABLE_CONFIG');
  assert.ok(
    JSON.parse(
      await fs.readFile(mutable + '/data/LobbyGoblinProbe.json', 'utf8'),
    ) >= 1,
  );
  assert.equal((await fs.stat(engine + '/RustDedicated')).uid, 0);
  const code =
    framework === 'carbon'
      ? engine + '/carbon/managed/Carbon.Preloader.dll'
      : engine + '/RustDedicated_Data/Managed/Oxide.Rust.dll';
  assert.equal((await fs.stat(code)).uid, 0);
  if (framework === 'carbon') {
    for (const name of [
      'config.json',
      'config.auto.json',
      'config.webpanel.json',
      'oxide.config.json',
    ])
      assert.equal((await fs.lstat(path.join(mutable, name))).uid, 1000);
    assert.equal(
      JSON.parse(await fs.readFile(mutable + '/config.webpanel.json', 'utf8'))
        .Enabled,
      false,
    );
    const log = await fs.lstat(mutable + '/logs/Carbon.Harmony.bootstrap.log');
    assert.ok(log.isFile() && !log.isSymbolicLink() && log.nlink === 1);
    assert.equal(log.uid, 1000);
    assert.ok(log.size > 0);
    assert.equal(
      await fs.lstat(engine + '/harmony_log.txt').catch(() => null),
      null,
    );
  }
  if (framework === 'oxide') {
    const compiler = engine + '/Oxide.Compiler',
      stat = await fs.lstat(compiler);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o022, 0);
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(compiler))
        .digest('hex'),
      oxideCompiler.sha256,
      'Framework startup must retain the reviewed compiler bytes',
    );
  }
  assert.equal((await fs.stat(mutable)).uid, 1000);
  assert.equal(
    await fs.readFile(world + '/copied-world.txt', 'utf8'),
    'new disposable fixture only',
  );
  console.log(
    JSON.stringify({
      framework,
      immutableCodeOwner: 0,
      mutableDataOwner: 1000,
      pluginConfigured: true,
      pluginDataWritten: true,
      worldPreserved: true,
    }),
  );
} else assert.fail('Unknown managed mod fixture phase');
