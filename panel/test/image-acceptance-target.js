import assert from 'node:assert/strict';
import {ownedImages} from '../core/game-images.js';
import {imagePolicies} from '../applications/image-policies.js';
import {imageMatch} from '../core/image-policy.js';

// Local native acceptance may test an unpublished build, but must bind its
// reviewed package reference to the exact image produced by that build.
export function acceptanceTarget(game, env = process.env) {
  const target = env.ACCEPTANCE_TARGET_IMAGE || ownedImages[game];
  const expectedId = env.ACCEPTANCE_TARGET_ID;
  assert.ok(
    imageMatch(imagePolicies[game], target),
    'Unreviewed acceptance image',
  );
  if (env.ACCEPTANCE_TARGET_IMAGE || expectedId)
    assert.match(
      expectedId || '',
      /^sha256:[a-f0-9]{64}$/,
      'Select an immutable build ID',
    );
  return {target, expectedId};
}
export function validateAcceptanceImage(game, target, expectedId, image) {
  const policy = imagePolicies[game],
    match = imageMatch(policy, target);
  assert.ok(match, 'Unreviewed acceptance image');
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  if (expectedId)
    assert.equal(image.Id, expectedId, 'The selected build changed');
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, policy.architecture);
  for (const [key, value] of Object.entries(policy.labels))
    assert.equal(image.Config?.Labels?.[key], value);
  for (const [key, capture] of Object.entries(policy.captureLabels))
    assert.equal(image.Config?.Labels?.[key], match.groups[capture]);
}
