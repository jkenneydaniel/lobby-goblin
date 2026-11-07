import test from 'node:test';
import assert from 'node:assert/strict';
import {selectInstalledItems as select} from '../public/mod-library.js';

const items = Object.freeze([
  Object.freeze({
    id: 'last-ID',
    title: 'Zulu .* [世界]',
    name: 'PRIVATE-FILE',
    enabled: true,
    source: 'fixture',
    modified: false,
  }),
  Object.freeze({
    id: 'disabled-target',
    title: 'Alpha',
    enabled: false,
    source: null,
    modified: true,
  }),
  Object.freeze({
    id: 'manual',
    name: 'Fallback name',
    enabled: true,
    source: null,
    modified: false,
    managed: true,
  }),
  Object.freeze({
    id: 'unknown',
    title: null,
    enabled: undefined,
    source: 'fixture',
    modified: null,
    summary: 'PRIVATE',
    version: 'PRIVATE',
  }),
]);

test('Installed search uses literal trimmed case-insensitive displayed name and ID', () => {
  assert.deepEqual(select(items, '  ZULU .* [世界]  ', 'all'), [items[0]]);
  assert.deepEqual(select(items, 'LAST-id', 'all'), [items[0]]);
  assert.deepEqual(select(items, 'FALLBACK NAME', 'all'), [items[2]]);
  assert.deepEqual(select(items, 'unknown', 'all'), [items[3]]);
  assert.deepEqual(select(items, '^Zulu|Alpha', 'all'), []);
  assert.deepEqual(select(items, 'PRIVATE', 'all'), []);
});

test('fixed observation filters match the existing row labels, including modified/manual precedence', () => {
  assert.deepEqual(select(items, '', 'enabled'), [items[0], items[2]]);
  assert.deepEqual(select(items, '', 'disabled'), [items[1], items[3]]);
  assert.deepEqual(select(items, '', 'modified'), [items[1]]);
  assert.deepEqual(select(items, '', 'manual'), [items[2]]);
  assert.deepEqual(select(items, 'alpha', 'modified'), [items[1]]);
  assert.deepEqual(select(items, 'alpha', 'manual'), []);
  assert.deepEqual(select(items, '', 'unknown-filter'), []);
  const legacy = [{id: 'truthy', enabled: 1, modified: 'yes'}, {id: 'absent'}];
  assert.deepEqual(select(legacy, '', 'enabled'), [legacy[0]]);
  assert.deepEqual(select(legacy, '', 'modified'), [legacy[0]]);
  assert.deepEqual(select(legacy, '', 'manual'), [legacy[1]]);
});

test('empty and unknown identity fields do not coerce unrelated metadata into the query', () => {
  const unknown = [
    {id: 42, title: {}, name: 'PRIVATE'},
    {id: 'shown', title: '', name: ''},
  ];
  assert.deepEqual(select(unknown, 'object', 'all'), []);
  assert.deepEqual(select(unknown, '42', 'all'), []);
  assert.deepEqual(select(unknown, 'shown', 'all'), [unknown[1]]);
  assert.deepEqual(select([], '', 'all'), []);
  assert.deepEqual(select(items, null, 'all'), items);
});

test('selection keeps full received order and object identities without mutating frozen input', () => {
  const before = structuredClone(items),
    result = select(items, ' ', 'all');
  assert.deepEqual(result, items);
  assert.notEqual(result, items);
  assert.equal(result[0], items[0]);
  assert.deepEqual(items, before);
  const large = Array.from({length: 251}, (_, i) =>
    Object.freeze({id: 'item-' + i, title: i === 250 ? 'last match' : 'other'}),
  );
  assert.deepEqual(select(large, 'last match', 'all'), [large[250]]);
});
