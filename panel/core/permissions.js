import {assert} from '../common.js';

// Existing administrator/read-only accounts retain their installation-wide scope.
// Delegated members start with no access and receive explicit server assignments.
import {permissionCatalog, validPermissionName} from './permission-catalog.js';
export {permissionCatalog} from './permission-catalog.js';
export const permissionCatalogFor = (module) => ({
  ...permissionCatalog,
  ...module?.contract?.policy?.permissions,
});
export const validScope = (value) =>
  value === 'standalone' ||
  (typeof value === 'string' &&
    /^(?:\/hosts\/[a-f0-9]{32})?\/servers\/[a-f0-9]{32}$/.test(value));
export function normalizeGrants(
  value,
  catalog = permissionCatalog,
  previous = {},
) {
  assert(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 64,
    'Choose at most 64 server assignments.',
  );
  const result = {};
  for (const [scope, permissions] of Object.entries(value)) {
    assert(
      validScope(scope) &&
        Array.isArray(permissions) &&
        permissions.length <= 128,
      'Invalid server assignment.',
    );
    assert(
      permissions.every(
        (permission) =>
          typeof permission === 'string' &&
          (Object.hasOwn(catalog, permission) ||
            (validPermissionName(permission) &&
              Array.isArray(previous[scope]) &&
              previous[scope].includes(permission))),
      ),
      'Unknown server permission.',
    );
    const unique = [...new Set(permissions)].sort();
    assert(
      !unique.length || unique.includes('server.view'),
      'Server assignments must include viewing access.',
    );
    if (unique.length) result[scope] = unique;
  }
  return result;
}
export const assignedPermissions = (
  user,
  scope,
  catalog = permissionCatalog,
) =>
  user?.role === 'member' &&
  validScope(scope) &&
  Object.hasOwn(user.grants || {}, scope) &&
  Array.isArray(user.grants[scope])
    ? user.grants[scope].filter((permission) =>
        Object.hasOwn(catalog, permission),
      )
    : [];
export const hasAssignment = (user, scope) =>
  user?.role !== 'member' ||
  assignedPermissions(user, scope).includes('server.view');
export function requireAssignment(user, scope) {
  assert(hasAssignment(user, scope), 'Server not found.', 404);
}
export function requireServerPermission(user, scope, method, route, options) {
  requireAssignment(user, scope);
  const permission = routePermission(method, route, options);
  const catalog = permissionCatalogFor(options?.module);
  assert(
    permissionGranted(permission, assignedPermissions(user, scope, catalog)),
    'This account does not have permission for this server action.',
    403,
  );
}
// A package can narrow a shared permission with additional explicit grants.
// Arrays always mean all permissions are required; null remains admin-only.
const permissionGranted = (required, granted) =>
  typeof required === 'string'
    ? granted.includes(required)
    : Array.isArray(required) &&
      required.length > 0 &&
      required.every(
        (permission) =>
          typeof permission === 'string' && granted.includes(permission),
      );
export function routePermission(method, route, {module, action, kind} = {}) {
  const contract = module?.contract;
  if (!contract?.policy) return null;
  if (method === 'POST' && route === '/jobs')
    return Object.hasOwn(contract.actions, action)
      ? contract.actions[action].permission
      : null;
  const shared = {
    GET: {
      '/status': 'server.view',
      '/capabilities': 'server.view',
      '/jobs': 'server.view',
      '/backups': 'backups.read',
      '/application-releases': 'images.change',
      '/update-status': 'images.change',
    },
    POST: {
      '/schedule': 'backups.schedule',
      '/backup-retention': 'backups.cleanup',
      '/update-plan': 'images.change',
      '/update-install': 'images.change',
    },
  };
  if (method === 'GET' && route === '/download')
    // The shared controller handles only explicit backup downloads. Factorio's
    // historical handler treats every other kind (including an omitted kind)
    // as a world download; authorization must use the same default.
    return kind === 'backup' ? 'backups.download' : 'worlds.download';
  if (Object.hasOwn(shared[method] || {}, route)) return shared[method][route];
  return contract.policy.routes?.[route]?.[method] ?? null;
}
export function publicAccess(user, scope, module) {
  if (user.role !== 'member') return {};
  const permissions = assignedPermissions(
    user,
    scope,
    permissionCatalogFor(module),
  );
  const actions = module?.contract?.policy ? module.contract.actions : {};
  return {
    permissions,
    allowedActions: Object.keys(actions).filter((action) =>
      permissionGranted(actions[action].permission, permissions),
    ),
  };
}
