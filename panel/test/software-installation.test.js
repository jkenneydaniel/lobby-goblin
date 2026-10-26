import test from 'node:test';
import assert from 'node:assert/strict';
import {
  softwareCapabilities,
  softwareSelection,
  softwareSelectionKey,
  softwareReceipt,
  softwareInstallation,
  transitionSoftwareInstallation,
  reviewSoftwareInstallation,
  adoptSoftwareInstallation,
} from '../core/software-installation.js';
import {
  softwareDelivery,
  publicSoftwareDelivery,
  validateSoftwareProvider,
  initialSoftwareVersion,
} from '../core/software-delivery.js';
import {runtimeReceipt} from '../applications/factorio/runtime.js';

const operationId = '12345678-1234-1234-1234-123456789abc';
const nextOperation = '87654321-4321-4321-4321-cba987654321';
const selection = {
  format: 1,
  provider: 'steamcmd',
  application: 'rust',
  platform: 'linux/amd64',
  softwareVersion: '12345',
  source: {
    kind: 'steam',
    appId: '258550',
    branch: 'public',
    buildId: '12345',
    depots: [
      {id: '258551', manifest: '18446744073709551615'},
      {id: '258552', manifest: '9007199254740993'},
    ],
  },
};
const receipt = {
  format: 1,
  selection,
  inventory: {sha256: 'a'.repeat(64), files: 123, bytes: 123456},
};
const capabilities = {
  version: 1,
  platforms: ['linux/amd64'],
  authentication: 'anonymous',
  discovery: true,
  repair: true,
  updates: true,
  historicalVersions: false,
  adoption: true,
};
const empty = () =>
  softwareInstallation({format: 1, revision: 0, state: 'uninstalled'});
const step = (current, next, options = {}) =>
  transitionSoftwareInstallation(current, next, {
    expectedRevision: current.revision,
    ...options,
  });
function activating() {
  let current = step(empty(), {state: 'preparing', operationId});
  current = step(current, {
    state: 'downloading',
    target: selection,
    progress: {receivedBytes: 0},
  });
  current = step(current, {state: 'validating'});
  return step(current, {state: 'activating'});
}

test('exact software identity includes platform, server build and full-width depot manifests', () => {
  const value = softwareSelection(selection);
  assert.deepEqual(value, selection);
  assert.ok(Object.isFrozen(value.source.depots[0]));
  const reordered = structuredClone(selection);
  reordered.source.depots.reverse();
  assert.equal(softwareSelectionKey(value), softwareSelectionKey(reordered));
  assert.notEqual(
    softwareSelectionKey(value),
    softwareSelectionKey({...selection, platform: 'linux/arm64'}),
  );
  assert.notEqual(
    softwareSelectionKey(value),
    softwareSelectionKey({
      ...selection,
      softwareVersion: '12346',
      source: {...selection.source, buildId: '12346'},
    }),
  );
  assert.equal(value.source.depots[0].manifest, '18446744073709551615');
  assert.equal(
    softwareSelection({
      ...selection,
      provider: 'factorio-headless',
      application: 'factorio',
      softwareVersion: '2.0.77',
      source: {kind: 'archive', sha256: 'b'.repeat(64)},
    }).softwareVersion,
    '2.0.77',
  );
});

test('software identities reject aliases, injected commands, credentials, paths and incomplete Steam targets', () => {
  for (const value of [
    {...selection, softwareVersion: 'public'},
    {...selection, softwareVersion: '../control'},
    {...selection, platform: 'windows/amd64'},
    {...selection, password: 'secret'},
    {...selection, source: {...selection.source, token: 'secret'}},
    {...selection, source: {...selection.source, appId: '258550; echo bad'}},
    {...selection, source: {...selection.source, appId: '4294967296'}},
    {...selection, source: {...selection.source, branch: '../public'}},
    {...selection, source: {...selection.source, buildId: '12346'}},
    {...selection, source: {...selection.source, depots: []}},
    {
      ...selection,
      source: {
        ...selection.source,
        depots: [selection.source.depots[0], selection.source.depots[0]],
      },
    },
    {
      ...selection,
      source: {
        ...selection.source,
        depots: [{id: '258551', manifest: '18446744073709551616'}],
      },
    },
    {
      ...selection,
      source: {
        kind: 'archive',
        sha256: 'b'.repeat(64),
        url: 'https://user:secret@example.test',
      },
    },
  ])
    assert.throws(() => softwareSelection(value));
  let accessed = false;
  assert.throws(() =>
    softwareSelection({
      get format() {
        accessed = true;
        return 1;
      },
    }),
  );
  assert.equal(accessed, false);
});

