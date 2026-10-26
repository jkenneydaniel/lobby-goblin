import {pathToFileURL} from 'node:url';
import {projectRoot, imageDefinition, testImage} from './build.mjs';
const definition = await imageDefinition();
await testImage(definition);
const {migrationAcceptance} = await import(
  pathToFileURL(projectRoot + '/panel/test/package-image-acceptance.mjs')
);
migrationAcceptance('factorio', definition, projectRoot);
