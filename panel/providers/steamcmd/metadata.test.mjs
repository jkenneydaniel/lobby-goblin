import test from 'node:test';
import assert from 'node:assert/strict';
import {
  steamSource,
  steamKeyValues,
  steamBuild,
  steamDiscoveryArguments,
  steamInstallArguments,
  verifySteamManifest,
} from './metadata.js';

const source = {
  application: 'rust',
  appId: '258550',
  platform: 'linux/amd64',
  branches: ['public', 'staging'],
};
const metadata =
  'Steam console log\n"258550"\n{\n"common" {"name" "Rust Dedicated Server"}\n"depots" {\n"258551" {"config" {"oslist" "windows"} "manifests" {"public" {"gid" "99" "size" "100"}}}\n"258552" {"config" {"oslist" "linux" "osarch" "64"} "manifests" {"public" {"gid" "18446744073709551615" "size" "123"}}}\n"branches" {"public" {"buildid" "12345"} "staging" {"buildid" "12346"}}\n}\n}\nSteam>Bye';
const manifest =
  '"AppState"\n{\n"appid" "258550"\n"StateFlags" "4"\n"buildid" "12345"\n"UserConfig" {"BetaKey" "public"}\n"InstalledDepots" {"258552" {"manifest" "18446744073709551615"}}\n}';

test('Steam discovery extracts one exact Linux server build and preserves full-width manifests', () => {
  const result = steamBuild(metadata, source);
  assert.equal(result.selection.source.appId, '258550');
  assert.equal(result.selection.softwareVersion, '12345');
  assert.deepEqual(result.selection.source.depots, [
    {id: '258552', manifest: '18446744073709551615'},
  ]);
  assert.equal(result.bytes, 123);
  assert.ok(Object.isFrozen(result.selection.source));
  assert.equal(
    steamBuild(metadata, source, 'staging').selection.softwareVersion,
    '12346',
  );
});
test('KeyValues bounds and duplicate/unsafe fields fail before metadata is used', () => {
  for (const text of [
    metadata + '\n' + metadata,
    metadata.replace('"common"', '"depots"'),
    metadata.replace('"name"', '"__proto__"'),
    metadata.replace('"Rust Dedicated Server"', '"unterminated'),
    metadata.replace('"depots" {', '"depots" {' + '"nested" {'.repeat(30)),
    metadata.replace('"12345"', '"x'.repeat(65537)),
    'x'.repeat(8 * 1024 ** 2 + 1),
  ])
    assert.throws(() => steamKeyValues(text, '258550'));
  const values = steamKeyValues(
    '"AppState" { // comment\n "path" "C:\\\\directory" "note" "a\\"b" }',
    'AppState',
  );
  assert.equal(values.path, 'C:\\directory');
  assert.equal(values.note, 'a"b');
});
test('discovery refuses unsupported, missing and unresolved Steam content', () => {
  for (const text of [
    metadata.replace('"buildid" "12345"', '"buildid" "public"'),
    metadata.replace(
      '"gid" "18446744073709551615"',
      '"gid" "18446744073709551616"',
    ),
    metadata.replace(
      '"config" {"oslist" "linux" "osarch" "64"}',
      '"depotfromapp" "228980"',
    ),
    metadata.replace(
      '"manifests" {"public" {"gid" "18446744073709551615" "size" "123"}}',
      '"encryptedmanifests" {}',
    ),
    metadata.replace('"size" "123"', '"size" "1099511627777"'),
  ])
    assert.throws(() => steamBuild(text, source));
  assert.throws(() => steamBuild(metadata, source, 'private'));
});
test('Steam commands use fixed argument arrays, anonymous login and an explicit branch', () => {
  assert.deepEqual(steamDiscoveryArguments(source), [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+login',
    'anonymous',
    '+app_info_update',
    '1',
    '+app_info_print',
    '258550',
    '+quit',
  ]);
  const target = steamBuild(metadata, source).selection;
  const args = steamInstallArguments(
    source,
    '/private/staging/a space',
    target,
  );
  assert.equal(
    args[args.indexOf('+force_install_dir') + 1],
    '/private/staging/a space',
  );
  assert.equal(args[args.indexOf('-beta') + 1], 'public');
  assert.equal(args.at(-2), 'validate');
  for (const value of [
    {...source, appId: '258550;bad'},
    {...source, branches: ['+quit']},
    {...source, platform: 'linux/arm64'},
    {...source, password: 'secret'},
  ])
    assert.throws(() => steamSource(value));
  for (const directory of [
    '/',
    '/private/../other',
    '/private/\nmalicious',
    'relative',
  ])
    assert.throws(() => steamInstallArguments(source, directory, target));
  assert.throws(() =>
    steamInstallArguments(
      {...source, application: 'valheim'},
      '/private/staging',
      target,
    ),
  );
});
test('completion metadata must match the reviewed server build, branch and complete depot set', () => {
  const target = steamBuild(metadata, source).selection;
  assert.deepEqual(verifySteamManifest(manifest, target), target);
  for (const text of [
    manifest.replace('"4"', '"6"'),
    manifest.replace('"12345"', '"12346"'),
    manifest.replace('"258550"', '"252490"'),
    manifest.replace('"public"', '"staging"'),
    manifest.replace('"18446744073709551615"', '"18446744073709551614"'),
    manifest.replace('"InstalledDepots"', '"MissingDepots"'),
  ])
    assert.throws(() => verifySteamManifest(text, target));
});
