import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRustModStores} from '../applications/rust/mod-stores.js';
import {createModManager} from '../applications/rust/mods.js';
import {writeArchive, verifyArchive} from '../applications/rust/archive.js';
import {extractRust} from '../fleet/snapshots.js';

const linux = process.platform === 'linux';
const config = (anchor) => ({
  softwareManaged: true,
  data: path.join(anchor, 'server'),
  installRoot: path.join(anchor, 'engine'),
  identity: 'lobby-goblin-rust',
});
test('managed Rust declares only the four fixed mutable stores and preserves legacy routing', () => {
  const value = config(path.resolve('fixture-data'));
  assert.equal(createRustModStores({...value, softwareManaged: false}), null);
  const stores = createRustModStores(value);
  assert.deepEqual(
    [...stores.keys()],
    ['carbon/plugins', 'carbon/configs', 'oxide/plugins', 'oxide/config'],
  );
  for (const [name, store] of stores) {
    assert.equal(
      store.root,
      path.join(value.data, value.identity, 'mods', name),
    );
  }
  for (const identity of ['..', '../private', 'world/a', '', 'a:stream']) {
    assert.throws(() => createRustModStores({...value, identity}));
  }
  assert.throws(() => createRustModStores({...value, installRoot: value.data}));
  assert.throws(() =>
    createRustModStores({...value, data: path.dirname(value.data)}),
  );
});

for (const framework of ['carbon', 'oxide']) {
  test(
    `managed ${framework} plugin/config operations use world data and backups retain code plus mutable data`,
    {skip: !linux},
    async (t) => {
      const base = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'rust-mod-stores-')),
      );
      t.after(() => fs.rm(base, {recursive: true, force: true}));
      const anchor = path.join(base, 'data'),
        state = path.join(base, 'state');
      await fs.mkdir(anchor, {mode: 0o755});
      const value = config(anchor),
        root = value.installRoot;
      await fs.mkdir(root);
      await fs.mkdir(path.join(state, 'mods'), {recursive: true, mode: 0o700});
      const stores = createRustModStores(value),
        plugins = stores.get(framework + '/plugins');
      const configs = stores.get(
        framework + (framework === 'carbon' ? '/configs' : '/config'),
      );
      await configs.write('Probe.json', Buffer.from('{"keep":true}'));
      const identityRoot = path.join(value.data, value.identity);
      await fs.writeFile(
        path.join(identityRoot, 'world.sav'),
        'WORLD SENTINEL',
      );
      // The engine links are ABI-owned. Mutable operations must route directly to
      // their declared data stores rather than relax the code walker for links.
      if (framework === 'oxide')
        await fs.symlink(
          '../server/' + value.identity + '/mods/oxide',
          path.join(root, 'oxide'),
        );
      else {
        await fs.mkdir(path.join(root, 'carbon'));
        await fs.symlink(
          '../../server/' + value.identity + '/mods/carbon/configs',
          path.join(root, 'carbon/configs'),
        );
      }
      await fs.writeFile(
        path.join(state, 'mods/installed.json'),
        JSON.stringify({format: 1, framework, files: []}),
      );
      await fs.writeFile(
        path.join(root, '.lobby-goblin-mods.json'),
        JSON.stringify({format: 1, status: 'complete', framework}),
      );
      const commands = [];
      const mods = createModManager({
        root,
        state,
        mutableStores: stores,
        assertStopped: async () => {},
        command: async (value) => {
          commands.push(value);
          return 'Reloaded';
        },
      });
      await mods.plugin({
        operation: 'install',
        name: 'Probe.cs',
        source: '// source one',
      });
      assert.equal(
        (await plugins.read('Probe.cs')).data.toString(),
        '// source one',
      );
      await mods.plugin({operation: 'disable', name: 'Probe.cs'});
      assert.equal((await mods.status()).plugins[0].disabled, true);
      await mods.plugin({operation: 'enable', name: 'Probe.cs'});
      assert.equal(mods.store(framework).root, plugins.root);
      await mods.plugin({operation: 'reload', name: 'Probe.cs'});
      assert.deepEqual(commands, [
        (framework === 'carbon' ? 'c.' : 'oxide.') + 'reload Probe',
      ]);
      const before = await mods.configuration('Probe.json');
      await mods.configuration('Probe.json', {
        source: '{"keep":true,"rate":2}',
        revision: before.revision,
      });
      await assert.rejects(
        mods.configuration('Probe.json', {
          source: '{}',
          revision: before.revision,
        }),
        /changed/,
      );
      const extras = await mods.backupRoots();
      assert.deepEqual(
        extras.map((extra) => extra.prefix),
        ['mod-state'],
      );
      const archive = path.join(base, 'backup.tar.gz');
      await writeArchive(archive, identityRoot, {
        identity: value.identity,
        instance: 'a'.repeat(32),
        extras,
      });
      assert.equal((await verifyArchive(archive)).modded, true);
      const extracted = path.join(base, 'extracted');
      await extractRust(archive, extracted);
      assert.equal(
        await fs.readFile(
          path.join(extracted, 'identity/mods', framework, 'plugins/Probe.cs'),
          'utf8',
        ),
        '// source one',
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(
              extracted,
              'mod-state/backup-active/.lobby-goblin-mods.json',
            ),
          ),
        ).framework,
        framework,
      );
      assert.equal(
        await fs.readFile(path.join(identityRoot, 'world.sav'), 'utf8'),
        'WORLD SENTINEL',
      );
      await assert.rejects(mods.install('unused'), /paired software and data/);
      await assert.rejects(mods.recover(), /paired software and data/);
      // Undeclared data paths remain unreachable even when the game forges a
      // leaf pointing at controller-private state.
      await fs.symlink(
        path.join(state, 'mods/installed.json'),
        path.join(plugins.root, 'Private.cs'),
      );
      await assert.rejects(
        mods.plugin({operation: 'reload', name: 'Private.cs'}),
        /links/,
      );
    },
  );
}
