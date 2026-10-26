import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const run = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
const engine = JSON.parse(run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'Explicit disposable engine authority is required.',
);
assert.equal(
  JSON.parse(run(['ps', '--all', '--format', 'json']).trim() || 'null'),
  null,
  'Native conformance requires an empty disposable engine.',
);
const fleet = crypto.randomBytes(16).toString('hex'),
  registry = 'lobby-package-registry-' + fleet,
  runner = 'lobby-goblin-host-' + fleet,
  broker = 'lobby-goblin-docker-broker-' + fleet,
  group = 'lobby-goblin-fleet-' + fleet;
const image = 'local/lobby-package-runtime:' + fleet,
  status = 'ghcr.io/jkenneydaniel/status-page:1-lg.1';
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'lobby-package-native-'),
);
try {
  const label = 'io.lobby-goblin.acceptance=application-packages';
  run([
    'run',
    '-d',
    '--name',
    registry,
    '--label',
    label,
    '-p',
    '127.0.0.1:5000:5000',
    'registry:3',
  ]);
  const local = 'localhost:5000/lobby-status:1-lg.1';
  run(['tag', status, local]);
  run(['push', local]);
  // The acceptance copy changes only its package image reference to a local
  // registry. It still goes through the production digest/label admission code.
  await fs.cp(path.join(root, 'panel'), path.join(temporary, 'panel'), {
    recursive: true,
    filter: (file) =>
      !['node_modules', 'test', 'quality', 'images'].includes(
        path.basename(file),
      ),
  });
  const definitionFile = path.join(
    temporary,
    'panel/applications/status-page/definition.json',
  );
  const source = JSON.parse(await fs.readFile(definitionFile, 'utf8'));
  source.services[0].configuration.imagePolicy.defaultImage = local;
  source.services[0].configuration.imagePolicy.referencePattern =
    '^localhost:5000/lobby-status:1-lg\\.(?<revision>[1-9]\\d*)$';
  await fs.writeFile(definitionFile, JSON.stringify(source));
  run(['build', '-t', image, path.join(temporary, 'panel')]);
  for (const suffix of ['state', 'library', 'broker-state', 'broker-transport'])
    run([
      'volume',
      'create',
      '--label',
      label,
      '--label',
      'io.lobby-goblin.fleet=' + fleet,
      '--label',
      'io.lobby-goblin.role=' + suffix,
      group + '-' + suffix,
    ]);
  // Exercise the production broker in its own socket-owning container. The
  // operator test runner retains direct Docker access only for assertions.
  run([
    'run',
    '-d',
    '--name',
    broker,
    '--label',
    label,
    '--label',
    'io.lobby-goblin.fleet=' + fleet,
    '--label',
    'io.lobby-goblin.role=docker-broker',
    '--user',
    '0:0',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '-e',
    'MODE=docker-broker',
    '-e',
    'FLEET_ID=' + fleet,
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount',
    'type=volume,source=' + group + '-broker-state,target=/broker-state',
    '--mount',
    'type=volume,source=' +
      group +
      '-broker-transport,target=/broker-transport',
    image,
  ]);
  for (let attempt = 0; ; attempt++) {
    const info = JSON.parse(run(['inspect', broker]))[0];
    if (info.State.Health?.Status === 'healthy') break;
    assert.ok(
      info.State.Running && attempt < 90,
      'Disposable broker did not become healthy.',
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(
    run([
      'run',
      '--rm',
      '--name',
      runner,
      '--label',
      label,
      '--label',
      'io.lobby-goblin.fleet=' + fleet,
      '--label',
      'io.lobby-goblin.role=host-controller',
      '--user',
      '0:0',
      '--mount',
      'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount',
      'type=volume,source=' + group + '-state,target=/fleet',
      '--mount',
      'type=volume,source=' + group + '-library,target=/library',
      '--mount',
      'type=bind,source=' +
        root +
        'panel/test/container-runtime-acceptance.mjs,target=/app/test/container-runtime-acceptance.mjs,readonly',
      '--mount',
      'type=volume,source=' +
        group +
        '-broker-transport,target=/broker/socket,volume-subpath=socket,readonly',
      '--mount',
      'type=volume,source=' +
        group +
        '-broker-transport,target=/broker/credential,volume-subpath=host,readonly',
      '-e',
      'ACCEPTANCE_ENGINE_ID=' + engine,
      '-e',
      'ACCEPTANCE_FLEET=' + fleet,
      '-e',
      'ACCEPTANCE_RUNNER=' + runner,
      '-e',
      'ACCEPTANCE_IMAGE=' + image,
      '--entrypoint',
      'node',
      image,
      '/app/test/container-runtime-acceptance.mjs',
    ]),
  );
} finally {
  // This engine began empty; cleanup is limited to the fresh acceptance fleet.
  const containers = run([
    'ps',
    '-aq',
    '--filter',
    'label=io.lobby-goblin.fleet=' + fleet,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const id of containers) run(['rm', '-f', id]);
  try {
    run(['rm', '-f', registry]);
  } catch {}
  for (const id of run([
    'network',
    'ls',
    '-q',
    '--filter',
    'label=io.lobby-goblin.fleet=' + fleet,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean))
    run(['network', 'rm', id]);
  for (const id of run([
    'volume',
    'ls',
    '-q',
    '--filter',
    'label=io.lobby-goblin.fleet=' + fleet,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean))
    run(['volume', 'rm', id]);
  for (const suffix of [
    'state',
    'library',
    'broker-state',
    'broker-transport',
  ]) {
    try {
      run(['volume', 'rm', group + '-' + suffix]);
    } catch {}
  }
  await fs.rm(temporary, {recursive: true, force: true});
}
