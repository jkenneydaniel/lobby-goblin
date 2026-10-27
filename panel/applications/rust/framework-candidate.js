import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assert} from '../../common.js';
import {
  atomicRecord,
  directory,
  readRecord,
  softwareInventory,
} from '../../providers/steamcmd/files.js';
import {createModManager} from './mods.js';
import {frameworkFiles, sha256} from './mod-packages.js';
import {packagedCarbonHooks} from './mod-components.js';
import {
  carbonConflicts,
  oxideCompiler,
  oxideNativeConfig,
  oxideNativeConfigPath,
} from './mod-layout.js';

// Called only on a new, controller-private copy of a verified pristine release.
// The caller owns paired data recovery and stopped publication. No game-owned
// directory or previous execution tree is changed here.
export async function prepareFrameworkCandidate({
  engine,
  state,
  review,
  buildId,
  protocol,
  assertStopped,
  fetcher = fetch,
}) {
  await assertStopped();
  await directory(engine);
  await directory(state);
  for (const root of [engine, state]) {
    const stat = await fs.lstat(root);
    assert(
      stat.uid === process.getuid() && !(stat.mode & 0o022),
      'Framework candidates must remain private controller-owned storage.',
      409,
    );
  }
  const manager = createModManager({
    root: engine,
    state,
    assertStopped,
    fetcher,
    command: async () => {
      throw Error('A private candidate cannot execute game commands.');
    },
  });
  await fs.mkdir(path.join(state, 'mods'), {mode: 0o700});
  const id = randomUUID();
  await atomicRecord(path.join(state, 'mods/plan-' + id + '.json'), {
    ...review,
    id,
    created: Date.now(),
    current: sha256(
      Buffer.from(JSON.stringify({format: 1, framework: 'none', files: []})),
    ),
  });
  await manager.install(id);
  const installedFile = path.join(state, 'mods/installed.json'),
    installed = await readRecord(installedFile);
  const originals = randomUUID(),
    before = path.join(state, 'mods/originals', originals);
  await fs.mkdir(before, {recursive: true, mode: 0o700});
  // Record every derived component against its pristine bytes, just like an
  // archive overlay. Recovery never needs to fetch a previous compiler/config.
  async function derived(name, data, mode) {
    const target = path.join(engine, name),
      stat = await fs.lstat(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
    let previous = null;
    if (stat) {
      assert(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          stat.uid === process.getuid() &&
          !(stat.mode & 0o022),
        'Derived framework components require sealed ordinary files.',
        409,
      );
      previous = await fs.readFile(target);
      assert(
        previous.length <= 256 * 1024 ** 2,
        'Framework original exceeds its recovery budget.',
        409,
      );
      await fs.mkdir(path.dirname(path.join(before, name)), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(before, name), previous, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    await assertStopped();
    if (data === null) {
      if (stat) await fs.unlink(target);
      (installed.removed ||= []).push({
        name,
        sha256: previous === null ? null : sha256(previous),
        original: previous === null ? null : originals,
      });
      return;
    }
    await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o755});
    await fs.writeFile(target, data, {mode});
    await fs.chmod(target, mode);
    const existing = installed.files.find((file) => file.name === name);
    if (existing) existing.sha256 = sha256(data);
    else
      installed.files.push({
        name,
        sha256: sha256(data),
        original: previous === null ? null : originals,
        originalSha256: previous === null ? null : sha256(previous),
      });
  }
  let hooks;
  if (review.framework === 'carbon') {
    assert(
      /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(protocol || ''),
      'Start and cleanly stop vanilla Rust once so its exact protocol can be reviewed.',
      409,
    );
    for (const name of carbonConflicts) await derived(name, null);
    const archive = await fs.readFile(
      path.join(state, 'mods/packages', review.sha256 + '.tar.gz'),
    );
    assert(
      sha256(archive) === review.sha256,
      'Prepared Carbon archive changed.',
      409,
    );
    hooks = packagedCarbonHooks(
      {buildId, protocol, packageSha256: review.sha256},
      frameworkFiles('carbon', archive),
    );
  }
  if (review.framework === 'oxide') {
    assert(
      JSON.stringify(review.compiler) === JSON.stringify(oxideCompiler),
      'Review the pinned Oxide compiler before preparing this framework.',
      409,
    );
    const response = await fetcher(oxideCompiler.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    assert(
      response.status === 200,
      'The reviewed Oxide compiler is unavailable.',
      502,
    );
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert(
        bytes <= oxideCompiler.bytes,
        'Oxide compiler exceeds its reviewed size.',
        409,
      );
      chunks.push(chunk);
    }
    const compiler = Buffer.concat(chunks);
    assert(
      compiler.length === oxideCompiler.bytes &&
        sha256(compiler) === oxideCompiler.sha256,
      'The Oxide compiler changed from its reviewed identity.',
      409,
    );
    await derived('Oxide.Compiler', compiler, 0o755);
    await derived(
      oxideNativeConfigPath,
      Buffer.from(oxideNativeConfig()),
      0o644,
    );
  }
  await atomicRecord(installedFile, installed);
  await atomicRecord(path.join(engine, '.lobby-goblin-mods.json'), {
    format: 1,
    status: 'complete',
    framework: review.framework,
    ...(hooks ? {hooks} : {}),
  });
  await softwareInventory(engine, {sync: true});
  await softwareInventory(path.join(state, 'mods'), {
    maxFiles: 20000,
    maxBytes: 64 * 1024 ** 3,
    sync: true,
  });
  await assertStopped();
  return installed;
}
