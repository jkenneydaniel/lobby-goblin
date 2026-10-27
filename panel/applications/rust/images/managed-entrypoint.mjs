// Runtime for separately prepared, exact Rust software. It never downloads or
// updates a game. The controller owns software publication; Rust owns worlds.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants, writeFileSync, unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {shutdownEvidence, startupEvidence} from './entrypoint.mjs';
import {createWebRcon} from './transport.js';

const check = (value, message) => {
  if (!value) throw Error(message);
};
const hash = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const readyFile = '/tmp/lobby-goblin-rust-ready.json';
export async function readinessProof(file = readyFile) {
  const handle = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  return {
    publish(pid) {
      check(
        Number.isSafeInteger(pid) && pid > 1,
        'Invalid game readiness identity',
      );
      // Keep the reserved descriptor: game-writable /tmp paths cannot redirect
      // a later privileged health write to the sealed executable tree.
      writeFileSync(handle.fd, JSON.stringify({pid}));
    },
    close: () => handle.close(),
  };
}
async function realDirectory(root, {sealed = false} = {}) {
  const stat = await fs.lstat(root);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await fs.realpath(root)) === root,
    'Managed Rust directories cannot be linked',
  );
  if (sealed)
    check(
      stat.uid === process.getuid() && !(stat.mode & 0o022),
      'Managed software requires controller-owned directories',
    );
  return root;
}
async function ensureDirectory(location) {
  await realDirectory(path.dirname(location));
  const stat = await fs.lstat(location).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) await fs.mkdir(location, {mode: 0o755});
  return realDirectory(location);
}
async function record(file, max) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    check(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === process.getuid() &&
        !(before.mode & 0o022) &&
        before.size <= max,
      'Managed Rust metadata must be a bounded controller-owned file',
    );
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(
        buffer,
        count,
        buffer.length - count,
        null,
      );
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    check(
      count === before.size &&
        after.nlink === 1 &&
        after.size === before.size &&
        after.ctimeMs === before.ctimeMs &&
        after.mtimeMs === before.mtimeMs,
      'Managed Rust metadata changed during startup',
    );
    return JSON.parse(buffer.subarray(0, count));
  } finally {
    await handle.close();
  }
}
export function executionReceipt(value) {
  check(
    value &&
      Object.keys(value).every((key) =>
        [
          'format',
          'application',
          'provider',
          'platform',
          'buildId',
          'inventorySha256',
          'binarySha256',
        ].includes(key),
      ) &&
      value.format === 1 &&
      value.application === 'rust' &&
      value.provider === 'steamcmd' &&
      value.platform === 'linux/amd64' &&
      typeof value.buildId === 'string' &&
      /^[1-9]\d{0,19}$/.test(value.buildId) &&
      hash(value.inventorySha256) &&
      hash(value.binarySha256),
    'A verified exact Rust execution receipt is required',
  );
  return value;
}
async function verifyBinary(binary, expected) {
  const handle = await fs.open(
    binary,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    check(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === process.getuid() &&
        !(before.mode & 0o022) &&
        !!(before.mode & 0o111) &&
        before.size > 0 &&
        before.size <= 256 * 1024 ** 2,
      'Managed Rust executable ownership or mode changed',
    );
    const digest = crypto.createHash('sha256'),
      buffer = Buffer.alloc(1024 ** 2);
    let count = 0;
    for (;;) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - count + 1),
        null,
      );
      if (!read.bytesRead) break;
      count += read.bytesRead;
      check(count <= before.size, 'Managed Rust executable grew');
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    check(
      count === before.size &&
        after.nlink === 1 &&
        after.size === before.size &&
        after.ctimeMs === before.ctimeMs &&
        after.mtimeMs === before.mtimeMs &&
        digest.digest('hex') === expected,
      'Managed Rust executable differs from its verified receipt',
    );
  } finally {
    await handle.close();
  }
}
async function framework(engine) {
  const file = path.join(engine, '.lobby-goblin-mods.json'),
    stat = await fs.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (!stat) return {};
  const marker = await record(file, 4096);
  check(
    marker.format === 1 &&
      marker.status === 'complete' &&
      ['none', 'carbon', 'oxide'].includes(marker.framework),
    'Framework files need controller recovery',
  );
  if (marker.framework === 'oxide') {
    const target = path.join(
      engine,
      'RustDedicated_Data/Managed/Oxide.Rust.dll',
    );
    check(
      (await fs.lstat(target)).isFile() &&
        (await fs.realpath(target)) === target,
      'Oxide loader is missing or linked',
    );
  }
  if (marker.framework !== 'carbon') return {};
  for (const name of [
    'libdoorstop.so',
    'carbon/managed/Carbon.Preloader.dll',
  ]) {
    const target = path.join(engine, name);
    check(
      (await fs.lstat(target)).isFile() &&
        (await fs.realpath(target)) === target,
      'Carbon loader is missing or linked',
    );
  }
  await realDirectory(path.join(engine, 'carbon'));
  const target = path.join(engine, 'carbon/config.json');
  const existing = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let config = {};
  if (existing) {
    check(
      existing.isFile() &&
        existing.nlink === 1 &&
        existing.size <= 512 * 1024 &&
        (await fs.realpath(target)) === target,
      'Invalid Carbon configuration',
    );
    config = JSON.parse(await fs.readFile(target, 'utf8'));
  }
  check(
    config && typeof config === 'object' && !Array.isArray(config),
    'Invalid Carbon configuration',
  );
  const updating = config.SelfUpdating || {};
  check(
    updating && typeof updating === 'object' && !Array.isArray(updating),
    'Invalid Carbon self-update configuration',
  );
  if (updating.Enabled !== false || updating.HookUpdates !== false) {
    config.SelfUpdating = {...updating, Enabled: false, HookUpdates: false};
    const temporary = target + '.' + crypto.randomUUID();
    try {
      await fs.writeFile(temporary, JSON.stringify(config), {
        flag: 'wx',
        mode: 0o644,
      });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, {force: true});
    }
  }
  return {
    TERM: 'xterm',
    LD_PRELOAD: path.join(engine, 'libdoorstop.so'),
    DOORSTOP_ENABLED: '1',
    DOORSTOP_TARGET_ASSEMBLY: path.join(
      engine,
      'carbon/managed/Carbon.Preloader.dll',
    ),
  };
}
export async function managedStartup(
  env = process.env,
  root = '/steamcmd/rust',
) {
  check(
    typeof root === 'string' &&
      path.isAbsolute(root) &&
      path.resolve(root) === root &&
      root !== '/',
    'Invalid managed Rust root',
  );
  await realDirectory(root, {sealed: true});
  const engine = await realDirectory(path.join(root, 'engine'), {sealed: true});
  const receipt = executionReceipt(
    await record(path.join(root, '.lobby-goblin-runtime.json'), 16 * 1024),
  );
  const binary = path.join(engine, 'RustDedicated');
  await verifyBinary(binary, receipt.binarySha256);
  check(
    /^[A-Za-z0-9_-]{1,64}$/.test(env.RUST_SERVER_IDENTITY || ''),
    'Invalid Rust identity',
  );
  check(
    /^[A-Za-z0-9_-]{32,128}$/.test(env.RUST_RCON_PASSWORD || ''),
    'A generated RCON password is required',
  );
  check(
    !env.RUST_SERVER_STARTUP_ARGUMENTS &&
      !['1', 'true'].includes(env.RUST_OXIDE_ENABLED),
    'Custom startup commands require a reviewed runtime',
  );
  const worldRoot = path.join(root, 'server');
  await ensureDirectory(worldRoot);
  const link = path.join(engine, 'server'),
    linked = await fs.lstat(link).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (!linked) await fs.symlink('../server', link);
  else
    check(
      linked.isSymbolicLink() && (await fs.readlink(link)) === '../server',
      'The execution tree cannot contain world data or another world link',
    );
  check(
    (await fs.realpath(link)) === worldRoot,
    'Managed Rust world link escaped its data root',
  );
  const identity = path.join(worldRoot, env.RUST_SERVER_IDENTITY);
  await ensureDirectory(identity);
  await ensureDirectory(path.join(identity, 'cfg'));
  const saves = (await fs.readdir(identity)).filter((name) =>
    name.endsWith('.sav'),
  );
  const identities = new Set(
    saves
      .map((name) => name.match(/^proceduralmap\.(\d+)\.(\d+)\.\d+\.sav$/))
      .filter(Boolean)
      .map((match) => match[1] + ':' + match[2]),
  );
  check(
    !saves.length ||
      (identities.size === 1 &&
        saves.every((name) =>
          /^proceduralmap\.\d+\.\d+\.\d+\.sav$/.test(name),
        )),
    'Existing save identity is ambiguous',
  );
  let seed = env.RUST_SERVER_SEED,
    size = env.RUST_SERVER_WORLDSIZE;
  if (identities.size) {
    const [savedSize, savedSeed] = [...identities][0].split(':');
    check(
      !seed || seed === savedSeed,
      'Configured seed differs from the existing world',
    );
    check(
      !size || size === savedSize,
      'Configured size differs from the existing world',
    );
    seed = savedSeed;
    size = savedSize;
  }
  seed ??= '12345';
  size ??= '2000';
  check(
    /^\d+$/.test(seed) && Number(seed) >= 1 && Number(seed) <= 0xffffffff,
    'Invalid world seed',
  );
  check(
    /^\d+$/.test(size) && Number(size) >= 1000 && Number(size) <= 6000,
    'Invalid world size',
  );
  const port = (key, fallback) => {
    const value = env[key] || fallback;
    check(
      /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535,
      'Invalid port',
    );
    return value;
  };
  const args = [
    '-batchmode',
    '-nographics',
    '+server.identity',
    env.RUST_SERVER_IDENTITY,
    '+server.port',
    port('RUST_SERVER_PORT', '28015'),
    '+server.queryport',
    port('RUST_SERVER_QUERYPORT', '28017'),
    '+server.level',
    env.RUST_SERVER_LEVEL || 'Procedural Map',
    '+server.seed',
    seed,
    '+server.worldsize',
    size,
    '+rcon.port',
    port('RUST_RCON_PORT', '28016'),
    '+rcon.password',
    env.RUST_RCON_PASSWORD,
    '+rcon.web',
    '1',
    '+rcon.ip',
    '0.0.0.0',
    '+server.secure',
    '1',
    '-logfile',
    '-',
  ];
  return {
    root,
    engine,
    worldRoot,
    binary,
    args,
    receipt,
    modEnv: await framework(engine),
    install: false,
  };
}
const run = (program, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(Error('Managed Rust ownership setup failed')),
    );
  });
