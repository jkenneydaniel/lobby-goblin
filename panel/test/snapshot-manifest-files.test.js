import test from 'node:test';
import assert from 'node:assert/strict';
import {selectManifestFiles} from '../public/fleet/snapshot-filters.js';

const target = Object.freeze({
  name: 'mods/Ünicode[世界]/Target.*<x>&+.cfg',
  size: 987654321,
  sha256: 'hash-only-needle',
  private: 'private-only-needle',
});
const files = Object.freeze([
  ...Array.from({length: 245}, (_, index) =>
    Object.freeze({
      name: 'chunks/part-' + index + '.dat',
      size: index,
      sha256: String(index).padStart(64, '0'),
    }),
  ),
  target,
]);

test('manifest find filters the complete inventory before the 200-row cap and reports all three counts', () => {
  assert.deepEqual(selectManifestFiles(files, '  TARGET.*<X>&+  '), {
    files: [target],
    matching: 1,
    loaded: 246,
  });
  const many = selectManifestFiles(files, 'chunks/');
  assert.equal(many.matching, 245);
  assert.equal(many.loaded, 246);
  assert.equal(many.files.length, 200);
  assert.deepEqual(many.files, files.slice(0, 200));
  assert.equal(selectManifestFiles(files, 'part-244.dat').files[0], files[244]);
  assert.equal(selectManifestFiles(files, '').matching, 246);
  assert.equal(selectManifestFiles(files, '   ').files.length, 200);
});

test('manifest find matches only literal relative names, including Unicode and punctuation', () => {
  assert.deepEqual(selectManifestFiles(files, 'üNICODE[世界]').files, [target]);
  for (const query of [
    'hash-only-needle',
    'private-only-needle',
    '987654321',
    '^mods/',
    'Target.*cfg$',
    'part-1|part-2',
  ])
    assert.deepEqual(
      selectManifestFiles(files, query),
      {files: [], matching: 0, loaded: 246},
      query,
    );
  assert.deepEqual(selectManifestFiles([], ''), {
    files: [],
    matching: 0,
    loaded: 0,
  });
});

test('manifest find preserves input order, path, exact values and object identity without mutation', () => {
  const duplicateNames = Object.freeze([
    Object.freeze({name: 'z/world.zip', size: 7, sha256: 'exact-z'}),
    Object.freeze({name: 'a/world.zip', size: 8, sha256: 'exact-a'}),
  ]);
  const before = structuredClone(files);
  const result = selectManifestFiles(duplicateNames, 'WORLD.ZIP');
  assert.deepEqual(result.files, duplicateNames);
  assert.notEqual(result.files, duplicateNames);
  assert.equal(result.files[0], duplicateNames[0]);
  assert.equal(result.files[1], duplicateNames[1]);
  selectManifestFiles(files, 'part');
  assert.deepEqual(files, before);
});
