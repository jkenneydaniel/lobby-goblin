import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import metadata from './image.json' with {type: 'json'};
import {steamBuild, steamDiscoveryArguments} from '../metadata.js';

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
const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public'],
};
try {
  const output = run([
    'run',
    '--rm',
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
} finally {
  try {
    run(['rm', '-f', name]);
  } catch {}
}
