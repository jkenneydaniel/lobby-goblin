import {assert} from '../common.js';
import {definitionData, freezeDefinition} from './definition-data.js';
import {validateImagePolicy, imageMatch} from './image-policy.js';
import {softwareDelivery} from './software-delivery.js';
import {validateEnvironmentBindings} from './environment-bindings.js';

// Trusted package metadata only. Requests choose a key, never an image, path,
// environment or privilege. The historical adapter option retains key runtime.
export function runtimeOption(value, {application, baseSoftware} = {}) {
  definitionData(value);
  assert(
    value &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) =>
        [
          'key',
          'label',
          'imagePolicy',
          'software',
          'environment',
          'controllerPrepared',
        ].includes(key),
      ),
    'Invalid runtime delivery option.',
  );
  validateImagePolicy(value.imagePolicy);
  assert(
    softwareDelivery(value.software).mode === 'runtime',
    'Runtime delivery needs a software provider.',
  );
  assert(
    (value.key === undefined ||
      (typeof value.key === 'string' &&
        /^[a-z][a-z0-9-]{0,31}$/.test(value.key))) &&
      (value.key || 'runtime') !== (baseSoftware?.mode || 'image'),
    'Runtime choice must have a distinct bounded key.',
  );
  if (value.label !== undefined)
    assert(
      typeof value.label === 'string' &&
        value.label.length > 0 &&
        value.label.length <= 120 &&
        !/[\x00-\x1f\x7f]/.test(value.label),
      'Invalid runtime choice label.',
    );
  assert(
    value.controllerPrepared === undefined ||
      typeof value.controllerPrepared === 'boolean',
    'Invalid controller preparation policy.',
  );
  if (value.environment !== undefined) {
    assert(
      value.environment &&
        !Array.isArray(value.environment) &&
        Object.keys(value.environment).every((key) =>
          ['server', 'controller'].includes(key),
        ),
      'Invalid runtime environment.',
    );
    validateEnvironmentBindings(value.environment.server || {});
    validateEnvironmentBindings(value.environment.controller || {}, {
      controllerPrefix: application.replaceAll('-', '_').toUpperCase() + '_',
    });
  }
  return freezeDefinition(value);
}

export function selectedRuntime(managed, item) {
  const option = managed.runtime;
  return option && item.softwareMode === (option.key || 'runtime')
    ? option
    : null;
}

// Controller environments are reconstructed from persisted trusted images as
// well as the creation key; a later lifecycle call cannot drop the override.
export function runtimeForImage(managed, item) {
  return managed.runtime && imageMatch(managed.runtime.imagePolicy, item.image)
    ? managed.runtime
    : null;
}
