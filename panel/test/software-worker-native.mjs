// Single-file fixture mounted in fresh CI containers. Imports use the tested
// management image, never a checkout, daemon socket or credentials in the worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {startDockerBroker} from '/app/core/docker-broker.js';
import {docker} from '/app/core/docker.js';
import {
  brokerClient,
  brokerSocket,
  brokerToken,
} from '/app/core/broker-client.js';
import {registeredApplications} from '/app/applications/index.js';
import {resources} from '/app/core/instance.js';
import {SoftwareWorkers} from '/app/core/software-workers.js';
import {createSteamProvider} from '/app/providers/steamcmd/provider.js';
import {softwareWorkerDeployment as deployment} from '/app/core/software-worker-policy.js';

assert.equal(process.env.SOFTWARE_WORKER_ACCEPTANCE, 'disposable');
assert.equal(process.getuid(), 0);
assert.equal(process.getgid(), 0);
const fleet = process.env.FLEET_ID,
  instance = process.env.FLEET_INSTANCE;
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
const mode = process.argv[2];
if (mode === 'broker') {
  assert.equal(process.env.DOCKER_BROKER_SOCKET, undefined);
  const modules = registeredApplications().map((module) =>
    module.id === 'rust'
      ? {...module, managed: {...module.managed, softwareWorker: declaration}}
      : module,
  );
  await startDockerBroker({
    env: process.env,
    runtimeImage: process.env.ACCEPTANCE_RUNTIME,
    modules,
    docker: async (method, route, ...args) => {
      const result = await docker(method, route, ...args);
      // Prove admission on a constrained budget without reducing real CI RAM.
      return method === 'GET' && route === '/info'
        ? {...result, MemTotal: 6 * 1024 ** 3}
        : result;
    },
  });
} else if (mode === 'initialize') {
  assert.deepEqual(await fs.readdir('/instance'), []);
  await fs.mkdir('/instance/data');
  await fs.writeFile(
    '/instance/data/copied-world.sav',
    'disposable sentinel only; no game world',
  );
} else {
  assert.equal(process.env.DOCKER_SOCKET, undefined);
  const client = brokerClient({
    socketPath: brokerSocket,
    tokenFile: brokerToken,
  });
  if (mode === 'grant') {
    await client.grant({id: instance, game: 'rust'});
  } else {
    assert.equal(mode, 'controller');
    const owned = resources(fleet, instance, 'rust'),
      helper = new SoftwareWorkers({
        docker: client.docker,
        env: process.env,
        declaration,
      });
    const selected = await helper.run('resolve', {channel: 'public'});
    assert.equal(await fs.stat(helper.paths.software).catch(() => null), null);
    assert.equal(
      (await client.docker('GET', '/containers/' + owned.container + '/json'))
        .State.Running,
      true,
    );
    let refused;
    try {
      await helper.run('prepare', selected, {confirm: true});
    } catch (error) {
      assert.match(error.message, /Stop the application|Stop the allocated/);
      refused = error.workerRequestId;
    }
    assert.ok(
      refused,
      'Preparation must not automatically stop the application',
    );
    await helper.close(await helper.inspect(refused), {
      confirm: true,
      offline: true,
    });
    // Only this newly created idle Node fixture is stopped. No game runs here.
    await client.docker(
      'POST',
      '/containers/' + owned.container + '/stop?t=30',
    );
    let startupFenced = false,
      inspectedMounts = false;
    const prepared = await helper.run('prepare', selected, {
      confirm: true,
      progress: async (value) => {
        if (value.phase === 'created') {
          await assert.rejects(
            client.docker('POST', '/containers/' + owned.container + '/start'),
            /preparation/,
          );
          startupFenced = true;
          const worker = (await helper.inspect(value.id)).worker;
          const info = await client.docker(
            'GET',
            '/containers/' + worker.id + '/json',
          );
          assert.equal(info.Image, deployment.imageId);
          assert.equal(info.Config.User, '1000:0');
          assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
          assert.deepEqual(info.HostConfig.CapAdd || [], []);
          assert.deepEqual(
            info.HostConfig.Mounts.map((mount) => mount.Target),
            ['/software', '/control', '/request', '/result'],
          );
          assert.ok(
            info.HostConfig.Mounts.every(
              (mount) =>
                mount.Type === 'volume' && mount.Source === owned.volume,
            ),
          );
          inspectedMounts = true;
        }
      },
    });
    assert.equal(
      (await fs.stat(helper.paths.control + '/installation.json')).uid,
      1000,
    );
    assert.equal(
      await fs.stat(helper.paths.control + '/active.json').catch(() => null),
      null,
    );
    const original = await fs.readFile('/instance/data/copied-world.sav');
    const provider = createSteamProvider({
      source: declaration.source,
      requiredFiles: declaration.requiredFiles,
      software: helper.paths.software,
      control: helper.paths.control,
      isApplicationEmpty: async () =>
        (await fs.readdir('/instance/data')).length === 0,
      isApplicationStopped: async () =>
        (await client.docker('GET', '/containers/' + owned.container + '/json'))
          .State.Running === false,
      command: async () =>
        assert.fail('Controller verification must be offline'),
    });
    await assert.rejects(
      provider.activate(prepared, {confirm: true}),
      /adoption or recovery/,
    );
    assert.deepEqual(
      await fs.readFile('/instance/data/copied-world.sav'),
      original,
    );
    await fs.mkdir('/instance/held-fixture');
    await fs.rename(
      '/instance/data/copied-world.sav',
      '/instance/held-fixture/copied-world.sav',
    );
    const receipt = await provider.activate(prepared, {confirm: true});
    assert.equal(await provider.installed(receipt), true);
    const controllerRecord = await fs.stat(
      helper.paths.control + '/installation.json',
    );
    assert.equal(controllerRecord.uid, 0);
    assert.equal(controllerRecord.mode & 0o777, 0o600);
    await fs.rename(
      '/instance/held-fixture/copied-world.sav',
      '/instance/data/copied-world.sav',
    );
    // A new real UID 1000 worker must read controller-owned 0600 activation
    // records through the helper's narrow GID 0 normalization and reuse cache.
    const cached = await helper.run('prepare', selected, {confirm: true});
    assert.deepEqual(cached.receipt, receipt);
    assert.deepEqual(await provider.activate(cached, {confirm: true}), receipt);
    assert.deepEqual(
      await fs.readFile('/instance/data/copied-world.sav'),
      original,
    );
    assert.equal((await helper.workers()).length, 0);
    assert.ok(startupFenced && inspectedMounts);
    console.log(
      JSON.stringify({
        passed: true,
        buildId: selected.softwareVersion,
        files: receipt.inventory.files,
        bytes: receipt.inventory.bytes,
        publishedWorker: deployment.image,
        workerUid: 1000,
        workerGid: 0,
        privateMountsVerified: true,
        startupFenced,
        constrainedAdmission: true,
        controllerActivation: true,
        rootToWorkerRecordBridge: true,
        cachedPreparation: true,
        fixtureDataUnchanged: true,
        gameProcessStarted: false,
      }),
    );
  }
}
