import test from 'node:test';
import assert from 'node:assert/strict';
import {
  softwareWorkerDeclaration,
  softwareWorkerDeployment,
  softwareWorkerScope,
  softwareWorkerSpec,
  softwareWorkerName,
  validateSoftwareWorkerCreate,
  validateSoftwareWorkerContainer,
  validateSoftwareWorkerImage,
} from '../core/software-worker-policy.js';

const fleet = 'a'.repeat(32),
  instance = 'b'.repeat(32),
  id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const declaration = {
  version: 1,
  provider: 'steamcmd',
  source: {
    application: 'rust',
    appId: '258550',
    platform: 'linux/amd64',
    branches: ['public'],
  },
  requiredFiles: [{path: 'RustDedicated', executable: true}],
};
const scope = softwareWorkerScope({
  fleet,
  instance,
  volume: 'lobby-goblin-' + fleet + '-' + instance,
  declaration,
});
function fixture(action = 'prepare') {
  const spec = softwareWorkerSpec(scope, id, action);
  const image = {
    Id: softwareWorkerDeployment.imageId,
    Os: 'linux',
    Architecture: 'amd64',
    RepoDigests: [
      softwareWorkerDeployment.image.split(':1-lg.1@')[0] +
        '@' +
        softwareWorkerDeployment.image.split('@')[1],
    ],
    Config: {
      User: '1000:1000',
      Entrypoint: [...softwareWorkerDeployment.entrypoint],
      Cmd: [],
      Env: ['HOME=/home/node'],
      Labels: {
        'io.lobby-goblin.provider': 'steamcmd-worker',
        'io.lobby-goblin.image-revision': '1',
      },
    },
  };
  const info = {
    Id: 'reviewed-worker-id',
    Name: '/' + softwareWorkerName(instance, id),
    Image: image.Id,
    Config: {
      Image: spec.Image,
      User: spec.User,
      Entrypoint: spec.Entrypoint,
      Cmd: spec.Cmd,
      Env: image.Config.Env,
      Labels: spec.Labels,
    },
    HostConfig: structuredClone(spec.HostConfig),
    Mounts: spec.HostConfig.Mounts.map((mount) => ({
      Type: 'volume',
      Name: scope.volume,
      Destination: mount.Target,
      RW: !mount.ReadOnly,
    })),
  };
  return {spec, image, info};
}
test('worker contracts bind published code and four private claims without lifecycle credentials', () => {
  const {spec, image, info} = fixture();
  assert.equal(
    softwareWorkerDeclaration(declaration, 'rust').provider,
    'steamcmd',
  );
  assert.throws(
    () => softwareWorkerDeclaration(declaration, 'other'),
    /another application/,
  );
  assert.throws(
    () => softwareWorkerDeclaration({...declaration, image: 'custom'}),
    /registered/,
  );
  assert.equal(
    validateSoftwareWorkerCreate(spec, softwareWorkerName(instance, id), scope)
      .action,
    'prepare',
  );
  assert.equal(validateSoftwareWorkerImage(image).Id, image.Id);
  assert.equal(validateSoftwareWorkerContainer(info, scope, image).id, id);
  assert.equal(spec.User, '1000:0');
  assert.deepEqual(
    spec.HostConfig.Mounts.map((mount) => mount.Target),
    ['/software', '/control', '/request', '/result'],
  );
  assert.ok(
    spec.HostConfig.Mounts.every(
      (mount) => !mount.VolumeOptions.Subpath.startsWith('data/'),
    ),
  );
  assert.equal(
    spec.HostConfig.Mounts.find((mount) => mount.Target === '/request')
      .ReadOnly,
    true,
  );
  const resolve = fixture('resolve');
  assert.equal(resolve.spec.HostConfig.Memory, 512 * 1024 ** 2);
  assert.equal(resolve.spec.HostConfig.Mounts.length, 2);
  validateSoftwareWorkerContainer(resolve.info, scope, resolve.image);
});

test('worker creation rejects altered code, root access, secrets, application mounts and injected options', () => {
  const {spec} = fixture(),
    name = softwareWorkerName(instance, id);
  const mutations = [
    (value) => (value.Image = 'ghcr.io/other/worker:latest'),
    (value) => (value.User = '0:0'),
    (value) => (value.Entrypoint = ['/bin/sh']),
    (value) => (value.Cmd = ['arbitrary-command']),
    (value) => (value.Env = ['TOKEN=not-accepted']),
    (value) => (value.HostConfig.NetworkMode = 'host'),
    (value) => (value.HostConfig.CapAdd = ['SYS_ADMIN']),
    (value) => (value.HostConfig.Privileged = true),
    (value) =>
      (value.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
    (value) => (value.HostConfig.Mounts[0].VolumeOptions.Subpath = 'data'),
    (value) => (value.HostConfig.Mounts[0].Source = 'another-volume'),
    (value) => (value.HostConfig.Mounts[2].ReadOnly = false),
    (value) => (value.HostConfig.Mounts[0].VolumeOptions.NoCopy = false),
    (value) =>
      value.HostConfig.Mounts.push({
        Type: 'bind',
        Source: '/secret',
        Target: '/secret',
      }),
    (value) => (value.Labels['io.lobby-goblin.instance'] = 'd'.repeat(32)),
    (value) => (value.HostConfig.Memory = 16 * 1024 ** 3),
    (value) => (value.HostConfig.Init = false),
  ];
  for (const mutate of mutations) {
    const value = structuredClone(spec);
    mutate(value);
    assert.throws(() => validateSoftwareWorkerCreate(value, name, scope));
  }
  assert.throws(() =>
    validateSoftwareWorkerCreate(spec, name + '-other', scope),
  );
});

test('existing worker inspection refuses changed image, environment, realized mounts and host privileges', () => {
  const {info, image} = fixture();
  for (const mutate of [
    (value) => (value.Image = 'sha256:' + 'f'.repeat(64)),
    (value) => (value.Config.Env = ['NODE_OPTIONS=unreviewed']),
    (value) => (value.Config.User = '0:0'),
    (value) => (value.HostConfig.CapAdd = ['CHOWN']),
    (value) => (value.Mounts[0].Name = 'another-volume'),
    (value) => (value.Mounts[2].RW = true),
    (value) => (value.HostConfig.PidMode = 'host'),
  ]) {
    const changed = structuredClone(info);
    mutate(changed);
    assert.throws(() => validateSoftwareWorkerContainer(changed, scope, image));
  }
  assert.throws(() =>
    validateSoftwareWorkerImage({...image, Id: 'sha256:' + 'e'.repeat(64)}),
  );
});
