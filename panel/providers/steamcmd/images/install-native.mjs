import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSteamProvider} from '../provider.js';

// Invoked only inside a fresh, named acceptance container on an explicitly
// disposable engine. Installs software; never launches a game or opens ports.
assert.equal(process.env.LOBBY_STEAM_INSTALL_ACCEPTANCE, 'disposable');
assert.equal(process.getuid(), 1000);
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'steam-native-install-')),
);
const options = {
  source: {
    application: 'rust',
    appId: '258550',
    platform: 'linux/amd64',
    branches: ['public'],
  },
  software: path.join(root, 'software'),
  control: path.join(root, 'private'),
  requiredFiles: [{path: 'RustDedicated', executable: true}],
  isApplicationEmpty: async () => true,
  isApplicationStopped: async () => true,
};
try {
  const provider = createSteamProvider(options),
    selection = await provider.resolve({channel: 'public'});
  console.log(
    'Resolved dedicated-server build ' +
      selection.softwareVersion +
      '; staging in disposable container.',
  );
  const receipt = await provider.install(selection);
  assert.equal(await provider.installed(receipt), true);
  const offline = createSteamProvider({
    ...options,
    command: async () =>
      assert.fail('A completed installation must restart offline'),
  });
  assert.deepEqual(await offline.install(selection), receipt);
  console.log(
    JSON.stringify({
      passed: true,
      freshInstall: true,
      inventoryVerified: true,
      offlineRestart: true,
      buildId: selection.softwareVersion,
      bytes: receipt.inventory.bytes,
      files: receipt.inventory.files,
      gameProcessStarted: false,
    }),
  );
} catch (error) {
  console.error(error.diagnostic || error.message);
  throw error;
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
