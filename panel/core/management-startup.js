import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../common.js';
import {managementImage, managementHash} from './management-installation.js';
import {managementVolume, managementAnchor, assertVolume, assertAnchor, portableRuntimeOverlay} from './management-volume.js';

// Only public runtime selection crosses back onto the host. Original installer
// files remain unchanged; private specifications never leave Docker storage.
export async function portableStartupRuntime(directory, manifest, {execute}) {
  const volume = managementVolume(manifest.id);
  const listed = (await execute('docker', ['volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}'])).trim();
  if (!listed) return null;
  assert(listed === volume, 'Management storage discovery was ambiguous. No services were started.', 409);
  const engine = (await execute('docker', ['info', '--format', '{{.ID}}'])).trim();
  const owned = JSON.parse(await execute('docker', ['volume', 'inspect', volume]));
  assert(owned.length === 1, 'Management storage identity changed.'); assertVolume(owned[0], manifest.id, engine);
  const anchors = JSON.parse(await execute('docker', ['inspect', managementAnchor(manifest.id)]));
  assert(anchors.length === 1, 'Management enrollment identity changed.'); assertAnchor(anchors[0], manifest.id, engine);
  const request = {action: 'runtime', fleet: manifest.id, engine};
  const selected = JSON.parse(await execute('docker', ['run', '--rm', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64',
    '--label', 'io.lobby-goblin.fleet=' + manifest.id, '--label', 'io.lobby-goblin.role=management-runtime-reader',
    '--mount', 'type=volume,source=' + volume + ',target=/management,readonly,volume-nocopy',
    '--env', 'MANAGEMENT_REQUEST=' + JSON.stringify(request), '--entrypoint', 'node', anchors[0].Image, '/app/management-volume-worker.js']));
  assert(!selected.error, 'Inspect the retained management update before starting this installation.', 409);
  if (!selected.enrolled) return null;
  assert(selected.kind === (manifest.kind || 'fleet') && selected.engine === engine && managementImage(selected.image) && ['brokered', 'legacy'].includes(selected.profile) &&
    /^[a-f0-9]{32}$/.test(selected.id || selected.enrollment), 'Management startup selection changed.', 409);
  const expected = portableRuntimeOverlay(selected);
  const overlay = JSON.stringify(expected, null, 2) + '\n';
  const file = path.join(directory, '.management-runtime-' + (selected.id || selected.enrollment) + '.compose.json');
  const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1 &&
    managementHash(JSON.parse(await fs.readFile(file, 'utf8'))) === managementHash(expected), 'A generated startup override changed. Preserve it for review.', 409);
  else {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(overlay); await handle.sync(); } finally { await handle.close(); }
    // A competing writer cannot replace a user-created path unnoticed.
    try { await fs.link(temporary, file); } finally { await fs.unlink(temporary); }
  }
  return {image: selected.image, engine, arguments: ['-f', file]};
}
