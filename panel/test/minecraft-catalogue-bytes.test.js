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
  parseJavaFixtureCatalogue,
  selectJavaFixtureRelease,
  maxFixtureCatalogueBytes,
  maxFixtureCatalogueDepth,
} from '../prototypes/minecraft-java/metadata.js';

const artifact = Buffer.from('synthetic bytes only, never a game');
const release = (gameVersion = 'fixture-1', bytes = artifact) => ({
  format: 1,
  edition: 'java',
  gameVersion,
  platform: 'linux/amd64',
  sha256: digest(bytes),
  bytes: bytes.length,
});
const catalogue = () => ({
  format: 1,
  kind: 'minecraft-java-fixture-catalogue',
  releases: [release(), release('fixture-2')],
});
const encode = (value = catalogue()) => Buffer.from(JSON.stringify(value));

test('raw fixture JSON accepts ordinary ordering, whitespace, escapes and repeated fields in separate objects', () => {
  const input = catalogue();
  const text = JSON.stringify(
    {
      releases: input.releases.map((x) => ({
        bytes: x.bytes,
        sha256: x.sha256,
        platform: x.platform,
        gameVersion: x.gameVersion,
        edition: x.edition,
        format: x.format,
      })),
      kind: input.kind,
      format: input.format,
    },
    null,
    2,
  )
    .replace('"kind"', '"k\\u0069nd"')
    .replace('"fixture-1"', '"fixture-\\u0031"');
  const parsed = parseJavaFixtureCatalogue(
    Buffer.from(' \r\n\t' + text + '\n'),
  );
  assert.deepEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.releases));
  assert.ok(Object.isFrozen(parsed.releases[0]));
});

test('raw metadata budget includes whitespace and is applied before decoding', () => {
  const raw = encode();
  const boundary = Buffer.concat([
    Buffer.alloc(maxFixtureCatalogueBytes - raw.length, 32),
    raw,
  ]);
  assert.deepEqual(parseJavaFixtureCatalogue(boundary), catalogue());
  for (const bytes of [
    Buffer.concat([boundary, Buffer.from(' ')]),
    Buffer.alloc(maxFixtureCatalogueBytes + 1, 255),
  ])
    assert.throws(
      () => parseJavaFixtureCatalogue(bytes),
      (e) => e.status === 413 && /metadata budget/.test(e.message),
    );
  const unicode = JSON.stringify({
    ...catalogue(),
    extra: 'é'.repeat(maxFixtureCatalogueBytes / 2),
  });
  assert.ok(unicode.length < maxFixtureCatalogueBytes);
  assert.ok(Buffer.byteLength(unicode) > maxFixtureCatalogueBytes);
  assert.throws(
    () => parseJavaFixtureCatalogue(Buffer.from(unicode)),
    /metadata budget/,
  );
});

test('catalogue decoding takes bytes only without invoking length accessors', () => {
  for (const value of [
    '',
    '{}',
    new Uint8Array(encode()),
    new ArrayBuffer(4),
    {},
    null,
    Buffer.alloc(0),
  ])
    assert.throws(() => parseJavaFixtureCatalogue(value));
  const bytes = encode();
  let calls = 0;
  for (const key of ['length', 'byteLength'])
    Object.defineProperty(bytes, key, {
      get() {
        calls++;
        throw Error('do not invoke');
      },
    });
  assert.deepEqual(parseJavaFixtureCatalogue(bytes), catalogue());
  assert.equal(calls, 0);
});

test('invalid UTF-8, BOMs, truncation and trailing JSON fail without echoing input', () => {
  const marker = 'PRIVATE_SYNTHETIC_CANARY';
  const invalid = [
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xe2, 0x82]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode()]),
    Buffer.concat([encode(), Buffer.from([0xff])]),
    Buffer.from('{"' + marker + '":'),
    Buffer.from('{"' + marker + '": true,}'),
    Buffer.from('{"' + marker + '":"bad\\escape"}'),
    Buffer.from('{"' + marker + '":"raw\nnewline"}'),
    Buffer.concat([encode(), Buffer.from('{}')]),
    encode().subarray(0, -1),
  ];
  for (const bytes of invalid)
    assert.throws(
      () => parseJavaFixtureCatalogue(bytes),
      (e) => {
        assert.equal(
          e.message,
          'Invalid synthetic Minecraft catalogue encoding or JSON.',
        );
        assert.ok(!e.message.includes(marker));
        assert.equal(e.cause, undefined);
        return true;
      },
    );
});

