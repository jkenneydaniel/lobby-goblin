import {existsSync} from 'node:fs';
const source = new URL('../mod-layout.js', import.meta.url);
export const {
  oxideCompiler,
  carbonDataDirectories,
  carbonDataFiles,
  oxideNativeConfigPath,
  oxideNativeConfig,
  modDirectory,
  prepareFrameworkLayout,
  prepareCarbonConfig,
} = await import(
  existsSync(source)
    ? source
    : new URL('../../../applications/rust/mod-layout.js', import.meta.url)
);
