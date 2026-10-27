import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
test('the real status page serves stored content, escapes markup and stops cleanly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'example-app-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const server = path.join(root, 'a directory with spaces', 'server.mjs');
  await fs.mkdir(path.dirname(server));
  await fs.copyFile(
    fileURLToPath(new URL('./server.mjs', import.meta.url)),
    server,
  );
  const file = path.join(root, 'settings.json');
  await fs.writeFile(
    file,
    JSON.stringify({title: 'Health <script>', message: 'Stored content'}),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(pathToFileURL(server))],
    {
      env: {...process.env, PORT: '0', SETTINGS_FILE: file},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const output = await new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(String(data)));
    child.once('error', reject);
    child.once('exit', () => reject(Error('Server exited before listening.')));
  });
  const port = Number(output.match(/port (\d+)/)?.[1]);
  assert.ok(port);
  const base = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(base + '/health')).status, 200);
  const page = await (await fetch(base)).text();
  assert.match(page, /Stored content/);
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<script>/);
  assert.equal((await fetch(base + '/unexpected')).status, 404);
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exit)[0], 0);
});
