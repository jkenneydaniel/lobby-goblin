import {assert} from '../common.js';
import {validateApplicationPresentation} from './application-presentation.js';
import {validateManagedGame} from './managed-game.js';
import {validateContract} from './game-contract.js';
import {sharedControllerEndpoints} from './routes.js';
import {validateModulePolicy} from './module-policy.js';
import {validateImagePolicy} from './image-policy.js';
import {validateStorageGroups} from './storage/groups.js';
import {validateDefinitionBinding} from './application-definition.js';

/**
 * @typedef {Object} ApplicationModule
 * @property {string} id Stable built-in identifier; never an import path.
 * @property {string} name Display name.
 * @property {Object} contract Versioned capabilities, action/route permissions, screens and backup declaration.
 * @property {string[]} routes Compatibility view derived from contract.routes.
 * @property {(env:Object, options?:Object) => Object} configuration Installation paths and transport settings.
 * @property {(context:Object) => Promise<Object>} createController Lifecycle, actions, status, route handler and backup implementation.
 * @property {(job:Object) => boolean} [discardOnRestart] Rebuildable background jobs that can release their recovery hold at startup.
 * @property {(options:Object) => Object} createUpdater init/refresh/status/plan/install/restored and update state.
 * @property {(options:Object) => Promise<Object>} diagnostics Read-only installation checks.
 * @property {Object} web Assets, accounts, cookie identity and onboarding hooks.
 * @property {Object} [managed] Version 1 provisioning and snapshot adapter.
 * @property {Object} [storage] Version 1 reviewed account record groups and codecs.
 */

// Application packages are trusted installed code. Package selection and route
// exposure stay explicit; environment values never supply an import path.
export function validateApplicationModule(module) {
  assert(module && /^[a-z][a-z0-9-]*$/.test(module.id), 'Invalid application module.');
  if(module.storage){assert(module.storage.version===1,'Unsupported module storage contract.');validateStorageGroups(module.storage.groups);assert(module.storage.groups.every(group=>group.id.startsWith(module.id+'-')&&group.namespace.startsWith(module.id+'-')),'Module storage must use its own namespace.');}
  assert(
    typeof module.name === 'string' && module.name.length > 0,
    'An application module needs a name.',
  );
  for (const key of [
    'configuration',
    'createController',
    'createUpdater',
    'diagnostics',
  ])
    assert(typeof module[key] === 'function', `Game module needs ${key}.`);
  assert(
    module.validateInstallation === undefined ||
      typeof module.validateInstallation === 'function',
    'Invalid installation-validation hook.',
  );
  assert(
    Array.isArray(module.routes) &&
      module.routes.every((route) =>
        /^\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(route),
      ),
    'Invalid game routes.',
  );
  assert(
    new Set(module.routes).size === module.routes.length,
    'Duplicate game routes.',
  );
  if (module.contract?.kind === 'gateway') {
    assert(
      module.contract.version === 1 && module.web?.allowRoute,
      'Invalid gateway contract.',
    );
  } else {
    validateContract(module.contract);
    validateModulePolicy(module);
    if(module.contract.policy)validateImagePolicy(module.imagePolicy);
    assert(
      JSON.stringify([...module.routes].sort()) ===
        JSON.stringify(Object.keys(module.contract.routes).sort()),
      'Module routes differ from its contract.',
    );
    for (const route of module.routes)
      if (sharedControllerEndpoints[route])
        assert(
          JSON.stringify(module.contract.routes[route]) ===
            JSON.stringify(sharedControllerEndpoints[route]),
          'Modules cannot override shared route permissions.',
        );
  }
  assert(
    module.web &&
      typeof module.web.Accounts === 'function' &&
      module.web.assets,
    'Game module needs a web definition.',
  );
  const web = module.web;
  for (const key of [
    'accountExtensions',
    'accountDeletionRecords',
    'deleteAccountData',
    'dispatch',
    'allowRoute',
    'bodyLimit',
    'handleAccount',
  ])
    assert(
      web[key] === undefined || typeof web[key] === 'function',
      `Invalid web ${key} hook.`,
    );
  assert(
    /^[a-z][a-z0-9_]*$/.test(web.sessionCookie || ''),
    'Application web needs a session cookie.',
  );
  assert(
    Array.isArray(web.accountRoutes) &&
      new Set(web.accountRoutes).size === web.accountRoutes.length &&
      web.accountRoutes.every((route) =>
        /^\/api\/[a-z][a-z0-9-]*$/.test(route),
      ),
    'Invalid module account routes.',
  );
  assert(
    !web.accountRoutes.length || typeof web.handleAccount === 'function',
    'Module account routes need a handler.',
  );
  for (const key of ['diagnosticsReport', 'validateOnboarding'])
    assert(typeof web[key] === 'function', `Application web needs ${key}.`);
  assert(!web.publicRoot || web.publicRoot instanceof URL && web.publicRoot.protocol==='file:' && web.publicRoot.pathname.endsWith('/'), 'Application assets require a local public directory.');
  for (const asset of Object.values(web.assets))
    assert(
      Array.isArray(asset) &&
        asset.length === 2 &&
        typeof asset[0] === 'string' &&
        !asset[0].startsWith('/') &&
        !asset[0].split('/').includes('..') &&
        typeof asset[1] === 'string',
      'Invalid module web asset.',
    );
  if (module.contract?.kind !== 'gateway') {
    const expected = Object.entries(module.contract.routes)
      .filter(([, methods]) => methods.GET === 'admin')
      .map(([route]) => route)
      .filter((route) => route !== '/download')
      .sort();
    assert(
      JSON.stringify([...(web.adminReadRoutes || [])].sort()) ===
        JSON.stringify(expected),
      'Module read permissions differ from its contract.',
    );
  }
  validateApplicationPresentation(module);
  validateDefinitionBinding(module);
  if (module.managed) validateManagedGame(module);
  return module;
}
