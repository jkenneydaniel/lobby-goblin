import {assert} from '../common.js';

// Reviewed UI hints are separate from fingerprinted runtime definitions. They
// neither configure a listener nor grant access to an application's public port.
const descriptors = Object.freeze({
  'status-page': Object.freeze({webProtocol: 'http'}),
});

export function fleetPresentation(module) {
  if (!Object.hasOwn(descriptors, module?.id)) return {};
  const descriptor = descriptors[module.id];
  assert(
    ['http', 'https'].includes(descriptor.webProtocol) &&
      module.definition?.kind === 'application' &&
      module.definition.services.find(
        (service) => service.id === module.definition.primary,
      )?.role === 'web' &&
      module.managed?.ports.some(
        (port) => port.key === 'gamePort' && port.protocol === 'tcp',
      ),
    'Invalid fleet web presentation declaration.',
  );
  return {...descriptor};
}
