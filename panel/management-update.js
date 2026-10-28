import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from './common.js';
import {readInstallation} from './install.js';
import {readHostInstallation} from './host-install.js';
import {ManagementUpdate} from './fleet/management-update.js';
import {ManagementEngine} from './fleet/management-engine.js';

export async function main(
  args = process.argv.slice(2),
  {
    engineFactory = (options) => new ManagementEngine(options),
    log = console.log,
  } = {},
) {
  const [command, ...rest] = args;
  if (command === '--help' || command === undefined)
    return log(
      'Management updates (local operator only)\n  plan --directory PATH --socket PATH --engine ENGINE_ID --image IMMUTABLE_IMAGE\n  apply|status|resume|rollback --directory PATH --socket PATH --engine ENGINE_ID --id UPDATE_ID\n  apply, resume and rollback require --confirm. Planning never changes existing services.\n  Application containers, worlds and backups are never mounted or changed.\n  A retained filesystem lease needs offline review through panel/storage.js lock/unlock.',
    );
  assert(
    ['plan', 'apply', 'status', 'resume', 'rollback'].includes(command),
    'Choose plan, apply, status, resume or rollback.',
  );
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    assert(
      [
        '--directory',
        '--socket',
        '--engine',
        '--image',
        '--id',
        '--confirm',
      ].includes(key) && !Object.hasOwn(options, key),
      'Unknown or repeated management update option.',
    );
    if (key === '--confirm') options[key] = true;
    else {
      assert(
        rest[index + 1] && !rest[index + 1].startsWith('--'),
        key + ' requires a value.',
      );
      options[key] = rest[++index];
    }
  }
  assert(
    options['--directory'] && options['--socket'] && options['--engine'],
    'Select the installation directory, explicit socket and engine ID.',
  );
  assert(
    command === 'plan'
      ? options['--image'] && !options['--id'] && !options['--confirm']
      : options['--id'] && !options['--image'],
    'Use an image only for planning and the retained ID for inspection/recovery.',
  );
  const directory = path.resolve(options['--directory']);
  let installation;
  // A directory belongs to exactly one existing installer; failed validation is
  // never treated as permission to adopt a different layout.
  const fs = await import('node:fs/promises');
  const central = await fs
    .lstat(path.join(directory, 'installation.json'))
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  installation = central
    ? await readInstallation(directory)
    : await readHostInstallation(directory);
  assert(
    installation,
    'Choose an intact existing installer-created directory. No resources were adopted.',
  );
  const workflow = new ManagementUpdate({
    directory,
    installation,
    engine: engineFactory({
      socket: options['--socket'],
      engine: options['--engine'],
    }),
  });
  const result =
    command === 'plan'
      ? await workflow.plan(options['--image'])
      : command === 'status'
        ? await workflow.status(options['--id'])
        : await workflow.run(options['--id'], {
            confirm: options['--confirm'] === true,
            rollback: command === 'rollback',
          });
  if (!['plan', 'status'].includes(command) && !result.cleanupRequired && result.pending === null)
    await workflow.engine.reconcilePanelUpdate?.(result);
  log(JSON.stringify(result, null, 2));
  return result;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