test('completion needs a bounded inventory; a selection alone is never an installed receipt', () => {
  assert.deepEqual(softwareReceipt(receipt), receipt);
  for (const inventory of [
    undefined,
    {sha256: 'bad', files: 1, bytes: 1},
    {sha256: 'a'.repeat(64), files: 0, bytes: 1},
    {sha256: 'a'.repeat(64), files: 1000001, bytes: 1},
    {sha256: 'a'.repeat(64), files: 1, bytes: 1024 ** 4 + 1},
  ])
    assert.throws(() => softwareReceipt({...receipt, inventory}));
  assert.throws(() =>
    softwareInstallation({
      format: 1,
      revision: 0,
      state: 'installed',
      installed: selection,
    }),
  );
});

test('installation records survive persistence with revision-guarded download, validation and activation', () => {
  let current = step(empty(), {state: 'preparing', operationId});
  assert.throws(
    () => step(current, {state: 'installed', installed: receipt}),
    /valid next step/,
  );
  current = step(current, {
    state: 'downloading',
    target: selection,
    progress: {receivedBytes: 0, totalBytes: 200},
  });
  current = step(current, {
    state: 'downloading',
    progress: {receivedBytes: 100, totalBytes: 200},
  });
  const restored = softwareInstallation(JSON.parse(JSON.stringify(current)));
  assert.deepEqual(restored, current);
  assert.equal(restored.revision, 3);
  assert.throws(
    () => step(current, {state: 'validating'}, {expectedRevision: 2}),
    /changed/,
  );
  assert.throws(
    () => step(current, {state: 'validating', operationId: nextOperation}),
    /stale operation/,
  );
  assert.throws(
    () => step(current, {state: 'downloading', progress: {receivedBytes: 99}}),
    /backwards/,
  );
  assert.throws(
    () =>
      step(current, {
        state: 'downloading',
        progress: {receivedBytes: 201, totalBytes: 200},
      }),
    /progress/,
  );
  assert.throws(
    () =>
      step(current, {
        state: 'validating',
        target: {...selection, platform: 'linux/arm64'},
      }),
    /target cannot change/,
  );
  current = step(current, {state: 'validating'});
  current = step(current, {state: 'activating'});
  current = step(current, {state: 'installed', installed: receipt});
  assert.deepEqual(current, {
    format: 1,
    revision: 6,
    state: 'installed',
    installed: receipt,
  });
  assert.ok(Object.isFrozen(current.installed.inventory));
});

test('a moved branch cannot replace the reviewed selection and completion cannot claim another build', () => {
  const current = activating();
  const changed = {
    ...selection,
    softwareVersion: '12346',
    source: {...selection.source, buildId: '12346'},
  };
  assert.throws(
    () =>
      step(current, {
        state: 'installed',
        installed: {...receipt, selection: changed},
      }),
    /reviewed target/,
  );
  assert.deepEqual(current.target, selection);
});

