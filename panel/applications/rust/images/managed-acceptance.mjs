import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import metadata from './managed/image.json' with {type: 'json'};
const run = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 ** 2,
  });
const engine = JSON.parse(run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'Select an explicit disposable engine.',
);
const image = metadata.repository + ':' + metadata.tag,
  info = JSON.parse(run(['image', 'inspect', image]))[0];
assert.equal(info.Architecture, 'amd64');
assert.equal(info.Config.User, '0:0');
assert.deepEqual(info.Config.Entrypoint, [
  'node',
  '/app/managed-entrypoint.mjs',
]);
assert.deepEqual(info.Config.Cmd || [], []);
assert.equal(
  info.Config.Labels['io.lobby-goblin.software-provider'],
  'steamcmd',
);
assert.equal(
  info.Config.Labels['io.lobby-goblin.image-revision'],
  String(metadata.revision),
);
const name = 'lobby-managed-rust-smoke-' + randomUUID();
try {
  run([
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {managedStartup} from '/app/managed-entrypoint.mjs';await assert.rejects(managedStartup(process.env));assert.deepEqual(await fs.readdir('/steamcmd/rust'),[]);console.log('Empty runtime refused without a download or world creation.');",
  ]);
} finally {
  try {
    run(['rm', '-f', name]);
  } catch {
    /* The short smoke container removes itself. */
  }
}
if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch')
  await import('./managed-native-acceptance.mjs');
else
  console.log(
    JSON.stringify({
      passed: true,
      image,
      missingSoftwareRefused: true,
      gameProcessStarted: false,
    }),
  );