test('duplicate JSON fields including escaped aliases are refused before normalization', () => {
  const text = encode().toString();
  for (const input of [
    text.replace('"format":1', '"format":2,"format":1'),
    text.replace('"format":1', '"for\\u006dat":1,"format":1'),
    text.replace(
      '"gameVersion":"fixture-1"',
      '"gameVersion":"other","gameVersion":"fixture-1"',
    ),
    text.replace(
      '"sha256":',
      '"sha\\u003256":"' + '0'.repeat(64) + '","sha256":',
    ),
    '{"extra":{"x":1,"\\u0078":2}}',
  ])
    assert.throws(
      () => parseJavaFixtureCatalogue(Buffer.from(input)),
      /duplicate fields/,
    );
});

test('lexical limits distinguish containers from escaped punctuation in strings', () => {
  const deep =
    '{"extra":' +
    '['.repeat(maxFixtureCatalogueDepth) +
    '0' +
    ']'.repeat(maxFixtureCatalogueDepth) +
    '}';
  assert.throws(
    () => parseJavaFixtureCatalogue(Buffer.from(deep)),
    /nesting limit/,
  );
  for (const extra of [
    '[{},]',
    'quote: " comma, braces{} arrays[] backslash\\',
    '\\"} , "x":1',
  ]) {
    const raw = encode({...catalogue(), extra});
    assert.throws(
      () => parseJavaFixtureCatalogue(raw),
      (e) => !/nesting limit|duplicate fields|encoding or JSON/.test(e.message),
    );
  }
  // The exact depth boundary passes lexical checks, then fails the catalogue schema.
  const boundary =
    '{"extra":' +
    '['.repeat(maxFixtureCatalogueDepth - 1) +
    '0' +
    ']'.repeat(maxFixtureCatalogueDepth - 1) +
    '}';
  assert.throws(
    () => parseJavaFixtureCatalogue(Buffer.from(boundary)),
    (e) => !/nesting limit/.test(e.message),
  );
});

test('decoded catalogues retain entry limits, complete validation and exact selection', () => {
  const full = {
    ...catalogue(),
    releases: Array.from({length: 64}, (_, n) => release('fixture-' + n)),
  };
  assert.equal(parseJavaFixtureCatalogue(encode(full)).releases.length, 64);
  assert.throws(
    () =>
      parseJavaFixtureCatalogue(
        encode({...full, releases: [...full.releases, release('overflow')]}),
      ),
    /bounded/,
  );
  for (const item of [
    release('fixture-1'),
    {...release('fixture-2'), edition: 'bedrock'},
    {...release('fixture-2'), command: 'synthetic'},
  ])
    assert.throws(() =>
      parseJavaFixtureCatalogue(
        encode({...catalogue(), releases: [release(), item]}),
      ),
    );
  for (const field of ['__proto__', 'constructor', 'prototype'])
    assert.throws(() =>
      parseJavaFixtureCatalogue(
        Buffer.from(
          encode()
            .toString()
            .replace('"format":1', '"' + field + '":{},"format":1'),
        ),
      ),
    );
  const parsed = parseJavaFixtureCatalogue(encode());
  for (const version of ['latest', 'stable', 'missing', 'FIXTURE-1', null])
    assert.throws(
      () => selectJavaFixtureRelease(parsed, version),
      /exact version/,
    );
});

test(
  'raw bytes reach existing preparation without granting transport or changing a saved plan',
  {skip: process.platform !== 'linux'},
  async (t) => {
    const raw = encode();
    const parsed = parseJavaFixtureCatalogue(raw);
    const selected = selectJavaFixtureRelease(parsed, 'fixture-1');
    raw.fill(32);
    assert.deepEqual(selected, release());
    const scope = {
      fleet: 'a'.repeat(32),
      instance: 'b'.repeat(32),
      volume: resources('a'.repeat(32), 'b'.repeat(32), 'minecraft-java')
        .volume,
    };
    const request = fixtureWorkerRequest(
      scope,
      '11111111-1111-4111-8111-111111111111',
      selected,
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-wire-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const options = {
      root,
      scope,
      release: selected,
      credentials: {minecraftManagement: 'SyntheticOnly'.padEnd(40, 'X')},
      exchange: async () =>
        assert.fail('No transport during offline preparation'),
    };
    const api = await createJavaFixture(options);
    const replacementBytes = Buffer.from('different synthetic artifact');
    const refreshed = parseJavaFixtureCatalogue(
      encode({
        ...catalogue(),
        releases: [release('fixture-1', replacementBytes)],
      }),
    );
    const replacement = selectJavaFixtureRelease(refreshed, 'fixture-1');
    await assert.rejects(api.prepare(request, replacementBytes), /differs/);
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal(
      (await api.prepare(request, artifact)).preparation,
      'complete',
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, 'server.jar')),
      artifact,
    );
    const mismatched = await createJavaFixture({
      ...options,
      release: replacement,
    });
    await assert.rejects(mismatched.inspect(), /private binding/);
    assert.equal(
      (await (await createJavaFixture(options)).inspect()).preparation,
      'complete',
    );
  },
);
