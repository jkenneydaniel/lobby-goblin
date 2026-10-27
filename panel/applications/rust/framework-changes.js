import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {assert} from '../../common.js';
import {
  atomicRecord,
  directory,
  readRecord,
  softwareInventory,
} from '../../providers/steamcmd/files.js';
import {
  stageExecution,
  executionInventory,
  executionBinary,
} from '../../core/software-execution.js';
import {copyStoppedData, verifyStoppedData} from '../../core/stopped-data.js';
import {syncDirectory} from '../../core/storage/files.js';
import {workflowJournal} from '../../core/workflow-journal.js';
import {softwareReceipt} from '../../core/software-installation.js';
import {prepareFrameworkCandidate} from './framework-candidate.js';
import {
  prepareFrameworkLayout,
  carbonDataDirectories,
  carbonDataFiles,
  oxideCompiler,
} from './mod-layout.js';
import {sha256} from './mod-packages.js';
import {rustUpdateProvider} from './update-provider.js';
import {rustSoftwareProtocol} from './software-protocol.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const settled = (value) =>
  !value || ['complete', 'recovered', 'reviewed'].includes(value.phase);
const exists = async (location) =>
  fs.lstat(location).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
const phases = [
  'reserved',
  'checking-software',
  'reviewed',
  'preparing-software',
  'software-prepared',
  'activating-software',
  'snapshotting',
  'staging',
  'publishing',
  'prepared',
  'validating',
  'complete',
  'recovering',
  'recovered',
];

// Bootstrap must permit only the temporary missing nested directories owned
// by a retained paired rename. It does not resume that transaction.
export async function pairedFrameworkMissing(config, part) {
  const value = await readRecord(
    path.join(config.state, 'software/rust/framework-changes/current.json'),
    {optional: true, max: 256 * 1024},
  );
  if (!value) return false;
  assert(
    value.format === 1 &&
      value.instance === config.instance &&
      uuid(value.id) &&
      phases.includes(value.phase),
    'Invalid paired framework bootstrap journal.',
    409,
  );
  if (part === 'world')
    return (
      value.phase === 'recovering' &&
      ['intent', 'done'].includes(value.moves?.['quarantine-world']) &&
      value.moves?.['restore-world'] !== 'done'
    );
  if (part === 'engine')
    return (
      value.phase === 'publishing' ||
      (value.phase === 'recovering' &&
        value.moves?.['restore-engine'] !== 'done')
    );
  return false;
}

export function rustExecutionLinks(config, framework) {
  const engine = config.installRoot,
    mutable = path.join(config.data, config.identity, 'mods', framework),
    links = {server: '../server'};
  if (framework === 'oxide') links.oxide = path.relative(engine, mutable);
  if (framework === 'carbon')
    for (const name of [...carbonDataDirectories, ...carbonDataFiles])
      links['carbon/' + name] = path.relative(
        path.join(engine, 'carbon'),
        path.join(mutable, name),
      );
  return links;
}

