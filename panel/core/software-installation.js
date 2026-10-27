import crypto from 'node:crypto';
import {assert} from '../common.js';
import {definitionData, freezeDefinition} from './definition-data.js';

const platforms = new Set(['linux/amd64', 'linux/arm64']);
const identifier = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const exactVersion = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) &&
  !['latest', 'stable', 'experimental', 'public'].includes(value);
const sha256 = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const unsigned = (value, maximum) =>
  typeof value === 'string' &&
  /^[1-9]\d{0,19}$/.test(value) &&
  BigInt(value) <= maximum;
const active = new Set([
  'preparing',
  'downloading',
  'validating',
  'activating',
]);
const errors = new Set([
  'download-failed',
  'validation-failed',
  'insufficient-space',
  'authentication-required',
  'interrupted',
  'provider-failed',
]);
function fields(value, names) {
  definitionData(value);
  assert(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => names.includes(key)),
    'Invalid software record fields.',
  );
}

export function softwareCapabilities(value) {
  fields(value, [
    'version',
    'platforms',
    'authentication',
    'discovery',
    'repair',
    'updates',
    'historicalVersions',
    'adoption',
  ]);
  assert(
    value.version === 1 &&
      Array.isArray(value.platforms) &&
      value.platforms.length > 0 &&
      value.platforms.length <= 2 &&
      value.platforms.every((item) => platforms.has(item)) &&
      new Set(value.platforms).size === value.platforms.length &&
      ['anonymous', 'account'].includes(value.authentication) &&
      [
        'discovery',
        'repair',
        'updates',
        'historicalVersions',
        'adoption',
      ].every((key) => typeof value[key] === 'boolean'),
    'Invalid software provider capabilities.',
  );
  return freezeDefinition({...value, platforms: [...value.platforms].sort()});
}

// An exact identity is separate from a completed installation. These records
// never contain executable commands, URLs, host paths or account credentials.
export function softwareSelection(value) {
  fields(value, [
    'format',
    'provider',
    'application',
    'platform',
    'softwareVersion',
    'source',
  ]);
  assert(
    value.format === 1 &&
      identifier(value.provider) &&
      identifier(value.application) &&
      platforms.has(value.platform) &&
      exactVersion(value.softwareVersion),
    'Software selection requires an exact version and platform.',
  );
  const source = value.source;
  fields(
    source,
    source?.kind === 'steam'
      ? ['kind', 'appId', 'branch', 'buildId', 'depots']
      : ['kind', 'sha256'],
  );
  let normalized;
  if (source.kind === 'steam') {
    assert(
      unsigned(source.appId, 4294967295n) &&
        unsigned(source.buildId, 18446744073709551615n) &&
        typeof source.branch === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(source.branch) &&
        value.softwareVersion === source.buildId &&
        Array.isArray(source.depots) &&
        source.depots.length > 0 &&
        source.depots.length <= 128,
      'Steam selection needs a resolved server build and depot manifests.',
    );
    for (const depot of source.depots) {
      fields(depot, ['id', 'manifest']);
      assert(
        unsigned(depot.id, 4294967295n) &&
          unsigned(depot.manifest, 18446744073709551615n),
        'Invalid Steam depot identity.',
      );
    }
    assert(
      new Set(source.depots.map((depot) => depot.id)).size ===
        source.depots.length,
      'Duplicate Steam depot.',
    );
    normalized = {
      kind: 'steam',
      appId: source.appId,
      branch: source.branch,
      buildId: source.buildId,
      depots: source.depots
        .map((depot) => ({id: depot.id, manifest: depot.manifest}))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  } else {
    assert(
      source.kind === 'archive' && sha256(source.sha256),
      'Archive selection needs a verified checksum.',
    );
    normalized = {kind: 'archive', sha256: source.sha256};
  }
  return freezeDefinition({
    format: 1,
    provider: value.provider,
    application: value.application,
    platform: value.platform,
    softwareVersion: value.softwareVersion,
    source: normalized,
  });
}
export const softwareSelectionKey = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(softwareSelection(value)))
    .digest('hex');

