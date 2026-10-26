import {registeredDefinitions} from './registry.js';

// Reviewed game metadata, kept independent of runtime adapter initialization.
// Registering another game never changes the shared image validator.
export const imagePolicies = Object.freeze(
  Object.fromEntries(
    registeredDefinitions()
      .filter((definition) =>
        definition.services.some((service) =>
          ['managed-game-v1', 'managed-container-v1'].includes(service.profile),
        ),
      )
      .map((definition) => [
        definition.id,
        definition.services.find((service) => service.id === definition.primary)
          .configuration.imagePolicy,
      ]),
  ),
);
