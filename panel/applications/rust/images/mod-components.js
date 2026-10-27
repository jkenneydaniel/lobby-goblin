import {existsSync} from 'node:fs';
const source = new URL('../mod-components.js', import.meta.url);
export const {packagedCarbonHooks} = await import(
  existsSync(source)
    ? source
    : new URL('../../../applications/rust/mod-components.js', import.meta.url)
);
