import fs from 'node:fs/promises';
import ids from './registry.json' with {type: 'json'};
import {assert} from '../common.js';
import {applicationDefinition} from '../core/application-definition.js';
import {containerPresentation} from '../core/container-application.js';

// This is an installation-owned list, never a request parameter or import path.
// Adding a package requires one registry entry; image metadata follows it.
assert(
  Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 64 &&
    ids.every(
      (id) => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id),
    ) &&
    new Set(ids).size === ids.length,
  'Invalid application registry.',
);
const definitions = new Map();
for (const id of ids) {
  const read = async (name) =>
    JSON.parse(
      await fs.readFile(
        new URL('./' + id + '/' + name, import.meta.url),
        'utf8',
      ),
    );
  const source = await read('definition.json');
  const presentation = await read('presentation.json').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return containerPresentation(source);
  });
  const definition = applicationDefinition(source, presentation);
  assert(
    definition.id === id,
    'Application package identity differs from its registry entry.',
  );
  definitions.set(id, definition);
}
export const registeredDefinitions = () => [...definitions.values()];
export function definitionFor(id) {
  const definition = definitions.get(id);
  assert(definition, 'Unsupported application: ' + id);
  return definition;
}
