import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resources} from '../core/instance.js';
import {
  digest,
  fixtureWorkerRequest,
} from '../prototypes/minecraft-java/provider.js';
import {createJavaFixture} from '../prototypes/minecraft-java/fixture.js';
import {
  javaFixtureCatalogue,
  selectJavaFixtureRelease,
  maxFixtureCatalogueBytes,
  maxFixtureCatalogueEntries,
} from '../prototypes/minecraft-java/metadata.js';

const first = Buffer.from('synthetic first artifact, not a game'),
  second = Buffer.from('synthetic second artifact, not a game');
const release = (version, bytes = first) => ({
  format: 1,
  edition: 'java',
  gameVersion: version,
  platform: 'linux/amd64',
  sha256: digest(bytes),
  bytes: bytes.length,
});
const catalogue = () => ({
  format: 1,
  kind: 'minecraft-java-fixture-catalogue',
  releases: [release('fixture-1'), release('fixture-2', second)],
});

test('fixture catalogues select only an exact version and return a private immutable release', () => {
  const input = catalogue(),
    normalized = javaFixtureCatalogue(input),
    selected = selectJavaFixtureRelease(input, 'fixture-2');
  assert.deepEqual(selected, release('fixture-2', second));
  assert.deepEqual(
    selectJavaFixtureRelease(
      {...input, releases: [...input.releases].reverse()},
      'fixture-2',
    ),
    selected,
  );
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.releases));
  assert.ok(Object.isFrozen(selected));
  input.releases[1].sha256 = digest(first);
  input.releases[1].bytes = first.length;
  input.releases.reverse();
  assert.deepEqual(selected, release('fixture-2', second));
  assert.deepEqual(normalized.releases[1], release('fixture-2', second));
  assert.throws(() => {
    selected.sha256 = digest(first);
  }, TypeError);
  for (const version of [
    'latest',
    'stable',
    'public',
    'experimental',
    'missing',
    'FIXTURE-2',
    '',
    null,
    2,
    {},
    'x'.repeat(65),
  ])
    assert.throws(
      () => selectJavaFixtureRelease(catalogue(), version),
      /exact version/,
    );
});

test('metadata budgets apply to the entire already-parsed catalogue', () => {
  const full = catalogue();
  full.releases = Array.from({length: maxFixtureCatalogueEntries}, (_, n) =>
    release('fixture-' + n),
  );
  assert.equal(javaFixtureCatalogue(full).releases.length, 64);
  assert.throws(
    () =>
      javaFixtureCatalogue({
        ...full,
        releases: [...full.releases, release('one-too-many')],
      }),
    /bounded/,
  );
  assert.throws(
    () =>
      javaFixtureCatalogue({
        ...full,
        extra: 'x'.repeat(maxFixtureCatalogueBytes),
      }),
    /metadata budget/,
  );
  for (const releases of [[], null, {}, 'not an array'])
    assert.throws(() => javaFixtureCatalogue({...catalogue(), releases}));
  for (const value of [
    null,
    [],
    JSON.stringify(catalogue()),
    {...catalogue(), format: 2},
    {...catalogue(), kind: 'mojang'},
  ])
    assert.throws(() => javaFixtureCatalogue(value));
});

test('duplicate IDs and invalid unselected entries cannot be hidden behind a valid target', () => {
  for (const duplicate of [
    release('fixture-1'),
    release('fixture-1', second),
  ]) {
    const input = {...catalogue(), releases: [release('fixture-1'), duplicate]};
    assert.throws(
      () => selectJavaFixtureRelease(input, 'fixture-1'),
      /duplicate/,
    );
  }
  for (const change of [
    {edition: 'bedrock'},
    {platform: 'linux/arm64'},
    {sha256: 'bad'},
    {bytes: 0},
    {bytes: 128 * 1024 ** 2 + 1},
    {gameVersion: 'latest'},
    {url: 'https://invalid.example/artifact'},
    {command: 'ignored command'},
    {destination: '/unrelated'},
  ]) {
    const input = catalogue();
    Object.assign(input.releases[1], change);
    assert.throws(() => selectJavaFixtureRelease(input, 'fixture-1'));
  }
  for (const change of [
    {url: 'https://invalid.example/catalogue'},
    {command: 'ignored'},
    {destination: '/unrelated'},
  ])
    assert.throws(() => javaFixtureCatalogue({...catalogue(), ...change}));
});

test('metadata remains data only, without invoking getters or serialization hooks', () => {
  let invoked = 0;
  const getter = catalogue();
  Object.defineProperty(getter, 'releases', {
    enumerable: true,
    get() {
      invoked++;
      return [];
    },
  });
  const nested = catalogue();
  Object.defineProperty(nested.releases[1], 'sha256', {
    enumerable: true,
    get() {
      invoked++;
      return digest(first);
    },
  });
  const hook = {
    ...catalogue(),
    toJSON() {
      invoked++;
      return catalogue();
    },
  };
  const cycle = catalogue();
  cycle.releases.push(cycle);
  const symbol = catalogue();
  symbol[Symbol('hidden')] = 'unsafe';
  const unsafe = JSON.parse(
    '{"format":1,"kind":"minecraft-java-fixture-catalogue","releases":[],"__proto__":{}}',
  );
  const hole = catalogue();
  delete hole.releases[1];
  for (const input of [
    getter,
    nested,
    hook,
    cycle,
    symbol,
    unsafe,
    hole,
    new Map(),
  ])
    assert.throws(() => javaFixtureCatalogue(input));
  assert.equal(invoked, 0);
});

test(
  'catalogue selection reaches preparation without changing an earlier artifact plan',
  {skip: process.platform !== 'linux'},
  async (t) => {
    const input = catalogue(),
      selected = selectJavaFixtureRelease(input, 'fixture-1'),
      scope = {
        fleet: 'a'.repeat(32),
        instance: 'b'.repeat(32),
        volume: resources('a'.repeat(32), 'b'.repeat(32), 'minecraft-java')
          .volume,
      },
      requestId = '11111111-1111-4111-8111-111111111111',
      request = fixtureWorkerRequest(scope, requestId, selected),
      credentials = {minecraftManagement: 'SyntheticOnly'.padEnd(40, 'X')};
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'minecraft-metadata-'),
    );
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const options = {
      root,
      scope,
      release: selected,
      credentials,
      exchange: async () =>
        assert.fail('Preparation cannot contact any transport'),
    };
    const api = await createJavaFixture(options);
    // A refreshed same-version entry cannot silently alter the earlier plan.
    input.releases[0] = release('fixture-1', second);
    const replacement = selectJavaFixtureRelease(input, 'fixture-1');
    assert.notDeepEqual(replacement, selected);
    await assert.rejects(api.prepare(request, second), /differs/);
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal((await api.prepare(request, first)).preparation, 'complete');
    assert.deepEqual(await fs.readFile(path.join(root, 'server.jar')), first);
    assert.equal((await api.inspect()).release.sha256, digest(first));
    const mismatched = await createJavaFixture({
      ...options,
      release: replacement,
    });
    await assert.rejects(mismatched.inspect(), /private binding/);
    const reconstructed = await createJavaFixture(options);
    assert.equal((await reconstructed.inspect()).preparation, 'complete');
  },
);
