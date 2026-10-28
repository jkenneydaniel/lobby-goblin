import {assert} from '../../common.js';
import {boundedJSON} from '../../core/release-fetch.js';
import {compareVersions} from '../../updates.js';
import {headlessChecksums} from './headless-releases.js';
const repository = 'jkenneydaniel/factorio-server';
const imagePrefix = 'ghcr.io/' + repository + ':';
const exactVersion = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

export async function factorioReleases({fetcher, software}) {
  const latest = await boundedJSON(
    fetcher,
    'https://factorio.com/api/latest-releases',
  );
  assert(
    exactVersion(latest.stable?.headless),
    'Invalid Factorio release metadata.',
    503,
  );
  if (software?.mode === 'runtime') {
    assert(
      software.provider === 'factorio-headless',
      'Unsupported Factorio software provider.',
      503,
    );
    const inventory = await headlessChecksums(fetcher);
    const consoleVersion = exactVersion(latest.console?.headless) ? latest.console.headless : null;
    return {
      game: 'factorio',
      stable: latest.stable.headless,
      experimental: exactVersion(latest.experimental?.headless)
        ? latest.experimental.headless
        : null,
      console: consoleVersion && inventory.has(consoleVersion) ? consoleVersion : null,
      choices: [...inventory.keys()]
        .map(version => ({
          kind: 'software',
          version,
          channel: version === latest.stable.headless ? 'stable' : version === latest.experimental?.headless ? 'experimental' : 'archived',
          channels: [version === latest.stable.headless && 'stable', version === latest.experimental?.headless && 'experimental', version === consoleVersion && 'console'].filter(Boolean),
          provider: 'factorio-headless',
          downloadUrl:
            'https://factorio.com/get-download/' +
            version +
            '/headless/linux64',
          notesUrl:
            'https://wiki.factorio.com/Version_history/' +
            version.split('.').slice(0, 2).join('.') +
            '.0#' +
            version,
        }))
        .sort((a, b) => compareVersions(b.version, a.version)),
      news: [],
      source: 'Wube release API and official Linux headless checksums',
      notesUrl: 'https://factorio.com/download',
      requiresImageChange: false,
    };
  }
  let choices = [],
    imageError = null;
  try {
    const auth = await boundedJSON(
      fetcher,
      'https://ghcr.io/token?service=ghcr.io&scope=repository%3A' +
        encodeURIComponent(repository) +
        '%3Apull',
    );
    assert(
      typeof auth.token === 'string' && auth.token.length <= 8192,
      'Invalid registry response.',
      503,
    );
    const images = await boundedJSON(
      fetcher,
      'https://ghcr.io/v2/' + repository + '/tags/list?n=1000',
      {authorization: 'Bearer ' + auth.token},
    );
    assert(
      images.name === repository &&
        Array.isArray(images.tags) &&
        images.tags.length <= 1000,
      'Invalid image catalogue.',
      503,
    );
    choices = images.tags
      .flatMap((tag) => {
        const match = /^(2\.0\.\d+)-fc\.([1-9]\d*)$/.exec(tag);
        if (!match || !Number.isSafeInteger(Number(match[2]))) return [];
        return [
          {
            kind: 'image',
            version: match[1],
            imageRevision: Number(match[2]),
            image: imagePrefix + tag,
            channel:
              match[1] === latest.stable.headless
                ? 'stable'
                : match[1] === latest.experimental?.headless
                  ? 'experimental'
                  : 'published',
            notesUrl:
              'https://wiki.factorio.com/Version_history/2.0.0#' + match[1],
          },
        ];
      })
      .sort(
        (a, b) =>
          compareVersions(b.version, a.version) ||
          b.imageRevision - a.imageRevision,
      );
  } catch {
    imageError =
      'Published image versions could not be checked. Installation choices are unavailable.';
  }
  return {
    game: 'factorio',
    requiresImageChange: true,
    stable: latest.stable.headless,
    experimental: exactVersion(latest.experimental?.headless)
      ? latest.experimental.headless
      : null,
    choices,
    imageError,
    news: [],
    source: 'Wube release API and the Lobby Goblin image registry',
    notesUrl: 'https://wiki.factorio.com/Version_history/2.0.0',
  };
}
