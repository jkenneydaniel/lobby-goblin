import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeOption, selectedRuntime} from '../core/runtime-option.js';
import {gameCatalog, validateManagedCreation} from '../core/managed-game.js';
import {registeredApplications} from '../applications/index.js';
import {arena} from './fixtures/arena-game.js';
import source from './fixtures/arena-definition.json' with {type: 'json'};
import {runtimeFixture} from './fixtures/runtime-choice.js';

test('named software choices preserve the old runtime meaning and apply only to their reviewed image', () => {
  const module = arena('/unused', {runtimeDefinition: runtimeFixture()}),
    managed = module.managed;
  const catalog = gameCatalog(module);
  assert.deepEqual(catalog.softwareModes, ['runtime', 'managed']);
  assert.equal(catalog.defaultSoftwareMode, 'runtime');
  assert.equal(catalog.runtimeKey, 'managed');
  assert.equal(selectedRuntime(managed, {softwareMode: 'runtime'}), null);
  assert.equal(selectedRuntime(managed, {}), null);
  assert.equal(
    selectedRuntime(managed, {softwareMode: 'managed'}),
    managed.runtime,
  );
  assert.equal(
    validateManagedCreation(
      {game: 'arena', name: 'Fixture', softwareMode: 'runtime'},
      module,
    ).softwareMode,
    'runtime',
  );
  assert.throws(
    () =>
      validateManagedCreation(
        {game: 'arena', name: 'Fixture', softwareMode: 'image'},
        module,
      ),
    /delivery mode/,
  );
  const item = {
    id: 'a'.repeat(32),
    container: 'fixture',
    gamePort: 7777,
    tickRate: 20,
  };
  const legacy = managed.controllerEnvironment({
    ...item,
    image: managed.catalog.image,
  });
  assert.equal(legacy.ARENA_INSTALL_ROOT, undefined);
  const current = {
    ...item,
    image:
      managed.runtime.imagePolicy.defaultImage + '@sha256:' + 'a'.repeat(64),
  };
  assert.equal(
    managed.controllerEnvironment(current).ARENA_INSTALL_ROOT,
    '/instance/data/engine',
  );
  assert.equal(managed.gameEnvironment(current).ARENA_MANAGED, 'true');
  assert.equal(
    managed.gameEnvironment({...item, image: managed.catalog.image})
      .ARENA_MANAGED,
    undefined,
  );
});

test('choice metadata rejects collisions, management controls, paths, secrets and unknown hooks', () => {
  for (const change of [
    (option) => {
      option.key = 'runtime';
    },
    (option) => {
      option.key = '../managed';
    },
    (option) => {
      option.key = 1;
    },
    (option) => {
      option.environment.controller.DOCKER_HOST = [{literal: 'tcp://other'}];
    },
    (option) => {
      option.environment.controller.ARENA_PATH = [{literal: '/production'}];
    },
    (option) => {
      option.environment.controller.ARENA_SECRET = [{secret: 'rconPassword'}];
    },
    (option) => {
      option.environment.controller.OTHER_PATH = [{literal: '/instance/data'}];
    },
    (option) => {
      option.controllerPrepared = 'true';
    },
    (option) => {
      option.command = 'run';
    },
    (option) => {
      option.imagePolicy = structuredClone(
        source.services[0].configuration.imagePolicy,
      );
    },
  ]) {
    const data = runtimeFixture();
    change(data.services[0].configuration.runtimeOption);
    assert.throws(() => arena('/unused', {runtimeDefinition: data}));
  }
  const option = runtimeFixture().services[0].configuration.runtimeOption;
  assert.ok(
    Object.isFrozen(
      runtimeOption(option, {
        application: 'arena',
        baseSoftware: {mode: 'runtime'},
      }),
    ),
  );
});

test('existing built-in choices and environments keep their prior contract', () => {
  const modules = registeredApplications();
  const factorio = modules.find((value) => value.id === 'factorio');
  assert.deepEqual(gameCatalog(factorio).softwareModes, ['image', 'runtime']);
  assert.equal(gameCatalog(factorio).runtimeKey, undefined);
  const rust = modules.find((value) => value.id === 'rust');
  assert.deepEqual(gameCatalog(rust).softwareModes, ['runtime', 'managed']);
  assert.equal(gameCatalog(rust).defaultSoftwareMode, 'runtime');
  assert.equal(selectedRuntime(rust.managed, {softwareMode: 'runtime'}), null);
});
