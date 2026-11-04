// Already-parsed synthetic catalogue contract, not a Mojang JSON client.
// This module has no transport, source URL, executable command or fallback.
import {assert} from '../../common.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';
import {exactRecord, javaFixtureRelease} from './provider.js';

export const maxFixtureCatalogueBytes = 64 * 1024;
export const maxFixtureCatalogueEntries = 64;

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