export function softwareReceipt(value) {
  fields(value, ['format', 'selection', 'inventory']);
  assert(value.format === 1, 'Unsupported software receipt.');
  const selection = softwareSelection(value.selection),
    inventory = value.inventory;
  fields(inventory, ['sha256', 'files', 'bytes']);
  assert(
    sha256(inventory.sha256) &&
      integer(inventory.files, 1000000) &&
      inventory.files > 0 &&
      integer(inventory.bytes, 1024 ** 4) &&
      inventory.bytes > 0,
    'A completed installation needs a bounded verified inventory.',
  );
  return freezeDefinition({
    format: 1,
    selection,
    inventory: {
      sha256: inventory.sha256,
      files: inventory.files,
      bytes: inventory.bytes,
    },
  });
}

// This is an additive private record format. Factorio's existing version:1
// receipts remain provider-owned and are not rewritten or implicitly adopted.
export function softwareInstallation(value) {
  fields(value, [
    'format',
    'revision',
    'state',
    'operationId',
    'target',
    'installed',
    'progress',
    'error',
  ]);
  assert(
    value.format === 1 &&
      integer(value.revision) &&
      [
        'uninstalled',
        ...active,
        'installed',
        'failed',
        'recovery-required',
      ].includes(value.state),
    'Invalid software installation state.',
  );
  const result = {format: 1, revision: value.revision, state: value.state};
  if (value.target !== undefined)
    result.target = softwareSelection(value.target);
  if (value.installed !== undefined)
    result.installed = softwareReceipt(value.installed);
  if (value.state === 'uninstalled') {
    assert(
      Object.keys(value).length === 3,
      'Uninstalled state cannot claim software or an operation.',
    );
  } else if (value.state === 'installed') {
    assert(
      result.installed && Object.keys(value).length === 4,
      'Installed state requires only its verified receipt.',
    );
  } else {
    assert(
      typeof value.operationId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId),
      'Installation operation identity is required.',
    );
    result.operationId = value.operationId;
    if (active.has(value.state)) {
      assert(
        value.error === undefined &&
          (value.state === 'preparing' || result.target),
        'Active installation needs its resolved target.',
      );
      if (value.progress !== undefined) {
        fields(value.progress, ['receivedBytes', 'totalBytes']);
        assert(
          integer(value.progress.receivedBytes, 1024 ** 4) &&
            (value.progress.totalBytes === undefined ||
              (integer(value.progress.totalBytes, 1024 ** 4) &&
                value.progress.totalBytes >= value.progress.receivedBytes)),
          'Invalid installation progress.',
        );
        result.progress = {...value.progress};
      }
    } else {
      assert(
        value.progress === undefined && errors.has(value.error),
        'Failed installation needs a bounded error code.',
      );
      result.error = value.error;
    }
  }
  if (result.target && result.installed) {
    const before = result.installed.selection;
    assert(
      ['application', 'provider', 'platform'].every(
        (key) => before[key] === result.target[key],
      ),
      'An installation cannot change application, provider or platform.',
    );
  }
  return freezeDefinition(result);
}

