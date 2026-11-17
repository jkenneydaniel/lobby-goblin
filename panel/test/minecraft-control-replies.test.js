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

const linux = {skip: process.platform !== 'linux'};
const bytes = Buffer.from('synthetic reply fixture, never a game');
const release = {
  format: 1,
  edition: 'java',
  gameVersion: 'fixture-1',
  platform: 'linux/amd64',
  sha256: digest(bytes),
  bytes: bytes.length,
};
const scope = {
  fleet: 'a'.repeat(32),
  instance: 'b'.repeat(32),
  volume: resources('a'.repeat(32), 'b'.repeat(32), 'minecraft-java').volume,
};
const request = fixtureWorkerRequest(
  scope,
  '11111111-1111-4111-8111-111111111111',
  release,
);
const credentials = {minecraftManagement: 'SyntheticOnly'.padEnd(40, 'X')};
const alias = (key) =>
  '"\\u' + key.charCodeAt(0).toString(16).padStart(4, '0') + key.slice(1) + '"';

async function fixture(t, response = (_phase, text) => text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-replies-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const state = {running: true, calls: []};
  const exchange = async ({method}) => {
    state.calls.push(method);
    const phase =
      method === 'status'
        ? state.calls.length === 1
          ? 'initial'
          : 'final'
        : method;
    if (method === 'stop') state.running = false;
    const value =
      method === 'status'
        ? {
            format: 1,
            edition: 'java',
            gameVersion: release.gameVersion,
            running: state.running,
            ready: state.running,
          }
        : {format: 1, ok: true};
    return response(phase, JSON.stringify(value));
  };
  const options = {root, scope, release, credentials, exchange};
  const api = await createJavaFixture(options);
  await api.prepare(request, bytes);
  return {api, options, state};
}

function duplicate(text, key, first, escaped = false) {
  const value = JSON.parse(text)[key];
  const original = JSON.stringify(key) + ':' + JSON.stringify(value);
  assert.ok(text.includes(original));
  return text.replace(
    original,
    JSON.stringify(key) +
      ':' +
      JSON.stringify(first) +
      ',' +
      (escaped ? alias(key) : JSON.stringify(key)) +
      ':' +
      JSON.stringify(value),
  );
}

test(
  'flat synthetic replies accept whitespace, ordering and unique escaped names',
  linux,
  async (t) => {
    const f = await fixture(t, (_phase, text) => {
      const value = JSON.parse(text);
      const ordered = Object.fromEntries(Object.entries(value).reverse());
      return (
        ' \r\n\t' +
        JSON.stringify(ordered, null, 2)
          .replace('"ready"', alias('ready'))
          .replace('"ok"', alias('ok'))
          .replace('"format"', alias('format'))
          .replace('"fixture-1"', '"fixture-\\u0031"') +
        '\n'
      );
    });
    assert.equal(
      (await f.api.saveAndStop({confirm: true})).control,
      'complete',
    );
    assert.deepEqual(f.state.calls, ['status', 'save', 'stop', 'status']);
  },
);

test(
  'duplicate initial status fields never authorize a save or stop',
  linux,
  async (t) => {
    const conflicting = {
      format: 2,
      edition: 'bedrock',
      gameVersion: 'PRIVATE_SYNTHETIC_CANARY',
      running: false,
      ready: false,
    };
    for (const [key, wrong] of Object.entries(conflicting))
      for (const style of ['conflict', 'identical', 'escaped'])
        await t.test(key + ' ' + style, async (t) => {
          const f = await fixture(t, (phase, text) =>
            phase === 'initial'
              ? duplicate(
                  text,
                  key,
                  style === 'identical' ? JSON.parse(text)[key] : wrong,
                  style === 'escaped',
                )
              : text,
          );
          await assert.rejects(f.api.saveAndStop({confirm: true}), (error) => {
            assert.equal(
              error.message,
              'Invalid synthetic Minecraft response.',
            );
            assert.equal(error.cause, undefined);
            return true;
          });
          assert.deepEqual(f.state.calls, ['status']);
          assert.equal((await f.api.inspect()).control, 'idle');
          const restored = await createJavaFixture(f.options);
          assert.equal((await restored.inspect()).control, 'idle');
        });
  },
);

