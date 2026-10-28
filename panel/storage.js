// Explicit management-document maintenance. No Docker, service or world actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assert} from './common.js';
import {repairMigrationHistory} from './core/migration-history.js';
import {registeredApplications} from './applications/index.js';
import {
  planStorageMigration,
  applyStorageMigration,
} from './core/storage/migrations.js';
import {
  exportManagementStorage,
  recoverManagementStorage,
} from './core/storage/recovery.js';
import {
  inspectStorageLock,
  recoverStorageLock,
} from './core/storage/coordination.js';
import {selectedStorage, closeStorage} from './core/storage/selection.js';
import {
  regularFile,
  publishJSON,
  parseStorageJSON,
} from './core/storage/files.js';

export async function storageMain(
  argv = process.argv.slice(2),
  {
    modules = registeredApplications(),
    write = (value) => console.log(JSON.stringify(value, null, 2)),
  } = {},
) {
  const [command, ...args] = argv,
    options = {};
  assert(
    [
      'status',
      'plan',
      'migrate',
      'export',
      'recover',
      'lock',
      'unlock',
      'repair-migration-history',
    ].includes(command),
    'Choose status, plan, migrate, export, recover, lock, unlock or repair-migration-history. See docs/STORAGE.md.',
  );
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert(
      [
        '--root',
        '--profile',
        '--out',
        '--plan',
        '--source',
        '--review',
        '--offline',
        '--confirm',
      ].includes(key) && !Object.hasOwn(options, key),
      'Unknown or repeated storage option.',
    );
    if (['--offline', '--confirm'].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      assert(value && !value.startsWith('--'), 'Storage option needs a value.');
      options[key] = value;
    }
  }
  const allowed = {
    'repair-migration-history': ['--root', '--offline', '--confirm'],
    status: ['--root', '--profile'],
    plan: ['--root', '--profile', '--out'],
    migrate: ['--root', '--profile', '--plan', '--offline', '--confirm'],
    export: ['--root', '--profile', '--out'],
    recover: ['--source', '--out', '--offline', '--confirm'],
    lock: ['--root', '--out'],
    unlock: ['--root', '--review', '--offline', '--confirm'],
  }[command];
  assert(
    Object.keys(options).every((key) => allowed.includes(key)),
    'This storage operation does not accept those options.',
  );
  const groups = modules.flatMap((module) => module.storage?.groups || []),
    confirmation = {
      confirm: options['--confirm'] === true,
      offline: options['--offline'] === true,
      groups,
    };
  let result, root;
  if (command !== 'recover') {
    assert(
      typeof options['--root'] === 'string',
      'Choose an explicit management storage root.',
    );
    root = await fs.realpath(options['--root']);
  }
  if (['status', 'plan', 'migrate', 'export'].includes(command))
    assert(
      ['accounts', 'controller', 'host'].includes(options['--profile']),
      'Choose accounts, controller or host storage.',
    );
  try {
    if (command === 'repair-migration-history') {
      assert(confirmation.offline && confirmation.confirm, 'Confirm host management writers are offline before repairing migration history.');
      result = await repairMigrationHistory(root);
    } else if (command === 'status') {
      const plan = await planStorageMigration(root, options['--profile'], {
        groups,
      });
      result = {
        root,
        profile: options['--profile'],
        backend: plan.selected ? 'sqlite' : 'json',
        ...(plan.selected
          ? {identity: (await selectedStorage(root)).metadata.identity}
          : {}),
        lock: await inspectStorageLock(root),
      };
    } else if (command === 'plan')
      result = await planStorageMigration(root, options['--profile'], {groups});
    else if (command === 'migrate') {
      assert(
        typeof options['--plan'] === 'string',
        'Choose the reviewed migration plan.',
      );
      const plan = parseStorageJSON(
        await regularFile(options['--plan'], {max: 4 * 1024 * 1024}),
      );
      assert(
        plan.root === root && plan.profile === options['--profile'],
        'The reviewed plan belongs to another root or profile.',
      );
      result = await applyStorageMigration(plan, confirmation);
    } else if (command === 'export') {
      assert(
        typeof options['--out'] === 'string',
        'Choose a new private export directory.',
      );
      result = await exportManagementStorage(root, options['--out'], {
        profile: options['--profile'],
        groups,
      });
    } else if (command === 'recover') {
      assert(
        typeof options['--source'] === 'string' &&
          typeof options['--out'] === 'string',
        'Choose the export and a new storage directory.',
      );
      result = await recoverManagementStorage(
        options['--source'],
        options['--out'],
        confirmation,
      );
      await closeStorage(result.directory);
    } else if (command === 'lock') result = await inspectStorageLock(root);
    else {
      assert(
        typeof options['--review'] === 'string',
        'Choose the reviewed storage lock record.',
      );
      result = await recoverStorageLock(
        root,
        parseStorageJSON(await regularFile(options['--review'], {max: 8192})),
        confirmation,
      );
    }
    if (['plan', 'lock'].includes(command) && options['--out'])
      await publishJSON(path.resolve(options['--out']), result);
    write(result);
    return result;
  } finally {
    if (root) await closeStorage(root);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  storageMain().catch((error) => {
    console.error('Management storage: ' + error.message);
    process.exitCode = 1;
  });
