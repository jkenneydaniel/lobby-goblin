import source from './arena-definition.json' with {type: 'json'};

export function runtimeFixture(controllerPrepared = true) {
  const data = structuredClone(source),
    service = data.services[0];
  service.software = {
    version: 1,
    mode: 'runtime',
    provider: 'old-installer',
    initial: {channel: 'public'},
    storage: 'application-volume',
    updates: 'manual',
  };
  service.configuration.runtimeOption = {
    key: 'managed',
    label: 'Prepare a verified installation',
    controllerPrepared,
    imagePolicy: {
      ...service.configuration.imagePolicy,
      defaultImage: 'registry.example/arena:2-r1',
      referencePattern:
        '^registry\\.example/arena:(?<engine>2)-r(?<revision>[1-9]\\d*)$',
    },
    software: {...service.software, provider: 'steamcmd'},
    environment: {
      controller: {ARENA_INSTALL_ROOT: [{literal: '/instance/data/engine'}]},
      server: {ARENA_MANAGED: [{literal: 'true'}]},
    },
  };
  return data;
}
