import fs from 'node:fs/promises';
import path from 'node:path';
import {selectedApplication} from '../applications/index.js';
import {runWorker} from '../fleet/worker.js';
import {startController} from '../core/controller.js';
import {startWeb} from '../core/web.js';
import {hashPassword} from '../auth.js';
import {writeJSON} from '../common.js';
export async function containerFixture(root, {webPort = 0} = {}) {
  const module = selectedApplication('status-page'),
    instance = path.join(root, 'instance');
  await fs.mkdir(instance);
  await runWorker(
    {
      action: 'provision',
      fleet: 'a'.repeat(32),
      id: 'b'.repeat(32),
      game: module.id,
      controllerToken: 'test-controller-token',
      name: 'Fixture',
    },
    {instance},
  );
  const auth = path.join(root, 'auth');
  await fs.mkdir(auth);
  await writeJSON(path.join(auth, 'users.json'), {
    Owner: {...hashPassword('container-preview-password'), role: 'admin'},
    Read: {
      ...hashPassword('container-preview-password'),
      role: 'member',
      grants: {
        standalone: [
          'server.view',
          'settings.read',
          'logs.read',
          'backups.read',
        ],
      },
    },
  });
  const env = {
    STATUS_PAGE_ROOT: instance,
    STATUS_PAGE_CONTAINER: 'disposable-status-page',
    AUTH_DIR: auth,
    CONTROLLER_TOKEN_FILE: path.join(instance, 'control/controller-token'),
    PANEL_HOSTS: '127.0.0.1',
    RELEASE_CHECKS: 'false',
  };
  let running = false,
    health = 'healthy',
    unavailable = false;
  const calls = [];
  const docker = async (method, route) => {
    calls.push({method, route});
    if (unavailable) throw Error('Fixture engine is unavailable.');
    if (route.endsWith('/json'))
      return {State: {Running: running, Health: {Status: health}}};
    if (route.endsWith('/start')) {
      running = true;
      return null;
    }
    if (route.includes('/stop')) {
      running = false;
      return null;
    }
    if (route.includes('/logs?'))
      return Buffer.from('Status page fixture logs.');
    if (route.includes('/stats?')) return {};
    throw Error('Unexpected fixture Docker call: ' + method + ' ' + route);
  };
  const controller = await startController(module, {
    env,
    docker,
    hostname: '127.0.0.1',
    port: 0,
  });
  const web = await startWeb(module, {
    env: {
      ...env,
      CONTROLLER_URL: 'http://127.0.0.1:' + controller.address().port,
    },
    hostname: '127.0.0.1',
    port: webPort,
  });
  return {
    module,
    instance,
    env,
    calls,
    controller,
    web,
    get running() {
      return running;
    },
    set health(value) {
      health = value;
    },
    set unavailable(value) {
      unavailable = value;
    },
    async close() {
      for (const server of [web, controller]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
