import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredApplications} from '../applications/index.js';
import {runtimeImagePolicy} from '../applications/factorio/runtime.js';
import {imageMatch} from '../core/image-policy.js';
import {verifyPublishedApplicationImages} from '../core/published-application-images.js';

function fixture() {
  const images = new Map();
  for (const policy of [
    ...registeredApplications().map((module) => module.imagePolicy),
    runtimeImagePolicy,
  ]) {
    const reference = policy.defaultImage,
      match = imageMatch(policy, reference);
    const repository = reference.slice(0, reference.lastIndexOf(':'));
    images.set(reference, {
      Id: 'sha256:' + 'a'.repeat(64),
      Os: 'linux',
      Architecture: policy.architecture,
      RepoDigests: [repository + '@sha256:' + 'b'.repeat(64)],
      Config: {
        User: '1000:0',
        Healthcheck: {Test: ['CMD', 'health-check']},
        Labels: {
          ...policy.labels,
          ...Object.fromEntries(
            Object.entries(policy.captureLabels).map(([key, capture]) => [
              key,
              match.groups[capture],
            ]),
          ),
        },
      },
    });
  }
  const calls = [];
  const docker = async (method, route) => {
    assert.equal(method, 'GET');
    assert.match(route, /^\/images\/.+\/json$/);
    const reference = decodeURIComponent(
      route.slice('/images/'.length, -'/json'.length),
    );
    calls.push(reference);
    assert.ok(images.has(reference));
    return images.get(reference);
  };
  return {images, calls, docker};
}
test('release admission accepts all package defaults and retains the extra Factorio runtime gate', async () => {
  const {calls, docker} = fixture();
  const images = await verifyPublishedApplicationImages(docker, {
    additionalPolicies: [runtimeImagePolicy],
  });
  assert.deepEqual(
    images.map((image) => image.id),
    ['factorio', 'rust', 'status-page', runtimeImagePolicy.defaultImage],
  );
  assert.deepEqual(calls, [
    ...registeredApplications().map(
      (module) => module.imagePolicy.defaultImage,
    ),
    runtimeImagePolicy.defaultImage,
  ]);
  assert.ok(
    images.every((image) =>
      image.reference.endsWith('@sha256:' + 'b'.repeat(64)),
    ),
  );
});
test('release admission retains each provider contract rather than weakening validation for new applications', async () => {
  for (const mutation of [
    (image) => {
      image.Config.Labels['io.lobby-goblin.image-revision'] = '999';
    },
    (image) => {
      image.Config.User = '0:0';
    },
    (image) => {
      image.Config.Healthcheck.Test = ['NONE'];
    },
    (image) => {
      image.RepoDigests = [];
    },
  ]) {
    const {images, docker} = fixture();
    mutation(
      images.get(
        registeredApplications().find((module) => module.id === 'status-page')
          .imagePolicy.defaultImage,
      ),
    );
    await assert.rejects(
      verifyPublishedApplicationImages(docker),
      /contract|non-root|health check|Publish/,
    );
  }
});
