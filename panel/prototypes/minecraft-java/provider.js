// Unregistered, offline prototype. There is no downloader or Docker dispatcher.
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assert} from '../../common.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';
import {resources, validId} from '../../core/instance.js';
import {
  softwareSelection,
  softwareReceipt,
} from '../../core/software-installation.js';

export const maxFixtureBytes = 128 * 1024 ** 2;
export const digest = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
export function exactRecord(value, keys) {
  definitionData(value);
  assert(
    value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    'Invalid Minecraft fixture record.',
  );
}
export function javaFixtureRelease(value) {
  exactRecord(value, [
    'format',
    'edition',
    'gameVersion',
    'platform',
    'sha256',
    'bytes',
  ]);
  assert(
    value.format === 1 &&
      value.edition === 'java' &&
      value.platform === 'linux/amd64' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= maxFixtureBytes,
    'Choose a bounded Java fixture artifact.',
  );
  const selection = softwareSelection({
    format: 1,
    provider: 'mojang-fixture',
    application: 'minecraft-java',
    platform: value.platform,
    softwareVersion: value.gameVersion,
    source: {kind: 'archive', sha256: value.sha256},
  });
  return freezeDefinition({
    format: 1,
    edition: 'java',
    gameVersion: selection.softwareVersion,
    platform: selection.platform,
    sha256: selection.source.sha256,
    bytes: value.bytes,
  });
}
export function fixtureReceipt(value) {
  const release = javaFixtureRelease(value);
  const files = [
    {
      name: 'server.jar',
      size: release.bytes,
      sha256: release.sha256,
      executable: false,
    },
  ];
  return softwareReceipt({
    format: 1,
    selection: {
      format: 1,
      provider: 'mojang-fixture',
      application: 'minecraft-java',
      platform: release.platform,
      softwareVersion: release.gameVersion,
      source: {kind: 'archive', sha256: release.sha256},
    },
    inventory: {
      sha256: digest(JSON.stringify(files)),
      files: 1,
      bytes: release.bytes,
    },
  });
}
export function verifyFixtureBytes(bytes, value) {
  const release = javaFixtureRelease(value);
  assert(
    Buffer.isBuffer(bytes) &&
      bytes.length === release.bytes &&
      digest(bytes) === release.sha256,
    'Minecraft fixture artifact differs from its selection.',
    409,
  );
  return fixtureReceipt(release);
}
export function fixtureScope(value) {
  exactRecord(value, ['fleet', 'instance', 'volume']);
  assert(
    validId(value.fleet) &&
      validId(value.instance) &&
      resources(value.fleet, value.instance, 'minecraft-java').volume ===
        value.volume,
    'Minecraft fixture storage belongs to another scope.',
    403,
  );
  return freezeDefinition(value);
}
export function fixtureWorkerRequest(scope, request, release) {
  scope = fixtureScope(scope);
  release = javaFixtureRelease(release);
  assert(
    typeof request === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request),
    'Invalid Minecraft fixture request.',
  );
  // An abstract, synthetic intent, never a Docker create payload. No image,
  // environment, arbitrary command, host bind or management credential is allowed.
  return freezeDefinition({
    format: 1,
    kind: 'minecraft-java-fixture',
    scope,
    request,
    action: 'prepare',
    release,
    limits: {
      bytes: maxFixtureBytes,
      memoryMiB: 2048,
      cpus: 1,
      pids: 256,
      network: 'none',
    },
    mounts: [
      {
        volume: scope.volume,
        path: 'state/minecraft-java-fixture/' + request + '/request',
        access: 'read-only',
      },
      {
        volume: scope.volume,
        path: 'state/minecraft-java-fixture/' + request + '/result',
        access: 'write',
      },
    ],
  });
}
export function validateFixtureWorkerRequest(value, scope, request, release) {
  definitionData(value);
  assert(
    isDeepStrictEqual(value, fixtureWorkerRequest(scope, request, release)),
    'Minecraft fixture worker scope or capabilities changed.',
    403,
  );
  return value;
}
