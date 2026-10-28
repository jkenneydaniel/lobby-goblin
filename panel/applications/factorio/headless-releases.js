import {assert} from '../../common.js';

export const headlessVersion = value => typeof value === 'string' && /^2\.\d{1,3}\.\d{1,4}$/.test(value);
export const checksumURL = 'https://factorio.com/download/sha256sums/';

// Discovery and installation use the same official inventory and reject an
// ambiguous entry rather than choosing one of several hashes for a release.
export function parseHeadlessChecksums(text) {
  const releases = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const match = /^factorio-headless_linux_(2\.\d{1,3}\.\d{1,4})\.tar\.xz$/.exec(parts[1]);
    if (!match) continue;
    assert(/^[a-f0-9]{64}$/.test(parts[0]) && !releases.has(match[1]), 'Official headless checksum inventory is invalid or ambiguous.', 503);
    releases.set(match[1], parts[0]);
    assert(releases.size <= 2000, 'Oversized headless release catalogue.', 503);
  }
  assert(releases.size > 0, 'Official headless release checksums are unavailable.', 503);
  return releases;
}
export async function headlessChecksums(fetcher = fetch) {
  const response = await fetcher(checksumURL, {
    headers: {accept: 'text/plain', 'user-agent': 'LobbyGoblin/1'},
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  assert(response.ok && /text\/plain/i.test(response.headers.get('content-type') || ''), 'Official release checksums are unavailable.', 503);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 2 * 1024 ** 2, 'Oversized checksum response.', 503);
    chunks.push(chunk);
  }
  return parseHeadlessChecksums(Buffer.concat(chunks).toString());
}