const gameHelper = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['/app/managed-helper.mjs', ...args],
      {
        uid: 1000,
        gid: 1000,
        env: {PATH: '/usr/bin:/bin', HOME: '/home/node'},
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(Error('Managed Rust game-user setup failed')),
    );
  });
export async function main() {
  check(
    process.getuid() === 0,
    'Managed Rust supervisor requires its reviewed root profile',
  );
  await fs.unlink(readyFile).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const config = await managedStartup();
  // Only mutable worlds change ownership. Executables remain controller-owned.
  await run('chown', ['-hR', '1000:1000', config.worldRoot]);
  for (const file of [
    path.join(config.engine, 'steamclient.so'),
    '/opt/steamcmd/linux64/steamclient.so',
  ])
    if (await fs.stat(file).catch(() => null)) {
      await gameHelper(['sdk', file]);
      break;
    }
  const user = {
    uid: 1000,
    gid: 1000,
    cwd: config.engine,
    env: {
      ...process.env,
      HOME: '/home/node',
      LD_LIBRARY_PATH:
        config.engine +
        ':' +
        config.engine +
        '/RustDedicated_Data/Plugins/x86_64',
      ...config.modEnv,
    },
  };
  const proof = await readinessProof();
  let child;
  try {
    child = spawn(config.binary, config.args, {
      ...user,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    await proof.close();
    throw error;
  }
  const rcon = createWebRcon(),
    shutdown = shutdownEvidence(),
    startup = startupEvidence();
  let stopping = false,
    healthy = false,
    proofFailed = false;
  for (const [stream, destination, key] of [
    [child.stdout, process.stdout, 'stdout'],
    [child.stderr, process.stderr, 'stderr'],
  ])
    stream.on('data', (chunk) => {
      shutdown.observe(chunk, key);
      if (!healthy && !proofFailed && startup.observe(chunk, key)) {
        try {
          proof.publish(child.pid);
          healthy = true;
        } catch {
          proofFailed = true;
          console.error(
            'Managed Rust startup completed but its health proof could not be recorded. Inspect available storage.',
          );
        }
      }
      destination.write(chunk);
    });
  process.once('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    shutdown.request();
    void (async () => {
      try {
        const saved = await rcon({
          host: '127.0.0.1',
          port: Number(process.env.RUST_RCON_PORT || 28016),
          password: process.env.RUST_RCON_PASSWORD,
          command: 'server.save',
        });
        shutdown.acknowledgeSave(saved);
        shutdown.quit();
        try {
          await rcon({
            host: '127.0.0.1',
            port: Number(process.env.RUST_RCON_PORT || 28016),
            password: process.env.RUST_RCON_PASSWORD,
            command: 'quit',
          });
        } catch {
          /* Quit may close WebRCON before replying. */
        }
      } catch {
        console.error(
          'Managed Rust is not ready for a graceful save; waiting for its process.',
        );
        if (child.exitCode === null && child.signalCode === null)
          await gameHelper(['signal', String(child.pid)]).catch(() =>
            console.error(
              'Managed Rust could not be signalled; waiting for its process.',
            ),
          );
      }
    })();
  });
  child.once('error', () => {
    console.error('Managed Rust process could not start.');
    rcon.close();
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    void proof.close().catch(() => {});
    try {
      unlinkSync(readyFile);
    } catch {
      /* No stale health proof remains. */
    }
    console.log('Managed Rust process exited: ' + (signal || code));
    rcon.close();
    process.exitCode = shutdown.exitCode(code, signal);
    if (process.exitCode)
      console.error(
        'Rust shutdown evidence: ' + JSON.stringify(shutdown.evidence()),
      );
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      'Managed Rust startup refused. Inspect its verified software and world layout in the panel.',
    );
    process.exitCode = 1;
  });
