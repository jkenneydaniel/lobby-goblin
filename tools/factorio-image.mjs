// Compatibility entry point; application-owned tooling is authoritative.
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sourceFile} from '../panel/source-layout.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const module = await import(
  pathToFileURL(await sourceFile(root, 'factorio-image/build.mjs'))
);
export const {
  imageDefinition,
  buildImage,
  testImage,
  runtimeImageDefinition,
  buildRuntimeImage,
  testRuntimeImage,
} = module;
const [command] = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const actions = {
    describe: async () =>
      console.log(JSON.stringify(await imageDefinition(), null, 2)),
    'runtime-describe': async () =>
      console.log(JSON.stringify(await runtimeImageDefinition(), null, 2)),
    build: async () => buildImage(await imageDefinition()),
    test: async () => testImage(await imageDefinition()),
    'runtime-build': async () =>
      buildRuntimeImage(await runtimeImageDefinition()),
    'runtime-test': async () =>
      testRuntimeImage(await runtimeImageDefinition()),
  };
  if (!actions[command])
    throw Error(
      'Use describe, build, test, runtime-describe, runtime-build or runtime-test.',
    );
  await actions[command]();
}
