// Offline synthetic catalogue contract, not a Mojang JSON client.
// This module has no transport, source URL, executable command or fallback.
import {assert} from '../../common.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';
import {exactRecord, javaFixtureRelease} from './provider.js';

export const maxFixtureCatalogueBytes = 64 * 1024;
export const maxFixtureCatalogueEntries = 64;
export const maxFixtureCatalogueDepth = 32;

const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
).get;

export function parseJavaFixtureCatalogue(bytes) {
  assert(Buffer.isBuffer(bytes), 'Supply synthetic catalogue bytes.');
  // Use the intrinsic length: caller-defined accessors must not run before the
  // raw-byte budget. Whitespace and escaped fields count toward this budget.
  const length = byteLength.call(bytes);
  assert(
    length > 0 && length <= maxFixtureCatalogueBytes,
    'Minecraft fixture catalogue exceeds its metadata budget.',
    413,
  );
  let text, value;
  try {
    // Preserve a leading BOM so JSON grammar refuses it rather than silently
    // stripping bytes. Invalid UTF-8 must never become replacement characters.
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
      bytes,
    );
    value = JSON.parse(text);
  } catch {
    // Native syntax errors can contain source excerpts. Never expose them.
    throw Error('Invalid synthetic Minecraft catalogue encoding or JSON.');
  }

  // Native JSON.parse owns grammar. This bounded lexical pass only detects
  // ambiguous duplicate object keys and nesting, which JSON.parse normalizes.
  // Strings are skipped as units; escaped key spellings compare after decoding.
  const frames = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{' || char === '[') {
      frames.push(char === '{' ? {keys: new Set(), key: true} : null);
      assert(
        frames.length <= maxFixtureCatalogueDepth,
        'Minecraft fixture catalogue exceeds its nesting limit.',
        413,
      );
    } else if (char === '}' || char === ']') {
      frames.pop();
    } else if (char === ',') {
      if (frames.at(-1)) frames.at(-1).key = true;
    } else if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const frame = frames.at(-1);
      if (frame?.key) {
        const key = JSON.parse(text.slice(start, i + 1));
        assert(
          !frame.keys.has(key),
          'Minecraft fixture catalogue contains duplicate fields.',
          409,
        );
        frame.keys.add(key);
        frame.key = false;
      }
    }
  }
  return javaFixtureCatalogue(value);
}

export function javaFixtureCatalogue(value) {
  // Inspect data descriptors before reading fields or serializing caller input.
  definitionData(value);
  assert(
    Buffer.byteLength(JSON.stringify(value)) <= maxFixtureCatalogueBytes,
    'Minecraft fixture catalogue exceeds its metadata budget.',
    413,
  );
  exactRecord(value, ['format', 'kind', 'releases']);
  assert(
    value.format === 1 &&
      value.kind === 'minecraft-java-fixture-catalogue' &&
      Array.isArray(value.releases) &&
      value.releases.length > 0 &&
      value.releases.length <= maxFixtureCatalogueEntries,
    'Choose a bounded synthetic Java fixture catalogue.',
  );
  // Validate every entry, including those not selected by the caller. A
  // duplicate version is ambiguous even if both records have identical bytes.
  const releases = value.releases.map(javaFixtureRelease);
  assert(
    new Set(releases.map((release) => release.gameVersion)).size ===
      releases.length,
    'Minecraft fixture catalogue contains duplicate versions.',
    409,
  );
  return freezeDefinition({
    format: 1,
    kind: 'minecraft-java-fixture-catalogue',
    releases,
  });
}

export function selectJavaFixtureRelease(value, requestedVersion) {
  const catalogue = javaFixtureCatalogue(value);
  const selected =
    typeof requestedVersion === 'string' &&
    catalogue.releases.find(
      (release) => release.gameVersion === requestedVersion,
    );
  assert(
    selected,
    'Choose one exact version present in the fixture catalogue.',
  );
  // This is the existing immutable release shape. It neither authorizes a
  // transfer nor authenticates the catalogue publisher or a runnable JAR.
  return selected;
}
