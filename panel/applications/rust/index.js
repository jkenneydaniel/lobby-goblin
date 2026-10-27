import {definition} from './definition.js';
import {applicationMetadata} from '../../core/application-services.js';
const presentation = definition.presentation,
  imagePolicy = definition.services[0].configuration.imagePolicy;
import {contract} from './contract.js';
import path from 'node:path';
import {ownedImage, legacyImage} from '../../core/game-images.js';
import fs from 'node:fs/promises';
import {assert, HttpError} from '../../common.js';
import {Accounts} from '../../core/accounts.js';
import {createRust} from './controller.js';
import {managed} from './managed.js';
import {imageMatch} from '../../core/image-policy.js';
import {readRecord} from '../../providers/steamcmd/files.js';

export function rustConfiguration(env, {migrationBootstrap = false} = {}) {
  const instance = env.RUST_INSTANCE_ID;
  assert(
    /^[a-f0-9]{32}$/.test(instance || ''),
    'Prepare a separate Rust installation before selecting the Rust module.',
  );
  assert(
    env.RUST_CONTAINER === `lobby-goblin-rust-${instance}`,
    'Rust container name must match its installation ID.',
  );
  assert(
    ownedImage('rust', env.RUST_IMAGE) ||
      (migrationBootstrap && legacyImage('rust', env.RUST_IMAGE)),
    'Rust requires a Lobby Goblin rust-server image. Legacy images are accepted only by the migration bootstrap.',
  );
  assert(
    path.isAbsolute(env.RUST_HOST_DATA || ''),
    'Rust requires its dedicated host data path.',
  );
  const data = path.resolve(env.RUST_DATA || '/rust-server'),
    state = path.resolve(env.RUST_STATE_DIR || '/rust-state'),
    backups = path.resolve(env.RUST_BACKUPS_DIR || '/rust-backups');
  const softwareManaged = !!imageMatch(
    managed.runtime?.imagePolicy,
    env.RUST_IMAGE,
  );
  assert(
    softwareManaged === (env.RUST_SOFTWARE_MODE === 'managed'),
    'Rust image and software delivery mode must agree.',
    409,
  );
  if (softwareManaged)
    assert(
      env.FLEET_ID &&
        env.FLEET_VOLUME &&
        env.RUST_DATA === '/instance/data/server' &&
        env.RUST_INSTALL_ROOT === '/instance/data/engine' &&
        env.RUST_STATE_DIR === '/instance/state',
      'Managed Rust requires its dedicated fleet storage.',
      409,
    );
  const roots = [data, state, backups];
  assert(
    roots.every(
      (root) =>
        root !== '/' && !['/factorio', '/backups', '/state'].includes(root),
    ) &&
      roots.every((root, i) =>
        roots.every(
          (other, j) =>
            i === j || (root !== other && !root.startsWith(other + '/')),
        ),
      ),
    'Rust data, backups and controller state require separate dedicated directories.',
  );
  return {
    managedVolume: env.FLEET_VOLUME || null,
    fleet: env.FLEET_ID || null,
    restartPolicy: env.FLEET_RESTART_POLICY || 'unless-stopped',
    instance,
    container: env.RUST_CONTAINER,
    image: env.RUST_IMAGE,
    softwareManaged,
    hostData: path.resolve(env.RUST_HOST_DATA),
    installRoot: env.RUST_INSTALL_ROOT
      ? path.resolve(env.RUST_INSTALL_ROOT)
      : null,
    identity: 'lobby-goblin-rust',
    data,
    state,
    backups,
    library: path.join(state, 'unused-library'),
    backupDir: path.join(backups, 'archives'),
    rconPort: 28016,
    passwordFile:
      env.RUST_RCON_PASSWORD_FILE || '/run/secrets/rust_rcon_password',
  };
}
export async function validateInstallation(config) {
  for (const root of [
    ...(config.softwareManaged ? [] : [config.data]),
    config.state,
    config.backups,
  ]) {
    assert(
      (await fs.realpath(root)) === root,
      'Rust storage cannot use symbolic links.',
    );
    const marker = JSON.parse(
      await fs.readFile(path.join(root, '.lobby-goblin-rust.json'), 'utf8'),
    );
    assert(
      marker.game === 'rust' && marker.instance === config.instance,
      'Rust storage belongs to a different installation.',
      409,
    );
  }
  if (config.softwareManaged) {
    const instance = path.dirname(path.dirname(config.data)),
      data = path.dirname(config.data);
    assert(
      (await fs.realpath(data)) === data,
      'Managed Rust data root cannot be linked.',
      409,
    );
    const owner = await readRecord(path.join(instance, '.fleet-owner.json'), {
      max: 4096,
    });
    assert(
      owner.fleet === config.fleet &&
        owner.id === config.instance &&
        owner.game === 'rust',
      'Managed Rust volume belongs to another instance.',
      409,
    );
    const world = await fs.lstat(config.data).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (world)
      assert(
        world.isDirectory() &&
          !world.isSymbolicLink() &&
          (await fs.realpath(config.data)) === config.data,
        'Rust world storage cannot be linked.',
        409,
      );
    else {
      const pending = await readRecord(
        path.join(config.state, 'software/rust/installation.json'),
        {max: 65536},
      );
      assert(
        pending.instance === config.instance &&
          pending.phase !== 'complete' &&
          /^[a-f0-9-]{36}$/.test(pending.id || ''),
        'Missing Rust world storage requires installation recovery.',
        409,
      );
    }
  }
}
function updater({current}) {
  const status = () => ({
    current,
    busy: false,
    jobs: [],
    pendingRestore: null,
    supported: false,
    message:
      'Rust updates are managed separately. The Factorio updater is unavailable for this installation.',
  });
  const unavailable = async () => {
    throw new HttpError(
      409,
      'Rust updates are managed separately; this installation cannot run the Factorio updater.',
    );
  };
  return {
    current,
    jobs: [],
    busy: false,
    pendingRestore: null,
    init: async () => {},
    refresh: async () => status(),
    status,
    plan: unavailable,
    install: unavailable,
    restored: async () => {},
  };
}
export const rust = {
  definition,
  application: applicationMetadata(definition),
  presentation,
  contract,
  imagePolicy,
  managed,
  id: 'rust',
  name: 'Rust',
  releaseRepository: 'jkenneydaniel/lobby-goblin',
  stopTimeout: -1,
  routes: Object.keys(contract.routes),
  configuration: rustConfiguration,
  validateInstallation,
  createController: createRust,
  createUpdater: updater,
  diagnostics: async () => ({
    game: 'rust',
    checks: [],
    message: 'Inspect Rust status and logs for readiness.',
  }),
  web: {
    Accounts,
    sessionCookie: 'rust_session',
    accountRoutes: [],
    extensions: {
      'rust.mods': {
        version: 1,
        script: '/rust/mods-capability.js',
        template: '/rust/mods.html',
      },
    },
    adminReadRoutes: Object.entries(contract.routes)
      .filter(([, methods]) => methods.GET === 'admin')
      .map(([route]) => route),
    publicRoot: new URL('./public/', import.meta.url),
    assets: {
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/rust/mods-capability.js': [
        'rust/mods-capability.js',
        'text/javascript; charset=utf-8',
      ],
      '/rust/mods-page.js': [
        'rust/mods-page.js',
        'text/javascript; charset=utf-8',
      ],
      '/rust/mods.html': ['rust/mods.html', 'text/html; charset=utf-8'],
      '/rust/style.css': ['rust/style.css', 'text/css; charset=utf-8'],
      '/style.css': ['rust/style.css', 'text/css; charset=utf-8'],
    },
    diagnosticsReport: (version, controller) => ({version, controller}),
    validateOnboarding: (value) =>
      assert(value.ready, 'Wait for Rust to become ready.', 409),
  },
};
export default rust;
