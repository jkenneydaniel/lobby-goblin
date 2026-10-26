import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, writeJSON, sleep} from '../common.js';
import {definitionFingerprint} from './application-services.js';
import {createServiceApplication} from './service-application.js';
import {compileManagedDefinition} from './managed-definition.js';
import {validateApplicationModule} from './application-module.js';
import {imageMatch} from './image-policy.js';
import {demultiplex} from './docker.js';
import {zipEntries} from './archive.js';
import {boundedFileInventory, safeSnapshotPath} from './snapshot-files.js';
import {regularFile} from './storage/files.js';

const maxBackupFiles = 4096,
  maxBackupBytes = 64 * 1024 * 1024,
  maxArchiveBytes = 65 * 1024 * 1024;

// A bounded production profile for one image-owned process and one data claim.
// Multi-service provisioning and database-consistent backups need other profiles.
export function containerPresentation(source) {
  assert(
    source.services?.length === 1 &&
      source.services[0].profile === 'managed-container-v1',
    'This application needs an explicit presentation and runtime adapter.',
  );
  const fields = source.services[0].configuration.settings?.fields;
  return {
    version: 1,
    id: source.id,
    revision: source.revision,
    kind: source.kind,
    screens: [
      {
        id: 'overview',
        label: 'Overview',
        component: 'overview',
        permission: 'server.view',
        actions: ['start', 'restart', 'stop'],
        options: {fields: [{key: 'summary.state', label: 'Status'}]},
      },
      ...(fields
        ? [
            {
              id: 'settings',
              label: 'Settings',
              component: 'settings',
              permission: 'settings.read',
              options: {
                source: '/settings',
                action: 'save-settings',
                valuesKey: 'values',
                paramsKey: 'values',
                revisionKey: 'revision',
                requiresStopped: true,
                formId: 'application-settings',
                submitLabel: 'Save configuration',
                description:
                  'Stop the application before editing. Changes apply at the next start.',
                fields,
              },
            },
          ]
        : []),
      {
        id: 'logs',
        label: 'Logs',
        component: 'logs',
        permission: 'logs.read',
        options: {
          source: '/logs',
          key: 'logs',
          description: 'Recent application logs.',
        },
      },
      {
        id: 'backups',
        label: 'Backups',
        component: 'backups',
        permission: 'backups.read',
        options: {
          description:
            'Stop the application before backing up its data. Clone a verified snapshot to recover into a new instance.',
        },
      },
      {
        id: 'operations',
        label: 'Operations',
        component: 'operations',
        adminOnly: true,
      },
      {
        id: 'accounts',
        label: 'Accounts',
        component: 'accounts',
        permission: 'account.self',
      },
    ],
  };
}

