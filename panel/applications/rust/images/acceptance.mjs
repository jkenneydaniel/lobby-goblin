import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {projectRoot, imageDefinition} from './build.mjs';
const definition = await imageDefinition();
const run = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 ** 2,
  });
const engine = JSON.parse(run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'An explicit disposable engine is required.',
);
const info = JSON.parse(run(['image', 'inspect', definition.image]))[0];
assert.equal(info.Architecture, 'amd64');
assert.equal(info.Config.User, '0:0');
assert.equal(info.Config.WorkingDir, '/app');
assert.deepEqual(info.Config.Entrypoint, ['node', '/app/entrypoint.mjs']);
assert.deepEqual(info.Config.Cmd || [], []);
assert.equal(
  info.Config.Labels['io.lobby-goblin.image-revision'],
  String(definition.revision),
);
const name = 'lobby-rust-base-' + randomUUID();
try {
  run([
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--entrypoint',
    'node',
    definition.image,
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {constants} from 'node:fs';import {execFileSync} from 'node:child_process';assert.equal(process.getuid(),1000);await fs.access('/opt/steamcmd/steamcmd.sh',constants.X_OK);for(const root of ['/steamcmd/rust','/home/node/.steam/sdk64'])await fs.access(root,constants.W_OK);assert.ok(!execFileSync('ldd',['/opt/steamcmd/linux32/steamcmd'],{encoding:'utf8'}).includes('not found'));assert.equal(typeof(await import('/app/transport.js')).createWebRcon,'function');",
  ]);
  console.log(
    JSON.stringify({
      passed: true,
      image: definition.image,
      sharedSteamBase: true,
      legacySupervisorUser: info.Config.User,
      steamWorkerUser: 1000,
      gameProcessStarted: false,
    }),
  );
} finally {
  try {
    run(['rm', '-f', name]);
  } catch {}
}
const {migrationAcceptance} = await import(
  pathToFileURL(projectRoot + '/panel/test/package-image-acceptance.mjs')
);
migrationAcceptance('rust', definition, projectRoot);
