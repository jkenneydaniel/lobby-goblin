// This runs only on a fresh CI engine, with three newly created fixture volumes.
// No daemon socket or real game process is mounted into these workers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {runWorker} from '/app/fleet/worker.js';
import {runRetainedWorker} from '/app/fleet/retained-worker.js';
import {retainedInventory} from '/app/fleet/retained-files.js';
import {writeJSON, readJSON} from '/app/common.js';
import {softwareInventory} from '/app/providers/steamcmd/files.js';
import {executionProjection} from '/app/core/software-execution.js';
const fleet = 'a'.repeat(32),
  sourceId = 'b'.repeat(32),
  id = 'c'.repeat(32),
  nonce = 'd'.repeat(64);
const source = '/source',
  instance = '/instance',
  library = '/setup/library';
const config = {
  fleet,
  game: 'rust',
  softwareMode: 'managed',
  seed: 3532793187,
  worldSize: 2000,
  name: 'Recovered fixture',
  maxPlayers: 8,
  controllerToken: 'new-controller',
  rconPassword: 'new-rcon',
};
async function put(root, name, data) {
  await fs.mkdir(path.dirname(root + '/' + name), {recursive: true});
  await fs.writeFile(root + '/' + name, data, {mode: 0o600});
}
if (process.argv[2] === 'prepare') {
  await fs.mkdir(library);
  await runWorker(
    {
      ...config,
      action: 'provision',
      id: sourceId,
      controllerToken: 'old-controller',
      rconPassword: 'old-rcon',
    },
    {instance: source, library},
  );
  await runWorker(
    {...config, action: 'provision', id, retainedRecovery: {sourceId, nonce}},
    {instance, library},
  );
  await put(source, 'data/engine/RustDedicated', 'fixture binary');
  await fs.chmod(source + '/data/engine/RustDedicated', 0o755);
  const receipt = {
      format: 1,
      selection: {
        format: 1,
        provider: 'steamcmd',
        application: 'rust',
        platform: 'linux/amd64',
        softwareVersion: '123',
        source: {
          kind: 'steam',
          appId: '258550',
          branch: 'public',
          buildId: '123',
          depots: [{id: '258551', manifest: '12345678901234567890'}],
        },
      },
      inventory: (await softwareInventory(source + '/data/engine')).inventory,
    },
    binary = {
      name: 'RustDedicated',
      executable: true,
      sha256: crypto
        .createHash('sha256')
        .update('fixture binary')
        .digest('hex'),
    },
    initialId = crypto.randomUUID();
  await put(
    source,
    'data/server/lobby-goblin-rust/proceduralmap.2000.2147483647.289.sav',
    'synthetic world',
  );
  await put(
    source,
    'data/server/lobby-goblin-rust/player.blueprints.5.db',
    'synthetic players',
  );
  await put(
    source,
    'data/server/lobby-goblin-rust/mods/oxide/plugins/Fixture.cs',
    'synthetic plugin',
  );
  await put(source, 'state/mods/installed.json', '{"framework":"oxide"}');
  await writeJSON(source + '/state/software/rust/installation.json', {
    format: 1,
    id: initialId,
    instance: sourceId,
    phase: 'complete',
    prepared: {receipt},
    binary,
  });
  await writeJSON(source + '/state/software/rust/current.json', {
    format: 1,
    initialId,
    transactionId: crypto.randomUUID(),
    receipt,
    binary,
  });
  await writeJSON(
    source + '/data/.lobby-goblin-runtime.json',
    executionProjection(receipt, binary, 'rust'),
  );
  await fs.symlink('../server', source + '/data/engine/server');
  await fs.symlink(
    '../server/lobby-goblin-rust/mods/oxide',
    source + '/data/engine/oxide',
  );
  await put(
    source,
    'software/steamcmd/private-cache',
    'synthetic pristine software',
  );
  await fs.chown(source + '/software/steamcmd/private-cache', 1000, 1000);
  await fs.chown(source + '/software/steamcmd', 1000, 1000);
  await fs.chmod(source + '/software/steamcmd', 0o700);
  await fs.chown(
    source + '/data/server/lobby-goblin-rust/player.blueprints.5.db',
    845,
    845,
  );
  const result = await runRetainedWorker(
    {...config, action: 'inspect', sourceId},
    {source, instance},
  );
  assert.equal(result.recovery.ready, true, result.recovery.reason);
  await writeJSON('/setup/request.json', {
    ...config,
    action: 'copy',
    sourceId,
    id,
    nonce,
    fingerprint: result.fingerprint,
  });
  console.log(
    'Prepared synthetic managed Rust with private cache, player data and inert framework links.',
  );
} else if (process.argv[2] === 'inspect') {
  const request = await readJSON('/setup/request.json');
  const result = await runRetainedWorker(
    {...request, action: 'inspect'},
    {source},
  );
  assert.equal(result.recovery.ready, true, result.recovery.reason);
  assert.equal(result.fingerprint, request.fingerprint);
  assert.equal(result.recovery.seed, 2147483647);
  await assert.rejects(fs.writeFile(source + '/unexpected', 'no write'), {
    code: 'EROFS',
  });
  console.log(
    'Read-only inspection passed; private source metadata remained unchanged.',
  );
} else {
  const request = await readJSON('/setup/request.json');
  await runRetainedWorker(request, {source, instance});
  assert.equal(
    (await retainedInventory(source)).fingerprint,
    request.fingerprint,
  );
  assert.equal(
    await fs.readFile(instance + '/control/controller-token', 'utf8'),
    'new-controller',
  );
  assert.equal(
    await fs.readFile(instance + '/control/rcon-password', 'utf8'),
    'new-rcon',
  );
  assert.equal(
    (await readJSON(instance + '/state/software/rust/installation.json'))
      .instance,
    id,
  );
  assert.equal(
    (await fs.stat(instance + '/software/steamcmd/private-cache')).uid,
    1000,
  );
  assert.equal(
    (await fs.stat(instance + '/software/steamcmd/private-cache')).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await fs.stat(instance + '/software/steamcmd')).mode & 0o777,
    0o700,
  );
  assert.equal(
    (
      await fs.stat(
        instance + '/data/server/lobby-goblin-rust/player.blueprints.5.db',
      )
    ).uid,
    845,
  );
  assert.equal(
    await fs.readlink(instance + '/data/engine/oxide'),
    '../server/lobby-goblin-rust/mods/oxide',
  );
  assert.equal(
    await fs.readFile(
      instance + '/data/server/lobby-goblin-rust/mods/oxide/plugins/Fixture.cs',
      'utf8',
    ),
    'synthetic plugin',
  );
  await assert.rejects(fs.writeFile(source + '/unexpected', 'no write'), {
    code: 'EROFS',
  });
  console.log(
    'Verified independent copy, source integrity, fresh credentials, owner permissions, exact software record and declared framework links. No game was started.',
  );
}
