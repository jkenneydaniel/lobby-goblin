import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createGuardedModStore} from '../core/guarded-mod-store.js';

const linux = process.platform === 'linux';
const relative = 'server/identity/mods/carbon/plugins';
async function fixture(t, options = {}) {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'guarded-mod-data-')),
  );
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const anchor = path.join(temporary, 'data'),
    secret = path.join(temporary, 'private');
  await fs.mkdir(anchor, {mode: 0o700});
  await fs.mkdir(secret, {mode: 0o700});
  await fs.writeFile(path.join(secret, 'Safe.cs'), 'PRIVATE SENTINEL');
  const store = createGuardedModStore(anchor, relative, {
    accept: (name) => /\.cs$/.test(name),
    ...options,
  });
  return {temporary, anchor, secret, store};
}
test('guarded mod stores accept only declared anchors/directories and leaf names', () => {
  const anchor = path.resolve('fixture-data');
  for (const directory of [
    '',
    '../private',
    '/private',
    'server/../private',
    'server//plugins',
    'server\\private',
    'server/a:stream',
  ])
    assert.throws(() => createGuardedModStore(anchor, directory));
  assert.throws(() => createGuardedModStore('/', relative));
  assert.throws(() =>
    createGuardedModStore(anchor, relative, {maxFileBytes: -1}),
  );
});
test(
  'guarded Linux data files retain atomic updates, modes and bounded inventories while refusing links and special files',
  {skip: !linux, timeout: 5000},
  async (t) => {
    const f = await fixture(t, {maxFileBytes: 1024});
    assert.equal(await f.store.read('Missing.cs'), null);
    await f.store.write('Safe.cs', Buffer.from('public source'), 0o600);
    assert.deepEqual(await f.store.read('Safe.cs'), {
      data: Buffer.from('public source'),
      mode: 0o600,
    });
    assert.deepEqual([...(await f.store.list()).keys()], ['Safe.cs']);
    await assert.rejects(f.store.write('../private', Buffer.from('bad')));
    await assert.rejects(
      f.store.write('Oversize.cs', Buffer.alloc(1025)),
      /Invalid mod file data/,
    );
    await fs.symlink(
      path.join(f.secret, 'Safe.cs'),
      path.join(f.store.root, 'Link.cs'),
    );
    await assert.rejects(f.store.read('Link.cs'), /cannot be links/);
    await assert.rejects(
      f.store.write('Link.cs', Buffer.from('bad')),
      /cannot be links/,
    );
    await fs.link(
      path.join(f.store.root, 'Safe.cs'),
      path.join(f.store.root, 'Hard.cs'),
    );
    await assert.rejects(f.store.read('Hard.cs'), /without hardlinks/);
    await fs.unlink(path.join(f.store.root, 'Hard.cs'));
    execFileSync('mkfifo', [path.join(f.store.root, 'Pipe.cs')]);
    await assert.rejects(f.store.read('Pipe.cs'), /ordinary files/);
    assert.equal(
      await fs.readFile(path.join(f.secret, 'Safe.cs'), 'utf8'),
      'PRIVATE SENTINEL',
    );
    await fs.unlink(path.join(f.store.root, 'Link.cs'));
    await fs.unlink(path.join(f.store.root, 'Pipe.cs'));
    await f.store.write('Safe.cs', null);
    assert.equal(await f.store.read('Safe.cs'), null);
  },
);
test(
  'a game-owned parent swap cannot redirect a privileged mod read into private state',
  {skip: !linux},
  async (t) => {
    let f,
      armed = false;
    f = await fixture(t, {
      fault: async (phase) => {
        if (!armed || phase !== 'directory-open') return;
        armed = false;
        await fs.rename(f.store.root, f.store.root + '-retained');
        await fs.symlink(f.secret, f.store.root);
      },
    });
    await f.store.write('Safe.cs', Buffer.from('public source'));
    armed = true;
    await assert.rejects(
      f.store.read('Safe.cs'),
      /cannot contain links|storage changed/,
    );
    assert.equal(
      await fs.readFile(
        path.join(f.store.root + '-retained', 'Safe.cs'),
        'utf8',
      ),
      'public source',
    );
    assert.equal(
      await fs.readFile(path.join(f.secret, 'Safe.cs'), 'utf8'),
      'PRIVATE SENTINEL',
    );
  },
);
test(
  'a parent swap during publication writes only to the pinned public directory',
  {skip: !linux},
  async (t) => {
    let f,
      armed = false;
    f = await fixture(t, {
      fault: async (phase) => {
        if (!armed || phase !== 'before-write') return;
        armed = false;
        await fs.rename(f.store.root, f.store.root + '-retained');
        await fs.symlink(f.secret, f.store.root);
      },
    });
    await f.store.write('Safe.cs', Buffer.from('public source'));
    armed = true;
    await assert.rejects(
      f.store.write('Safe.cs', Buffer.from('public replacement')),
      /cannot contain links|storage changed/,
    );
    assert.equal(
      await fs.readFile(
        path.join(f.store.root + '-retained', 'Safe.cs'),
        'utf8',
      ),
      'public replacement',
    );
    assert.equal(
      await fs.readFile(path.join(f.secret, 'Safe.cs'), 'utf8'),
      'PRIVATE SENTINEL',
    );
    assert.ok(
      !(await fs.readdir(f.store.root + '-retained')).some((name) =>
        name.startsWith('.lg-mod-'),
      ),
    );
  },
);
