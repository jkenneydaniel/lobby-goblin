import {assert} from '../common.js';
import {validId} from './instance.js';
import {imageMatch} from './image-policy.js';
import {validateManagedBinding} from './managed-bindings.js';

// Versioned, trusted built-in adapters. No module path or image comes from a request.
export function validateManagedGame(module) {
  assert(
    module &&
      /^[a-z][a-z0-9-]*$/.test(module.id) &&
      typeof module.name === 'string' &&
      module.name.length > 0,
    'Invalid managed game identity.',
  );
  const managed = module.managed,
    creation = managed?.catalog?.creation;
  assert(managed?.version === 1, 'Unsupported managed-game contract.');
  assert(
    /^\/[A-Za-z0-9_/-]+$/.test(managed.dataTarget) &&
      !managed.dataTarget.includes('..'),
    'Invalid game data target.',
  );
  assert(
    /^[a-z][a-z0-9-]*$/.test(managed.backupDirectory),
    'Invalid game backup directory.',
  );
  for (const key of [
    'ensureImage',
    'creationFromSnapshot',
    'gameEnvironment',
    'controllerEnvironment',
    'prepareStorage',
    'configureStorage',
  ])
    assert(typeof managed[key] === 'function', `Managed game needs ${key}.`);
  assert(
    managed.snapshots &&
      typeof managed.snapshots.includesPlayerData === 'boolean',
    'Managed game needs snapshot metadata.',
  );
  for (const key of ['compatible', 'collect', 'restore'])
    assert(
      typeof managed.snapshots[key] === 'function',
      `Game snapshots need ${key}.`,
    );
  assert(
    Array.isArray(managed.ports) && managed.ports.length > 0,
    'Managed game needs ports.',
  );
  assert(
    new Set(managed.ports.map((port) => port.key)).size ===
      managed.ports.length,
    'Duplicate managed game ports.',
  );
  for (const port of managed.ports)
    assert(
      /^[a-z][A-Za-z0-9]*Port$/.test(port.key) &&
        ['tcp', 'udp'].includes(port.protocol) &&
        Number.isInteger(port.containerPort) &&
        port.containerPort > 0 &&
        port.containerPort < 65536 &&
        Number.isInteger(port.offset) &&
        port.offset >= 0 &&
        port.offset <= 32,
      'Invalid managed game port.',
    );
  assert(
    managed.ports.some((port) => port.key === 'gamePort'),
    'Managed game needs a primary game port.',
  );
  for (const field of ['offset', 'containerPort'])
    assert(
      new Set(managed.ports.map((port) => port.protocol + ':' + port[field]))
        .size === managed.ports.length,
      'Overlapping managed game ports.',
    );
  assert(
    creation &&
      Number.isInteger(creation.minMemoryGiB) &&
      creation.minMemoryGiB >= 1 &&
      Number.isInteger(creation.maxMemoryGiB) &&
      creation.maxMemoryGiB >= creation.minMemoryGiB &&
      Number.isInteger(creation.maxPlayers) &&
      creation.maxPlayers >= 1 &&
      Number.isInteger(creation.defaultPlayers) &&
      creation.defaultPlayers >= 1 &&
      creation.defaultPlayers <= creation.maxPlayers &&
      Array.isArray(creation.fields),
    'Invalid game creation policy.',
  );
  for (const field of creation.fields)
    assert(
      /^[a-z][A-Za-z0-9]*$/.test(field.key) &&
        ![
          'game',
          'name',
          'cpu',
          'memoryGiB',
          'seed',
          'maxPlayers',
          'snapshotId',
          'autoStart',
        ].includes(field.key) &&
        typeof field.label === 'string' &&
        Number.isInteger(field.min) &&
        Number.isInteger(field.max) &&
        field.max >= field.min &&
        Number.isInteger(field.step) &&
        field.step > 0 &&
        Number.isInteger(field.default) &&
        field.default >= field.min &&
        field.default <= field.max &&
        (field.default - field.min) % field.step === 0,
      'Invalid game creation field.',
    );
  assert(
    new Set(creation.fields.map((field) => field.key)).size ===
      creation.fields.length,
    'Duplicate game creation fields.',
  );
  const catalog = managed.catalog;
  assert(
    typeof catalog.version === 'string' &&
      typeof catalog.image === 'string' &&
      catalog.image.length > 0 &&
      !/\s/.test(catalog.image) &&
      Number.isFinite(catalog.cpu) &&
      catalog.cpu >= 0.5 &&
      catalog.cpu <= 8 &&
      catalog.cpu * 2 === Math.round(catalog.cpu * 2) &&
      Number.isInteger(catalog.memoryGiB) &&
      catalog.memoryGiB >= creation.minMemoryGiB &&
      catalog.memoryGiB <= creation.maxMemoryGiB,
    'Invalid game catalogue defaults.',
  );
  for (const port of managed.ports)
    assert(
      catalog[port.key] === port.containerPort,
      'Catalogue port must match its runtime definition.',
    );
  if (managed.legacyMigration)
    for (const key of ['file', 'names'])
      assert(
        typeof managed.legacyMigration[key] === 'function',
        `Legacy migration needs ${key}.`,
      );
  if (managed.previewWorker)
    assert(
      /^\/[A-Za-z0-9_/-]+$/.test(managed.previewWorker.target) &&
        !managed.previewWorker.target.includes('..') &&
        /^state\/[A-Za-z0-9_.-]+$/.test(managed.previewWorker.root) &&
        !['state/.', 'state/..'].includes(managed.previewWorker.root),
      'Invalid game preview worker.',
    );
  if (module.contract?.policy) {
    assert(imageMatch(module.imagePolicy, managed.catalog.image), 'Managed image differs from its game policy.');
    const paths = managed.archiveReadPaths;
    assert(Array.isArray(paths) && paths.length <= 16 && paths.every(value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..')), 'Invalid game archive-read policy.');
    assert(Array.isArray(managed.execCommands) && managed.execCommands.length <= 16 && managed.execCommands.every(value => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.executable) && Number.isInteger(value.arguments) && value.arguments >= 0 && value.arguments <= 16 && Number.isInteger(value.maxArgumentBytes) && value.maxArgumentBytes > 0 && value.maxArgumentBytes <= 65536), 'Invalid game command-helper policy.');
    if (managed.previewWorker) {
      const worker = managed.previewWorker;
      assert(worker.softwareTarget === undefined || /^\/[A-Za-z0-9_/-]+$/.test(worker.softwareTarget) && !worker.softwareTarget.includes('..') && worker.softwareTarget !== worker.target, 'Invalid read-only helper software target.');
      assert(Array.isArray(worker.entrypoint) && worker.entrypoint.length > 0 && worker.entrypoint.length <= 8 && worker.entrypoint.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) && /^\/[A-Za-z0-9_./-]+$/.test(worker.entrypoint[0]) && !worker.entrypoint[0].split('/').includes('..'), 'Invalid game worker entrypoint.');
      assert(Array.isArray(worker.namePrefixes) && worker.namePrefixes.length > 0 && worker.namePrefixes.length <= 8 && worker.namePrefixes.every(value => /^[a-z][a-z0-9-]{0,63}-$/.test(value)), 'Invalid game worker names.');
    }
  }
  validateManagedBinding(module);return managed;
}