export function createContainerApplication(definition) {
  const service = definition.services[0],
    data = service.configuration,
    policy = data.imagePolicy;
  assert(
    definition.services.length === 1 &&
      service.profile === 'managed-container-v1' &&
      !definition.secrets?.length &&
      !definition.deployment &&
      !service.secretRefs?.length,
    'The container profile supports one service without private providers or deployment tasks.',
  );
  assert(
    data.secrets?.length === 0 &&
      !data.helpers.previewWorker &&
      data.helpers.archiveReadPaths.length === 0 &&
      data.helpers.execCommands.length === 0,
    'Container packages cannot declare privileged helpers.',
  );
  assert(
    (service.software?.mode || 'image') === 'image',
    'Container software must be supplied by its reviewed image.',
  );
  const settings = data.settings;
  assert(
    !settings ||
      (settings.version === 1 &&
        Object.keys(settings).every((key) =>
          ['version', 'file', 'fields'].includes(key),
        ) &&
        /^[a-z][a-z0-9-]*\.json$/.test(settings.file)),
    'Use a JSON configuration file at the data root.',
  );
  const prefix = definition.id.replaceAll('-', '_').toUpperCase() + '_';
  const configuration = (env) => {
    const root = path.resolve(env[prefix + 'ROOT'] || '/instance');
    assert(
      root !== '/',
      'Application storage needs a dedicated installation root.',
    );
    return {
      container: env[prefix + 'CONTAINER'],
      data: path.join(root, 'data'),
      state: path.join(root, 'state'),
      library: path.join(root, 'library'),
      backupDir: path.join(root, 'backups', data.storage.backupDirectory),
    };
  };
  if (settings)
    assert(
      JSON.stringify(
        definition.presentation.screens.find(
          (screen) => screen.component === 'settings',
        )?.options.fields,
      ) === JSON.stringify(settings.fields),
      'Presentation and runtime settings fields differ.',
    );
  const archive = (buffer) => {
    assert(
      buffer.length <= maxArchiveBytes,
      'Application archive is too large.',
    );
    const entries = zipEntries(buffer);
    assert(
      entries.reduce((sum, entry) => sum + entry.size, 0) <= maxBackupBytes &&
        entries.length <= maxBackupFiles &&
        entries.every((entry) => safeSnapshotPath(entry.name)),
      'Unsupported application archive.',
    );
    for (const entry of entries) entry.read();
    return entries;
  };
  async function files(root) {
    const inventory = await boundedFileInventory(root, {
      maxFiles: maxBackupFiles,
      maxBytes: maxBackupBytes,
      maxEntries: 8192,
      maxDepth: 32,
    });
    assert(
      inventory.length > 0 &&
        inventory.length <= maxBackupFiles &&
        inventory.reduce((sum, item) => sum + item.size, 0) <= maxBackupBytes,
      'Application backups require 1–4096 files within 64 MiB.',
    );
    // makeZip stores each name in its 30-byte local and 46-byte central
    // headers, followed by a 22-byte end record. Check the complete ZIP size
    // before reading data, including UTF-8 names in both headers.
    assert(
      22 +
        inventory.reduce(
          (sum, item) =>
            sum + item.size + 76 + 2 * Buffer.byteLength(item.name),
          0,
        ) <=
        maxArchiveBytes,
      'Application backup including ZIP metadata exceeds 65 MiB.',
    );
    const result = [];
    for (const item of inventory) {
      const data = await regularFile(path.join(root, item.name), {
        max: item.size,
      });
      assert(
        data.length === item.size,
        'Application data changed during backup.',
        409,
      );
      result.push({name: item.name, data});
    }
    return result;
  }
  const module = createServiceApplication(definition, {
    configuration,
    ...(settings
      ? {
          configurationFile: (ctx) => path.join(ctx.config.data, settings.file),
          configurationSaved: (file) => fs.chmod(file, 0o640),
        }
      : {}),
    backup: {
      files: (ctx) => files(ctx.config.data),
      validate: (buffer) => ({files: archive(buffer).length}),
    },
    profiles: {
      'managed-container-v1': {
        roles: ['web', 'service', 'worker'],
        imagePolicy: policy,
        validate() {},
        create(ctx) {
          const inspect = async () => {
            const info = await ctx.host.info();
            const running = info.State?.Running === true;
            return {
              running,
              ready: running && info.State.Health?.Status === 'healthy',
              error:
                running && !info.State.Health
                  ? 'The image needs a Docker health check.'
                  : null,
            };
          };
          return {
            inspect,
            start: () => ctx.host.control('start'),
            stop: () => ctx.host.control('stop'),
            logs: async () =>
              demultiplex(
                await ctx.docker(
                  'GET',
                  `/containers/${encodeURIComponent(ctx.config.container)}/logs?stdout=true&stderr=true&tail=100`,
                  undefined,
                  {raw: true},
                ),
              ),
            async waitReady() {
              for (let attempt = 0; attempt < 60; attempt++) {
                const state = await inspect();
                if (state.ready) return;
                assert(
                  state.running && !state.error,
                  state.error || 'Application stopped before readiness.',
                  409,
                );
                await sleep(1000);
              }
              assert(
                false,
                'Application readiness timed out. Review its logs.',
                409,
              );
            },
          };
        },
      },
    },
  });
  module.managed = compileManagedDefinition(definition, {
    async prepareStorage() {},
    async configureStorage({instance, config}) {
      await fs.chmod(path.join(instance, 'data'), 0o770);
      await fs.mkdir(path.join(instance, 'library'));
      await fs.mkdir(
        path.join(instance, 'backups', data.storage.backupDirectory),
      );
      await writeJSON(
        path.join(instance, 'state/application-definition.json'),
        {
          id: definition.id,
          revision: definition.revision,
          sha256: definitionFingerprint(definition),
        },
      );
      if (settings) {
        const file = path.join(instance, 'data', settings.file);
        if (!config.snapshotId)
          await writeJSON(
            file,
            Object.fromEntries(
              settings.fields.map((field) => [
                field.key,
                field.default ??
                  (field.type === 'boolean'
                    ? false
                    : field.type === 'number'
                      ? field.min
                      : ''),
              ]),
            ),
          );
        await fs.chmod(file, 0o640);
      }
    },
    snapshots: {
      // A clone retains the exact image; cross-image data migrations need review.
      compatible: (from, to) =>
        !!imageMatch(policy, from) &&
        !!imageMatch(policy, to) &&
        from.split('@')[0] === to.split('@')[0] &&
        (!from.includes('@') || !to.includes('@') || from === to),
      async collect({backup, content}) {
        for (const entry of archive(
          await regularFile(backup, {max: maxArchiveBytes}),
        )) {
          const file = path.join(content, entry.name);
          await fs.mkdir(path.dirname(file), {recursive: true});
          await fs.writeFile(file, entry.read(), {flag: 'wx', mode: 0o600});
        }
      },
      async restore({root, data: destination, manifest}) {
        for (const item of manifest.files) {
          assert(
            safeSnapshotPath(item.name),
            'Invalid application snapshot path.',
          );
          const file = path.join(destination, item.name);
          await fs.mkdir(path.dirname(file), {recursive: true});
          await fs.writeFile(
            file,
            await regularFile(path.join(root, item.name), {
              max: maxBackupBytes,
            }),
            {flag: 'wx', mode: 0o660},
          );
          await fs.chmod(file, 0o660);
          let directory = path.dirname(file);
          while (directory !== destination) {
            await fs.chmod(directory, 0o770);
            directory = path.dirname(directory);
          }
        }
      },
    },
  });
  return validateApplicationModule(module);
}
