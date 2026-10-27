import {requireServerPermission} from '../../core/permissions.js';
import {Accounts} from './accounts.js';
import {requireAdmin} from '../../auth.js';
import {assert, json, requestJSON, HttpError} from '../../common.js';
import {diagnosticsReport} from '../../diagnostics.js';
import {contract} from './contract.js';

export const web = {
  Accounts,
  sessionCookie: 'factorio_session',
  accountExtensions: (accounts, scope) => ({
    worldSetups: (username, body) =>
      Accounts.prototype.worldSetups.call(accounts, username, body, scope),
  }),
  accountDeletionRecords: (accounts, user, snapshot) =>
    Accounts.prototype.deletionRecords.call(accounts, user, snapshot),
  deleteAccountData: (accounts, user, snapshot) =>
    Accounts.prototype.onDelete.call(accounts, user, snapshot),
  accountRoutes: ['/api/world-setups'],
  extensions: Object.fromEntries(
    ['worlds', 'map', 'setup', 'updates'].map((id) => [
      'factorio.' + id,
      {
        version: 1,
        script: '/factorio/capabilities.js',
        template: '/factorio/' + id + '.html',
      },
    ]),
  ),
  adminReadRoutes: Object.entries(contract.routes)
    .filter(
      ([route, methods]) => methods.GET === 'admin' && route !== '/download',
    )
    .map(([route]) => route),
  publicRoot: new URL('./public/', import.meta.url),
  assets: {
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/factorio/capabilities.html': [
      'factorio/capabilities.html',
      'text/html; charset=utf-8',
    ],
    '/factorio/capabilities.js': [
      'factorio/capabilities.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/map-screen.js': [
      'factorio/map-screen.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/map-views.js': [
      'factorio/map-views.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/map.html': ['factorio/map.html', 'text/html; charset=utf-8'],
    '/factorio/settings-views.js': [
      'factorio/settings-views.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/setup.html': ['factorio/setup.html', 'text/html; charset=utf-8'],
    '/factorio/ui-views.js': [
      'factorio/ui-views.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/updates.html': [
      'factorio/updates.html',
      'text/html; charset=utf-8',
    ],
    '/factorio/updates.js': [
      'factorio/updates.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/world-editor-views.js': [
      'factorio/world-editor-views.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/worlds-screen.js': [
      'factorio/worlds-screen.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/worlds-views.js': [
      'factorio/worlds-views.js',
      'text/javascript; charset=utf-8',
    ],
    '/factorio/worlds.html': [
      'factorio/worlds.html',
      'text/html; charset=utf-8',
    ],
    '/game-images.js': ['game-images.js', 'text/javascript; charset=utf-8'],
    '/game-update.js': ['game-update.js', 'text/javascript; charset=utf-8'],
    '/map.js': ['map.js', 'text/javascript; charset=utf-8'],
    '/map-spatial.js': ['map-spatial.js', 'text/javascript; charset=utf-8'],
    '/onboarding.js': ['onboarding.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/world-editor.js': ['world-editor.js', 'text/javascript; charset=utf-8'],
    '/world-fields.js': ['world-fields.js', 'text/javascript; charset=utf-8'],
    '/world-preview.js': ['world-preview.js', 'text/javascript; charset=utf-8'],
  },
  diagnosticsReport,
  bodyLimit: (route) => (route === '/upload' ? 128 * 1024 * 1024 : 1024 * 1024),
  validateOnboarding(value) {
    assert(
      value.ready &&
        value.currentWorld &&
        value.saveVerified &&
        !value.activeJob,
      'Wait for a ready game and a confirmed completed save before finishing setup.',
      409,
    );
  },
  async handleAccount(
    req,
    res,
    url,
    {user, accounts, requireNoUpdate, accessScope},
  ) {
    if (user.role === 'member')
      requireServerPermission(user, accessScope, 'GET', '/world-options', {
        module: {contract},
      });
    else requireAdmin(user);
    assert(['GET', 'POST'].includes(req.method), 'Not found.', 404);
    if (req.method === 'POST') await requireNoUpdate();
    const body = req.method === 'POST' ? await requestJSON(req) : undefined;
    try {
      return json(res, 200, await accounts.worldSetups(user.username, body));
    } catch (error) {
      if (error.status) throw error;
      throw new HttpError(
        503,
        'Saved setups could not be accessed. Check the panel account storage permissions on the host, then try again.',
      );
    }
  },
};