// A framework change retains the complete stopped world and previous execution
// tree. The mods permission can prepare files, but only a later server-start
// operation may run and validate them. Recovery restores code and pre-start data
// together, retaining any newer data in the transaction's quarantine.
export function createRustFrameworkChanges(
  ctx,
  {
    software,
    mods,
    protocol,
    prepareValidation = async () => {},
    validate,
    validateSoftware,
    fault = async () => {},
    fetcher = fetch,
  },
) {
  if (!software) return null;
  const {config} = ctx,
    maintenance = software.maintenance,
    {engine, stopped, workers} = maintenance;
  const root = path.join(maintenance.root, 'framework-changes'),
    file = path.join(root, 'current.json');
  const journal = workflowJournal({
    file,
    history: path.join(root, 'history'),
    source: 'paired-frameworks',
    label: 'Paired framework changes',
    action: 'install-framework',
    getActive: () => ctx.active,
    describe: (record, parent) => ({
      source: 'paired-frameworks',
      action: record.action || 'install-framework',
      kind: record.kind === 'software' ? 'update' : 'mods',
      state: ['complete', 'reviewed'].includes(record.phase)
        ? 'succeeded'
        : record.phase === 'recovered'
          ? 'failed'
          : (parent?.id || record.operationRecord?.parentId) ===
                ctx.active?.id && !!ctx.active
            ? 'running'
            : 'interrupted',
      phase: record.phase,
      message:
        record.phase === 'reviewed'
          ? 'Exact Steam build reviewed. No application files changed.'
          : record.phase === 'complete'
            ? 'Paired transaction completed.'
            : record.phase === 'recovered'
              ? 'Previous software and world retained or restored together.'
              : 'A paired change needs validation or explicit recovery.',
      recovery: {
        required: !settled(record) && !ctx.active,
        actions: [
          {id: 'inspect', label: 'Inspect paired change'},
          {id: 'open', label: 'Open recovery tools', href: '#mods'},
        ],
      },
    }),
  });
  const updates = rustUpdateProvider(maintenance);
  let busy = false;
  async function read() {
    if (!(await exists(root))) return null;
    await directory(root);
    const value = await readRecord(file, {optional: true, max: 256 * 1024});
    if (!value) return null;
    assert(
      value.format === 1 &&
        uuid(value.id) &&
        value.instance === config.instance &&
        phases.includes(value.phase) &&
        (value.kind === undefined || value.kind === 'software') &&
        ['none', 'carbon', 'oxide'].includes(value.previousFramework) &&
        ['none', 'carbon', 'oxide'].includes(value.review?.framework),
      'Invalid paired framework journal. Preserve it for inspection.',
      409,
    );
    const moves = [
      'quarantine-world',
      'restore-world',
      'quarantine-mods',
      'restore-mods',
      'quarantine-engine',
      'restore-engine',
    ];
    assert(
      value.moves &&
        typeof value.moves === 'object' &&
        !Array.isArray(value.moves) &&
        Object.entries(value.moves).every(
          ([key, state]) =>
            moves.includes(key) && ['intent', 'done'].includes(state),
        ),
      'Invalid paired recovery progress.',
      409,
    );
    for (const key of ['world', 'beforeCode', 'beforeMods'])
      if (value[key])
        assert(
          /^[a-f0-9]{64}$/.test(value[key].sha256) &&
            Number.isSafeInteger(value[key].files) &&
            value[key].files >= 0 &&
            value[key].files <= (key === 'beforeCode' ? 200000 : 20000) &&
            Number.isSafeInteger(value[key].bytes) &&
            value[key].bytes >= 0 &&
            value[key].bytes <= 128 * 1024 ** 3,
          'Invalid paired recovery inventory.',
          409,
        );
    maintenance.target(softwareReceipt(value.previous?.receipt).selection);
    if (value.kind === 'software') {
      for (const key of ['resolveId', 'prepareId', 'rollbackId'])
        assert(
          value[key] === undefined || uuid(value[key]),
          'Invalid retained update worker.',
          409,
        );
      if (value.target) maintenance.target(value.target);
      for (const [key, id, selection] of [
        ['prepared', 'prepareId', value.target],
        ['rollback', 'rollbackId', value.previous.receipt.selection],
      ])
        if (value[key])
          assert(
            value[key].operationId === value[id] &&
              Number.isSafeInteger(value[key].revision) &&
              same(
                maintenance.target(
                  softwareReceipt(value[key].receipt).selection,
                ),
                selection,
              ),
            'Invalid retained update preparation.',
            409,
          );
    }
    assert(
      value.previous.binary.name === 'RustDedicated' &&
        /^[a-f0-9]{64}$/.test(value.previous.binary.sha256) &&
        value.previous.binary.executable === true,
      'Invalid retained execution identity.',
      409,
    );
    return value;
  }
  const location = (value, name) => path.join(root, 'history', value.id, name);
  async function checkpoint(value, phase, extra = {}, parent) {
    const next = {...value, ...extra, phase};
    await journal.write(next, parent);
    await fault(phase);
    return next;
  }
  async function guard(action) {
    const current = await read();
    assert(
      settled(current) ||
        [
          'stop',
          'recover-framework',
          'software-recover',
          'software-recover-modded',
          'software-cancel',
        ].includes(action) ||
        (action === 'start' && current.phase === 'prepared'),
      'A paired framework change needs validation or recovery before other changes.',
      409,
    );
  }
  async function plan(framework) {
    await guard('mods-plan');
    const reviewed = await mods.plan(framework);
    const value = {
      ...reviewed,
      layout: 1,
      ...(framework === 'oxide' ? {compiler: oxideCompiler} : {}),
      message:
        'Rust must remain stopped while preparing. A complete pre-change world and the previous software are retained together. Start Rust to validate the new framework. Recovery restores that earlier world, settings and plugins and retains any newer data privately.',
    };
    await atomicRecord(
      path.join(config.state, 'mods/plan-' + value.id + '.json'),
      value,
    );
    return value;
  }
  async function prepare(planId, job, update = null) {
    assert(!busy && uuid(planId), 'Choose one reviewed framework change.', 409);
    busy = true;
    try {
      await guard('install-framework');
      await stopped();
      await mods.verifyInstalled();
      assert(
        (await software.status()).phase === 'complete',
        'Finish initial Rust software setup before changing frameworks.',
        409,
      );
      const previousReceipt = await software.ensure(),
        previous = await maintenance.execution();
      assert(
        same(previousReceipt, previous.receipt),
        'Active software changed before framework review.',
        409,
      );
      const installedFile = path.join(config.state, 'mods/installed.json'),
        installed = (await readRecord(installedFile, {optional: true})) || {
          format: 1,
          framework: 'none',
          files: [],
        };
      const review = await readRecord(
        path.join(config.state, 'mods/plan-' + planId + '.json'),
        {max: 16384},
      );
      assert(
        review.id === planId &&
          review.layout === 1 &&
          Date.now() - review.created < 15 * 60000 &&
          review.current === sha256(Buffer.from(JSON.stringify(installed))),
        'Framework review expired or the installation changed. Review again.',
        409,
      );
      const currentProtocol =
        !update && review.framework === 'carbon' ? await protocol() : null;
      if (update)
        assert(
          update.kind === 'software' &&
            update.phase === 'reviewed' &&
            same(update.previous, previous) &&
            update.previousFramework === installed.framework &&
            review.framework === installed.framework &&
            update.review.id === planId,
          'The reviewed software or framework changed. Check updates again.',
          409,
        );
      await directory(root, {create: true});
      let value = {
        format: 1,
        id: randomUUID(),
        instance: config.instance,
        phase: 'reserved',
        started: new Date().toISOString(),
        previous,
        previousFramework: installed.framework,
        review,
        moves: {},
        ...(update
          ? {
              kind: 'software',
              action:
                update.action === 'software-check-modded'
                  ? 'software-update-modded'
                  : 'software-update',
              target: update.target,
              resolveId: update.resolveId,
              wasRunning: update.wasRunning,
            }
          : {}),
      };
      value = await checkpoint(value, 'reserved', {}, job);
      const transaction = location(value, '');
      value = await checkpoint(value, 'snapshotting');
      if (job)
        await ctx.stageMessage(
          job,
          'Retaining the complete stopped world for paired recovery…',
          'paired-world-copy',
        );
      const world = await copyStoppedData({
        source: config.data,
        destination: location(value, 'world'),
        assertStopped: stopped,
        fault,
      });
      const beforeCode = await executionInventory(
        engine,
        rustExecutionLinks(config, installed.framework),
      );
      const beforeMods = await softwareInventory(
        path.join(config.state, 'mods'),
        {maxFiles: 20000, maxBytes: 64 * 1024 ** 3},
      );
      value = await checkpoint(value, 'staging', {
        world,
        beforeCode,
        beforeMods: beforeMods.inventory,
      });
      if (job)
        await ctx.stageMessage(
          job,
          'Preparing a private framework candidate from verified Rust software…',
          'preparing-framework',
        );
      if (update) value = await updates.prepare(value, checkpoint);
      const candidateReceipt = update
        ? value.prepared.receipt
        : previous.receipt;
      const candidateProtocol = update
        ? await rustSoftwareProtocol({
            ...workers.paths,
            receipt: candidateReceipt,
          })
        : null;
      const candidateBinary = await stageExecution({
        software: workers.paths.software,
        staging: location(value, 'candidate'),
        receipt: candidateReceipt,
        executable: 'RustDedicated',
        fault,
      });
      await fs.mkdir(location(value, 'new-state'), {mode: 0o700});
      await prepareFrameworkCandidate({
        engine: location(value, 'candidate'),
        state: location(value, 'new-state'),
        review,
        buildId: candidateReceipt.selection.softwareVersion,
        protocol: candidateProtocol?.protocol || currentProtocol,
        assertStopped: stopped,
        fetcher,
      });
      // Plugin identities, source tracking and transaction history belong to
      // the library, independently of the selected framework package. Carry
      // them into the new private state instead of dropping update tracking.
      const library = path.join(config.state, 'mods/mod-library');
      if (await exists(library))
        await copyStoppedData({
          source: library,
          destination: location(value, 'new-state/mods/mod-library'),
          assertStopped: stopped,
        });
      await stopped();
      assert(
        same(
          await executionInventory(
            engine,
            rustExecutionLinks(config, installed.framework),
          ),
          beforeCode,
        ),
        'Previous execution changed during framework preparation.',
        409,
      );
      assert(
        same(
          (
            await softwareInventory(path.join(config.state, 'mods'), {
              maxFiles: 20000,
              maxBytes: 64 * 1024 ** 3,
            })
          ).inventory,
          value.beforeMods,
        ),
        'Previous mod state changed during framework preparation.',
        409,
      );
      await verifyStoppedData(config.data, world, stopped);
      if (update) {
        value = await checkpoint(value, value.phase, {
          candidateBinary,
          candidateProtocol,
        });
        value = await updates.activate(value, checkpoint);
        await fault('software-activated');
      }
      value = await checkpoint(value, 'publishing');
      await fs.rename(engine, location(value, 'previous-engine'));
      await syncDirectory(path.dirname(engine));
      await syncDirectory(transaction);
      await fault('previous-engine-held');
      await fs.rename(
        path.join(config.state, 'mods'),
        location(value, 'previous-mods'),
      );
      await syncDirectory(config.state);
      await syncDirectory(transaction);
      await fault('previous-mods-held');
      await fs.rename(location(value, 'candidate'), engine);
      await syncDirectory(path.dirname(engine));
      await syncDirectory(transaction);
      await fault('candidate-published');
      await fs.rename(
        location(value, 'new-state/mods'),
        path.join(config.state, 'mods'),
      );
      await syncDirectory(config.state);
      await syncDirectory(location(value, 'new-state'));
      if (review.framework !== 'none')
        await prepareFrameworkLayout({
          engine,
          worldRoot: config.data,
          identity: config.identity,
          framework: review.framework,
          initializeNative: false,
        });
      await maintenance.publishCurrent(
        candidateReceipt,
        candidateBinary,
        value.id,
      );
      value = await checkpoint(value, 'prepared');
      return 'Framework files prepared with paired world recovery. Start Rust to validate them, or recover the previous software and world.';
    } finally {
      busy = false;
    }
  }
  async function start(run, beforeCommit = async () => {}) {
    let value = await read();
    if (settled(value)) return run();
    await guard('start');
    await stopped();
    value = await checkpoint(value, 'validating');
    try {
      await stopped();
      await prepareValidation(value.review.framework, value.id);
      const result = await run();
      if (ctx.active)
        await ctx.stageMessage(
          ctx.active,
          'Checking framework loading and C# compilation…',
          'validating-framework',
        );
      if (value.kind === 'software')
        await validateSoftware(value.candidateProtocol);
      await validate(value.review.framework, value.id);
      await fault('before-framework-commit');
      await beforeCommit();
      await checkpoint(value, 'complete');
      return result;
    } catch (error) {
      // The new binary may already have saved this world. Ordinary actions stay
      // fenced until recovery restores the matching previous code/data pair.
      if ((await ctx.host.info()).State?.Running)
        await ctx.host.control('stop');
      throw error;
    }
  }
  async function inspect({deep = false} = {}) {
    const value = await read();
    if (!value) return {pending: false, review: null};
    const observation = {
      record: value,
      running: !!(await ctx.host.info()).State?.Running,
      paths: {},
      ...(deep && value.kind === 'software'
        ? {software: await updates.inspect()}
        : {}),
    };
    for (const name of [
      'previous-engine',
      'previous-mods',
      'world',
      'quarantine-engine',
      'quarantine-mods',
      'quarantine-world',
      'restore-world',
    ]) {
      const stat = await exists(location(value, name));
      observation.paths[name] = stat
        ? {
            dev: stat.dev,
            ino: stat.ino,
            directory: stat.isDirectory(),
            linked: stat.isSymbolicLink(),
          }
        : null;
    }
    return {
      pending: !settled(value),
      kind: value.kind || 'framework',
      phase: value.phase,
      framework: value.review.framework,
      previousFramework: value.previousFramework,
      review: createHash('sha256')
        .update(JSON.stringify(observation))
        .digest('hex'),
      observation,
    };
  }
  async function recover(params) {
    assert(
      !busy &&
        params?.confirm === true &&
        /^[a-f0-9]{64}$/.test(params.review || ''),
      'Inspect and confirm this paired framework recovery.',
      409,
    );
    busy = true;
    try {
      const inspected = await inspect({
        deep: (await read())?.kind === 'software',
      });
      assert(
        inspected.pending && inspected.review === params.review,
        'Paired recovery observations changed. Inspect again.',
        409,
      );
      let value = inspected.observation.record;
      if (value.kind === 'software') {
        const info = await ctx.host.info();
        const metadataOnly =
          value.phase === 'checking-software' &&
          !value.prepareId &&
          !value.world;
        assert(
          metadataOnly ||
            (info.State?.Running === false && !info.State.Restarting),
          'Stop Rust before paired software recovery.',
          409,
        );
        value = await updates.restore(
          value,
          checkpoint,
          inspected.observation.software,
          {metadataOnly},
        );
        if (metadataOnly) {
          await checkpoint(value, 'recovered');
          return 'Metadata discovery closed. Application software and world were never changed.';
        }
      }
      await stopped();
      // No engine was changed before publication. Retain staged/partial data
      // and close the transaction without replacing any current world bytes.
      if (
        !(await exists(location(value, 'previous-engine'))) &&
        !value.moves?.['restore-engine']
      ) {
        assert(
          [
            'reserved',
            'checking-software',
            'preparing-software',
            'software-prepared',
            'activating-software',
            'snapshotting',
            'staging',
            'publishing',
            'recovering',
          ].includes(value.phase),
          'Previous execution is missing. Preserve recovery evidence.',
          409,
        );
        await software.receipt();
        await checkpoint(value, 'recovered');
        return 'Preparation closed; previous software and world were never replaced.';
      }
      assert(
        value.world && value.beforeCode && value.beforeMods,
        'Paired recovery receipts are incomplete.',
        409,
      );
      await verifyStoppedData(location(value, 'world'), value.world, stopped);
      const priorEngine =
        value.moves?.['restore-engine'] &&
        !(await exists(location(value, 'previous-engine')))
          ? engine
          : location(value, 'previous-engine');
      assert(
        same(
          await executionInventory(
            priorEngine,
            rustExecutionLinks(config, value.previousFramework),
          ),
          value.beforeCode,
        ),
        'Previous execution failed recovery verification.',
        409,
      );
      const oldMods = (await exists(location(value, 'previous-mods')))
        ? location(value, 'previous-mods')
        : path.join(config.state, 'mods');
      assert(
        same(
          (
            await softwareInventory(oldMods, {
              maxFiles: 20000,
              maxBytes: 64 * 1024 ** 3,
            })
          ).inventory,
          value.beforeMods,
        ),
        'Previous mod state failed recovery verification.',
        409,
      );
      value = await checkpoint(value, 'recovering');
      async function move(from, to, key) {
        if (value.moves[key] === 'done') return;
        value = await checkpoint(value, 'recovering', {
          moves: {...value.moves, [key]: 'intent'},
        });
        await stopped();
        const source = await exists(from),
          destination = await exists(to);
        assert(
          !(source && destination) && (source || destination),
          'Paired recovery move is ambiguous. Preserve both copies.',
          409,
        );
        if (source) {
          assert(
            source.isDirectory() && !source.isSymbolicLink(),
            'Recovery directories cannot be linked.',
            409,
          );
          await fs.rename(from, to);
          await syncDirectory(path.dirname(from));
          await syncDirectory(path.dirname(to));
        }
        await fault('moved-' + key);
        value = await checkpoint(value, 'recovering', {
          moves: {...value.moves, [key]: 'done'},
        });
      }
      if (value.moves['restore-world'] !== 'done') {
        if (!value.moves['restore-world']) {
          if (await exists(location(value, 'restore-world'))) {
            try {
              await verifyStoppedData(
                location(value, 'restore-world'),
                value.world,
                stopped,
              );
            } catch {
              const partial = await fs.lstat(location(value, 'restore-world'));
              assert(
                partial.isDirectory() &&
                  !partial.isSymbolicLink() &&
                  partial.uid === process.getuid(),
                'Partial recovery must remain private ordinary storage.',
                409,
              );
              await fs.rename(
                location(value, 'restore-world'),
                location(value, 'partial-world-' + randomUUID()),
              );
              await syncDirectory(location(value, ''));
            }
          }
          if (!(await exists(location(value, 'restore-world'))))
            await copyStoppedData({
              source: location(value, 'world'),
              destination: location(value, 'restore-world'),
              expected: value.world,
              assertStopped: stopped,
              fault,
            });
          await verifyStoppedData(
            location(value, 'restore-world'),
            value.world,
            stopped,
          );
          await move(
            config.data,
            location(value, 'quarantine-world'),
            'quarantine-world',
          );
        }
        await move(
          location(value, 'restore-world'),
          config.data,
          'restore-world',
        );
      }
      if (
        (await exists(location(value, 'previous-mods'))) ||
        value.moves['restore-mods']
      ) {
        if (
          ((await exists(path.join(config.state, 'mods'))) ||
            value.moves['quarantine-mods']) &&
          value.moves['quarantine-mods'] !== 'done' &&
          !value.moves['restore-mods']
        )
          await move(
            path.join(config.state, 'mods'),
            location(value, 'quarantine-mods'),
            'quarantine-mods',
          );
        await move(
          location(value, 'previous-mods'),
          path.join(config.state, 'mods'),
          'restore-mods',
        );
      }
      if (
        ((await exists(engine)) || value.moves['quarantine-engine']) &&
        value.moves['quarantine-engine'] !== 'done' &&
        !value.moves['restore-engine']
      )
        await move(
          engine,
          location(value, 'quarantine-engine'),
          'quarantine-engine',
        );
      await move(location(value, 'previous-engine'), engine, 'restore-engine');
      await verifyStoppedData(config.data, value.world, stopped);
      await executionBinary(
        engine,
        'RustDedicated',
        value.previous.binary.sha256,
      );
      await maintenance.publishCurrent(
        value.previous.receipt,
        value.previous.binary,
        value.id,
      );
      await checkpoint(value, 'recovered');
      return 'Previous software, settings, plugins and world restored together. Newer data is retained privately. Rust remains stopped.';
    } finally {
      busy = false;
    }
  }
  async function softwareStatus() {
    const value = await read();
    if (value?.kind !== 'software') return {available: false, pending: false};
    return {
      available: true,
      pending: !settled(value),
      phase: value.phase,
      id: value.id,
      current: value.previous.receipt.selection,
      target: value.target || null,
      framework: value.review.framework,
      frameworkVersion: value.review.version,
      frameworkSha256: value.review.sha256 || null,
      compilerSha256: value.review.compiler?.sha256 || null,
      compatibility: {
        framework:
          value.review.framework === 'none'
            ? 'vanilla'
            : 'runtime-compilation-required',
        plugins:
          value.review.framework === 'none'
            ? 'none'
            : 'operator-review-required',
      },
      updateAvailable:
        !!value.target && !same(value.target, value.previous.receipt.selection),
      expires: new Date(Date.parse(value.started) + 15 * 60000).toISOString(),
      message:
        'Updates require a clean save and downtime. The whole pre-update world and software are retained together; recovery restores that earlier world and retains newer data privately.',
    };
  }
  async function checkSoftware(job, {modded = false} = {}) {
    assert(!busy, 'A paired change is already active.', 409);
    busy = true;
    try {
      await guard('software-check');
      await software.ensure();
      const installed = await mods.verifyInstalled();
      assert(
        modded || installed.framework === 'none',
        'Use the executable-mod update review for this framework.',
        409,
      );
      const review = await plan(installed.framework);
      await directory(root, {create: true});
      let value = {
        format: 1,
        id: randomUUID(),
        instance: config.instance,
        kind: 'software',
        action: modded ? 'software-check-modded' : 'software-check',
        phase: 'checking-software',
        started: new Date().toISOString(),
        previous: await maintenance.execution(),
        previousFramework: installed.framework,
        review,
        moves: {},
      };
      value = await checkpoint(value, 'checking-software', {}, job);
      await updates.check(value, checkpoint);
      return softwareStatus();
    } finally {
      busy = false;
    }
  }
  async function updateSoftware(params, job, {modded = false, stop, run} = {}) {
    assert(
      !busy && params?.confirm === true && uuid(params.planId),
      'Review and confirm this exact Steam update.',
      409,
    );
    const value = await read();
    assert(
      value?.kind === 'software' &&
        value.phase === 'reviewed' &&
        value.id === params.planId &&
        Date.now() - Date.parse(value.started) < 15 * 60000,
      'Software review expired or changed. Check updates again.',
      409,
    );
    assert(
      modded || value.review.framework === 'none',
      'This update requires executable-mod authority.',
      409,
    );
    assert(
      value.target && !same(value.target, value.previous.receipt.selection),
      'This exact Steam build is already installed.',
      409,
    );
    assert(
      typeof validateSoftware === 'function',
      'Software updates require protocol validation.',
      409,
    );
    const current = await software.ensure(),
      installed = await mods.verifyInstalled();
    assert(
      same(current, value.previous.receipt) &&
        same(await maintenance.execution(), value.previous) &&
        value.review.current === sha256(Buffer.from(JSON.stringify(installed))),
      'The reviewed software or framework changed. Check updates again.',
      409,
    );
    const info = await ctx.host.info(),
      wasRunning = !!info.State?.Running;
    if (wasRunning) await stop();
    await prepare(value.review.id, job, {...value, wasRunning});
    await start(run, wasRunning ? undefined : stop);
    return wasRunning
      ? 'Rust software updated, validated and running.'
      : 'Rust software updated and validated. Rust remains stopped.';
  }
  async function recoverSoftware(params, {modded = false} = {}) {
    const value = await read();
    assert(
      value?.kind === 'software' &&
        (modded || value.previousFramework === 'none'),
      'Use the matching software recovery authority for this transaction.',
      409,
    );
    return recover(params);
  }
  async function recoverFramework(params) {
    assert(
      (await read())?.kind !== 'software',
      'Use paired software recovery for this Steam update.',
      409,
    );
    return recover(params);
  }
  async function cancelSoftware() {
    const value = await read();
    assert(
      value?.kind === 'software' && !settled(value),
      'No pending software update owns preparation.',
      409,
    );
    return updates.cancel(value);
  }
  return {
    plan,
    prepare,
    checkSoftware,
    updateSoftware,
    recoverSoftware,
    cancelSoftware,
    softwareStatus,
    start,
    recover: recoverFramework,
    inspect,
    guard,
    operationSource: journal.operationSource,
  };
}