test('activation uncertainty fences retry until explicit inspection proves a known installation', () => {
  const current = activating();
  assert.throws(
    () => step(current, {state: 'failed', error: 'provider-failed'}),
    /recovery/,
  );
  const uncertain = step(current, {
    state: 'recovery-required',
    error: 'interrupted',
  });
  assert.throws(
    () => step(uncertain, {state: 'preparing', operationId: nextOperation}),
    /recovery/,
  );
  assert.throws(
    () =>
      reviewSoftwareInstallation(
        uncertain,
        {state: 'installed', receipt},
        {expectedRevision: uncertain.revision},
      ),
    /Explicit/,
  );
  assert.throws(
    () =>
      reviewSoftwareInstallation(
        uncertain,
        {state: 'unknown'},
        {expectedRevision: uncertain.revision, confirm: true},
      ),
    /unknown/,
  );
  assert.throws(
    () =>
      reviewSoftwareInstallation(
        uncertain,
        {
          state: 'installed',
          receipt: {
            ...receipt,
            selection: {...selection, application: 'valheim'},
          },
        },
        {expectedRevision: uncertain.revision, confirm: true},
      ),
    /unrelated/,
  );
  const recovered = reviewSoftwareInstallation(
    uncertain,
    {state: 'installed', receipt},
    {expectedRevision: uncertain.revision, confirm: true},
  );
  assert.equal(recovered.state, 'installed');
});

test('an update retains the prior receipt and recovery cannot discard it or cross application boundaries', () => {
  const installed = step(activating(), {
    state: 'installed',
    installed: receipt,
  });
  const current = step(installed, {
    state: 'preparing',
    operationId: nextOperation,
  });
  assert.deepEqual(current.installed, receipt);
  assert.throws(
    () =>
      step(current, {
        state: 'downloading',
        target: {...selection, application: 'valheim'},
      }),
    /cannot change application/,
  );
  const failed = step(current, {state: 'failed', error: 'download-failed'});
  assert.throws(
    () =>
      reviewSoftwareInstallation(
        failed,
        {state: 'empty'},
        {expectedRevision: failed.revision, confirm: true},
      ),
    /discard/,
  );
  const recovered = reviewSoftwareInstallation(
    failed,
    {state: 'installed', receipt},
    {expectedRevision: failed.revision, confirm: true},
  );
  assert.deepEqual(recovered.installed, receipt);
});

test('an empty failed first installation can be reviewed and retried with a new operation', () => {
  const current = step(empty(), {state: 'preparing', operationId});
  const failed = step(current, {state: 'failed', error: 'insufficient-space'});
  assert.throws(
    () => step(failed, {state: 'preparing', operationId}),
    /fresh operation/,
  );
  const reviewed = reviewSoftwareInstallation(
    failed,
    {state: 'empty'},
    {expectedRevision: failed.revision, confirm: true},
  );
  assert.equal(
    step(reviewed, {state: 'preparing', operationId: nextOperation}).state,
    'preparing',
  );
  assert.throws(() =>
    softwareInstallation({...failed, error: 'Password secret was rejected'}),
  );
});

test('legacy adoption is explicit, revision guarded and constrained to the inspected application identity', () => {
  const current = empty(),
    identity = {
      provider: 'steamcmd',
      application: 'rust',
      platform: 'linux/amd64',
    };
  const options = {expectedRevision: 0, confirm: true, identity};
  assert.throws(
    () =>
      adoptSoftwareInstallation(current, receipt, {...options, confirm: false}),
    /Explicit adoption/,
  );
  assert.throws(
    () =>
      adoptSoftwareInstallation(current, receipt, {
        ...options,
        expectedRevision: 1,
      }),
    /changed/,
  );
  assert.throws(
    () =>
      adoptSoftwareInstallation(current, receipt, {
        ...options,
        identity: {...identity, application: 'valheim'},
      }),
    /Explicit adoption/,
  );
  const adopted = adoptSoftwareInstallation(current, receipt, options);
  assert.equal(adopted.state, 'installed');
  assert.throws(
    () =>
      adoptSoftwareInstallation(adopted, receipt, {
        ...options,
        expectedRevision: 1,
      }),
    /Explicit adoption/,
  );
});

