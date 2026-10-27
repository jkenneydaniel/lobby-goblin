import test from 'node:test';
import assert from 'node:assert/strict';
import {labels, resources} from '../core/instance.js';
import {
  softwareReservedMemory,
  assertPreparationAdmission,
  assertApplicationStart,
} from '../core/software-worker-resources.js';
import {
  softwareWorkerSpec,
  softwareWorkerScope,
  softwareWorkerName,
  softwareWorkerDeployment,
} from '../core/software-worker-policy.js';
const GiB = 1024 ** 3,
  fleet = 'a'.repeat(32),
  instance = 'b'.repeat(32),
  other = 'c'.repeat(32),
  id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
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
function game(id, running = false) {
  return {
    Name: '/' + resources(fleet, id, 'rust').container,
    Config: {Labels: labels(fleet, id, 'rust')},
    HostConfig: {Memory: 2 * GiB},
    State: {Running: running, Restarting: false},
  };
}
function worker() {
  const scope = softwareWorkerScope({
    fleet,
    instance,
    declaration,
    volume: resources(fleet, instance, 'rust').volume,
  });
  const spec = softwareWorkerSpec(scope, id, 'prepare');
  return {
    Name: '/' + softwareWorkerName(instance, id),
    Image: softwareWorkerDeployment.imageId,
    Config: {Image: spec.Image, Labels: spec.Labels},
    HostConfig: spec.HostConfig,
  };
}
test('only a verified preparation claim borrows its own stopped application reservation', () => {
  const one = game(instance),
    two = game(other),
    claim = worker();
  assert.equal(softwareReservedMemory([one, two], fleet), 4 * GiB);
  assertPreparationAdmission([one, two], claim, fleet);
  assert.equal(softwareReservedMemory([one, two, claim], fleet), 4 * GiB);
  assert.equal(
    softwareReservedMemory(
      [{...one, State: {Running: true}}, two, claim],
      fleet,
    ),
    6 * GiB,
  );
  assert.equal(
    softwareReservedMemory([one, two, {...claim, Image: 'unreviewed'}], fleet),
    6 * GiB,
  );
  assert.equal(
    softwareReservedMemory([one, two, claim, structuredClone(claim)], fleet),
    8 * GiB,
  );
  assert.throws(
    () => assertPreparationAdmission([game(instance, true), two], claim, fleet),
    /Stop/,
  );
  assert.throws(
    () => assertPreparationAdmission([one, two, claim], claim, fleet),
    /existing instance worker/,
  );
});
test('created or exited preparation workers fence application start until explicit cleanup', () => {
  const one = game(instance),
    claim = worker();
  assert.throws(
    () => assertApplicationStart([one, claim], one, fleet),
    /Finish software/,
  );
  assert.throws(
    () =>
      assertApplicationStart(
        [one, {...claim, State: {Running: false}}],
        one,
        fleet,
      ),
    /Finish software/,
  );
  assertApplicationStart([one, claim], game(other), fleet);
  assertApplicationStart([one], one, fleet);
  assert.throws(
    () => assertPreparationAdmission([{...one, State: {}}], claim, fleet),
    /Stop/,
  );
});
