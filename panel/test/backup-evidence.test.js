import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = {pathname: '/'};
const {backupEvidenceView: view} = await import('../public/shared/backups.js');
delete globalThis.location;

const hash = 'a1'.repeat(32);
const unknown = 'Not available in this recorded check';

test('successful evidence shows only the recorded check time and valid checksum', () => {
  const checked = '2026-11-07T10:12:13.000Z',
    result = view({
      ok: true,
      checked,
      sha256: hash,
      identity: 'PRIVATE-IDENTITY',
      software: {token: 'PRIVATE-SOFTWARE'},
      error: 'NOT-A-FAILED-CHECK',
      files: ['PRIVATE-FILE'],
    });
  assert.ok(result.includes(new Date(checked).toLocaleString()));
  assert.ok(result.includes(hash));
  assert.doesNotMatch(result, /PRIVATE|NOT-A-FAILED-CHECK|Failure reason/);
  assert.match(result, /do not prove that the game can load or recover/);
  assert.match(result, /^<details><summary>Integrity check details<\/summary>/);
});

test('failed evidence shows its recorded time and fixed failure state without a checksum', () => {
  const checked = '2026-11-07T10:12:13.000Z';
  const result = view({
    ok: false,
    checked,
    sha256: hash,
    error: '<img src=x onerror="fail()"> & reason',
  });
  assert.ok(result.includes(new Date(checked).toLocaleString()));
  assert.match(result, /Recorded integrity check failed\./);
  assert.ok(result.includes(unknown));
  assert.ok(!result.includes(hash));
  assert.doesNotMatch(result, /img|script|onerror|reason/);
});

test('missing, scalar and array records never coerce arbitrary data into display', () => {
  for (const value of [null, undefined])
    assert.match(view(value), /No matching integrity check is recorded/);
  for (const value of ['PRIVATE-STRING', 1, true, ['PRIVATE-ARRAY']]) {
    assert.match(
      view(value),
      /Recorded integrity check details are unavailable/,
    );
    assert.doesNotMatch(view(value), /PRIVATE/);
  }
});

test('unstructured errors never expose archive JSON, local paths, markup or long text', () => {
  const expected = view({ok: false});
  for (const error of [
    'Unexpected token after JSON: {"password":"ARCHIVE-CONTENT"}',
    'ENOENT: /private/server/config/server-settings.json',
    '<img src=x onerror="fail()"> & reason',
    'LONG-PRIVATE-TEXT'.repeat(500),
    {reason: 'PRIVATE-OBJECT'},
  ]) {
    assert.equal(view({ok: false, error}), expected);
  }
});

test('legacy records and invalid checksums or field types remain explicitly unknown', () => {
  for (const value of [
    {},
    {ok: 1, checked: 123, sha256: hash},
    {ok: true, checked: {}, sha256: {}},
    {ok: true, checked: 'invalid', sha256: 'a'.repeat(63)},
    {ok: true, sha256: 'g'.repeat(64)},
    {ok: true, sha256: hash + ' '},
  ]) {
    const result = view(value);
    assert.match(result, /Checked: Unknown/);
    assert.ok(result.includes(unknown));
    assert.doesNotMatch(result, /\[object Object\]/);
  }
  assert.ok(
    view({ok: true, sha256: hash.toUpperCase()}).includes(hash.toUpperCase()),
  );
  for (const error of [null, {}, 42, ' '])
    assert.match(view({ok: false, error}), /Recorded integrity check failed\./);
});
