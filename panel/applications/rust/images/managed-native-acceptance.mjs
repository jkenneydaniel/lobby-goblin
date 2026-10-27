import assert from 'node:assert/strict';
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
const volumes = ['software', 'control', 'game'].map(
  (name) => 'lobby-managed-rust-' + id + '-' + name,
);
const fixture = fileURLToPath(new URL('./managed-native.mjs', import.meta.url));
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
const rcon = async (command) =>
  run([
    'exec',
    game,
    'node',
    '--input-type=module',
    '-e',
    "import {createWebRcon} from '/app/transport.js';const r=createWebRcon();try{console.log(await r({host:'127.0.0.1',port:28016,password:process.env.RUST_RCON_PASSWORD,command:process.argv[1]}));}finally{r.close();}",
    command,
  ]);
async function cleanStop() {
  await run(['stop', '--time', '-1', game], 180000);
  const state = (await info()).State;
  assert.equal(state.Running, false);
  assert.equal(state.OOMKilled, false);
  assert.equal(state.ExitCode, 0, 'Managed Rust must prove its save and quit.');
}
try {
  await run(['pull', '--platform', 'linux/amd64', deployment.image], 1200000);
  for (const volume of volumes)
    await run(['volume', 'create', '--label', owner, volume]);
  await fixtureRun('initialize', ['software', 'control', 'game']);
  await fixtureRun('prepare', ['software', 'control'], '1000:0');
  const prepared = JSON.parse(
    await fixtureRun('publish', ['software', 'control', 'game']),
  );
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
  assert.equal((await info()).Image, imageId);
  const first = JSON.parse(await rcon('serverinfo'));
  assert.equal(first.MaxPlayers, 1);
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
  await run(['start', game]);
  await ready();
  assert.equal(JSON.parse(await rcon('serverinfo')).MaxPlayers, 1);
  await cleanStop();
  const after = JSON.parse(await fixtureRun('inspect', ['game']));
  assert.equal(after.save, before.save);
  assert.equal(after.buildId, before.buildId);
  const newLogs = (await run(['logs', game])).slice(oldLogs.length);
  assert.ok(
    /Loading.*(?:save|\.sav)/i.test(newLogs),
    'Restart must load the existing fixture world.',
  );
  console.log(
    JSON.stringify({
      passed: true,
      image,
      ...prepared,
      ...after,
      gameUid: 1000,
      saveAndQuitVerified: true,
      existingWorldLoaded: true,
      privatePristineStoreNotMounted: true,
      existingServicesTouched: false,
      existingWorldsTouched: false,
    }),
  );
} catch (error) {
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
}
