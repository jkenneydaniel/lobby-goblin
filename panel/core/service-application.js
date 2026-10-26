import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, json, writeJSON, redact, HttpError} from '../common.js';
import {action, backupActions} from './game-contract.js';
import {
  ApplicationServices,
  applicationMetadata,
  definitionFingerprint,
  serviceOrder,
} from './application-services.js';
import {presentationScreens} from './application-presentation.js';
import {applicationWeb} from './application-web.js';
import {noManagedUpdater} from './managed-updater.js';
import {validateApplicationModule} from './application-module.js';
import {applicationDefinition} from './application-definition.js';
import {
  ApplicationDeployment,
  validateDeployment,
} from './application-deployment.js';
import {regularFile, parseStorageJSON} from './storage/files.js';
import {withStorageLock} from './storage/coordination.js';

// Reusable non-game adapter. Runtime and backup providers are trusted registered
// code, chosen at package registration, never functions/paths from a request.
// A managed runtime provider supplies Docker-host provisioning when supported.
export function createServiceApplication(
  definition,
  {
    configuration,
    profiles,
    backup,
    secretProviders = {},
    configurationFile,
    configurationSaved,
  },
) {
  definition = applicationDefinition(definition);
  serviceOrder(definition);
  assert(
    typeof configuration === 'function' &&
      backup &&
      typeof backup.files === 'function' &&
      typeof backup.validate === 'function',
    'Application needs installation and backup providers.',
  );
  for (const service of definition.services) {
    assert(
      Object.hasOwn(profiles, service.profile) &&
        Array.isArray(profiles[service.profile].roles) &&
        profiles[service.profile].roles.includes(service.role) &&
        typeof profiles[service.profile].create === 'function',
      'Unknown or incompatible application runtime profile.',
    );
    if (service.configuration !== undefined) {
      assert(
        typeof profiles[service.profile].validate === 'function',
        'Runtime configuration needs a registered profile validator.',
      );
      profiles[service.profile].validate(service.configuration, service);
    }
  }
  for (const secret of definition.secrets || [])
    assert(
      Object.hasOwn(secretProviders, secret.provider) &&
        typeof secretProviders[secret.provider] === 'function',
      'Application secret reference needs a registered private provider.',
    );
  validateDeployment(definition, profiles);
  const deploymentPolicy = definition.deployment;
  const presentation = definition.presentation,
    settings = presentation.screens.find(
      (screen) => screen.component === 'settings',
    )?.options;
  assert(
    presentation.kind === definition.kind &&
      presentation.revision === definition.revision,
    'Application and presentation revisions differ.',
  );
  if (settings)
    assert(
      settings.source === '/settings' &&
        settings.action === 'save-settings' &&
        settings.valuesKey === 'values' &&
        settings.paramsKey === 'values' &&
        settings.revisionKey === 'revision' &&
        settings.requiresStopped === true &&
        settings.fields.every(
          (field) => field.type !== 'password' && !field.visibleWhen,
        ),
      'The JSON settings provider requires a stopped application, revision checks and separately managed secrets.',
    );
  const routes = {
    '/services': {GET: 'viewer'},
    '/logs': {GET: 'admin'},
    ...(settings ? {'/settings': {GET: 'admin'}} : {}),
    ...(deploymentPolicy ? {'/deployment': {GET: 'viewer'}} : {}),
  };
  const contract = {
    version: 2,
    screens: presentationScreens(presentation),
    features: {
      settings: !!settings,
      backups: true,
      scheduledBackups: backup.scheduleSafe === true,
      deployment: !!deploymentPolicy,
    },
    backup: {
      strategy: 'files',
      extension: '.zip',
      mediaType: 'application/zip',
      interruption: false,
    },
    actions: {
      ...backupActions(),
      start: action('Start application', false, 'convergent', 'server.operate'),
      stop: action('Stop application', true, 'convergent', 'server.operate'),
      restart: action('Restart application', true, 'manual', 'server.operate'),
      ...(settings
        ? {
            'save-settings': action(
              'Save configuration',
              false,
              'manual',
              'settings.write',
            ),
          }
        : {}),
      ...(deploymentPolicy
        ? {
            deploy: action(
              'Deploy application',
              true,
              'manual',
              deploymentPolicy.permission,
            ),
          }
        : {}),
    },
    routes,
    policy: {
      version: 1,
      permissions: deploymentPolicy
        ? {[deploymentPolicy.permission]: 'Deploy this application'}
        : {},
      routes: {
        '/services': {GET: 'server.view'},
        '/logs': {GET: 'logs.read'},
        ...(settings ? {'/settings': {GET: 'settings.read'}} : {}),
        ...(deploymentPolicy ? {'/deployment': {GET: 'server.view'}} : {}),
      },
    },
  };
  const module = {
    id: definition.id,
    name: definition.name,
    definition,
    presentation,
    application: applicationMetadata(definition),
    contract,
    routes: Object.keys(routes),
    imagePolicy:
      profiles[
        definition.services.find((service) => service.id === definition.primary)
          .profile
      ].imagePolicy,
    releaseRepository: 'jkenneydaniel/lobby-goblin',
    configuration,
    createUpdater: ({current}) => noManagedUpdater(current),
    diagnostics: async () => ({checks: []}),
    web: applicationWeb(definition.id, contract),
    async validateInstallation(config) {
      const roots = [
        config.state,
        config.library,
        config.backupDir,
        ...(config.data ? [config.data] : []),
      ];
      assert(
        roots.every(
          (root) =>
            typeof root === 'string' && path.isAbsolute(root) && root !== '/',
        ) &&
          roots.every((root, index) =>
            roots.every(
              (other, otherIndex) =>
                index === otherIndex ||
                (root !== other && !root.startsWith(other + '/')),
            ),
          ),
        'Application storage needs separate absolute roots.',
      );
      for (const root of roots)
        assert(
          (await fs.realpath(root)) === root,
          'Application storage cannot use symbolic links.',
        );
      const file = path.join(config.state, 'application-definition.json'),
        stat = await fs.lstat(file);
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2048,
        'Application definition marker must be a small regular file.',
      );
      const marker = parseStorageJSON(await regularFile(file, {max: 2048}));
      assert(
        marker?.id === definition.id &&
          marker.revision === definition.revision &&
          marker.sha256 === definitionFingerprint(definition),
        'The installed application definition revision or contents differ. Review a migration before starting management.',
        409,
      );
    },
    async createController(ctx) {
      const secretValues = {};
      for (const secret of definition.secrets || []) {
        let value;
        try {
          value = await secretProviders[secret.provider]({
            config: ctx.config,
            application: definition.id,
            instance: ctx.env.FLEET_INSTANCE || null,
            name: secret.id,
          });
        } catch {
          throw new HttpError(
            503,
            'Application secret provider is unavailable.',
          );
        }
        assert(
          typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 65536,
          'Application secret provider returned an unsupported value.',
          503,
        );
        secretValues[secret.id] = value;
      }
      const privateSecrets = (service) =>
        Object.freeze(
          Object.fromEntries(
            (service.secretRefs || []).map((name) => [
              name,
              secretValues[name],
            ]),
          ),
        );
      const sanitize = (value) => {
        let text = String(value);
        for (const secret of Object.values(secretValues).sort(
          (a, b) => b.length - a.length,
        ))
          text = text.replaceAll(secret, '[redacted]');
        return redact(text);
      };
      const drivers = {};
      for (const service of definition.services) {
        try {
          drivers[service.id] = await profiles[service.profile].create(
            ctx,
            service,
            {secrets: privateSecrets(service)},
          );
        } catch (error) {
          throw new HttpError(503, sanitize(error.message));
        }
      }
      const runtime = new ApplicationServices(definition, drivers, {sanitize}),
        file = configurationFile
          ? configurationFile(ctx)
          : path.join(ctx.config.state, 'application-configuration.json');
      let recent = null;
      function validateValues(values) {
        assert(
          values &&
            typeof values === 'object' &&
            !Array.isArray(values) &&
            Object.keys(values).length === settings.fields.length &&
            settings.fields.every((field) => Object.hasOwn(values, field.key)),
          'Choose only the declared configuration fields.',
        );
        for (const field of settings.fields) {
          const value = values[field.key];
          if (field.type === 'number')
            assert(
              Number.isInteger(value) &&
                (field.min === undefined || value >= field.min) &&
                (field.max === undefined || value <= field.max),
              'Invalid ' + field.label + '.',
            );
          else if (field.type === 'boolean')
            assert(typeof value === 'boolean', 'Invalid ' + field.label + '.');
          else
            assert(
              typeof value === 'string' &&
                (!field.required || value.trim().length > 0) &&
                (field.max === undefined || value.length <= field.max) &&
                !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),
              'Invalid ' + field.label + '.',
            );
        }
      }
      async function readSettings() {
        const bytes = await regularFile(file, {
            optional: true,
            max: 1024 * 1024,
          }),
          text = bytes?.toString() || '';
        const values = text
          ? parseStorageJSON(text)
          : Object.fromEntries(
              settings.fields.map((field) => [
                field.key,
                field.default ??
                  (field.type === 'boolean'
                    ? false
                    : field.type === 'number'
                      ? (field.min ?? 0)
                      : ''),
              ]),
            );
        validateValues(values);
        return {
          values,
          revision: crypto.createHash('sha256').update(text).digest('hex'),
        };
      }
      const deployment = deploymentPolicy
        ? new ApplicationDeployment(definition, profiles, {
            ctx,
            runtime,
            configuration: async () =>
              settings ? (await readSettings()).values : {},
            privateSecrets,
          })
        : null;
      async function status() {
        const state = await runtime.status();
        recent = {
          ...state,
          ...(state.running === null ? {running: undefined} : {}),
          name: definition.name,
          connection: ctx.env.APPLICATION_ADDRESS || ctx.env.GAME_ADDRESS || '',
          activeJob: ctx.active,
        };
        return recent;
      }
      const actions = {
        start: async () => {
          await deployment?.requireReady();
          await runtime.start(settings ? (await readSettings()).values : {});
          return 'Application services are ready.';
        },
        stop: async () => {
          await runtime.stop();
          return 'Application services are stopped.';
        },
        restart: async () => {
          await deployment?.requireReady();
          const values = settings ? (await readSettings()).values : {};
          await runtime.stop();
          await runtime.start(values);
          return 'Application services have restarted.';
        },
        ...(deployment
          ? {deploy: (params, job) => deployment.run(params, job)}
          : {}),
        ...(settings
          ? {
              'save-settings': async (params) =>
                withStorageLock(ctx.config.state, 'write', async () => {
                  assert(
                    (await runtime.status()).running === false,
                    'Stop all application services before saving configuration.',
                    409,
                  );
                  validateValues(params.values);
                  assert(
                    params.revision === (await readSettings()).revision,
                    'Configuration changed. Reload before saving.',
                    409,
                  );
                  await writeJSON(file, params.values);
                  await configurationSaved?.(file);
                  return 'Configuration saved. It applies at the next start.';
                }),
            }
          : {}),
      };
      return {
        actions,
        status,
        recentStatus: () => recent,
        locations: [],
        invalidate() {
          recent = null;
        },
        async inspectOperation(job) {
          if (job.action === 'deploy' && deployment)
            return deployment.recover();
          const state = await runtime.status();
          if (
            job.action === 'start' &&
            state.services.every((service) => service.ready)
          )
            return {
              outcome: 'succeeded',
              message: 'All application services have reached readiness.',
            };
          if (
            job.action === 'stop' &&
            state.services.every((service) => service.running === false)
          )
            return {
              outcome: 'succeeded',
              message: 'All application services are stopped.',
            };
          return {
            message:
              'Review individual application services and their logs. No operation has been replayed.',
          };
        },
        async init() {},
        async start() {},
        async beforeJob() {},
        async afterJob(job) {
          if (job.action === 'deploy') deployment?.after(job);
        },
        async waitIdle() {},
        validateAction(body) {
          if (body.action === 'save-settings') {
            validateValues(body.params?.values);
            assert(
              typeof body.params?.revision === 'string',
              'Reload configuration first.',
            );
          }
          if (body.action === 'deploy')
            assert(
              body.params?.confirm === true &&
                Object.keys(body.params).every((key) => key === 'confirm'),
              'Confirm the declared deployment without task overrides.',
            );
        },
        validateSchedule(value) {
          assert(
            !value.enabled || backup.scheduleSafe === true,
            'This application requires an explicit stopped backup; automatic backups are unavailable.',
            409,
          );
        },
        async backupFiles() {
          assert(
            (await runtime.status()).running === false,
            'Stop all application services before creating a consistent backup.',
            409,
          );
          return backup.files(ctx);
        },
        validateBackup: backup.validate,
        backupVerified: (result) =>
          `Application archive verified: ${result.files} files.`,
        async handle(req, res, url) {
          if (url.pathname === '/services')
            return json(res, 200, {
              services: (await runtime.status()).services,
            });
          if (url.pathname === '/logs')
            return json(res, 200, {logs: await runtime.logs()});
          if (url.pathname === '/deployment' && deployment)
            return json(res, 200, {steps: await deployment.observations()});
          if (url.pathname === '/settings' && settings) {
            const value = await readSettings();
            return json(res, 200, {
              ...value,
              editable:
                (await runtime.status()).running === false && !ctx.active,
              message: settings.description,
            });
          }
          assert(false, 'Not found.', 404);
        },
      };
    },
  };
  return validateApplicationModule(module);
}
