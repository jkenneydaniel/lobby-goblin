import fs from 'node:fs/promises';
import path from 'node:path';
import {assert} from '../common.js';
import {validId} from './instance.js';
import crypto from 'node:crypto';
import {syncDirectory} from './storage/files.js';
import {managementHash, managementImage, privateManagementDirectory, readManagementJSON, assertManagementStartAllowed} from './management-installation.js';

export const managementVolume = fleet => `lobby-goblin-fleet-${fleet}-management-updates`;
// Reserve the historical claim name permanently. Old operator binaries also
// refuse a previously queued plan, rather than creating a second private ledger.
export const managementAnchor = fleet => `lobby-goblin-management-lock-${fleet}`;
export const anchorRole = 'management-update-anchor';
export function assertVolume(info, fleet, engine) {
  assert(info?.Name === managementVolume(fleet) && info.Driver === 'local' && !Object.keys(info.Options || {}).length &&
    info.Labels?.['io.lobby-goblin.fleet'] === fleet && info.Labels['io.lobby-goblin.role'] === 'management-update-ledger' &&
    info.Labels['io.lobby-goblin.engine'] === engine, 'Management recovery storage belongs to another installation or engine.', 409);
}
export function assertAnchor(info, fleet, engine) {
  assert(info?.Name === '/' + managementAnchor(fleet) && /^sha256:[a-f0-9]{64}$/.test(info.Image || '') &&
    /^[a-f0-9]{64}$/.test(info.Id || '') && info.Config?.Labels?.['io.lobby-goblin.fleet'] === fleet &&
    info.Config.Labels['io.lobby-goblin.role'] === anchorRole && info.Config.Labels['io.lobby-goblin.engine'] === engine &&
    info.Config.Labels['io.lobby-goblin.management-volume'] === managementVolume(fleet) &&
    !info.State?.Running && info.State?.Status === 'created' && !info.Mounts?.length &&
    info.HostConfig?.NetworkMode === 'none' && info.HostConfig.ReadonlyRootfs === true && !info.HostConfig.Privileged &&
    !info.HostConfig.Binds?.length && !info.HostConfig.Mounts?.length && info.HostConfig.RestartPolicy?.Name === 'no',
  'The management enrollment anchor changed. Preserve its records for review.', 409);
}
export async function ensureManagementVolume({docker, inspect, fleet, engine, image}) {
  assert(validId(fleet), 'Invalid management installation.');
  let anchor = await inspect(managementAnchor(fleet));
  if (anchor) assertAnchor(anchor, fleet, engine);
  let volume;
  try { volume = await docker('GET', '/volumes/' + managementVolume(fleet)); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!volume) volume = await docker('POST', '/volumes/create', {Name: managementVolume(fleet), Driver: 'local', Labels: {
    'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': 'management-update-ledger', 'io.lobby-goblin.engine': engine,
  }});
  assertVolume(volume, fleet, engine);
  if (!anchor) {
    const created = await docker('POST', '/containers/create?' + new URLSearchParams({name: managementAnchor(fleet)}), {
      Image: image, Entrypoint: ['node'], Cmd: ['--version'], Healthcheck: {Test: ['NONE']}, Labels: {
        'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': anchorRole, 'io.lobby-goblin.engine': engine,
        'io.lobby-goblin.management-volume': managementVolume(fleet),
      }, HostConfig: {NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: {Name: 'no'}},
    });
    anchor = await inspect(created.Id);
  }
  assertAnchor(anchor, fleet, engine);
  return {volume: volume.Name, anchor: anchor.Id};
}

