import path from 'node:path';
import {assert} from '../../common.js';
import {createGuardedModStore} from '../../core/guarded-mod-store.js';
import {frameworks} from './mod-packages.js';

// Only the reviewed managed layout routes mutable files away from sealed code.
// The mount root is controller-owned; descendants belong to the game and must
// be traversed through pinned directory descriptors for every operation.
export function createRustModStores(config) {
  if (!config.softwareManaged) return null;
  const anchor = path.dirname(config.data);
  assert(
    config.installRoot === path.join(anchor, 'engine') &&
      config.data === path.join(anchor, 'server') &&
      /^[A-Za-z0-9_-]{1,80}$/.test(config.identity),
    'Managed Rust mod data differs from its declared storage.',
    409,
  );
  const stores = new Map();
  for (const [framework, definition] of Object.entries(frameworks)) {
    for (const kind of ['plugins', 'configs']) {
      const directory = definition[kind];
      stores.set(
        directory,
        createGuardedModStore(
          anchor,
          'server/' +
            config.identity +
            '/mods/' +
            framework +
            '/' +
            directory.split('/')[1],
          {
            accept:
              kind === 'plugins'
                ? (name) =>
                    /^[A-Za-z][A-Za-z0-9_]{0,79}\.cs(?:\.disabled)?$/.test(name)
                : (name) =>
                    /^[A-Za-z][A-Za-z0-9_. -]{0,99}\.json$/.test(name) &&
                    !name.includes('..'),
            maxFileBytes: 512 * 1024,
          },
        ),
      );
    }
  }
  return stores;
}