export function gameCatalog(module) {
  validateManagedGame(module);
  return {
    id: module.id,
    name: module.name,
    kind: module.definition?.kind || 'game',
    ...(module.managed.runtime?{softwareModes:['image','runtime'],runtimeImage:module.managed.runtime.imagePolicy.defaultImage}:{}),
    ...structuredClone(module.managed.catalog),
  };
}

export function validateManagedCreation(input, module) {
  const game = gameCatalog(module),
    policy = game.creation;
  assert(input.game === module.id, 'Choose a supported game.');
  assert(
    typeof input.name === 'string' &&
      input.name.trim().length >= 1 &&
      input.name.trim().length <= 80 &&
      !/[\x00-\x1f\x7f";\\]/.test(input.name),
    'Use a server name of 1–80 characters without commands or control characters.',
  );
  const cpu = Number(input.cpu ?? game.cpu),
    memoryGiB = Number(input.memoryGiB ?? game.memoryGiB);
  assert(
    Number.isFinite(cpu) &&
      cpu >= 0.5 &&
      cpu <= 8 &&
      cpu * 2 === Math.round(cpu * 2),
    'CPU must be 0.5–8 in half-core steps.',
  );
  assert(
    Number.isInteger(memoryGiB) &&
      memoryGiB >= policy.minMemoryGiB &&
      memoryGiB <= policy.maxMemoryGiB,
    `Choose ${policy.minMemoryGiB}–${policy.maxMemoryGiB} GiB for ${module.name}.`,
  );
  const seed =
    input.seed === '' || input.seed == null ? null : Number(input.seed);
  assert(
    seed === null ||
      (Number.isInteger(seed) && seed >= 1 && seed <= 0xffffffff),
    'Seed must be 1–4294967295, or blank for a new random seed.',
  );
  const maxPlayers = Number(input.maxPlayers ?? policy.defaultPlayers);
  assert(
    Number.isInteger(maxPlayers) &&
      maxPlayers >= 1 &&
      maxPlayers <= policy.maxPlayers,
    'Player limit is outside the supported range.',
  );
  assert(
    input.snapshotId == null ||
      input.snapshotId === '' ||
      validId(input.snapshotId),
    'Invalid snapshot.',
  );
  assert(
    input.autoStart === undefined || typeof input.autoStart === 'boolean',
    'Invalid startup preference.',
  );
  assert(input.softwareMode === undefined || input.softwareMode === (module.managed.software?.mode || 'image') || input.softwareMode === 'runtime' && module.managed.runtime, 'This application does not support that software delivery mode.');
  const fields = {...policy.defaults};
  for (const field of policy.fields) {
    const value = Number(input[field.key] ?? field.default);
    assert(
      Number.isInteger(value) &&
        value >= field.min &&
        value <= field.max &&
        (value - field.min) % field.step === 0,
      `${field.label} must be ${field.min}–${field.max} in steps of ${field.step}.`,
    );
    fields[field.key] = value;
  }
  return {
    game: module.id,
    ...(input.softwareMode?{softwareMode:input.softwareMode}:{}),
    name: input.name.trim(),
    cpu,
    memoryGiB,
    seed,
    ...fields,
    maxPlayers,
    snapshotId: input.snapshotId || null,
    autoStart: input.autoStart !== false,
  };
}
