import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  frameworkRelease,
  frameworkFiles,
  boundedDownload,
  sha256,
} from './mod-packages.js';
import {oxideCompiler} from './mod-layout.js';
import {createWebRcon} from './transport.js';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import metadata from './managed/image.json' with {type: 'json'};
import deployment from '../../../providers/steamcmd/deployment.json' with {type: 'json'};
const execute = promisify(execFile),
  id = randomUUID(),
  owner = 'io.lobby-goblin.acceptance=' + id;
const game = 'lobby-managed-rust-' + id,
  image = metadata.repository + ':' + metadata.tag;
const volumes = ['software', 'control', 'game', 'mod-scratch'].map(
  (name) => 'lobby-managed-rust-' + id + '-' + name,
);
const fixture = fileURLToPath(new URL('./managed-native.mjs', import.meta.url));
const modFixture = fileURLToPath(
  new URL('./managed-mod-native.mjs', import.meta.url),
);
let packagesRoot = null;
let phase = 'initializing';
const progress = (next, detail = {}) => {
  phase = next;
  console.log(JSON.stringify({phase, ...detail}));
};
const password =
  randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const run = async (args, timeout = 120000) =>
  (
    await execute('docker', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 ** 2,
    })
  ).stdout.trim();
const engine = JSON.parse(await run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'Select an explicit disposable engine.',
);
assert.equal(
  await run(['ps', '-aq']),
  '',
  'Native acceptance requires a fresh engine with no existing containers.',
);
const imageId = JSON.parse(await run(['image', 'inspect', image]))[0].Id;
const mounts = (keys) =>
  keys.flatMap((key) => [
    '--mount',
    'type=volume,source=' +
      volumes[['software', 'control', 'game'].indexOf(key)] +
      ',target=/' +
      key +
      ',volume-nocopy',
  ]);
