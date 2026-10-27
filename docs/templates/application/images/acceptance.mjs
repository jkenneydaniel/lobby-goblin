// Run only on a fresh disposable CI engine, never an existing application host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import metadata from './image.json' with {type: 'json'};
const docker = (...args) => execFileSync('docker', args, {encoding: 'utf8'}).trim();
const engine = docker('info', '--format', '{{.ID}}');
assert.ok(process.env.GITHUB_ACTIONS === 'true' || process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine, 'Select an explicitly disposable engine.');
assert.equal(docker('ps', '-aq'), '', 'Use an empty disposable engine.');
const name = 'example-app-acceptance-' + randomUUID(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'example-app-native-'));
try {
  await fs.chmod(root, 0o755);
  const settings = path.join(root, 'settings.json');
  await fs.writeFile(settings, JSON.stringify({title: 'Disposable example', message: 'Ready'}), {mode: 0o644});
  docker('run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--mount', 'type=bind,source=' + settings + ',target=/data/settings.json,readonly', metadata.repository + ':' + metadata.tag);
  for (let attempt = 0; ; attempt++) {
    const state = JSON.parse(docker('inspect', name))[0];
    assert.equal(state.Config.User, '1000:0');
    assert.ok(state.State.Running, 'Example exited before readiness.');
    if (state.State.Health?.Status === 'healthy') break;
    assert.ok(attempt < 30, 'Example did not become healthy.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const content = docker('exec', name, 'node', '-e', "fetch('http://127.0.0.1:8080').then(r=>r.text()).then(t=>process.stdout.write(t))");
  assert.match(content, /Disposable example/);
  docker('stop', '--time', '15', name);
  assert.equal(JSON.parse(docker('inspect', name))[0].State.ExitCode, 0);
} finally {
  try { docker('rm', '-f', name); } finally { await fs.rm(root, {recursive: true, force: true}); }
}
