import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from '../../common.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';
import {softwareSelection} from '../../core/software-installation.js';
import {steamSource} from './metadata.js';
import {createSteamProvider} from './provider.js';
import {directory, readRecord, atomicRecord} from './files.js';

const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function softwareWorkerRequest(value) {
  definitionData(value);
  assert(
    value?.format === 1 &&
      uuid(value.id) &&
      ['resolve', 'prepare', 'inspect'].includes(value.action),
    'Choose a supported software worker request.',
  );
  const common = ['format', 'id', 'action', 'source', 'requiredFiles'];
  const extra =
    value.action === 'resolve'
      ? ['initial']
      : value.action === 'prepare'
        ? ['selection', 'confirm']
        : [];
  assert(
    fields(value, [...common, ...extra]),
    'Unknown software worker field.',
  );
  const source = steamSource(value.source);
  const result = {
    format: 1,
    id: value.id,
    action: value.action,
    source,
    requiredFiles: value.requiredFiles,
  };
  if (value.action === 'resolve') {
    assert(
      fields(value.initial, ['channel']) &&
        Object.keys(value.initial).length === 1 &&
        source.branches.includes(value.initial.channel),
      'Choose a reviewed Steam branch.',
    );
    result.initial = {channel: value.initial.channel};
  }
  if (value.action === 'prepare') {
    assert(value.confirm === true, 'Confirm private software preparation.');
    const selection = softwareSelection(value.selection);
    assert(
      selection.provider === 'steamcmd' &&
        selection.application === source.application &&
        selection.platform === source.platform &&
        selection.source.kind === 'steam' &&
        selection.source.appId === source.appId &&
        source.branches.includes(selection.source.branch),
      'Software belongs to another Steam application.',
      409,
    );
    result.selection = selection;
    result.confirm = true;
  }
  // Reuse the provider's required-file validation before any filesystem effect.
  createSteamProvider({
    source,
    requiredFiles: result.requiredFiles,
    software: '/software',
    control: '/control',
  });
  return freezeDefinition(result);
}

// Only reviewed callers/tests can supply filesystem roots or an executable
// adapter. The container protocol has fixed roots and no lifecycle authority.
export async function executeWorkerRequest(
  value,
  {software = '/software', control = '/control', command, signal} = {},
) {
  const request = softwareWorkerRequest(value);
  const provider = createSteamProvider({
    source: request.source,
    software,
    control,
    requiredFiles: request.requiredFiles,
    ...(command ? {command} : {}),
  });
  let result;
  if (request.action === 'resolve')
    result = await provider.resolve(request.initial, {signal});
  if (request.action === 'prepare')
    result = await provider.prepare(request.selection, {
      confirm: true,
      operationId: request.id,
      signal,
    });
  if (request.action === 'inspect') result = await provider.inspect();
  return {format: 1, id: request.id, action: request.action, ok: true, result};
}

export async function main() {
  const abort = new AbortController(),
    cancel = () => abort.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  let request, response;
  try {
    await directory('/request');
    request = softwareWorkerRequest(
      await readRecord('/request/request.json', {max: 64 * 1024}),
    );
    response = await executeWorkerRequest(request, {signal: abort.signal});
  } catch (error) {
    response = {
      format: 1,
      id: request?.id || null,
      ok: false,
      error: {
        code: 'software-worker-failed',
        status: [400, 409, 413, 503, 504, 507].includes(error.status)
          ? error.status
          : 503,
        message: error.status
          ? String(error.message).slice(0, 1000)
          : 'Software preparation failed. Inspect its retained private state before retrying.',
      },
    };
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
  assert(
    Buffer.byteLength(JSON.stringify(response)) <= 256 * 1024,
    'Software worker response exceeds its bound.',
  );
  await directory('/result');
  await atomicRecord('/result/result.json', response);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      'Software worker result could not be recorded. Inspect private storage.',
    );
    process.exitCode = 1;
  });