test('optional capabilities are immutable and cannot exceed the registered provider', () => {
  const policy = {
    version: 1,
    mode: 'runtime',
    provider: 'steamcmd',
    initial: {channel: 'public'},
    storage: 'application-volume',
    updates: 'manual',
    capabilities,
  };
  const provider = {
    capabilities,
    resolve() {},
    installed() {},
    empty() {},
    install() {},
  };
  assert.equal(
    validateSoftwareProvider(policy, {steamcmd: provider}),
    provider,
  );
  assert.deepEqual(publicSoftwareDelivery(policy).capabilities, capabilities);
  assert.ok(Object.isFrozen(softwareCapabilities(capabilities).platforms));
  for (const value of [
    {...capabilities, platforms: ['linux/amd64', 'linux/amd64']},
    {...capabilities, token: 'secret'},
    {...capabilities, updates: 'on-restart'},
  ])
    assert.throws(() => softwareCapabilities(value));
  assert.throws(
    () =>
      validateSoftwareProvider(
        {...policy, capabilities: {...capabilities, historicalVersions: true}},
        {steamcmd: provider},
      ),
    /exceeds/,
  );
  assert.throws(
    () =>
      validateSoftwareProvider(
        {
          ...policy,
          capabilities: {...capabilities, platforms: ['linux/arm64']},
        },
        {steamcmd: provider},
      ),
    /exceeds/,
  );
  assert.throws(() =>
    validateSoftwareProvider(policy, {
      steamcmd: {...provider, capabilities: undefined},
    }),
  );
});

test('existing provider declarations and Factorio receipts keep their exact historical shape', () => {
  const policy = {
    version: 1,
    mode: 'runtime',
    provider: 'factorio-headless',
    initial: {channel: 'stable'},
    storage: 'application-volume',
    updates: 'manual',
  };
  const provider = {resolve() {}, installed() {}, empty() {}, install() {}};
  assert.equal(
    validateSoftwareProvider(policy, {'factorio-headless': provider}),
    provider,
  );
  assert.deepEqual(softwareDelivery(policy), policy);
  assert.equal(
    Object.hasOwn(publicSoftwareDelivery(policy), 'capabilities'),
    false,
  );
  const legacy = {
    version: 1,
    provider: 'factorio-headless',
    softwareVersion: '2.0.77',
    sha256: 'a'.repeat(64),
    files: [{name: 'bin/x64/factorio', sha256: 'b'.repeat(64), size: 1}],
  };
  const original = JSON.stringify(legacy);
  assert.equal(runtimeReceipt(legacy), legacy);
  assert.equal(JSON.stringify(legacy), original);
});

test('the existing initial-version interface handles new exact selections and receipts without resolving on restart', async () => {
  const calls = [];
  const policy = {
    version: 1,
    mode: 'runtime',
    provider: 'steamcmd',
    initial: {channel: 'public'},
    storage: 'application-volume',
    updates: 'manual',
    capabilities,
  };
  const provider = {
    capabilities,
    async empty() {
      calls.push('empty');
      return true;
    },
    async resolve() {
      calls.push('resolve');
      return selection;
    },
    async installed(value) {
      calls.push('inspect');
      assert.deepEqual(value, receipt);
      return true;
    },
    async install() {
      assert.fail('Selection and inspection cannot install');
    },
  };
  const providers = {steamcmd: provider};
  assert.deepEqual(
    await initialSoftwareVersion(policy, {providers, receipt: null}),
    {selection, install: true},
  );
  assert.deepEqual(calls, ['empty', 'resolve']);
  calls.length = 0;
  assert.deepEqual(await initialSoftwareVersion(policy, {providers, receipt}), {
    selection: receipt,
    install: false,
  });
  assert.deepEqual(calls, ['inspect']);
  calls.length = 0;
  await assert.rejects(
    initialSoftwareVersion(policy, {
      providers,
      receipt: {...receipt, selection: {...selection, platform: 'linux/arm64'}},
    }),
    /platform/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    initialSoftwareVersion(policy, {
      providers,
      receipt: {...receipt, selection: {...selection, provider: 'foreign'}},
    }),
    /recovery/,
  );
  assert.deepEqual(calls, []);
});
