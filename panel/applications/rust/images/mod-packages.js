import {existsSync} from 'node:fs';
const source = new URL('../mod-packages.js', import.meta.url);
export const {frameworkRelease, frameworkFiles, boundedDownload, sha256} =
  await import(
    existsSync(source)
      ? source
      : new URL('../../../applications/rust/mod-packages.js', import.meta.url)
  );