test(
  'ambiguous mutation acknowledgments preserve unknown and refuse replay',
  linux,
  async (t) => {
    for (const phase of ['save', 'stop'])
      for (const key of ['format', 'ok'])
        for (const style of ['conflict', 'identical', 'escaped'])
          await t.test(phase + ' ' + key + ' ' + style, async (t) => {
            const f = await fixture(t, (current, text) =>
              current === phase
                ? duplicate(
                    text,
                    key,
                    style === 'identical'
                      ? JSON.parse(text)[key]
                      : key === 'ok'
                        ? false
                        : 2,
                    style === 'escaped',
                  )
                : text,
            );
            await assert.rejects(
              f.api.saveAndStop({confirm: true}),
              /Fixture control outcome requires inspection\./,
            );
            const expected =
              phase === 'save'
                ? ['status', 'save']
                : ['status', 'save', 'stop'];
            assert.deepEqual(f.state.calls, expected);
            assert.equal((await f.api.inspect()).control, 'unknown');
            const restored = await createJavaFixture(f.options);
            assert.equal((await restored.inspect()).control, 'unknown');
            await assert.rejects(
              restored.saveAndStop({confirm: true}),
              /do not replay/,
            );
            assert.deepEqual(f.state.calls, expected);
          });
  },
);

test(
  'ambiguous final status cannot confirm shutdown or become replayable',
  linux,
  async (t) => {
    for (const key of ['format', 'edition', 'gameVersion', 'running', 'ready'])
      for (const escaped of [false, true])
        await t.test(key + ' escaped=' + escaped, async (t) => {
          const wrong = {
            format: 2,
            edition: 'bedrock',
            gameVersion: 'other',
            running: true,
            ready: true,
          };
          const f = await fixture(t, (phase, text) =>
            phase === 'final'
              ? duplicate(text, key, wrong[key], escaped)
              : text,
          );
          await assert.rejects(
            f.api.saveAndStop({confirm: true}),
            /Fixture control outcome requires inspection\./,
          );
          assert.equal((await f.api.inspect()).control, 'unknown');
          const restored = await createJavaFixture(f.options);
          assert.equal((await restored.inspect()).control, 'unknown');
          await assert.rejects(
            restored.saveAndStop({confirm: true}),
            /do not replay/,
          );
          assert.deepEqual(f.state.calls, ['status', 'save', 'stop', 'status']);
        });
  },
);

test(
  'synthetic reply byte bounds include whitespace and remain unchanged',
  linux,
  async (t) => {
    const f = await fixture(t, (_phase, text) =>
      text.padEnd(16384 - Buffer.byteLength(text) + text.length, ' '),
    );
    assert.equal(
      (await f.api.saveAndStop({confirm: true})).control,
      'complete',
    );
    for (const tail of [' ', 'é']) {
      const f = await fixture(
        t,
        (_phase, text) => text.padEnd(16384, ' ') + tail,
      );
      await assert.rejects(
        f.api.saveAndStop({confirm: true}),
        /Invalid synthetic/,
      );
      assert.equal((await f.api.inspect()).control, 'idle');
      assert.deepEqual(f.state.calls, ['status']);
    }
  },
);

test(
  'malformed or nested synthetic replies retain fixed non-disclosing errors',
  linux,
  async (t) => {
    const marker = 'PRIVATE_SYNTHETIC_CANARY';
    for (const text of [
      '{"' + marker + '":',
      '{"format":1,"ok":true,}',
      '{"format":1,"ok":true}{}',
      '\ufeff{"format":1,"ok":true}',
      '{"format":1,"ready":{"' + marker + '":true}}',
      '{"format":1,"ready":["' + marker + '"]}',
    ]) {
      const f = await fixture(t, () => text);
      await assert.rejects(f.api.observe(), (error) => {
        assert.equal(error.message, 'Invalid synthetic Minecraft response.');
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal((await f.api.inspect()).control, 'idle');
    }
  },
);
