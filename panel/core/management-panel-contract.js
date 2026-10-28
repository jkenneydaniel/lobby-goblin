import {assert} from '../common.js';
import {managementHash} from './management-installation.js';

export const panelWorkerRole = 'management-panel-worker';
export const panelWorkerName = (fleet, attempt) => `lobby-goblin-management-panel-${fleet}-${attempt}`;
export function panelWorkerSpec({fleet, attempt, image, directory, managementVolume, socket, volume, subpath}) {
  return {
    Image: image, User: '0:0', Entrypoint: ['node', '/app/management-panel-worker.js'], Cmd: [], Healthcheck: {Test: ['NONE']},
    Env: ['NODE_ENV=production'], WorkingDir: '/app',
    Labels: {'io.lobby-goblin.fleet': fleet, 'io.lobby-goblin.role': panelWorkerRole, 'io.lobby-goblin.panel-attempt': attempt},
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, RestartPolicy: {Name: 'no'}, AutoRemove: true,
      CapDrop: ['ALL'], CapAdd: managementVolume ? [] : ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges:true'],
      Memory: 512 * 1024 ** 2, NanoCpus: 1000000000, PidsLimit: 128,
      Mounts: [
        {Type: 'bind', Source: socket, Target: '/var/run/docker.sock'},
        managementVolume ? {Type: 'volume', Source: managementVolume, Target: '/management', VolumeOptions: {NoCopy: true}} : {Type: 'bind', Source: directory, Target: directory},
        {Type: 'volume', Source: volume, Target: '/request', VolumeOptions: {Subpath: subpath}},
      ],
    },
  };
}
export function assertPanelWorker(info, spec, name) {
  const same = (a, b) => managementHash(a ?? null) === managementHash(b ?? null);
  const mounts = values => (values || []).map(m => ({Type: m.Type, Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly === true, Subpath: m.VolumeOptions?.Subpath || null}));
  assert(info && info.Name === '/' + name && info.Image === spec.Image &&
    ['User', 'Entrypoint', 'WorkingDir'].every(key => same(info.Config?.[key], spec[key])) &&
    same(info.Config.Cmd || [], []) &&
    same(info.Config.Healthcheck?.Test, ['NONE']) &&
    spec.Env.every(value => info.Config.Env?.includes(value)) &&
    !info.Config.Env?.some(value => /^DOCKER_|^NODE_OPTIONS=/.test(value)) &&
    Object.entries(spec.Labels).every(([key, value]) => info.Config.Labels?.[key] === value) &&
    ['NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Memory', 'NanoCpus', 'PidsLimit'].every(key => same(info.HostConfig?.[key], spec.HostConfig[key])) &&
    same(info.HostConfig.CapAdd || [], spec.HostConfig.CapAdd || []) &&
    same(mounts(info.HostConfig.Mounts), mounts(spec.HostConfig.Mounts)) &&
    info.HostConfig.RestartPolicy?.Name === 'no' && info.HostConfig.AutoRemove === spec.HostConfig.AutoRemove && !info.HostConfig.Privileged &&
    !info.HostConfig.PidMode && !info.HostConfig.Binds?.length && !info.HostConfig.VolumesFrom?.length && !info.HostConfig.Devices?.length && !info.HostConfig.DeviceRequests?.length,
  'The management coordinator changed. Preserve it for operator review.', 409);
}
export function operatorWorkerSpec({fleet, attempt, image, socket, managementVolume, request}) {
  const spec = panelWorkerSpec({fleet, attempt, image, socket, managementVolume});
  spec.Entrypoint = ['node', '/app/management-volume-worker.js'];
  spec.Env.push('MANAGEMENT_REQUEST=' + JSON.stringify(request));
  spec.HostConfig.AutoRemove = false;
  spec.HostConfig.Mounts = spec.HostConfig.Mounts.filter(mount => mount.Target !== '/request' && (request.action !== 'runtime' || mount.Target !== '/var/run/docker.sock'));
  if (request.action === 'runtime') spec.HostConfig.Mounts[0].ReadOnly = true;
  return spec;
}
