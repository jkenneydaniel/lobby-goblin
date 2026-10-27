import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import metadata from './worker/image.json' with {type: 'json'};

const run = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 ** 2,
    ...options,
  });
const engine = JSON.parse(run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'An explicit disposable engine is required.',
);
const image = metadata.repository + ':' + metadata.tag;
const info = JSON.parse(run(['image', 'inspect', image]))[0];
assert.equal(info.Config.User, '1000:1000');
assert.equal(info.Architecture, 'amd64');
assert.deepEqual(info.Config.Entrypoint, [
  'node',
  '/opt/lobby/panel/providers/steamcmd/worker.js',
]);
assert.deepEqual(info.Config.Cmd || [], []);
const name = 'lobby-steam-worker-' + randomUUID();
const common = (container) => [
  'run',
  '--rm',
  '--init',
  '--name',
  container,
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--memory',
  '2g',
  '--cpus',
  '2',
];
try {
  run([
    ...common(name),
    '--network',
    'none',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict';import {executeWorkerRequest} from '/opt/lobby/panel/providers/steamcmd/worker.js';assert.equal(process.getuid(),1000);const request={format:1,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source:{application:'rust',appId:'258550',platform:'linux/amd64',branches:['public']},requiredFiles:[{path:'RustDedicated',executable:true}],action:'inspect'};const response=await executeWorkerRequest(request);assert.equal(response.result.state.state,'uninstalled');await assert.rejects(executeWorkerRequest({...request,action:'activate'}),/supported/);",
  ]);
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const fixture = fileURLToPath(
      new URL('./worker-native.mjs', import.meta.url),
    );
    console.log(
      run(
        [
          ...common(name + '-native'),
          '--mount',
          'type=bind,source=' + fixture + ',target=/acceptance.mjs,readonly',
          '-e',
          'LOBBY_STEAM_WORKER_ACCEPTANCE=disposable',
          '--entrypoint',
          'node',
          image,
          '/acceptance.mjs',
        ],
        {timeout: 2400000},
      ),
    );
  } else
    console.log(
      JSON.stringify({
        passed: true,
        image,
        user: info.Config.User,
        isolatedRuntimeImports: true,
        lifecycleCommandsRefused: true,
        gameProcessStarted: false,
      }),
    );
} finally {
  for (const container of [name, name + '-native'])
    try {
      run(['rm', '-f', container]);
    } catch {}
}
