// Fresh GitHub Actions engine only. Never run against a developer/live daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.MANAGEMENT_PANEL_DISPOSABLE, 'true');
assert.equal(process.platform, 'linux');
const command = async (file, args) => {
  const {stdout, stderr} = await exec(file, args, {maxBuffer: 32 * 1024 ** 2});
  if (stderr) process.stderr.write(stderr); return stdout.trim();
};
const docker = args => command('docker', args);
assert.equal(await docker(['ps', '-aq']), '', 'A fresh engine with no containers is required.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-panel-acceptance-'));
const context = path.join(temporary, 'context');
await command(process.execPath, ['panel/test/prepare-runtime-acceptance.mjs', '--out', context]);
const panel = path.join(context, 'panel');
async function version(value) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(panel, name), data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.version = value; if (data.packages?.['']) data.packages[''].version = value;
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  }
  const file = path.join(panel, 'Dockerfile');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/image.version="[^"]+"/, 'image.version="' + value + '"'));
}
await version('0.3.7-alpha');
await docker(['build', '-t', 'local/lgb-panel-next:fixture', panel]);
const next = await docker(['image', 'inspect', '--format', '{{.Id}}', 'local/lgb-panel-next:fixture']);
// Only the copied test image substitutes registry resolution. All broker RPC,
// permissions, UID drop, detached cutover, real-image manifest checks, metadata
// snapshots, activation and reconnection execute production code on real Docker.
const worker = path.join(panel, 'management-panel-worker.js'), source = await fs.readFile(worker, 'utf8');
const resolver = 'resolveImage: version => resolvePanelRuntime(engine, version)';
assert.equal(source.split(resolver).length, 2);
await fs.writeFile(worker, source.replace(resolver, 'resolveImage: async () => ' + JSON.stringify(next)));
await version('0.3.6-alpha');
await docker(['build', '-t', 'local/lgb-panel-current:fixture', panel]);
const runtime = await docker(['image', 'inspect', '--format', '{{.Id}}', 'local/lgb-panel-current:fixture']);
await docker(['pull', 'node:24-alpine']);
const output = '/acceptance-output';
await command('sudo', ['mkdir', '-m', '700', output]);
await command('sudo', ['chown', '1001:0', output]);
const owner = '01a16598-733c-7232-bd99-1d6b06086183';
const marker = path.join(temporary, 'owner'); await fs.writeFile(marker, owner + ' disposable platform acceptance only\n');
const engine = await docker(['info', '--format', '{{.ID}}']);
const socket = await fs.stat('/var/run/docker.sock');
const common = ['run', '--name', 'lgb-panel-acceptance-runner', '--user', '1001:0', '--group-add', String(socket.gid), '--label', 'io.lobby-goblin.acceptance=' + owner,
  '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
  '--mount', 'type=bind,source=' + output + ',target=' + output,
  '--mount', 'type=bind,source=' + marker + ',target=/acceptance-owner,readonly',
  '--mount', 'type=bind,source=' + path.resolve('deploy/fleet/compose.yaml') + ',target=/acceptance-template,readonly',
  '-e', 'DOCKER_SOCKET=/var/run/docker.sock', '-e', 'ACCEPTANCE_ENGINE_ID=' + engine,
  '-e', 'ACCEPTANCE_RUNTIME=' + runtime, '-e', 'ACCEPTANCE_NEXT=' + next,
  '-e', 'ACCEPTANCE_PANEL=true', ...(process.env.ACCEPTANCE_LEGACY === 'true' ? ['-e', 'ACCEPTANCE_LEGACY=true'] : []), '--entrypoint', 'node', runtime, 'test/management-update-runtime.mjs'];
console.log(await docker(common));
const result = JSON.parse(await command('sudo', ['cat', output + '/result.json']));
assert.equal(result.panel, true); assert.equal(result.complete, true);
console.log(JSON.stringify(result, null, 2));
