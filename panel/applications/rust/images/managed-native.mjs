// Mounted as one read-only fixture file, never the checkout. Preparation has no
// game mount. A separate trusted fixture controller verifies and copies software.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
assert.equal(process.env.LOBBY_MANAGED_RUST_ACCEPTANCE, 'disposable');
const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public'],
};
const requiredFiles = [{path: 'RustDedicated', executable: true}];
const mode = process.argv[2];
if (mode === 'initialize') {
  assert.equal(process.getuid(), 0);
  for (const root of ['/software', '/control', '/game']) {
    assert.deepEqual(await fs.readdir(root), []);
    await fs.chmod(root, root === '/game' ? 0o755 : 0o2770);
  }
} else if (mode === 'prepare') {
  assert.equal(process.getuid(), 1000);
  assert.equal(await fs.stat('/game').catch(() => null), null);
  const {executeWorkerRequest} =
    await import('/opt/lobby/panel/providers/steamcmd/worker.js');
  const request = (action, extra) => ({
    format: 1,
    id: randomUUID(),
    action,
    source,
    requiredFiles,
    ...extra,
  });
  const selection = (
    await executeWorkerRequest(
      request('resolve', {initial: {channel: 'public'}}),
    )
  ).result;
  const prepared = (
    await executeWorkerRequest(request('prepare', {selection, confirm: true}))
  ).result;
  await fs.writeFile(
    '/control/native-prepared.json',
    JSON.stringify(prepared),
    {mode: 0o600},
  );
} else if (mode === 'publish') {
  assert.equal(process.getuid(), 0);
  assert.deepEqual(await fs.readdir('/game'), []);
  const {createSteamProvider} =
    await import('/opt/lobby/panel/providers/steamcmd/provider.js');
  const {softwareInventory} =
    await import('/opt/lobby/panel/providers/steamcmd/files.js');
  const provider = createSteamProvider({
    source,
    requiredFiles,
    software: '/software',
    control: '/control',
    isApplicationEmpty: async () => (await fs.readdir('/game')).length === 0,
    isApplicationStopped: async () => true,
    command: async () => assert.fail('Fixture activation must be offline'),
  });
  // The orchestrator has not created its freshly named game container yet.
  const prepared = JSON.parse(
    await fs.readFile('/control/native-prepared.json', 'utf8'),
  );
  const receipt = await provider.activate(prepared, {confirm: true});
  const release = await provider.activeDirectory(),
    original = await softwareInventory(release);
  assert.deepEqual(original.inventory, receipt.inventory);
  assert.ok(
    !original.files.some(
      (file) => file.name === 'server' || file.name.startsWith('server/'),
    ),
  );
  await fs.mkdir('/game/engine', {mode: 0o755});
  for (const file of original.files) {
    const target = path.join('/game/engine', file.name);
    await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o755});
    await fs.copyFile(
      path.join(release, file.name),
      target,
      fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL,
    );
    await fs.chmod(target, file.executable ? 0o755 : 0o644);
  }
  assert.deepEqual(
    (await softwareInventory('/game/engine')).inventory,
    receipt.inventory,
  );
  const binary = original.files.find((file) => file.name === 'RustDedicated');
  await fs.writeFile(
    '/game/.lobby-goblin-runtime.json',
    JSON.stringify({
      format: 1,
      application: 'rust',
      provider: 'steamcmd',
      platform: 'linux/amd64',
      buildId: receipt.selection.softwareVersion,
      inventorySha256: receipt.inventory.sha256,
      binarySha256: binary.sha256,
    }),
    {mode: 0o644},
  );
  await fs.mkdir('/game/server/lobby-goblin-rust/cfg', {recursive: true});
  await fs.writeFile(
    '/game/server/lobby-goblin-rust/cfg/server.cfg',
    'server.hostname "Managed Rust native acceptance"\nserver.maxplayers 1\nserver.saveinterval 600\n',
  );
  await fs.writeFile(
    '/game/server/lobby-goblin-rust/copied-world.txt',
    'new disposable fixture only',
  );
  console.log(
    JSON.stringify({
      buildId: receipt.selection.softwareVersion,
      files: receipt.inventory.files,
      bytes: receipt.inventory.bytes,
      copiedInventoryVerified: true,
    }),
  );
} else if (mode === 'inspect') {
  const marker = JSON.parse(
    await fs.readFile('/game/.lobby-goblin-runtime.json', 'utf8'),
  );
  const identity = '/game/server/lobby-goblin-rust';
  assert.equal(await fs.readlink('/game/engine/server'), '../server');
  assert.equal(await fs.realpath('/game/engine/server'), '/game/server');
  assert.equal((await fs.stat('/game/engine')).uid, 0);
  assert.equal((await fs.stat('/game/engine/RustDedicated')).uid, 0);
  assert.equal((await fs.stat('/game/server')).uid, 1000);
  assert.equal(
    await fs.readFile(identity + '/copied-world.txt', 'utf8'),
    'new disposable fixture only',
  );
  const saves = (await fs.readdir(identity)).filter((name) =>
    /^proceduralmap\.1000\.12345\.\d+\.sav$/.test(name),
  );
  assert.equal(saves.length, 1);
  assert.ok((await fs.stat(identity + '/' + saves[0])).size > 0);
  assert.match(
    await fs.readFile(identity + '/cfg/server.cfg', 'utf8'),
    /Managed Rust native acceptance/,
  );
  console.log(
    JSON.stringify({
      buildId: marker.buildId,
      save: saves[0],
      executableOwner: 0,
      worldOwner: 1000,
      stableWorldLink: true,
      fixtureTextUnchanged: true,
    }),
  );
} else assert.fail('Unknown native fixture phase');
