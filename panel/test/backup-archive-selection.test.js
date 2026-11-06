import test from 'node:test';
import assert from 'node:assert/strict';
// The existing shared browser module imports pathname scoping; selection has no DOM.
globalThis.location = {pathname: '/'};
const {selectBackupArchives: select} =
  await import('../public/shared/backups.js');
delete globalThis.location;

const archives = Object.freeze([
  Object.freeze({
    relative: 'Zulu .* [before]&+.zip',
    validation: Object.freeze({ok: true}),
  }),
  Object.freeze({
    relative: 'alpha-manual.zip',
    validation: Object.freeze({ok: false}),
  }),
  Object.freeze({relative: 'ALPHA-scheduled.zip', validation: null}),
  Object.freeze({relative: 'other.zip'}),
]);

test('archive find trims and matches names case-insensitively with literal punctuation only', () => {
  assert.deepEqual(select(archives, '  ALPHA  ', 'all'), [
    archives[1],
    archives[2],
  ]);
  assert.deepEqual(select(archives, '.* [BEFORE]&+', 'all'), [archives[0]]);
  assert.deepEqual(select(archives, '^Zulu', 'all'), []);
  assert.deepEqual(select(archives, 'manual|scheduled', 'all'), []);
  assert.deepEqual(
    select(
      [
        {
          relative: 'name.zip',
          message: 'private needle',
          validation: {ok: true, error: 'needle'},
        },
      ],
      'needle',
      'all',
    ),
    [],
  );
});

test('verification selection follows the exact existing row-label mapping and composes with the name query', () => {
  assert.deepEqual(select(archives, '', 'verified'), [archives[0]]);
  assert.deepEqual(select(archives, '', 'failed'), [archives[1]]);
  assert.deepEqual(select(archives, '', 'unverified'), [
    archives[2],
    archives[3],
  ]);
  assert.deepEqual(select(archives, 'alpha', 'failed'), [archives[1]]);
  assert.deepEqual(select(archives, 'alpha', 'verified'), []);
  // Preserve the existing truthy-ok / present-validation / absent-validation labels.
  const legacy = [
    {relative: 'truthy.zip', validation: {ok: 1}},
    {relative: 'present.zip', validation: {}},
    {relative: 'null.zip', validation: null},
  ];
  assert.deepEqual(select(legacy, '', 'verified'), [legacy[0]]);
  assert.deepEqual(select(legacy, '', 'failed'), [legacy[1]]);
  assert.deepEqual(select(legacy, '', 'unverified'), [legacy[2]]);
});

test('blank query preserves loaded source order and records without mutating frozen input', () => {
  const before = structuredClone(archives),
    result = select(archives, '   ', 'all');
  assert.deepEqual(result, archives);
  assert.notEqual(result, archives);
  assert.equal(result[0], archives[0]);
  assert.deepEqual(archives, before);
  assert.deepEqual(select([], '', 'all'), []);
});
