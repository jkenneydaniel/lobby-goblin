import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  imageCatalogue,
  selectImageRecipes,
  buildApplicationImage,
  checkApplicationImage,
  acceptApplicationImage,
} from '../panel/core/application-image-build.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'list', selection] = process.argv.slice(2);
const all = await imageCatalogue(root);
const selected = selection
  ? all.filter((recipe) => recipe.key === selection)
  : all;
if (!selected.length)
  throw Error(
    'Unknown application image. Use list to inspect registered recipes.',
  );
if (command === 'list')
  console.log(
    JSON.stringify(
      selected.map(({key, image, metadata}) => ({
        key,
        image,
        platform: metadata.platform,
      })),
      null,
      2,
    ),
  );
else if (command === 'matrix')
  console.log(
    JSON.stringify({include: selected.map(({key, image}) => ({key, image}))}),
  );
else if (['build', 'check', 'acceptance'].includes(command)) {
  for (const recipe of command === 'acceptance'
    ? selected
    : selectImageRecipes(all, selection)) {
    console.log(command + ' ' + recipe.key);
    console.log(
      (await (
        command === 'build'
          ? buildApplicationImage
          : command === 'check'
            ? checkApplicationImage
            : acceptApplicationImage
      )(recipe)) || '',
    );
  }
} else
  throw Error(
    'Use list, matrix, check, acceptance or build [application/image].',
  );
