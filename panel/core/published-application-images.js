import {registeredApplications} from '../applications/index.js';
import {ensureGameImage} from './image-policy.js';

// Release admission follows the same package provider used for provisioning.
// Legacy Factorio/Rust migration rules do not describe other applications.
export async function verifyPublishedApplicationImages(
  docker,
  {applications = registeredApplications(), additionalPolicies = []} = {},
) {
  const verified = [];
  for (const application of applications) {
    const resolved = await application.managed.ensureImage(
      docker,
      application.imagePolicy.defaultImage,
    );
    verified.push({id: application.id, ...resolved});
  }
  for (const policy of additionalPolicies) {
    const resolved = await ensureGameImage(docker, policy, policy.defaultImage);
    verified.push({id: policy.defaultImage, ...resolved});
  }
  return verified;
}
