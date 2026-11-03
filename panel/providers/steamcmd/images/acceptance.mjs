import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sharedImages,
  imageContext,
} from '../../../core/application-image-build.js';
import metadata from './image.json' with {type: 'json'};
import {steamBuild, steamDiscoveryArguments} from '../metadata.js';
import {bootstrapFailureSummary} from '../bootstrap-diagnostics.js';

const run = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8 * 1024 ** 2,
  });
const engine = JSON.parse(run(['info', '--format', '{{json .ID}}']));
assert.ok(
  process.env.GITHUB_ACTIONS === 'true' ||
    process.env.LOBBY_DISPOSABLE_ENGINE_ID === engine,
  'An explicit disposable engine is required.',
);
const image = metadata.repository + ':' + metadata.tag;
const info = JSON.parse(run(['image', 'inspect', image]))[0];
assert.equal(info.Config.User, '1000:1000');
assert.equal(info.Architecture, 'amd64');
assert.equal(info.Config.Labels['io.lobby-goblin.provider'], 'steamcmd');
const name = 'lobby-steam-metadata-' + crypto.randomBytes(16).toString('hex');
const installer = name + '-install';
const networkProbe = name + '-network';
const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public'],
};
async function reportBootstrapFailure() {
  try {
    const container = JSON.parse(run(['inspect', name]))[0];
    assert.equal(container.Config.Labels['io.lobby-goblin.acceptance'], 'steamcmd');
    assert.equal(container.Name, '/' + name);
    // Docker emits a tar archive. Bound both transfer and extraction in memory;
    // never materialize an unbounded container log on the runner filesystem.
    const archive = execFileSync('docker', ['cp', container.Id + ':/home/node/Steam/logs/bootstrap_log.txt', '-'], {
      timeout: 15000, maxBuffer: 300 * 1024,
    });
    const log = execFileSync('tar', ['--extract', '--to-stdout', '--file', '-'], {
      input: archive, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
    });
    console.error('SteamCMD bootstrap diagnostic: ' + JSON.stringify(bootstrapFailureSummary(log)));
  } catch {
    console.error('SteamCMD bootstrap diagnostic unavailable.');
  }
}
async function reportBootstrapNetwork() {
  try {
    const script = await fs.readFile(new URL('./bootstrap-network-probe.mjs', import.meta.url), 'utf8');
    const result = execFileSync('docker', ['run', '--rm', '--name', networkProbe,
      '--label', 'io.lobby-goblin.acceptance=steamcmd', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1',
      '--pids-limit', '64', '--entrypoint', 'node', image, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 20000, maxBuffer: 8192,
    });
    console.error('SteamCMD manifest network diagnostic: ' + result.trim());
  } catch {
    console.error('SteamCMD manifest network diagnostic unavailable.');
  }
}
try {
  const output = run([
    'run',
    '--name',
    name,
    '--label',
    'io.lobby-goblin.acceptance=steamcmd',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    '1g',
    '--cpus',
    '2',
    image,
    ...steamDiscoveryArguments(source),
  ]);
  const result = steamBuild(output, source);
  assert.ok(result.selection.source.depots.length > 0);
  console.log(
    JSON.stringify({
      passed: true,
      image,
      user: info.Config.User,
      appId: source.appId,
      buildId: result.selection.softwareVersion,
      depots: result.selection.source.depots.length,
      dedicatedServerMetadata: true,
      gameFilesDownloaded: false,
    }),
  );
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const project = fileURLToPath(new URL('../../../../', import.meta.url));
    const worker = (await sharedImages(project)).find(
      (recipe) => recipe.id === 'worker',
    );
    await imageContext(worker, async (context) => {
      // The dependency's software-only acceptance needs provider code, not the
      // checkout or its CI credentials. Reuse the same closed worker runtime.
      const root = path.join(context, 'runtime'),
        fixtures = path.join(root, 'panel/providers/steamcmd/images');
      await fs.mkdir(fixtures, {recursive: true});
      await fs.copyFile(
        fileURLToPath(new URL('./install-native.mjs', import.meta.url)),
        path.join(fixtures, 'install-native.mjs'),
      );
      console.log(
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--init',
            '--name',
            installer,
            '--label',
            'io.lobby-goblin.acceptance=steamcmd',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges:true',
            '--memory',
            '2g',
            '--cpus',
            '2',
            '--mount',
            'type=bind,source=' + root + ',target=/source,readonly',
            '-e',
            'LOBBY_STEAM_INSTALL_ACCEPTANCE=disposable',
            '--entrypoint',
            'node',
            image,
            '/source/panel/providers/steamcmd/images/install-native.mjs',
          ],
          {encoding: 'utf8', timeout: 2400000, maxBuffer: 8 * 1024 ** 2},
        ),
      );
    });
  }
} catch (error) {
  try {
    await reportBootstrapFailure();
  } catch {
    console.error('SteamCMD bootstrap diagnostic unavailable.');
  }
  await reportBootstrapNetwork();
  throw error;
} finally {
  try {
    run(['rm', '-f', networkProbe]);
  } catch {}
  try {
    run(['rm', '-f', installer]);
  } catch {}
  try {
    run(['rm', '-f', name]);
  } catch {}
}
