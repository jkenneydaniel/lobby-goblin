import path from 'node:path';
import {assert} from '../../common.js';
import {
  softwareSelection,
  softwareSelectionKey,
} from '../../core/software-installation.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';

const appId = (value) =>
  typeof value === 'string' &&
  /^[1-9]\d{0,9}$/.test(value) &&
  BigInt(value) <= 4294967295n;
const branchName = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export function steamSource(value) {
  definitionData(value);
  assert(
    value &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) =>
        ['application', 'appId', 'platform', 'branches'].includes(key),
      ) &&
      typeof value.application === 'string' &&
      /^[a-z][a-z0-9-]{0,63}$/.test(value.application) &&
      appId(value.appId) &&
      value.platform === 'linux/amd64' &&
      Array.isArray(value.branches) &&
      value.branches.length > 0 &&
      value.branches.length <= 16 &&
      value.branches.every(branchName) &&
      new Set(value.branches).size === value.branches.length,
    'Invalid reviewed Steam server source.',
  );
  return freezeDefinition(value);
}

// Steam app_info_print and appmanifest files use Valve KeyValues, not JSON.
// Parse only a requested quoted root; logs before/after it are not metadata.
export function steamKeyValues(text, root) {
  assert(
    typeof text === 'string' &&
      Buffer.byteLength(text) <= 8 * 1024 ** 2 &&
      typeof root === 'string' &&
      /^(?:[1-9]\d{0,9}|AppState)$/.test(root),
    'Steam metadata exceeds its bounds.',
  );
  const pattern = new RegExp(
    '(?:^|\\n)[ \\t]*"' + root + '"[ \\t\\r\\n]*\\{',
    'g',
  );
  const matches = [...text.matchAll(pattern)];
  assert(
    matches.length === 1,
    'Steam metadata must contain one requested root.',
  );
  let index = matches[0].index + matches[0][0].lastIndexOf('{'),
    nodes = 0;
  function whitespace() {
    for (;;) {
      while (/\s/.test(text[index] || '') && index < text.length) index++;
      if (text.slice(index, index + 2) !== '//') break;
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end + 1;
    }
  }
  function quoted() {
    whitespace();
    assert(text[index++] === '"', 'Invalid Steam metadata token.');
    let result = '';
    for (;;) {
      assert(
        index < text.length && result.length <= 65536,
        'Invalid Steam metadata string.',
      );
      const char = text[index++];
      if (char === '"') return result;
      if (char === '\\') {
        assert(index < text.length, 'Invalid Steam metadata escape.');
        const escaped = text[index++];
        result +=
          {n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\'}[escaped] ??
          '\\' + escaped;
      } else result += char;
    }
  }
  function object(depth) {
    whitespace();
    assert(
      text[index++] === '{' && depth <= 24,
      'Steam metadata is too deeply nested.',
    );
    const value = Object.create(null);
    for (;;) {
      whitespace();
      assert(
        index < text.length && ++nodes <= 50000,
        'Steam metadata exceeds its bounds.',
      );
      if (text[index] === '}') {
        index++;
        return value;
      }
      const key = quoted();
      assert(
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
          !Object.hasOwn(value, key),
        'Ambiguous Steam metadata field.',
      );
      whitespace();
      value[key] = text[index] === '{' ? object(depth + 1) : quoted();
    }
  }
  return object(0);
}

function branch(source, value) {
  assert(
    source.branches.includes(value),
    'Choose a reviewed Steam server branch.',
  );
  return value;
}
export function steamDiscoveryArguments(value) {
  const source = steamSource(value);
  return [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+login',
    'anonymous',
    '+app_info_update',
    '1',
    '+app_info_print',
    source.appId,
    '+quit',
  ];
}

export function steamBuild(text, value, requestedBranch = 'public') {
  const source = steamSource(value),
    selectedBranch = branch(source, requestedBranch);
  const info = steamKeyValues(text, source.appId),
    depots = info.depots;
  const buildId = depots?.branches?.[selectedBranch]?.buildid;
  assert(
    depots && typeof depots === 'object' && typeof buildId === 'string',
    'The Steam server branch has no resolved build.',
  );
  const selected = [];
  let bytes = 0;
  for (const [id, depot] of Object.entries(depots)) {
    if (!appId(id)) continue;
    assert(depot && typeof depot === 'object', 'Invalid Steam depot metadata.');
    const config = depot.config || {};
    if (config.oslist && !String(config.oslist).split(',').includes('linux'))
      continue;
    if (config.osarch && config.osarch !== '64') continue;
    // Shared-app dependencies require their own resolved manifests. Refuse
    // unsupported sources rather than silently claiming a complete identity.
    assert(
      !depot.depotfromapp && !depot.encryptedmanifests?.[selectedBranch],
      'Shared or encrypted Steam depots require a reviewed resolver.',
    );
    const manifest =
      depot.manifests?.[selectedBranch] || depot.manifests?.public;
    assert(
      manifest &&
        typeof manifest === 'object' &&
        typeof manifest.gid === 'string' &&
        typeof manifest.size === 'string' &&
        /^\d{1,13}$/.test(manifest.size),
      'The Steam depot has no exact public manifest.',
    );
    bytes += Number(manifest.size);
    assert(
      Number.isSafeInteger(bytes) && bytes <= 1024 ** 4,
      'Steam installation exceeds its size bound.',
    );
    selected.push({id, manifest: manifest.gid});
  }
  const selection = softwareSelection({
    format: 1,
    provider: 'steamcmd',
    application: source.application,
    platform: source.platform,
    softwareVersion: buildId,
    source: {
      kind: 'steam',
      appId: source.appId,
      branch: selectedBranch,
      buildId,
      depots: selected,
    },
  });
  return freezeDefinition({selection, bytes});
}

export function steamInstallArguments(value, directory, target) {
  const source = steamSource(value),
    selection = softwareSelection(target);
  assert(
    selection.provider === 'steamcmd' &&
      selection.application === source.application &&
      selection.platform === source.platform &&
      selection.source.kind === 'steam' &&
      selection.source.appId === source.appId,
    'Steam selection belongs to another application.',
  );
  branch(source, selection.source.branch);
  assert(
    typeof directory === 'string' &&
      directory !== '/' &&
      path.posix.isAbsolute(directory) &&
      path.posix.normalize(directory) === directory &&
      !/[\x00-\x1f\x7f]/.test(directory),
    'Invalid private Steam staging directory.',
  );
  // Passing public explicitly also leaves any previous beta branch.
  return [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+force_install_dir',
    directory,
    '+login',
    'anonymous',
    '+app_update',
    source.appId,
    '-beta',
    selection.source.branch,
    'validate',
    '+quit',
  ];
}

// This checks Steam's completion metadata, not the downloaded file inventory.
// The installer must verify both before publishing its completed receipt.
export function verifySteamManifest(text, target) {
  const selection = softwareSelection(target);
  assert(
    selection.provider === 'steamcmd' && selection.source.kind === 'steam',
    'A Steam selection is required.',
  );
  const state = steamKeyValues(text, 'AppState');
  assert(
    state.appid === selection.source.appId &&
      state.StateFlags === '4' &&
      state.InstalledDepots &&
      (state.UserConfig?.BetaKey || 'public') === selection.source.branch,
    'Steam installation is incomplete or belongs to another branch.',
  );
  const observed = softwareSelection({
    ...selection,
    softwareVersion: state.buildid,
    source: {
      ...selection.source,
      buildId: state.buildid,
      depots: Object.entries(state.InstalledDepots).map(([id, value]) => ({
        id,
        manifest: value?.manifest,
      })),
    },
  });
  assert(
    softwareSelectionKey(observed) === softwareSelectionKey(selection),
    'Steam installed a different build or depot manifest. Refresh the update plan.',
  );
  return selection;
}
