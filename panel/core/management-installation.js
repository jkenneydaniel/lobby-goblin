import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../common.js';
import {regularFile, parseStorageJSON, syncDirectory} from './storage/files.js';
import {inspectStorageLock} from './storage/coordination.js';

export const managementDirectory = (directory) =>
  path.join(directory, '.management-updates');
export const managementHash = (value) => {
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))))
    .digest('hex');
};
export const managementImage = (value) =>
  typeof value === 'string' &&
  /^(?:ghcr\.io\/jkenneydaniel\/lobby-goblin@)?sha256:[a-f0-9]{64}$/.test(
    value,
  );

// Private operator files are never mounted in management or application services.
export async function privateManagementDirectory(
  directory,
  {create = false} = {},
) {
  if (create) await fs.mkdir(directory, {mode: 0o700});
  const stat = await fs.lstat(directory);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (process.getuid === undefined || stat.uid === process.getuid()) &&
      (await fs.realpath(directory)) === directory,
    'Management update records need a canonical private operator directory.',
  );
  return directory;
}

export async function saveManagementJSON(file, value) {
  await privateManagementDirectory(path.dirname(file));
  const prior = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert(
    !prior ||
      (prior.isFile() &&
        !prior.isSymbolicLink() &&
        prior.nlink === 1 &&
        (prior.mode & 0o077) === 0),
    'Management update records must remain private regular files.',
  );
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close();
    await fs.rm(temporary, {force: true});
  }
}

export async function readManagementJSON(file, {optional = false} = {}) {
  const stat = await fs.lstat(file).catch((error) => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  await privateManagementDirectory(path.dirname(file));
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o077) === 0,
    'Management update records must remain private regular files.',
  );
  return parseStorageJSON(await regularFile(file));
}

export async function assertManagementStartAllowed(directory) {
  assert(
    !(await inspectStorageLock(directory)),
    'A management update or retained operator lock needs review before starting this installation.',
    409,
  );
  const root = managementDirectory(directory);
  const present = await fs.lstat(root).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!present) return;
  await privateManagementDirectory(root);
  for (const id of await fs.readdir(root)) {
    if (!/^[a-f0-9]{32}$/.test(id)) continue;
    const record = await readManagementJSON(
      path.join(root, id, 'operation.json'),
    );
    assert(
      record.version === 1 &&
        record.id === id &&
        record.pending === null &&
        ((record.phase === 'planned' && record.state === 'queued') ||
          (record.phase === 'complete' && record.state === 'succeeded') ||
          (record.phase === 'rolled-back' && record.state === 'failed')),
      'Finish the retained management update or cleanup with the operator command before starting this installation.',
      409,
    );
  }
}

export function managementOverlay(manifest, receipt) {
  assert(
    receipt?.version === 1 &&
      receipt.fleet === manifest.id &&
      receipt.installationHash === managementHash(manifest) &&
      /^[a-f0-9]{32}$/.test(receipt.id || '') &&
      managementImage(receipt.image) &&
      receipt.complete === true &&
      typeof receipt.engine === 'string' &&
      /^[A-Za-z0-9:_-]{1,128}$/.test(receipt.engine),
    'The retained management runtime needs operator recovery. Installation files were left unchanged.',
    409,
  );
  const agent = manifest.kind === 'host-agent';
  return {
    services: {
      'docker-broker': {image: receipt.image},
      'fleet-controller': {
        image: receipt.image,
        environment: {
          FLEET_IMAGE: receipt.image,
          PANEL_MAINTENANCE_ID: receipt.id,
          ...(manifest.management?.profile === 'legacy' ? {FLEET_SKIP_MIGRATIONS: 'true'} : {}),
        },
      },
      [agent ? 'host-agent' : 'fleet-web']: {
        image: receipt.image,
        environment: {PANEL_MAINTENANCE_ID: receipt.id},
      },
    },
  };
}

export async function managementInstallationRuntime(directory, manifest) {
  const root = managementDirectory(directory);
  const stat = await fs.lstat(root).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return {image: manifest.options.image, arguments: []};
  await privateManagementDirectory(root);
  const receipt = await readManagementJSON(path.join(root, 'active.json'), {
    optional: true,
  });
  if (!receipt) return {image: manifest.options.image, arguments: []};
  const expected = managementOverlay(manifest, receipt);
  const operation = await readManagementJSON(
    path.join(root, receipt.id, 'operation.json'),
  );
  assert(
    operation.state === 'succeeded' &&
      operation.phase === 'complete' &&
      operation.commit === true &&
      operation.id === receipt.id &&
      operation.fleet === receipt.fleet &&
      operation.engine === receipt.engine &&
      operation.image === receipt.image &&
      operation.installationHash === receipt.installationHash,
    'Finish the retained management update with the operator command before starting this installation.',
    409,
  );
  const file = path.join(root, 'runtime.compose.json');
  assert(
    managementHash(await readManagementJSON(file)) === managementHash(expected),
    'The retained management startup override changed. Preserve it for operator review.',
    409,
  );
  return {
    image: receipt.image,
    engine: receipt.engine,
    arguments: ['-f', file],
  };
}
