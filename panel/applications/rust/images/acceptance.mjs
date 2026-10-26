import {pathToFileURL} from 'node:url';
import {projectRoot, imageDefinition} from './build.mjs';
const definition = await imageDefinition();
const {migrationAcceptance} = await import(
  pathToFileURL(projectRoot + '/panel/test/package-image-acceptance.mjs')
);
migrationAcceptance('rust', definition, projectRoot);