const transitions = {
  uninstalled: ['preparing'],
  installed: ['preparing'],
  preparing: [
    'preparing',
    'downloading',
    'validating',
    'failed',
    'recovery-required',
  ],
  downloading: ['downloading', 'validating', 'failed', 'recovery-required'],
  validating: ['validating', 'activating', 'failed', 'recovery-required'],
  // Once activation is submitted, an uncertain outcome requires inspection.
  activating: ['activating', 'installed', 'recovery-required'],
  failed: ['preparing'],
  'recovery-required': [],
};
function currentRevision(value, expectedRevision) {
  const current = softwareInstallation(value);
  assert(
    current.revision === expectedRevision &&
      current.revision < Number.MAX_SAFE_INTEGER,
    'Software installation changed. Reload it before continuing.',
    409,
  );
  return current;
}
export function transitionSoftwareInstallation(
  value,
  next,
  {expectedRevision} = {},
) {
  const current = currentRevision(value, expectedRevision);
  fields(next, [
    'state',
    'operationId',
    'target',
    'installed',
    'progress',
    'error',
  ]);
  assert(
    transitions[current.state].includes(next.state),
    'Software installation requires recovery or a valid next step.',
    409,
  );
  const result = {...current, ...next, revision: current.revision + 1};
  if (next.state === 'preparing' && !active.has(current.state)) {
    assert(
      next.operationId &&
        next.operationId !== current.operationId &&
        next.installed === undefined,
      'A new installation needs a fresh operation.',
    );
    delete result.target;
    delete result.error;
    delete result.progress;
    if (next.target) result.target = next.target;
  } else {
    assert(
      next.operationId === undefined ||
        next.operationId === current.operationId,
      'A stale operation cannot advance installation.',
      409,
    );
    assert(
      !current.target ||
        !next.target ||
        softwareSelectionKey(current.target) ===
          softwareSelectionKey(next.target),
      'An installation target cannot change during its operation.',
      409,
    );
    if (next.state === 'installed') {
      const receipt = softwareReceipt(next.installed);
      assert(
        softwareSelectionKey(receipt.selection) ===
          softwareSelectionKey(current.target),
        'Installed software differs from the reviewed target.',
        409,
      );
      return softwareInstallation({
        format: 1,
        revision: result.revision,
        state: 'installed',
        installed: receipt,
      });
    }
    assert(
      next.installed === undefined,
      'An active operation cannot replace its prior installation.',
    );
    if (next.progress && current.progress && next.state === current.state)
      assert(
        next.progress.receivedBytes >= current.progress.receivedBytes,
        'Installation progress cannot move backwards.',
      );
  }
  if (!active.has(next.state)) delete result.progress;
  return softwareInstallation(result);
}

// Callers supply observations from a trusted read-only inspector, never a POST
// body. These pure functions cannot download, repair, activate or delete files.
export function reviewSoftwareInstallation(
  value,
  observation,
  {expectedRevision, confirm = false} = {},
) {
  const current = currentRevision(value, expectedRevision);
  assert(
    confirm && ['failed', 'recovery-required'].includes(current.state),
    'Explicit installation recovery review is required.',
    409,
  );
  fields(observation, ['state', 'receipt']);
  if (observation.state === 'partial') {
    assert(
      !current.installed && current.target && observation.receipt === undefined,
      'Partial recovery cannot discard installed software.',
      409,
    );
    return softwareInstallation({
      format: 1,
      revision: current.revision + 1,
      state: 'failed',
      error: 'interrupted',
      operationId: current.operationId,
      target: current.target,
    });
  }
  if (observation.state === 'empty') {
    assert(
      !current.installed && observation.receipt === undefined,
      'Recovery cannot discard a prior installation.',
      409,
    );
    return softwareInstallation({
      format: 1,
      revision: current.revision + 1,
      state: 'uninstalled',
    });
  }
  assert(
    ['installed', 'staged'].includes(observation.state),
    'Installation outcome is unknown. Preserve it for inspection.',
    409,
  );
  const receipt = softwareReceipt(observation.receipt),
    key = softwareSelectionKey(receipt.selection);
  assert(
    [current.target, current.installed?.selection].some(
      (selection) => selection && softwareSelectionKey(selection) === key,
    ),
    'Recovery observed unrelated software.',
    409,
  );
  if (observation.state === 'staged') {
    assert(
      current.target && softwareSelectionKey(current.target) === key,
      'Recovery staged software differs from its target.',
      409,
    );
    return softwareInstallation({
      format: 1,
      revision: current.revision + 1,
      state: 'validating',
      operationId: current.operationId,
      target: current.target,
      ...(current.installed ? {installed: current.installed} : {}),
    });
  }
  return softwareInstallation({
    format: 1,
    revision: current.revision + 1,
    state: 'installed',
    installed: receipt,
  });
}

export function adoptSoftwareInstallation(
  value,
  receipt,
  {expectedRevision, confirm = false, identity} = {},
) {
  const current = currentRevision(value, expectedRevision),
    installed = softwareReceipt(receipt);
  fields(identity, ['provider', 'application', 'platform']);
  assert(
    confirm &&
      current.state === 'uninstalled' &&
      ['provider', 'application', 'platform'].every(
        (key) => identity[key] === installed.selection[key],
      ),
    'Explicit adoption of this application installation is required.',
    409,
  );
  return softwareInstallation({
    format: 1,
    revision: current.revision + 1,
    state: 'installed',
    installed,
  });
}
