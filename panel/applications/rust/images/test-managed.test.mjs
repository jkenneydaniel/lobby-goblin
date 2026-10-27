import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  managedStartup,
  executionReceipt,
  readinessProof,
} from './managed-entrypoint.mjs';
import {prepareSdk} from './managed-helper.mjs';
import {liveProcess} from './managed-health.mjs';

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-rust-managed-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.chmod(root, 0o755);
  const engine = path.join(root, 'engine');
  await fs.mkdir(engine, {mode: 0o755});
  await fs.writeFile(
    path.join(engine, 'RustDedicated'),
    'verified synthetic executable',
    {mode: 0o755},
  );
  const receipt = {
    format: 1,
    application: 'rust',
    provider: 'steamcmd',
    platform: 'linux/amd64',
    buildId: '456',
    inventorySha256: 'a'.repeat(64),
    binarySha256: crypto
      .createHash('sha256')
      .update('verified synthetic executable')
      .digest('hex'),
  };
  await fs.writeFile(
    path.join(root, '.lobby-goblin-runtime.json'),
    JSON.stringify(receipt),
    {mode: 0o644},
  );
  const env = {
    RUST_SERVER_IDENTITY: 'lobby-goblin-rust',
    RUST_RCON_PASSWORD: 'x'.repeat(48),
  };
  return {root, engine, receipt, env};
}
test('managed startup requires exact verified software and links only the stable world directory', async (t) => {
  const f = await fixture(t),
    config = await managedStartup(f.env, f.root);
  assert.equal(config.install, false);
  assert.equal(config.binary, path.join(f.engine, 'RustDedicated'));
  assert.equal(config.worldRoot, path.join(f.root, 'server'));
  assert.equal(await fs.readlink(path.join(f.engine, 'server')), '../server');
  assert.equal(
    await fs.realpath(path.join(f.engine, 'server')),
    config.worldRoot,
  );
  assert.equal(config.args[config.args.indexOf('+server.seed') + 1], '12345');
  assert.deepEqual(executionReceipt(f.receipt), f.receipt);
});
test('missing, foreign or altered software never starts a download or creates a replacement world', async (t) => {
  const f = await fixture(t),
    marker = path.join(f.root, '.lobby-goblin-runtime.json');
  for (const receipt of [
    {...f.receipt, buildId: 'public'},
    {...f.receipt, provider: 'other'},
    {...f.receipt, platform: 'linux/arm64'},
    {...f.receipt, command: '/bin/sh'},
    {...f.receipt, binarySha256: 'b'.repeat(64)},
  ]) {
    await fs.writeFile(marker, JSON.stringify(receipt));
    await assert.rejects(managedStartup(f.env, f.root));
    assert.equal(
      await fs.stat(path.join(f.root, 'server')).catch(() => null),
      null,
    );
  }
  await fs.unlink(marker);
  await assert.rejects(managedStartup(f.env, f.root));
  await fs.writeFile(marker, JSON.stringify(f.receipt));
  await fs.unlink(path.join(f.engine, 'RustDedicated'));
  await assert.rejects(managedStartup(f.env, f.root));
  assert.equal(
    await fs.stat(path.join(f.root, 'server')).catch(() => null),
    null,
  );
});
test('saved world identity, settings and player files remain in the stable directory across execution changes', async (t) => {
  const f = await fixture(t),
    identity = path.join(f.root, 'server/lobby-goblin-rust');
  await fs.mkdir(path.join(identity, 'cfg'), {recursive: true});
  const contents = {
    'proceduralmap.1000.456.289.sav': 'fixture save',
    'player.blueprints.5.db': 'fixture players',
    'cfg/server.cfg': 'server.hostname Private',
  };
  for (const [name, value] of Object.entries(contents))
    await fs.writeFile(path.join(identity, name), value);
  const config = await managedStartup(f.env, f.root);
  assert.equal(config.args[config.args.indexOf('+server.seed') + 1], '456');
  assert.equal(
    config.args[config.args.indexOf('+server.worldsize') + 1],
    '1000',
  );
  await assert.rejects(
    managedStartup({...f.env, RUST_SERVER_SEED: '789'}, f.root),
    /seed differs/,
  );
  for (const [name, value] of Object.entries(contents))
    assert.equal(await fs.readFile(path.join(identity, name), 'utf8'), value);
});
test('world escape links, writable execution trees and unreviewed startup options are refused', async (t) => {
  const f = await fixture(t);
  await fs.symlink('../../elsewhere', path.join(f.engine, 'server'));
  await assert.rejects(managedStartup(f.env, f.root), /world link/);
  await fs.unlink(path.join(f.engine, 'server'));
  await fs.mkdir(path.join(f.engine, 'server'));
  await assert.rejects(managedStartup(f.env, f.root), /world data/);
  await fs.rmdir(path.join(f.engine, 'server'));
  await fs.chmod(f.engine, 0o777);
  await assert.rejects(managedStartup(f.env, f.root), /controller-owned/);
  await fs.chmod(f.engine, 0o755);
  for (const change of [
    {RUST_SERVER_IDENTITY: '../other'},
    {RUST_SERVER_STARTUP_ARGUMENTS: '+quit'},
    {RUST_OXIDE_ENABLED: 'true'},
  ])
    await assert.rejects(managedStartup({...f.env, ...change}, f.root));
});

