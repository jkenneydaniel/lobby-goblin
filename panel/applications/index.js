import {registeredDefinitions} from './registry.js';
import {assert} from '../common.js';
import {validateApplicationModule} from '../core/application-module.js';
import {createContainerApplication} from '../core/container-application.js';

const modules = new Map();
for (const definition of registeredDefinitions()) {
  // The profile is checked installed data. Generic packages need no executable
  // adapter; unsupported profiles retain the explicit reviewed module path.
  const module = definition.services.every(
    (service) => service.profile === 'managed-container-v1',
  )
    ? createContainerApplication(definition)
    : (await import('./' + definition.id + '/index.js')).default;
  validateApplicationModule(module);
  assert(
    module.definition === definition,
    'Application adapter must use its registered package definition.',
  );
  modules.set(definition.id, module);
}
export const registeredApplications = () =>
  [...modules.values()].map(validateApplicationModule);
export function selectedApplication(id = 'factorio') {
  const module = modules.get(id);
  if (!module) throw new Error('Unsupported application: ' + id);
  return validateApplicationModule(module);
}
