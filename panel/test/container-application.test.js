import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {containerFixture} from './container-application-fixture.js';
import {selectedApplication} from '../applications/index.js';
import {definitionFor} from '../applications/registry.js';
import {createContainerApplication} from '../core/container-application.js';
import {applicationDefinition} from '../core/application-definition.js';
import {publishSnapshot, cloneSnapshot} from '../fleet/snapshots.js';
import {runWorker} from '../fleet/worker.js';

test('a data-only package uses real shared provisioning, controller, settings, backups and snapshot cloning', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'container-app-')),
  );
  const f = await containerFixture(root);
  t.after(async () => {
    await f.close();
    await fs.rm(root, {recursive: true, force: true});
  });
  assert.deepEqual(f.module.web.assets, {});
  assert.equal(f.module.web.publicRoot, undefined);
  const base = 'http://127.0.0.1:' + f.controller.address().port;
  const request = async (route, body) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer test-controller-token',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {status: response.status, value: await response.json()};
  };
  const job = async (action, params = {}) => {
    const queued = await request('/jobs', {action, params});
    assert.equal(queued.status, 202, JSON.stringify(queued.value));
    for (let n = 0; n < 100; n++) {
      const state = (await request('/jobs')).value;
      const result = state.jobs.find((item) => item.id === queued.value.id);
      if (['succeeded', 'failed'].includes(result.state) && !state.active)
        return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Job did not settle.');
  };
  const settings = (await request('/settings')).value;
  assert.equal(
    (
      await job('save-settings', {
        values: {title: 'Changed page', message: 'Persistent'},
        revision: settings.revision,
      })
    ).state,
    'succeeded',
  );
  assert.equal(
    (
      await job('save-settings', {
        values: settings.values,
        revision: settings.revision,
      })
    ).state,
    'failed',
  );
  assert.equal((await job('start')).state, 'succeeded');
  assert.equal((await request('/status')).value.ready, true);
  assert.equal(
    (
      await job('save-settings', {
        values: settings.values,
        revision: (await request('/settings')).value.revision,
      })
    ).state,
    'failed',
  );
  assert.equal((await job('backup')).state, 'failed');
  assert.equal((await job('stop', {confirm: true})).state, 'succeeded');
  await fs.mkdir(path.join(f.instance, 'data/nested'));
  await fs.writeFile(
    path.join(f.instance, 'data/nested/sentinel.txt'),
    'preserved application data',
  );
  const backup = await job('backup');
  assert.equal(backup.state, 'succeeded');
  const archive = path.join(
    f.instance,
    'backups/archives',
    backup.result.match(/([A-Za-z0-9_.-]+\.zip)$/)[1],
  );
  const library = path.join(root, 'snapshots');
  await fs.mkdir(library);
  const id = 'c'.repeat(32),
    image = f.module.imagePolicy.defaultImage;
  const published = await publishSnapshot({
    library,
    backup: archive,
    record: {id, sourceId: 'b'.repeat(32), game: 'status-page', image},
    module: f.module,
  });
  const clone = path.join(root, 'clone');
  await fs.mkdir(clone);
  await runWorker(
    {
      action: 'provision',
      fleet: 'a'.repeat(32),
      id: 'd'.repeat(32),
      game: 'status-page',
      controllerToken: 'fresh-token',
      snapshotId: id,
      snapshotHash: published.manifestSha256,
      image,
    },
    {instance: clone, library},
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(clone, 'data/settings.json'), 'utf8'),
    ).title,
    'Changed page',
  );
  assert.equal(
    (await fs.stat(path.join(clone, 'data/nested/sentinel.txt'))).mode & 0o777,
    0o660,
  );
  assert.equal(
    await fs.readFile(path.join(clone, 'data/nested/sentinel.txt'), 'utf8'),
    'preserved application data',
  );
  assert.equal(
    await fs.readFile(path.join(clone, 'control/controller-token'), 'utf8'),
    'fresh-token',
  );
  await assert.rejects(
    cloneSnapshot({
      library,
      id,
      hash: published.manifestSha256,
      data: path.join(root, 'bad'),
      game: 'status-page',
      image: image.replace('lg.1', 'lg.2'),
      module: f.module,
    }),
    /compatible/,
  );
  const config = f.module.configuration(f.env);
  await f.module.validateInstallation(config);
  await fs.writeFile(
    path.join(config.state, 'application-definition.json'),
    JSON.stringify({id: 'status-page', revision: 2}),
  );
  await assert.rejects(f.module.validateInstallation(config), /differ/);
  const ctx = {
    config,
    host: {info: async () => ({State: {Running: false}})},
    docker: () => {},
    env: {},
  };
  const controller = await f.module.createController(ctx);
  assert.throws(() =>
    controller.validateBackup(Buffer.from('invalid archive')),
  );
  f.unavailable = true;
  assert.equal((await request('/status')).value.ready, false);
  assert.equal((await job('backup')).state, 'failed');
});

test('container profile refuses privilege hooks, settings drift and unsupported service graphs', () => {
  for (const mutate of [
    (source) => {
      source.services.push({
        ...source.services[0],
        id: 'queue',
        role: 'worker',
      });
    },
    (source) => {
      source.services[0].configuration.helpers.execCommands = [
        {executable: 'sh', arguments: 1, maxArgumentBytes: 100},
      ];
    },
    (source) => {
      source.services[0].configuration.settings.file = '../secret.json';
    },
    (source) => {
      source.presentation.screens.find(
        (screen) => screen.component === 'settings',
      ).options.fields = [];
    },
  ]) {
    const source = structuredClone(definitionFor('status-page'));
    mutate(source);
    assert.throws(() =>
      createContainerApplication(applicationDefinition(source)),
    );
  }
  assert.ok(selectedApplication('factorio').managed.legacyMigration);
});

test('the container provider admits only digest-pinned non-root images with its scoped data group', async () => {
  const module = selectedApplication('status-page'),
    policy = module.imagePolicy;
  const value = {
    Id: 'sha256:' + 'a'.repeat(64),
    Os: 'linux',
    Architecture: 'amd64',
    RepoDigests: ['ghcr.io/jkenneydaniel/status-page@sha256:' + 'b'.repeat(64)],
    Config: {
      User: '1000:0',
      Healthcheck: {Test: ['CMD', 'health-check']},
      Labels: {...policy.labels, 'io.lobby-goblin.image-revision': '1'},
    },
  };
  const docker = async () => value;
  assert.match(
    (await module.managed.ensureImage(docker, policy.defaultImage)).reference,
    /@sha256:/,
  );
  for (const user of ['0:0', 'node', '1000:1000', '65536:0']) {
    value.Config.User = user;
    await assert.rejects(
      module.managed.ensureImage(docker, policy.defaultImage),
      /non-root/,
    );
  }
  value.Config.User = '1000:0';
  value.Config.Healthcheck.Test = ['NONE'];
  await assert.rejects(
    module.managed.ensureImage(docker, policy.defaultImage),
    /health check/,
  );
  value.Config.Healthcheck.Test = ['CMD', 'health-check'];
  value.RepoDigests = [];
  await assert.rejects(
    module.managed.ensureImage(docker, policy.defaultImage),
    /Publish/,
  );
});
