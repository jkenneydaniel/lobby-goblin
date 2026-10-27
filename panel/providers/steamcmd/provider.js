import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../../common.js';
import {regularFile, syncDirectory} from '../../core/storage/files.js';
import {
  withStorageLock,
  inspectStorageLock,
  recoverStorageLock,
} from '../../core/storage/coordination.js';
import {
  softwareCapabilities,
  softwareSelection,
  softwareSelectionKey,
  softwareReceipt,
  softwareInstallation,
  transitionSoftwareInstallation,
  reviewSoftwareInstallation,
} from '../../core/software-installation.js';
import {
  steamSource,
  steamBuild,
  steamDiscoveryArguments,
  steamInstallArguments,
  verifySteamManifest,
} from './metadata.js';
import {runSteamCommand} from './command.js';
import {
  directory,
  readRecord,
  atomicRecord,
  softwareInventory,
} from './files.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyFor = (receipt) =>
  softwareSelectionKey(receipt.selection) + '-' + receipt.inventory.sha256;
const emptyState = () =>
  softwareInstallation({format: 1, revision: 0, state: 'uninstalled'});
const executing = new Set();

// Roots and executable adapters are supplied by reviewed application wiring.
// No request can choose roots, app IDs, executables or a shell command.
export function createSteamProvider({
  source: declaredSource,
  software,
  control,
  command = runSteamCommand,
  requiredFiles = [],
  isApplicationEmpty = async () => false,
  isApplicationStopped = async () => false,
  disk = async (root) => {
    const info = await fs.statfs(root);
    return info.bavail * info.bsize;
  },
  maxBytes = 128 * 1024 ** 3,
  maxFiles = 100000,
  fault = async () => {},
}) {
  const source = steamSource(declaredSource);
  definitionData(requiredFiles);
  assert(
    Array.isArray(requiredFiles) &&
      requiredFiles.length > 0 &&
      requiredFiles.length <= 32 &&
      requiredFiles.every(
        (item) =>
          item &&
          Object.keys(item).every((key) =>
            ['path', 'executable'].includes(key),
          ) &&
          typeof item.path === 'string' &&
          item.path.length <= 4096 &&
          !/[\x00-\x1f\\]/.test(item.path) &&
          item.path
            .split('/')
            .every((part) => part && part !== '.' && part !== '..') &&
          typeof item.executable === 'boolean',
      ) &&
      new Set(requiredFiles.map((item) => item.path)).size ===
        requiredFiles.length,
    'Declare the application required software files.',
  );
  const requiredSoftware = freezeDefinition(requiredFiles);
  assert(
    [software, control].every(
      (value) =>
        typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.resolve(value) === value &&
        value !== '/',
    ) &&
      software !== control &&
      !software.startsWith(control + path.sep) &&
      !control.startsWith(software + path.sep),
    'Software and private control roots must be separate canonical directories.',
  );
  assert(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 1024 ** 4 &&
      Number.isSafeInteger(maxFiles) &&
      maxFiles > 0 &&
      maxFiles <= 1000000,
    'Invalid Steam software budget.',
  );
  const stateFile = path.join(control, 'installation.json'),
    candidateFile = path.join(control, 'candidate.json'),
    activeFile = path.join(control, 'active.json');
  const stages = path.join(software, 'staging'),
    releases = path.join(software, 'releases'),
    bindings = path.join(control, 'cached-operations'),
    inventories = path.join(control, 'inventories');
  const capabilities = softwareCapabilities({
    version: 1,
    platforms: [source.platform],
    authentication: 'anonymous',
    discovery: true,
    repair: false,
    updates: true,
    historicalVersions: false,
    adoption: false,
  });

  function boundSelection(value) {
    const selected = softwareSelection(value);
    assert(
      selected.provider === 'steamcmd' &&
        selected.application === source.application &&
        selected.platform === source.platform &&
        selected.source.kind === 'steam' &&
        selected.source.appId === source.appId &&
        source.branches.includes(selected.source.branch),
      'Software belongs to another Steam application.',
      409,
    );
    return selected;
  }
  function boundReceipt(value) {
    const receipt = softwareReceipt(value);
    boundSelection(receipt.selection);
    assert(
      receipt.inventory.files <= maxFiles &&
        receipt.inventory.bytes <= maxBytes,
      'Software receipt exceeds this application budget.',
      409,
    );
    return receipt;
  }
  async function initialize() {
    for (const root of [
      software,
      control,
      stages,
      releases,
      inventories,
      bindings,
    ])
      await directory(root, {create: true});
  }
  async function withLease(work) {
    return withStorageLock(
      control,
      'write',
      async () => {
        assert(
          !executing.has(control),
          'A software worker remains active.',
          409,
        );
        executing.add(control);
        try {
          return await work();
        } finally {
          executing.delete(control);
        }
      },
      {timeout: 0},
    );
  }
  async function readState() {
    const stat = await fs.lstat(control).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return emptyState();
    await directory(control);
    const record = await readRecord(stateFile, {optional: true});
    const state = record ? softwareInstallation(record) : emptyState();
    if (state.target) boundSelection(state.target);
    if (state.installed) boundReceipt(state.installed);
    return state;
  }
  async function publishedReceipt(file, {optional = false} = {}) {
    const value = await readRecord(file, {optional});
    return value ? boundReceipt(value) : null;
  }
  function checkRequired(inventory) {
    for (const required of requiredSoftware)
      assert(
        inventory.files.some(
          (file) =>
            file.name === required.path &&
            file.size > 0 &&
            (!required.executable || file.executable),
        ),
        'Required Steam software is missing or not executable.',
        409,
      );
  }
  async function verify(receipt) {
    receipt = boundReceipt(receipt);
    await directory(control);
    await directory(inventories);
    await directory(releases);
    const root = path.join(releases, keyFor(receipt)),
      manifest = await readRecord(
        path.join(inventories, keyFor(receipt) + '.json'),
        {max: 64 * 1024 ** 2},
      );
    assert(
      manifest?.format === 1 && same(boundReceipt(manifest.receipt), receipt),
      'Software inventory receipt changed.',
      409,
    );
    verifySteamManifest(
      (
        await regularFile(
          path.join(root, 'steamapps', 'appmanifest_' + source.appId + '.acf'),
          {max: 1024 ** 2},
        )
      ).toString('utf8'),
      receipt.selection,
    );
    const observed = await softwareInventory(root, {maxFiles, maxBytes});
    checkRequired(observed);
    assert(
      same(observed.inventory, receipt.inventory) &&
        same(observed.files, manifest.files),
      'Installed software differs from its verified inventory.',
      409,
    );
    return receipt;
  }
  async function installed(value) {
    const receipt = boundReceipt(value),
      state = await readState();
    if (state.state !== 'installed' || !same(state.installed, receipt))
      return false;
    const active = await publishedReceipt(activeFile, {optional: true});
    if (!active || !same(active, receipt)) return false;
    try {
      await verify(receipt);
      return true;
    } catch {
      return false;
    }
  }
  async function empty() {
    const state = await readState();
    if (state.state !== 'uninstalled' || (await isApplicationEmpty()) !== true)
      return false;
    const stat = await fs.lstat(software).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return true;
    await directory(software);
    // Only an actually empty software tree is eligible for first installation.
    // Retained partial/release data requires explicit staging/recovery instead.
    for (const name of await fs.readdir(software)) {
      if (!['staging', 'releases'].includes(name)) return false;
      await directory(path.join(software, name));
      if ((await fs.readdir(path.join(software, name))).length) return false;
    }
    return true;
  }
  async function discovery(channel, signal) {
    assert(
      source.branches.includes(channel),
      'Choose a reviewed Steam branch.',
    );
    const result = steamBuild(
      await command(steamDiscoveryArguments(source), {timeout: 240000, signal}),
      source,
      channel,
    );
    assert(
      result.bytes <= maxBytes,
      'The Steam server exceeds this application software budget.',
      413,
    );
    return result;
  }
  async function cachedReceipt(target) {
    const names = await fs.readdir(inventories);
    assert(
      names.length <= 128,
      'Software inventory history exceeds its bound.',
      409,
    );
    const prefix = softwareSelectionKey(target) + '-';
    for (const name of names.filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name),
    )) {
      const value = await readRecord(path.join(inventories, name), {
        max: 64 * 1024 ** 2,
      });
      try {
        return await verify(boundReceipt(value.receipt));
      } catch {}
    }
    return null;
  }
  async function resolve(initial) {
    definitionData(initial);
    assert(
      initial &&
        Object.keys(initial).length === 1 &&
        typeof initial.channel === 'string',
      'Steam initial selection requires a branch. Historical builds are not automatically downloadable.',
    );
    return (await discovery(initial.channel)).selection;
  }
  async function stage(
    value,
    {confirm = false, operationId = crypto.randomUUID(), signal} = {},
  ) {
    const target = boundSelection(value);
    await initialize();
    return withLease(async () => {
      let current = await readState();
      assert(
        ['uninstalled', 'installed', 'failed'].includes(current.state),
        'Software work is interrupted. Inspect it before retrying.',
        409,
      );
      assert(
        confirm === true &&
          (current.installed || (await isApplicationEmpty()) === true),
        'Explicit software staging or empty-application confirmation is required.',
        409,
      );
      if (current.state === 'uninstalled')
        assert(
          await empty(),
          'Existing software requires explicit adoption or recovery.',
          409,
        );
      const prior = current;
      const preparing = transitionSoftwareInstallation(
        current,
        {state: 'preparing', operationId, target},
        {expectedRevision: current.revision},
      );
      const cached = await cachedReceipt(target);
      if (cached) {
        assert(
          (await fs.readdir(bindings)).length < 128,
          'Cached operation history needs reviewed cleanup.',
          409,
        );
        // Bind the verified inventory before publishing the new operation.
        // A separate file preserves every earlier operation's recovery proof.
        await atomicRecord(
          path.join(bindings, preparing.operationId + '.json'),
          {
            format: 1,
            operationId: preparing.operationId,
            receipt: cached,
          },
        );
        await fault('cached-bound');
      }
      async function move(next) {
        const record = transitionSoftwareInstallation(current, next, {
          expectedRevision: current.revision,
        });
        await atomicRecord(stateFile, record);
        current = record;
      }
      try {
        await atomicRecord(stateFile, preparing);
        current = preparing;
        if (cached) await fault('cached-preparing');
        const discovered = await discovery(target.source.branch, signal);
        assert(
          softwareSelectionKey(discovered.selection) ===
            softwareSelectionKey(target),
          'Steam branch moved. Refresh the installation plan.',
          409,
        );
        if (cached) {
          await move({state: 'validating'});
          await fault('cached-validating');
          await atomicRecord(candidateFile, {
            format: 1,
            operationId,
            receipt: cached,
          });
          return {operationId, revision: current.revision, receipt: cached};
        }
        assert(
          (await disk(software)) >= discovered.bytes * 2 + 512 * 1024 ** 2,
          'There is insufficient space to stage this Steam installation.',
          507,
        );
        assert(
          (await fs.readdir(stages)).length < 16 &&
            (await fs.readdir(releases)).length < 64,
          'Software storage needs reviewed cleanup before another installation.',
          409,
        );
        const destination = path.join(stages, operationId);
        if (
          prior.state === 'failed' &&
          prior.target &&
          softwareSelectionKey(prior.target) === softwareSelectionKey(target)
        ) {
          const previous = path.join(stages, prior.operationId);
          if (
            await fs.lstat(previous).catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            })
          ) {
            await softwareInventory(previous, {
              maxFiles,
              maxBytes,
              hash: false,
            });
            await fs.rename(previous, destination);
          } else await fs.mkdir(destination, {mode: 0o700});
        } else await fs.mkdir(destination, {mode: 0o700});
        await directory(destination);
        await move({
          state: 'downloading',
          progress: {receivedBytes: 0, totalBytes: discovered.bytes},
        });
        await command(steamInstallArguments(source, destination, target), {
          signal,
          onProgress: async (value) => {
            assert(
              value.totalBytes <= maxBytes && value.receivedBytes <= maxBytes,
              'Steam download exceeds this application budget.',
              413,
            );
            assert(
              (await disk(software)) >= 128 * 1024 ** 2,
              'Software staging exhausted its disk headroom.',
              507,
            );
            const receivedBytes = Math.max(
              current.progress?.receivedBytes || 0,
              value.receivedBytes,
            );
            const totalBytes = Math.max(
              current.progress?.totalBytes || 0,
              value.totalBytes,
              receivedBytes,
            );
            await move({
              state: 'downloading',
              progress: {receivedBytes, totalBytes},
            });
          },
        });
        await move({state: 'validating'});
        verifySteamManifest(
          (
            await regularFile(
              path.join(
                destination,
                'steamapps',
                'appmanifest_' + source.appId + '.acf',
              ),
              {max: 1024 ** 2},
            )
          ).toString('utf8'),
          target,
        );
        const inventory = await softwareInventory(destination, {
          maxFiles,
          maxBytes,
          sync: true,
        });
        checkRequired(inventory);
        const receipt = boundReceipt({
          format: 1,
          selection: target,
          inventory: inventory.inventory,
        });
        const key = keyFor(receipt),
          final = path.join(releases, key),
          manifestFile = path.join(inventories, key + '.json');
        const existing = await fs.lstat(final).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing) {
          await verify(receipt);
          await directory(destination);
          await fs.rm(destination, {recursive: true});
          await syncDirectory(stages);
        } else {
          await atomicRecord(manifestFile, {
            format: 1,
            operationId,
            receipt,
            files: inventory.files,
          });
          await fs.rename(destination, final);
          await syncDirectory(releases);
          await syncDirectory(stages);
        }
        await fault('before-candidate');
        await atomicRecord(candidateFile, {format: 1, operationId, receipt});
        await fault('staged');
        return {operationId, revision: current.revision, receipt};
      } catch (error) {
        const stored = await readState();
        if (
          stored.operationId === operationId &&
          ['preparing', 'downloading', 'validating'].includes(stored.state)
        ) {
          const code =
            error.status === 507
              ? 'insufficient-space'
              : stored.state === 'validating'
                ? 'validation-failed'
                : 'download-failed';
          await atomicRecord(
            stateFile,
            transitionSoftwareInstallation(
              stored,
              {state: 'failed', error: code},
              {expectedRevision: stored.revision},
            ),
          );
        }
        throw error;
      }
    });
  }
  async function activate(
    {operationId, revision, receipt},
    {confirm = false} = {},
  ) {
    receipt = boundReceipt(receipt);
    assert(confirm === true, 'Explicit software activation is required.', 409);
    assert(
      (await isApplicationStopped()) === true,
      'Stop the application before activating software.',
      409,
    );
    return withLease(async () => {
      let current = await readState();
      const candidate = await readRecord(candidateFile);
      assert(
        current.state === 'validating' &&
          current.operationId === operationId &&
          current.revision === revision &&
          candidate?.format === 1 &&
          candidate.operationId === operationId &&
          same(boundReceipt(candidate.receipt), receipt),
        'Staged software changed. Inspect it before activation.',
        409,
      );
      await verify(receipt);
      assert(
        (await isApplicationStopped()) === true,
        'Application state changed before software activation.',
        409,
      );
      current = transitionSoftwareInstallation(
        current,
        {state: 'activating'},
        {expectedRevision: revision},
      );
      await atomicRecord(stateFile, current);
      try {
        await fault('activation-intent');
        await atomicRecord(activeFile, receipt);
        await fault('activation-pointer');
        const completed = transitionSoftwareInstallation(
          current,
          {state: 'installed', installed: receipt},
          {expectedRevision: current.revision},
        );
        await atomicRecord(stateFile, completed);
        return receipt;
      } catch (error) {
        const stored = await readState();
        // A committed record wins even if its final publication response failed.
        if (stored.state === 'installed' && same(stored.installed, receipt))
          return receipt;
        if (stored.state === 'activating' && stored.operationId === operationId)
          await atomicRecord(
            stateFile,
            transitionSoftwareInstallation(
              stored,
              {state: 'recovery-required', error: 'interrupted'},
              {expectedRevision: stored.revision},
            ),
          );
        throw error;
      }
    });
  }
  async function install(value, options = {}) {
    const target = boundSelection(value),
      state = await readState();
    if (state.state === 'installed') {
      assert(
        softwareSelectionKey(state.installed.selection) ===
          softwareSelectionKey(target) && (await installed(state.installed)),
        'Installed Steam software needs explicit update or recovery.',
        409,
      );
      return state.installed;
    }
    assert(
      !state.installed &&
        ['uninstalled', 'failed'].includes(state.state) &&
        (await isApplicationEmpty()) === true,
      'Existing or interrupted applications need explicit adoption or recovery.',
      409,
    );
    return activate(await stage(target, {...options, confirm: true}), {
      confirm: true,
    });
  }
  async function findCandidate(state) {
    if (!state.target || !state.operationId) return null;
    for (const file of [
      candidateFile,
      path.join(bindings, state.operationId + '.json'),
    ]) {
      const candidate = await readRecord(file, {optional: true});
      if (
        candidate?.format === 1 &&
        candidate.operationId === state.operationId &&
        softwareSelectionKey(boundReceipt(candidate.receipt).selection) ===
          softwareSelectionKey(state.target)
      ) {
        try {
          await verify(candidate.receipt);
          return candidate;
        } catch {}
      }
    }
    const names = await fs.readdir(inventories).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert(
      names.length <= 128,
      'Software inventory history exceeds its bound.',
      409,
    );
    for (const name of names.filter((name) =>
      /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name),
    )) {
      const value = await readRecord(path.join(inventories, name), {
        max: 64 * 1024 ** 2,
      });
      if (
        value.operationId !== state.operationId ||
        softwareSelectionKey(boundReceipt(value.receipt).selection) !==
          softwareSelectionKey(state.target)
      )
        continue;
      try {
        await verify(value.receipt);
        return {
          format: 1,
          operationId: state.operationId,
          receipt: value.receipt,
        };
      } catch {}
    }
    return null;
  }
  async function inspect() {
    const state = await readState(),
      lock = await fs.lstat(control).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    const lease = lock ? await inspectStorageLock(control) : null;
    const pointer = lock
      ? await publishedReceipt(activeFile, {optional: true})
      : null;
    let observation = {state: 'unknown'};
    if (pointer) {
      try {
        await verify(pointer);
        observation = {state: 'installed', receipt: pointer};
      } catch {}
    } else {
      const candidate = lock ? await findCandidate(state) : null;
      if (candidate)
        observation = {state: 'staged', receipt: candidate.receipt};
      else if (!state.installed && state.operationId) {
        if (
          (
            await fs.readdir(releases).catch((error) => {
              if (error.code === 'ENOENT') return [];
              throw error;
            })
          ).length === 0
        ) {
          const retained = await fs.readdir(stages).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          if (retained.length) {
            try {
              assert(
                retained.length <= 16 &&
                  retained.every((name) =>
                    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name),
                  ),
                'Staging contains unknown entries.',
                409,
              );
              let files = 0,
                bytes = 0;
              for (const name of retained) {
                const inventory = await softwareInventory(
                  path.join(stages, name),
                  {maxFiles, maxBytes, hash: false},
                );
                files += inventory.inventory.files;
                bytes += inventory.inventory.bytes;
                assert(
                  files <= maxFiles && bytes <= maxBytes,
                  'Retained staging exceeds its inventory budget.',
                  413,
                );
              }
              observation = {state: 'partial'};
            } catch {}
          } else if (['failed', 'recovery-required'].includes(state.state))
            observation = {state: 'empty'};
        }
      }
    }
    return {state, lease, observation};
  }
  async function recover(review, {confirm = false, offline = false} = {}) {
    assert(
      confirm === true && offline === true,
      'Confirm all software workers are stopped before recovery.',
      409,
    );
    assert(!executing.has(control), 'A software worker remains active.', 409);
    await initialize();
    const observed = await inspect();
    assert(
      same(observed, review),
      'Software recovery observations changed. Inspect again.',
      409,
    );
    if (review.lease)
      await recoverStorageLock(control, review.lease, {confirm, offline});
    return withLease(async () => {
      let current = await readState();
      assert(
        current.revision === review.state.revision,
        'Software recovery revision changed.',
        409,
      );
      if (
        ['preparing', 'downloading', 'validating', 'activating'].includes(
          current.state,
        )
      ) {
        current = transitionSoftwareInstallation(
          current,
          {state: 'recovery-required', error: 'interrupted'},
          {expectedRevision: current.revision},
        );
        await atomicRecord(stateFile, current);
      }
      const record = reviewSoftwareInstallation(current, review.observation, {
        expectedRevision: current.revision,
        confirm,
      });
      if (review.observation.state === 'staged')
        await atomicRecord(candidateFile, {
          format: 1,
          operationId: current.operationId,
          receipt: boundReceipt(review.observation.receipt),
        });
      await atomicRecord(stateFile, record);
      return record;
    });
  }
  async function activeDirectory() {
    const state = await readState();
    assert(
      state.state === 'installed' && (await installed(state.installed)),
      'Installed software must be verified before starting.',
      409,
    );
    return path.join(releases, keyFor(state.installed));
  }
  return {
    capabilities,
    source,
    resolve,
    installed,
    empty,
    install,
    stage,
    activate,
    inspect,
    recover,
    read: readState,
    activeDirectory,
  };
}
