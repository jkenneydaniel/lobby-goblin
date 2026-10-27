import {definition} from './definition.js';
const presentation = definition.presentation;
import {presentationScreens} from '../../core/application-presentation.js';
import {
  action,
  backupActions,
  modActions,
  modRoutes,
} from '../../core/game-contract.js';

export const contract = {
  version: 2,
  screens: presentationScreens(presentation),
  policy: {
    version: 1,
    permissions: {
      'application.factorio.map.view':
        'Factorio: View saved maps, terrain thumbnails and live player positions',
      'application.factorio.map.generate':
        'Factorio: Generate a saved map preview',
      'application.factorio.map.configure':
        'Factorio: Configure automatic saved map refresh',
      'application.factorio.map.pins':
        'Factorio: Add and remove shared map pins',
      'application.factorio.map.tracking':
        'Factorio: Enable or disable live player tracking',
    },
    routes: {
      '/mod-library': {GET: 'mods.manage'},
      '/mod-library-plan': {POST: 'mods.manage'},
      '/mod-library-account': {POST: null},
      '/worlds': {GET: 'server.view'},
      '/settings': {GET: 'settings.read'},
      '/players': {GET: 'server.view'},
      '/logs': {GET: 'logs.read'},
      '/preview': {GET: 'application.factorio.map.view'},
      '/upload': {POST: 'worlds.manage'},
      '/map': {GET: 'application.factorio.map.view'},
      '/map-status': {GET: 'application.factorio.map.view'},
      '/map-settings': {POST: 'application.factorio.map.configure'},
      '/live-players': {GET: 'application.factorio.map.view'},
      '/pins': {POST: 'application.factorio.map.pins'},
      '/world-options': {GET: 'worlds.manage'},
      '/world-preview': {GET: 'worlds.manage', POST: 'worlds.manage'},
      '/world-preview-image': {GET: 'worlds.manage'},
    },
  },
  features: {
    worlds: true,
    map: true,
    players: true,
    settings: true,
    mods: true,
    backups: true,
    scheduledBackups: true,
    updates: true,
  },
  backup: {
    strategy: 'files',
    extension: '.zip',
    mediaType: 'application/zip',
    interruption: false,
  },
  actions: {
    ...backupActions(),
    'software-update': action('Install Factorio software', true, 'manual', 'images.change'),
    'software-recover': action('Recover software update', true, 'manual', 'images.change'),
    ...modActions,
    start: action('Start server', false, 'convergent', 'server.operate'),
    stop: action('Save and stop server', true, 'convergent', 'server.operate'),
    restart: action('Restart server', true, 'manual', 'server.operate'),
    save: action('Save world', false, 'manual', 'server.operate'),
    'live-tracking': action(
      'Configure live tracking',
      false,
      'manual',
      'application.factorio.map.tracking',
    ),
    'refresh-map': action(
      'Refresh saved map',
      false,
      'manual',
      'application.factorio.map.generate',
    ),
    switch: action('Switch active world', true, 'manual', 'worlds.manage'),
    restore: action('Restore backup', true, 'manual', 'backups.restore'),
    create: action('Create world', false, 'manual', 'worlds.manage'),
    'world-options': action(
      'Copy world settings',
      false,
      'manual',
      'worlds.manage',
    ),
    settings: action('Save server settings', true, 'manual', 'settings.write'),
    player: action('Manage player', false, 'manual', 'players.manage'),
    announce: action('Send announcement', false, 'manual', 'server.operate'),
    console: action(
      'Run supported administrative command',
      false,
      'manual',
      'console.execute',
    ),
  },
  routes: {
    ...modRoutes,
    '/worlds': {GET: 'viewer'},
    '/settings': {GET: 'viewer'},
    '/players': {GET: 'viewer'},
    '/logs': {GET: 'viewer'},
    '/download': {GET: 'admin'},
    '/preview': {GET: 'viewer'},
    '/upload': {POST: 'admin'},
    '/map': {GET: 'viewer'},
    '/map-status': {GET: 'viewer'},
    '/map-settings': {POST: 'admin'},
    '/live-players': {GET: 'viewer'},
    '/pins': {POST: 'admin'},
    '/world-options': {GET: 'admin'},
    '/world-preview': {GET: 'admin', POST: 'admin'},
    '/world-preview-image': {GET: 'admin'},
  },
};
