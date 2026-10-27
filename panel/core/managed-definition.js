import {softwareDelivery, publicSoftwareDelivery} from './software-delivery.js';
import {softwareWorkerDeclaration} from './software-worker-policy.js';
import {runtimeOption, runtimeForImage} from './runtime-option.js';
import {assert} from '../common.js';
import {definitionData, freezeDefinition} from './definition-data.js';
import {serviceOrder} from './application-services.js';
import {isApplicationDefinition} from './application-definition.js';
import {registerManagedBinding} from './managed-bindings.js';
import {
  ensureGameImage,
  validateImagePolicy,
  imageMatch,
} from './image-policy.js';
import {validateManagedGame} from './managed-game.js';
import {
  validateEnvironmentBindings,
  renderEnvironment,
} from './environment-bindings.js';

const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
function declaration(definition) {
  const services = serviceOrder(definition),
    service = services[0];
  assert(
    ((definition.kind === 'game' &&
      service.role === 'game' &&
      service.profile === 'managed-game-v1') ||
      (['application', 'service'].includes(definition.kind) &&
        ['web', 'service', 'worker'].includes(service.role) &&
        service.profile === 'managed-container-v1')) &&
      services.length === 1 &&
      service.id === definition.primary &&
      service.required === true,
    'The compatibility runtime profile needs one managed game service.',
  );
  assert(
    !definition.secrets?.length && !definition.deployment,
    'The game compatibility profile uses its reviewed credential and update adapters.',
  );
  const data = service.configuration;
  definitionData(data);
  assert(
    exact(data, [
      'version',
      'imagePolicy',
      'catalog',
      'storage',
      'ports',
      'helpers',
      'environment',
      'snapshots',
      'secrets',
      'runtimeOption',
      ...(service.profile === 'managed-container-v1' ? ['settings'] : []),
    ]) && data.version === 1,
    'Unsupported managed runtime declaration.',
  );
  assert(
    exact(data.imagePolicy, [
      'version',
      'defaultImage',
      'referencePattern',
      'architecture',
      'labels',
      'captureLabels',
    ]),
    'Unknown runtime image policy field.',
  );
  validateImagePolicy(data.imagePolicy);
  assert(
    data.imagePolicy.architecture === 'amd64',
    'The managed-game-v1 host profile currently requires amd64 images.',
  );
  assert(
    exact(data.storage, ['dataTarget', 'backupDirectory']) &&
      exact(data.catalog, [
        'version',
        'cpu',
        'memoryGiB',
        'creation',
        'snapshotHelp',
      ]) &&
      exact(data.catalog.creation, [
        'minMemoryGiB',
        'maxMemoryGiB',
        'maxPlayers',
        'defaultPlayers',
        'defaults',
        'fields',
        'help',
      ]),
    'Unknown runtime catalogue or storage field.',
  );
  assert(
    exact(data.helpers, [
      'previewWorker',
      'archiveReadPaths',
      'execCommands',
      'softwareWorker',
    ]) &&
      exact(data.environment, ['server', 'controller']) &&
      exact(data.snapshots, ['includesPlayerData']),
    'Unknown runtime helper, environment or snapshot field.',
  );
  assert(
    Array.isArray(data.ports) &&
      data.ports.length > 0 &&
      data.ports.length <= 16 &&
      data.ports.every((port) =>
        exact(port, ['key', 'containerPort', 'protocol', 'offset']),
      ) &&
      Array.isArray(data.helpers.execCommands),
    'Invalid runtime port or helper list.',
  );
  const reserved = new Set([
    'game',
    'name',
    'cpu',
    'memoryGiB',
    'seed',
    'maxPlayers',
    'snapshotId',
    'autoStart',
    'id',
    'container',
    'controller',
    'volume',
    'network',
    'image',
    'software',
    'softwareMode',
    'softwareReceipt',
    'definition',
    'isolationVersion',
    'created',
    'state',
    'controllerToken',
    'rconPassword',
    ...data.ports.map((port) => port.key),
  ]);
  assert(
    (data.catalog.creation.defaults === undefined ||
      (exact(
        data.catalog.creation.defaults,
        Object.keys(data.catalog.creation.defaults),
      ) &&
        Object.entries(data.catalog.creation.defaults).every(
          ([key, value]) =>
            /^[a-z][A-Za-z0-9]*$/.test(key) &&
            !reserved.has(key) &&
            !/password|token|secret/i.test(key) &&
            ['string', 'number', 'boolean'].includes(typeof value),
        ))) &&
      Array.isArray(data.catalog.creation.fields) &&
      data.catalog.creation.fields.every((field) =>
        exact(field, [
          'key',
          'label',
          'control',
          'lockOnClone',
          'min',
          'max',
          'step',
          'default',
        ]),
      ),
    'Runtime defaults cannot override core instance fields.',
  );
  assert(
    data.ports.every((port) =>
      exact(port, ['key', 'containerPort', 'protocol', 'offset']),
    ) &&
      data.helpers.execCommands.every((command) =>
        exact(command, ['executable', 'arguments', 'maxArgumentBytes']),
      ) &&
      (!data.helpers.previewWorker ||
        exact(data.helpers.previewWorker, [
          'target',
          'root',
          'entrypoint',
          'namePrefixes',
          'softwareTarget',
        ])),
    'Unknown runtime port or helper field.',
  );
  assert(
    Array.isArray(data.secrets) &&
      data.secrets.length <= 1 &&
      data.secrets.every((name) => name === 'rconPassword'),
    'The game compatibility profile supports only its private RCON credential.',
  );
  validateEnvironmentBindings(data.environment.server, {secrets: data.secrets});
  validateEnvironmentBindings(data.environment.controller, {
    controllerPrefix: definition.id.replaceAll('-', '_').toUpperCase() + '_',
  });
  return data;
}
function publicFields(item, context = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(item).filter(
        ([name]) => !/password|token|secret/i.test(name),
      ),
    ),
    ...context,
  };
}
// The JSON profile owns policy and environment assembly. Reviewed adapters own
// protocol/storage/snapshot behavior; they cannot overwrite these declarations.
export function compileManagedDefinition(definition, adapter) {
  assert(
    isApplicationDefinition(definition),
    'Register the application definition before compiling its runtime.',
  );
  const data = declaration(definition);
  const software = softwareDelivery(serviceOrder(definition)[0].software);
  assert(
    !(data.runtimeOption && adapter.runtime),
    'Declare one runtime delivery option.',
  );
  const runtime = data.runtimeOption || adapter.runtime;
  if (data.helpers.softwareWorker !== undefined)
    softwareWorkerDeclaration(data.helpers.softwareWorker, definition.id);
  assert(
    exact(adapter, [
      'legacyMigration',
      'creationFromSnapshot',
      'prepareStorage',
      'configureStorage',
      'snapshots',
      'runtime',
    ]),
    'Unknown managed runtime adapter hook.',
  );
  assert(
    exact(adapter.snapshots, ['compatible', 'collect', 'restore']),
    'Unknown snapshot adapter hook.',
  );
  if (runtime) {
    runtimeOption(runtime, {
      application: definition.id,
      baseSoftware: software,
    });
    assert(
      !imageMatch(runtime.imagePolicy, data.imagePolicy.defaultImage) &&
        !imageMatch(data.imagePolicy, runtime.imagePolicy.defaultImage),
      'Runtime choices require separate image references.',
    );
  }
  const metadata = freezeDefinition({
    version: 1,
    software,
    ...(runtime ? {runtime} : {}),
    catalog: {
      ...data.catalog,
      image: data.imagePolicy.defaultImage,
      software: publicSoftwareDelivery(software),
      ...Object.fromEntries(
        data.ports.map((port) => [port.key, port.containerPort]),
      ),
    },
    ...data.storage,
    ports: data.ports,
    ...data.helpers,
  });
  const managed = {
    ...metadata,
    ...(adapter.legacyMigration
      ? {legacyMigration: Object.freeze({...adapter.legacyMigration})}
      : {}),
    ensureImage: async (docker, image) => {
      const resolved = await ensureGameImage(
        docker,
        runtime && imageMatch(runtime.imagePolicy, image)
          ? runtime.imagePolicy
          : data.imagePolicy,
        image,
      );
      if (definition.services[0].profile === 'managed-container-v1')
        assert(
          /^[1-9][0-9]{0,4}:0$/.test(resolved.image.Config?.User || '') &&
            Number(resolved.image.Config.User.split(':')[0]) <= 65535,
          'Container images must use a numeric non-root UID and group 0 for their scoped data claim.',
          409,
        );
      if (definition.services[0].profile === 'managed-container-v1')
        assert(
          Array.isArray(resolved.image.Config?.Healthcheck?.Test) &&
            ['CMD', 'CMD-SHELL'].includes(
              resolved.image.Config.Healthcheck.Test[0],
            ) &&
            resolved.image.Config.Healthcheck.Test.length > 1,
          'Container images must declare a Docker health check.',
          409,
        );
      return resolved;
    },
    creationFromSnapshot: adapter.creationFromSnapshot || ((input) => input),
    gameEnvironment: (item) =>
      renderEnvironment(
        {
          ...data.environment.server,
          ...runtimeForImage(metadata, item)?.environment?.server,
        },
        publicFields(item),
        {
          rconPassword: item.rconPassword,
        },
      ),
    controllerEnvironment: (item, context) =>
      renderEnvironment(
        {
          ...data.environment.controller,
          ...runtimeForImage(metadata, item)?.environment?.controller,
        },
        publicFields(item, context),
        {},
        {controller: true},
      ),
    prepareStorage: adapter.prepareStorage,
    configureStorage: adapter.configureStorage,
    snapshots: Object.freeze({...data.snapshots, ...adapter.snapshots}),
  };
  validateManagedGame({
    id: definition.id,
    name: definition.name,
    imagePolicy: data.imagePolicy,
    contract: {policy: {}},
    managed,
  });
  Object.freeze(managed);
  registerManagedBinding(managed, definition, data.imagePolicy);
  return managed;
}