test('linked identities are refused before creating configuration outside the world root', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(f.root, 'server'));
  await fs.symlink(outside, path.join(f.root, 'server/lobby-goblin-rust'));
  await assert.rejects(managedStartup(f.env, f.root), /cannot be linked/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('readiness writes use a reserved descriptor and cannot follow a replaced temporary path', async (t) => {
  const f = await fixture(t),
    target = path.join(f.root, 'readiness.json'),
    outside = path.join(f.root, 'sealed.txt');
  await fs.writeFile(outside, 'sealed software');
  await fs.symlink(outside, target);
  await assert.rejects(readinessProof(target));
  await fs.unlink(target);
  const proof = await readinessProof(target);
  try {
    proof.publish(42);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {pid: 42});
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    await fs.unlink(target);
    await fs.symlink(outside, target);
    proof.publish(43);
    assert.equal(await fs.readFile(outside, 'utf8'), 'sealed software');
  } finally {
    await proof.close();
  }
});

test('SDK preparation replaces only an ordinary file and refuses links to sealed or world files', async (t) => {
  const f = await fixture(t),
    sdk = path.join(f.root, 'sdk'),
    source = path.join(f.root, 'source.so'),
    outside = path.join(f.root, 'world.txt');
  await fs.mkdir(sdk);
  await fs.writeFile(source, 'verified SDK');
  await fs.writeFile(outside, 'world data');
  await prepareSdk(source, sdk);
  assert.equal(
    await fs.readFile(path.join(sdk, 'steamclient.so'), 'utf8'),
    'verified SDK',
  );
  await fs.unlink(path.join(sdk, 'steamclient.so'));
  await fs.symlink(outside, path.join(sdk, 'steamclient.so'));
  await assert.rejects(prepareSdk(source, sdk), /destination cannot be linked/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'world data');
  await fs.unlink(path.join(sdk, 'steamclient.so'));
  await fs.link(outside, path.join(sdk, 'steamclient.so'));
  await assert.rejects(prepareSdk(source, sdk), /destination cannot be linked/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'world data');
});

test('readiness checks prove a live process without cross-user signal privileges', () => {
  for (const state of ['R', 'S', 'D', 'T'])
    assert.equal(
      liveProcess({pid: 42}, '42 (RustDedicated) ' + state + ' 1 2 3'),
      true,
    );
  for (const state of ['Z', 'X', 'x'])
    assert.equal(
      liveProcess({pid: 42}, '42 (RustDedicated) ' + state + ' 1 2 3'),
      false,
    );
  assert.equal(liveProcess({pid: 43}, '42 (RustDedicated) S 1 2 3'), false);
  assert.equal(liveProcess({pid: '../other'}, '42 (RustDedicated) S'), false);
});

test('unrecorded framework loaders and an unprepared compiler cannot start or redirect mutable setup', async (t) => {
  const f = await fixture(t),
    managed = path.join(f.engine, 'RustDedicated_Data/Managed');
  await fs.mkdir(managed, {recursive: true});
  await fs.writeFile(path.join(managed, 'Oxide.Rust.dll'), 'synthetic loader', {
    mode: 0o644,
  });
  await assert.rejects(managedStartup(f.env, f.root), /Unrecorded framework/);
  await fs.writeFile(
    path.join(f.engine, '.lobby-goblin-mods.json'),
    JSON.stringify({format: 1, status: 'complete', framework: 'oxide'}),
    {mode: 0o644},
  );
  await assert.rejects(managedStartup(f.env, f.root), /ENOENT/);
  await fs.writeFile(
    path.join(f.engine, 'Oxide.Compiler'),
    'unreviewed compiler',
    {mode: 0o755},
  );
  await assert.rejects(managedStartup(f.env, f.root), /executable differs/);
  assert.equal(
    await fs
      .lstat(path.join(f.root, 'server/lobby-goblin-rust/mods'))
      .catch(() => null),
    null,
  );
});