const fixtureRun = async (mode, keys, user = '0:0') =>
  run(
    [
      'run',
      '--rm',
      '--init',
      '--name',
      'lobby-managed-fixture-' + id,
      '--label',
      owner,
      '--user',
      user,
      '--cap-drop',
      'ALL',
      ...(user === '0:0' ? ['--cap-add', 'DAC_OVERRIDE'] : []),
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--mount',
      'type=bind,source=' + fixture + ',target=/acceptance.mjs,readonly',
      ...mounts(keys),
      '-e',
      'LOBBY_MANAGED_RUST_ACCEPTANCE=disposable',
      '--entrypoint',
      'node',
      deployment.image,
      '/acceptance.mjs',
      mode,
    ],
    2400000,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const info = async () => JSON.parse(await run(['inspect', game]))[0];
async function ready() {
  const deadline = Date.now() + 900000;
  for (;;) {
    const state = await info();
    assert.ok(
      state.State.Running && !state.State.OOMKilled,
      'New fixture game stopped before readiness.',
    );
    if (state.State.Health?.Status === 'healthy') return;
    assert.ok(Date.now() < deadline, 'New fixture game readiness timed out.');
    await sleep(2000);
  }
}
// Match the controller's reusable remote connection. Spawning a new loopback
// client for every assertion can hit Rust's per-IP reconnect controls and
// prevent the supervisor's separate loopback save/quit connection.
const consoleClient = createWebRcon();
const rcon = async (command) => {
  const current = await info(),
    networks = Object.values(current.NetworkSettings.Networks)
      .map((network) => network.IPAddress)
      .filter(Boolean);
  assert.equal(current.Config.Labels['io.lobby-goblin.acceptance'], id);
  assert.equal(networks.length, 1);
  assert.match(networks[0], /^\d{1,3}(?:\.\d{1,3}){3}$/);
  return consoleClient({host: networks[0], port: 28016, password, command});
};
async function worldTime() {
  const value = await rcon('env.time'),
    match = value.match(/env\.time:\s*"?([0-9]+(?:\.[0-9]+)?)/);
  assert.ok(match, 'The fixture must report its saved world time.');
  return Number(match[1]);
}
async function packages() {
  packagesRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lobby-managed-mod-packages-'),
  );
  const result = new Map();
  for (const framework of ['carbon', 'oxide']) {
    const release = await frameworkRelease(framework),
      archive = await boundedDownload(release.url, 64 * 1024 ** 2);
    assert.equal(archive.length, release.size);
    assert.equal(sha256(archive), release.sha256);
    const files = frameworkFiles(framework, archive);
    if (framework === 'oxide') {
      const response = await fetch(oxideCompiler.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
      assert.equal(response.status, 200);
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        assert.ok(bytes <= oxideCompiler.bytes);
        chunks.push(chunk);
      }
      const compiler = Buffer.concat(chunks);
      assert.equal(compiler.length, oxideCompiler.bytes);
      assert.equal(sha256(compiler), oxideCompiler.sha256);
      files.push({name: 'Oxide.Compiler', data: compiler, mode: 0o755});
    }
    const directory = path.join(packagesRoot, framework);
    await fs.mkdir(directory);
    const manifest = {
      framework,
      version: release.version,
      archiveSha256: release.sha256,
      files: [],
    };
    for (const file of files) {
      const target = path.join(directory, file.name);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, file.data, {flag: 'wx', mode: 0o644});
      manifest.files.push({
        name: file.name,
        sha256: sha256(file.data),
        size: file.data.length,
        mode: file.mode,
      });
    }
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify(manifest),
      {flag: 'wx'},
    );
    result.set(framework, {
      directory,
      version: release.version,
      sha256: release.sha256,
    });
  }
  return result;
}
async function modRun(mode, framework, directory) {
  assert.equal(
    (await info()).State.Running,
    false,
    'Stop the fresh game before private fixture writes.',
  );
  return run(
    [
      'run',
      '--rm',
      '--init',
      '--network',
      'none',
      '--label',
      owner,
      '--user',
      '0:0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'DAC_OVERRIDE',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--mount',
      'type=bind,source=' + modFixture + ',target=/acceptance.mjs,readonly',
      '--mount',
      'type=volume,source=' + volumes[2] + ',target=/game,volume-nocopy',
      '--mount',
      'type=volume,source=' + volumes[3] + ',target=/scratch,volume-nocopy',
      ...(directory
        ? [
            '--mount',
            'type=bind,source=' + directory + ',target=/package,readonly',
          ]
        : []),
      '-e',
      'LOBBY_MANAGED_MOD_ACCEPTANCE=disposable',
      '--entrypoint',
      'node',
      image,
      '/acceptance.mjs',
      mode,
      ...(framework ? [framework] : []),
    ],
    1200000,
  );
}
async function frameworkAcceptance() {
  progress('reviewing-framework-packages');
  const selected = await packages(),
    reports = [];
  await modRun('base');
  for (const framework of ['carbon', 'oxide']) {
    const release = selected.get(framework);
    progress('staging-' + framework, {version: release.version});
    await modRun('stage', framework, release.directory);
    progress('starting-' + framework);
    await run(['start', game]);
    await ready();
    progress('compiling-' + framework + '-plugin');
    assert.match(
      await rcon(framework === 'carbon' ? 'c.version' : 'oxide.version'),
      framework === 'carbon' ? /carbon/i : /oxide/i,
    );
    const deadline = Date.now() + 240000;
    let probe = '';
    while (Date.now() < deadline) {
      try {
        probe = await rcon('lg.probe');
        if (/LG_MOD_PROBE_OK:[1-9]/.test(probe)) break;
      } catch {}
      await sleep(2000);
    }
    assert.match(
      probe,
      /LG_MOD_PROBE_OK:[1-9]/,
      'The framework must compile and run its C# plugin.',
    );
    await cleanStop();
    const report = JSON.parse(await modRun('inspect', framework));
    progress('verified-' + framework, report);
    reports.push({
      ...report,
      version: release.version,
      packageSha256: release.sha256,
    });
  }
  return reports;
}
async function cleanStop() {
  await run(['stop', '--time', '-1', game], 180000);
  const state = (await info()).State;
  assert.equal(state.Running, false);
  assert.equal(state.OOMKilled, false);
  assert.equal(state.ExitCode, 0, 'Managed Rust must prove its save and quit.');
}
try {
  progress('preparing-exact-rust-software');
  await run(['pull', '--platform', 'linux/amd64', deployment.image], 1200000);
  for (const volume of volumes)
    await run(['volume', 'create', '--label', owner, volume]);
  await fixtureRun('initialize', ['software', 'control', 'game']);
  await fixtureRun('prepare', ['software', 'control'], '1000:0');
  const prepared = JSON.parse(
    await fixtureRun('publish', ['software', 'control', 'game']),
  );
  progress('starting-vanilla', {buildId: prepared.buildId});
  await run([
    'run',
    '-d',
    '--name',
    game,
    '--label',
    owner,
    '--platform',
    'linux/amd64',
    '--memory',
    '10g',
    '--cpus',
    '2',
    '--pids-limit',
    '1024',
    '--cap-drop',
    'ALL',
    ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'].flatMap(
      (cap) => ['--cap-add', cap],
    ),
    '--security-opt',
    'no-new-privileges:true',
    '--mount',
    'type=volume,source=' + volumes[2] + ',target=/steamcmd/rust,volume-nocopy',
    '-e',
    'RUST_RCON_PASSWORD=' + password,
    '-e',
    'RUST_SERVER_SEED=12345',
    '-e',
    'RUST_SERVER_WORLDSIZE=1000',
    image,
  ]);
  await ready();
  progress('verifying-vanilla-save');
  assert.equal((await info()).Image, imageId);
  const first = JSON.parse(await rcon('serverinfo'));
  assert.equal(first.MaxPlayers, 1);
  const savedTime = ((await worldTime()) + 9) % 24;
  await rcon('env.time ' + savedTime.toFixed(2));
  await rcon('server.save');
  const uid = await run([
    'exec',
    game,
    'node',
    '--input-type=module',
    '-e',
    "import fs from 'node:fs';const {pid}=JSON.parse(fs.readFileSync('/tmp/lobby-goblin-rust-ready.json'));const status=fs.readFileSync('/proc/'+pid+'/status','utf8');if(!/^Uid:\\s+1000\\s+1000\\s+1000\\s+1000$/m.test(status))throw Error('Unexpected game UID');console.log('1000');",
  ]);
  assert.equal(uid, '1000');
  await cleanStop();
  const before = JSON.parse(await fixtureRun('inspect', ['game']));
  const oldLogs = await run(['logs', game]);
  progress('reloading-vanilla-world');
  await run(['start', game]);
  await ready();
  assert.equal(JSON.parse(await rcon('serverinfo')).MaxPlayers, 1);
  const reloadedTime = await worldTime(),
    difference = Math.abs(reloadedTime - savedTime);
  assert.ok(
    Math.min(difference, 24 - difference) < 0.75,
    'Restart must restore the deliberately changed world time.',
  );
  await cleanStop();
  const after = JSON.parse(await fixtureRun('inspect', ['game']));
  assert.equal(after.save, before.save);
  assert.equal(after.buildId, before.buildId);
  const newLogs = (await run(['logs', game])).slice(oldLogs.length);
  assert.ok(
    /Spawning [1-9]\d* entities from save/.test(newLogs),
    'Restart must report loading entities from its saved world.',
  );
  const frameworks = await frameworkAcceptance();
  console.log(
    JSON.stringify({
      passed: true,
      frameworks,
      image,
      ...prepared,
      ...after,
      gameUid: 1000,
      saveAndQuitVerified: true,
      existingWorldLoaded: true,
      worldStateRestored: true,
      savedTime,
      reloadedTime,
      privatePristineStoreNotMounted: true,
      existingServicesTouched: false,
      existingWorldsTouched: false,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({failedPhase: phase, message: error.message}));
  const logs = await execute('docker', ['logs', '--tail', '150', game], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 ** 2,
  })
    .then((value) => value.stdout + '\n' + value.stderr)
    .catch(() => 'New fixture logs unavailable');
  console.error(logs.replaceAll(password, '[redacted]').slice(-12000));
  throw error;
} finally {
  consoleClient.close();
  const containers = (await run(['ps', '-aq', '--filter', 'label=' + owner]))
    .split('\n')
    .filter(Boolean);
  for (const container of containers) {
    const current = JSON.parse(await run(['inspect', container]))[0];
    assert.equal(current.Config.Labels['io.lobby-goblin.acceptance'], id);
    if (current.State.Running)
      await run(
        [
          'stop',
          '--time',
          current.Name === '/' + game ? '-1' : '30',
          container,
        ],
        180000,
      );
    await run(['rm', container]);
  }
  for (const volume of volumes) {
    const current = JSON.parse(await run(['volume', 'inspect', volume]))[0];
    assert.equal(current.Labels['io.lobby-goblin.acceptance'], id);
    await run(['volume', 'rm', volume]);
  }
  if (packagesRoot) await fs.rm(packagesRoot, {recursive: true, force: true});
}