// The descriptor is derived from owned runtime resources, never a browser path.
// Its first image/directory are provenance only; native paths are never mounted.
export async function volumeInstallation(directory, context) {
  assert(context?.version === 1 && validId(context.fleet) && ['brokered', 'legacy'].includes(context.profile) &&
    context.volume === managementVolume(context.fleet) && /^[A-Za-z0-9:_-]{1,128}$/.test(context.engine || '') &&
    /^[a-f0-9]{64}$/.test(context.anchor || '') && ['fleet', 'host-agent'].includes(context.kind) && managementImage(context.image) &&
    typeof context.sourceDirectory === 'string' && context.sourceDirectory.length <= 4096 && !/[\x00-\x1f]/.test(context.sourceDirectory),
  'Invalid managed update storage scope.');
  const present = await fs.lstat(path.join(directory, 'installation.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!present) {
    assert((await fs.readdir(directory)).length === 0, 'Unrecognized recovery storage was preserved.', 409);
    await fs.chmod(directory, 0o700);
    const installation = {format: 1, id: context.fleet, project: 'lobby-goblin-fleet-' + context.fleet, kind: context.kind,
      options: {image: context.image}, management: {version: 1, volume: context.volume, anchor: context.anchor, engine: context.engine, profile: context.profile},
      sourceDirectory: context.sourceDirectory};
    const temporary = path.join(directory, '.enrollment-' + crypto.randomUUID());
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(installation) + '\n'); await handle.sync(); } finally { await handle.close(); }
    // First enrollment is immutable, including when two operators race.
    try { await fs.link(temporary, path.join(directory, 'installation.json')); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await fs.unlink(temporary); }
    await syncDirectory(directory);
  }
  await privateManagementDirectory(directory);
  const installation = await readManagementJSON(path.join(directory, 'installation.json'));
  assert(installation.id === context.fleet && installation.project === 'lobby-goblin-fleet-' + context.fleet && installation.kind === context.kind &&
    managementHash(installation.management) === managementHash({version: 1, volume: context.volume, anchor: context.anchor, engine: context.engine, profile: context.profile}),
  'The enrolled management installation changed.', 409);
  return installation;
}

export async function volumeRuntime(directory, {fleet, engine}) {
  await assertManagementStartAllowed(directory);
  const installation = await readManagementJSON(path.join(directory, 'installation.json'), {optional: true});
  if (!installation) return {enrolled: false};
  assert(installation.id === fleet && installation.management?.engine === engine && installation.management.volume === managementVolume(fleet), 'The enrolled management scope changed.', 409);
  const receipt = await readManagementJSON(path.join(directory, '.management-updates/active.json'), {optional: true}).catch(error => {
    if (error.code !== 'ENOENT') throw error; return null;
  });
  if (!receipt) return {enrolled: true, kind: installation.kind, image: installation.options.image, engine, profile: installation.management.profile,
    enrollment: managementHash(installation).slice(0, 32)};
  const {managementInstallationRuntime} = await import('./management-installation.js');
  const selected = await managementInstallationRuntime(directory, installation);
  return {enrolled: true, kind: installation.kind, image: selected.image, engine, id: receipt.id, profile: installation.management.profile,
    enrollment: managementHash(installation).slice(0, 32)};
}
export function portableRuntimeOverlay(selected) {
  assert(selected.enrolled && managementImage(selected.image) && ['brokered', 'legacy'].includes(selected.profile) &&
    ['fleet', 'host-agent'].includes(selected.kind) && /^[a-f0-9]{32}$/.test(selected.id || selected.enrollment), 'Invalid management startup selection.', 409);
  return {services: {
    ...(selected.profile === 'brokered' ? {'docker-broker': {image: selected.image}} : {}),
    'fleet-controller': {image: selected.image, environment: {FLEET_IMAGE: selected.image,
      ...(selected.profile === 'legacy' ? {FLEET_SKIP_MIGRATIONS: 'true'} : {}),
      ...(selected.id ? {PANEL_MAINTENANCE_ID: selected.id} : {})}},
    [selected.kind === 'host-agent' ? 'host-agent' : 'fleet-web']: {image: selected.image,
      ...(selected.id ? {environment: {PANEL_MAINTENANCE_ID: selected.id}} : {})},
  }};
}
