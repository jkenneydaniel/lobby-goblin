import path from 'node:path';
import {assert} from '../common.js';
import {definitionData, freezeDefinition} from './definition-data.js';
import {resources, validId, labels} from './instance.js';
import {steamSource} from '../providers/steamcmd/metadata.js';
import {createSteamProvider} from '../providers/steamcmd/provider.js';
import deploymentRecord from '../providers/steamcmd/deployment.json' with {type: 'json'};

export const softwareWorkerKind = 'software-preparation';
export const softwareWorkerDeployment = freezeDefinition(deploymentRecord);
const deployment = softwareWorkerDeployment;
const tag = deployment.image.split('@')[0];
const repositoryDigest =
  tag.slice(0, tag.lastIndexOf(':')) + '@' + deployment.image.split('@')[1];
export const softwareWorkerPaths = Object.freeze({
  software: 'software/steamcmd',
  control: 'state/software/steamcmd',
  requests: 'state/software-workers',
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
export const softwareWorkerId = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export function softwareWorkerDeclaration(value, application) {
  definitionData(value);
  assert(
    exact(value, ['version', 'provider', 'source', 'requiredFiles']) &&
      value.version === 1 &&
      value.provider === 'steamcmd',
    'Choose a registered software preparation provider.',
  );
  const source = steamSource(value.source);
  assert(
    !application || source.application === application,
    'Software preparation belongs to another application.',
  );
  createSteamProvider({
    source,
    requiredFiles: value.requiredFiles,
    // This constructor validates metadata only; use canonical host paths so
    // Windows launchers can inspect Linux application declarations too.
    software: path.resolve('/software'),
    control: path.resolve('/control'),
  });
  return freezeDefinition({
    version: 1,
    provider: 'steamcmd',
    source,
    requiredFiles: value.requiredFiles,
  });
}

export function softwareWorkerName(instance, id) {
  assert(
    validId(instance) && softwareWorkerId(id),
    'Invalid software worker identity.',
  );
  return 'lobby-goblin-software-' + instance + '-' + id;
}
export function softwareWorkerScope({fleet, instance, volume, declaration}) {
  declaration = softwareWorkerDeclaration(declaration);
  const scope = resources(fleet, instance, declaration.source.application);
  assert(
    validId(fleet) && validId(instance) && volume === scope.volume,
    'Invalid software worker storage scope.',
  );
  return {...scope, fleet, instance, declaration};
}

export function softwareWorkerSpec(scope, id, action) {
  assert(
    softwareWorkerId(id) && ['resolve', 'prepare'].includes(action),
    'Unsupported software worker action.',
  );
  const preparing = action === 'prepare',
    root = softwareWorkerPaths.requests + '/' + id;
  const mount = (target, subpath, readOnly) => ({
    Type: 'volume',
    Source: scope.volume,
    Target: target,
    ReadOnly: readOnly,
    VolumeOptions: {Subpath: subpath, NoCopy: true},
  });
  return {
    Image: deployment.image,
    User: '1000:0',
    Entrypoint: [...deployment.entrypoint],
    Cmd: [],
    Labels: {
      ...labels(
        scope.fleet,
        scope.instance,
        scope.declaration.source.application,
      ),
      'io.lobby-goblin.worker': 'true',
      'io.lobby-goblin.worker-kind': softwareWorkerKind,
      'io.lobby-goblin.worker-action': action,
      'io.lobby-goblin.worker-request': id,
    },
    HostConfig: {
      NetworkMode: scope.network,
      Memory: (preparing ? 2 * 1024 : 512) * 1024 ** 2,
      NanoCpus: 1000000000,
      PidsLimit: 256,
      Init: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      LogConfig: {
        Type: 'json-file',
        Config: {'max-size': '5m', 'max-file': '2'},
      },
      Mounts: [
        ...(preparing
          ? [
              mount('/software', softwareWorkerPaths.software, false),
              mount('/control', softwareWorkerPaths.control, false),
            ]
          : []),
        mount('/request', root + '/request', true),
        mount('/result', root + '/result', false),
      ],
    },
  };
}

export function validateSoftwareWorkerImage(image) {
  assert(
    image?.Id === deployment.imageId &&
      image.Os === 'linux' &&
      image.Architecture === 'amd64' &&
      image.Config?.User === '1000:1000' &&
      same(image.Config.Entrypoint, deployment.entrypoint) &&
      same(image.Config.Cmd || [], []) &&
      image.Config.Labels?.['io.lobby-goblin.provider'] === 'steamcmd-worker' &&
      image.Config.Labels?.['io.lobby-goblin.image-revision'] ===
        deployment.revision &&
      image.RepoDigests?.includes(repositoryDigest),
    'Software worker image differs from its published contract.',
    409,
  );
  return image;
}

function validateMounts(mounts, expected) {
  assert(
    Array.isArray(mounts) && mounts.length === expected.length,
    'Software workers cannot mount application data or credentials.',
    403,
  );
  for (const required of expected) {
    const mount = mounts.find((value) => value.Target === required.Target);
    assert(
      exact(mount, ['Type', 'Source', 'Target', 'ReadOnly', 'VolumeOptions']) &&
        exact(mount.VolumeOptions, ['Subpath', 'NoCopy']) &&
        mount.Type === 'volume' &&
        mount.Source === required.Source &&
        (mount.ReadOnly === true) === required.ReadOnly &&
        mount.VolumeOptions.Subpath === required.VolumeOptions.Subpath &&
        mount.VolumeOptions.NoCopy === true,
      'Software worker storage is outside its private scope.',
      403,
    );
  }
}
export function validateSoftwareWorkerCreate(data, name, scope) {
  const marker = data?.Labels || {},
    id = marker['io.lobby-goblin.worker-request'],
    action = marker['io.lobby-goblin.worker-action'];
  const expected = softwareWorkerSpec(scope, id, action);
  assert(
    name === softwareWorkerName(scope.instance, id) &&
      exact(data, [
        'Image',
        'User',
        'Entrypoint',
        'Cmd',
        'Labels',
        'HostConfig',
      ]) &&
      exact(marker, Object.keys(expected.Labels)) &&
      Object.entries(expected.Labels).every(
        ([key, value]) => marker[key] === value,
      ) &&
      data.Image === expected.Image &&
      data.User === expected.User &&
      same(data.Entrypoint, expected.Entrypoint) &&
      same(data.Cmd, []),
    'Unreviewed software worker identity, image or executable.',
    403,
  );
  const host = data.HostConfig;
  assert(
    exact(host, Object.keys(expected.HostConfig)) &&
      Object.entries(expected.HostConfig)
        .filter(([key]) => key !== 'Mounts')
        .every(([key, value]) => same(host[key], value)),
    'Unreviewed software worker privileges, network or resources.',
    403,
  );
  validateMounts(host.Mounts, expected.HostConfig.Mounts);
  return {id, action, expected};
}

export function validateSoftwareWorkerContainer(info, scope, image) {
  validateSoftwareWorkerImage(image);
  const marker = info.Config?.Labels || {},
    id = marker['io.lobby-goblin.worker-request'],
    action = marker['io.lobby-goblin.worker-action'],
    expected = softwareWorkerSpec(scope, id, action);
  assert(
    typeof info.Id === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(info.Id) &&
      info.Name === '/' + softwareWorkerName(scope.instance, id) &&
      info.Image === deployment.imageId &&
      info.Config?.Image === deployment.image &&
      Object.entries(expected.Labels).every(
        ([key, value]) => marker[key] === value,
      ) &&
      info.Config.User === expected.User &&
      same(info.Config.Entrypoint, deployment.entrypoint) &&
      same(info.Config.Cmd || [], []) &&
      same(info.Config.Env || [], image.Config.Env || []),
    'This is not the reviewed software worker.',
    403,
  );
  const host = info.HostConfig || {};
  assert(
    host.NetworkMode === expected.HostConfig.NetworkMode &&
      host.Memory === expected.HostConfig.Memory &&
      host.NanoCpus === 1000000000 &&
      host.PidsLimit === 256 &&
      host.Init === true &&
      same(host.CapDrop, ['ALL']) &&
      !(host.CapAdd || []).length &&
      same(host.SecurityOpt, ['no-new-privileges:true']) &&
      !host.Privileged &&
      !(host.Binds || []).length &&
      !(host.Devices || []).length &&
      !(host.VolumesFrom || []).length &&
      !host.PidMode &&
      (!host.IpcMode || host.IpcMode === 'private'),
    'Software worker host access changed.',
    403,
  );
  validateMounts(host.Mounts, expected.HostConfig.Mounts);
  assert(
    info.Mounts?.length === expected.HostConfig.Mounts.length &&
      expected.HostConfig.Mounts.every((required) =>
        info.Mounts.some(
          (mount) =>
            mount.Type === 'volume' &&
            mount.Name === scope.volume &&
            mount.Destination === required.Target &&
            mount.RW === !required.ReadOnly,
        ),
      ),
    'Software worker mount realization changed.',
    403,
  );
  return {id, action};
}
