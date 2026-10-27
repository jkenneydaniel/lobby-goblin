import {definition} from './definition.js';
const presentation = definition.presentation;
import {presentationScreens} from '../../core/application-presentation.js';
import {
  action,
  backupActions,
  modActions,
  modRoutes,
} from '../../core/game-contract.js';

const frameworkPermission = [
  'mods.manage',
  'application.rust.framework.manage',
];
const softwarePermission = ['images.change', 'server.operate'];
const moddedSoftwarePermission = [
  ...softwarePermission,
  ...frameworkPermission,
];
const pluginPermission = ['mods.manage', 'application.rust.plugins.manage'];
const configurationPermission = [
  'mods.manage',
  'application.rust.plugins.configure',
];

export const contract = {
  version: 2,
  screens: presentationScreens(presentation),
  policy: {
    version: 1,
    permissions: {
      'application.rust.framework.manage':
        'Rust: Install and recover frameworks (also requires executable mods)',
      'application.rust.plugins.manage':
        'Rust: Install, remove and reload plugins (also requires executable mods)',
      'application.rust.plugins.configure':
        'Rust: Read and change plugin configuration (also requires executable mods)',
    },
    routes: {
      '/mod-library': {GET: pluginPermission},
      '/mod-library-plan': {POST: pluginPermission},
      '/mod-library-account': {POST: null},
      '/players': {GET: 'server.view'},
      '/logs': {GET: 'logs.read'},
      '/settings': {GET: 'settings.read'},
      '/software': {GET: 'images.change'},
      '/software-updates': {GET: 'images.change'},
      '/software-change': {GET: 'images.change'},
      '/mods': {GET: 'mods.manage'},
      '/mods-plan': {POST: frameworkPermission},
      '/framework-change': {GET: frameworkPermission},
      '/plugin-config': {GET: configurationPermission},
    },
  },
  features: {
    worlds: false,
    map: false,
    players: true,
    settings: true,
    mods: true,
    backups: true,
    scheduledBackups: true,
    updates: false,
  },
  backup: {
    strategy: 'stream',
    extension: '.tar.gz',
    mediaType: 'application/gzip',
    interruption: true,
  },
  actions: {
    ...backupActions(true),
    ...Object.fromEntries(
      Object.entries(modActions).map(([name, policy]) => [
        name,
        {...policy, permission: pluginPermission},
      ]),
    ),
    'software-check': action(
      'Check exact Steam build',
      false,
      'manual',
      'images.change',
    ),
    'software-check-modded': action(
      'Review Steam and framework updates',
      false,
      'manual',
      ['images.change', ...frameworkPermission],
    ),
    'software-update': action(
      'Install reviewed Steam build',
      true,
      'manual',
      softwarePermission,
    ),
    'software-update-modded': action(
      'Install reviewed modded Steam build',
      true,
      'manual',
      moddedSoftwarePermission,
    ),
    'software-recover-modded': action(
      'Recover modded software and world',
      true,
      'manual',
      ['images.change', ...frameworkPermission],
    ),
    'software-recover': action(
      'Recover software installation and paired world',
      false,
      'manual',
      'images.change',
    ),
    'software-cancel': action(
      'Cancel private software preparation',
      false,
      'manual',
      'images.change',
    ),
    start: action('Start server', false, 'convergent', 'server.operate'),
    stop: action('Save and stop server', true, 'convergent', 'server.operate'),
    restart: action('Restart server', true, 'manual', 'server.operate'),
    'install-framework': action(
      'Install reviewed framework',
      true,
      'manual',
      frameworkPermission,
    ),
    'recover-framework': action(
      'Recover framework',
      true,
      'manual',
      frameworkPermission,
    ),
    plugin: action('Manage plugin', true, 'manual', pluginPermission),
    'plugin-config': action(
      'Save plugin configuration',
      false,
      'manual',
      configurationPermission,
    ),
    'save-settings': action(
      'Save stopped server settings',
      false,
      'manual',
      'settings.write',
    ),
  },
  routes: {
    ...modRoutes,
    '/players': {GET: 'viewer'},
    '/logs': {GET: 'admin'},
    '/settings': {GET: 'admin'},
    '/software': {GET: 'admin'},
    '/software-updates': {GET: 'admin'},
    '/software-change': {GET: 'admin'},
    '/mods': {GET: 'admin'},
    '/mods-plan': {POST: 'admin'},
    '/framework-change': {GET: 'admin'},
    '/plugin-config': {GET: 'admin'},
  },
};
