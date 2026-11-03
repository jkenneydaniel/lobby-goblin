import {mountOperationHistory} from '../shared/operation-history.js';
import {formatBytes} from '../shared/view.js';
import {mountBackups} from '../shared/backups.js';
import {mountAccounts} from '../shared/accounts.js';
import {
  actionAvailable,
  fieldControl,
  mountActionForms,
} from './action-forms.js';

const read = (value, key) =>
  key
    .split('.')
    .reduce(
      (current, name) =>
        current && Object.hasOwn(current, name) ? current[name] : undefined,
      value,
    );
function display(value, format) {
  if (value == null) return '—';
  if (format === 'bytes') return formatBytes(value);
  if (format === 'percent')
    return Number.isFinite(value) ? value.toFixed(1) + '%' : '—';
  if (format === 'integer')
    return Number.isFinite(value) ? value.toFixed(0) : '—';
  if (format === 'minutes')
    return Number.isFinite(value) ? Math.floor(value / 60) + ' min' : '—';
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value)
    : '—';
}

// Components own their templates, state, requests and event lifetime. An
// application supplies data descriptors, not page HTML or event-handler code.
export function createApplicationComponents({
  presentation,
  contract,
  clone,
  getStatus,
  getSession,
  sessionController,
  operations,
  can,
  canAction,
  startJob,
  notify,
  extensions = {},
  extensionContext = {},
  onSignedOut,
}) {
  const busy = () =>
    operations.busy ||
    !!getStatus()?.activeJob ||
    !!getStatus()?.managementBusy ||
    !!getStatus()?.imageMigration;
  const forms = (ctx, options, drafts) =>
    mountActionForms(ctx, options.forms, {
      clone,
      canAction,
      busy,
      getStatus,
      startJob,
      drafts,
    });
  function paint(ctx, name) {
    ctx.root.replaceChildren(clone(name));
  }
  function metrics(ctx, fields, value) {
    const container = ctx.root.querySelector('[data-fields]');
    container.replaceChildren();
    for (const field of fields) {
      const fragment = clone('metric');
      fragment.querySelector('[data-label]').textContent = field.label;
      const output = fragment.querySelector('[data-value]');
      if (field.id) output.id = field.id;
      output.textContent = display(read(value, field.key), field.format);
      container.append(fragment);
    }
  }
  function actionButtons(ctx, screen) {
    const container = ctx.root.querySelector('[data-actions]');
    for (const action of screen.actions || []) {
      if (!canAction(action)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.textContent =
        screen.options?.actionLabels?.[action] ||
        {start: 'Start', stop: 'Stop', restart: 'Restart'}[action] ||
        contract.actions[action].label;
      container.append(button);
      ctx.on(button, 'click', () => startJob(action));
    }
  }
  function setBusy(ctx, screen) {
    for (const button of ctx.root.querySelectorAll('button[data-action]'))
      button.disabled =
        busy() ||
        !getStatus() ||
        !actionAvailable(
          getStatus(),
          screen?.options?.actionAvailability?.[button.dataset.action] ||
            {start: 'stopped', stop: 'running', restart: 'running'}[
              button.dataset.action
            ],
        );
  }
  const factories = {};
  for (const screen of presentation.screens) {
    const options = screen.options || {};
    if (screen.component === 'extension') {
      const extension = extensions[options.provider];
      if (!extension || extension.version !== options.version)
        throw Error('Unavailable application extension: ' + options.provider);
      factories[screen.id] = () =>
        extension.create({
          getStatus,
          getSession,
          busy,
          can,
          job: startJob,
          notify,
          ...extensionContext,
        });
    } else if (screen.component === 'overview')
      factories[screen.id] = () => ({
        mount(ctx) {
          paint(ctx, 'overview');
          actionButtons(ctx, screen);
          this.refresh(ctx);
        },
        refresh(ctx) {
          const value = getStatus();
          setBusy(ctx, screen);
          if (!value) return;
          ctx.root.querySelector('#server-name').textContent =
            value.name || contract.name;
          ctx.root.querySelector('#game-address').textContent =
            value.connection || '';
          metrics(ctx, options.fields, value);
          const resume = ctx.root.querySelector('[data-onboarding-resume]');
          resume.hidden = !(
            presentation.onboarding &&
            getSession()?.role === 'admin' &&
            getSession().onboarding?.completed === false
          );
          if (!resume.hidden) {
            const link = resume.querySelector('a');
            link.href = '#' + presentation.onboarding.screen;
            link.textContent = presentation.onboarding.resumeLabel;
          }
          const list = ctx.root.querySelector('#jobs');
          list.replaceChildren();
          for (const job of operations.jobs.slice(0, 8)) {
            const row = clone('operation');
            row.querySelector('[data-action]').textContent =
              contract.actions[job.action]?.label || job.action;
            row.querySelector('[data-message]').textContent = job.message;
            row.querySelector('[data-time]').textContent =
              new Date(job.started).toLocaleString() + ' · ' + job.actor;
            row.querySelector('[data-state]').textContent = job.state;
            list.append(row);
          }
          if (!operations.jobs.length) list.textContent = 'No operations yet.';
        },
      });
    else if (screen.component === 'resource')
      factories[screen.id] = () => {
        async function load(ctx) {
          metrics(ctx, options.fields, await ctx.request(options.source));
          setBusy(ctx, screen);
        }
        return {
          async mount(ctx) {
            paint(ctx, 'resource');
            ctx.root.querySelector('[data-heading]').textContent =
              options.heading || screen.label;
            actionButtons(ctx, screen);
            await load(ctx);
          },
          async refresh(ctx, reason) {
            if (reason.reason === 'status') setBusy(ctx, screen);
            else await load(ctx);
          },
        };
      };
    else if (screen.component === 'table')
      factories[screen.id] = () => {
        const drafts = new Map(),
          rowActions = new WeakMap();
        let controls;
        async function load(ctx) {
          const note = ctx.root.querySelector('[data-note]');
          note.textContent = 'Loading…';
          const response = await ctx.request(options.source),
            rows = read(response, options.collection);
          if (!Array.isArray(rows))
            throw Error('The application returned an invalid table response.');
          const available =
            !options.availableKey ||
            read(response, options.availableKey) !== false;
          note.textContent = available
            ? rows.length
              ? ''
              : options.empty || 'No records.'
            : read(response, options.messageKey || 'message') || 'Unavailable';
          const body = ctx.root.querySelector('[data-rows]');
          body.replaceChildren();
          for (const value of rows) {
            const row = document.createElement('tr');
            for (const field of options.fields) {
              const cell = document.createElement('td');
              cell.textContent = display(read(value, field.key), field.format);
              row.append(cell);
            }
            body.append(row);
            const choices = (options.rowActions || []).filter((action) =>
              canAction(action.action),
            );
            if (choices.length) {
              const cell = document.createElement('td');
              for (const action of choices) {
                const button = document.createElement('button');
                button.textContent = action.label;
                button.type = 'button';
                button.dataset.rowAction = action.action;
                button.disabled = busy();
                rowActions.set(button, {action, value});
                cell.append(button);
              }
              row.append(cell);
            }
          }
        }
        return {
          async mount(ctx) {
            paint(ctx, 'table');
            actionButtons(ctx, screen);
            setBusy(ctx, screen);
            ctx.root.querySelector('[data-heading]').textContent =
              options.heading || screen.label;
            const refresh = ctx.root.querySelector('[data-refresh]');
            refresh.textContent = options.refreshLabel;
            for (const field of options.fields) {
              const cell = document.createElement('th');
              cell.textContent = field.label;
              ctx.root.querySelector('[data-columns]').append(cell);
            }
            ctx.on(refresh, 'click', () => load(ctx));
            ctx.on(
              ctx.root.querySelector('[data-rows]'),
              'click',
              async (event) => {
                const button = event.target.closest('[data-row-action]'),
                  selection = button && rowActions.get(button);
                if (!selection || busy()) return;
                const {action, value} = selection,
                  params = {...action.params};
                for (const [key, path] of Object.entries(action.bindings))
                  params[key] = read(value, path);
                if (action.confirmation) {
                  if (
                    !(await ctx.confirm(
                      action.confirmation.title,
                      action.confirmation.message +
                        '\nSelected: ' +
                        Object.values(action.bindings)
                          .map((path) => display(read(value, path)))
                          .join(', '),
                    ))
                  )
                    return;
                  params.confirm = true;
                }
                if (ctx.isCurrent() && button.isConnected)
                  await startJob(action.action, params);
              },
            );
            controls = forms(ctx, options, drafts);
            controls.setBusy();
            await load(ctx);
          },
          async refresh(ctx, reason) {
            if (reason.reason !== 'status') await load(ctx);
            else controls.setBusy();
            setBusy(ctx, screen);
            for (const button of ctx.root.querySelectorAll('[data-row-action]'))
              button.disabled = busy();
          },
        };
      };
    else if (screen.component === 'logs')
      factories[screen.id] = () => {
        const drafts = new Map();
        let controls;
        async function load(ctx) {
          ctx.root.querySelector('#logs').textContent =
            read(await ctx.request(options.source), options.key) ||
            'No log output yet.';
        }
        return {
          async mount(ctx) {
            paint(ctx, 'logs');
            ctx.root.querySelector('[data-description]').textContent =
              options.description;
            ctx.on(ctx.root.querySelector('#refresh-logs'), 'click', () =>
              load(ctx),
            );
            controls = forms(ctx, options, drafts);
            controls.setBusy();
            await load(ctx);
          },
          async refresh(ctx, reason) {
            if (reason.reason !== 'status') await load(ctx);
            else controls.setBusy();
          },
        };
      };
    else if (screen.component === 'settings')
      factories[screen.id] = () => {
        let settings = null,
          draft = null,
          loading = 0;
        const editable = () =>
          can('settings.write') && settings?.editable !== false;
        function controls(ctx) {
          return [...ctx.root.querySelectorAll('[name]')];
        }
        function values(ctx) {
          return Object.fromEntries(
            controls(ctx).map((input) => [
              input.name,
              input.type === 'checkbox'
                ? input.checked
                : input.type === 'number'
                  ? Number(input.value)
                  : input.value,
            ]),
          );
        }
        function update(ctx) {
          const locked =
            busy() ||
            !getStatus() ||
            (options.requiresStopped && getStatus().running) ||
            !editable();
          for (const input of controls(ctx)) input.disabled = locked;
          ctx.root.querySelector('[type=submit]').disabled = locked;
        }
        function fields(ctx) {
          const container = ctx.root.querySelector('[data-settings-fields]');
          container.replaceChildren();
          for (const field of options.fields) {
            if (field.visibleWhen && read(settings, field.visibleWhen) !== true)
              continue;
            const row = clone('field');
            row.querySelector('[data-label]').textContent = field.label;
            const value =
              draft?.values[field.key] ??
              (options.valuesKey ? settings[options.valuesKey] : settings)[
                field.key
              ] ??
              field.default;
            const input = fieldControl(
              field,
              field.type === 'password' && !draft ? '' : value,
            );
            row.querySelector('[data-control]').replaceWith(input);
            row.querySelector('[data-help]').textContent = field.help || '';
            container.append(row);
          }
        }
        async function load(ctx) {
          const version = ++loading;
          const value = await ctx.request(options.source);
          if (version !== loading) return;
          settings = value;
          ctx.root.querySelector('#settings-note').textContent =
            draft &&
            options.revisionKey &&
            draft.revision !== settings[options.revisionKey]
              ? 'Settings changed while you were away. Your draft is retained; reload before saving it.'
              : settings.message || options.description;
          fields(ctx);
          update(ctx);
        }
        return {
          async mount(ctx) {
            paint(ctx, 'settings');
            const form = ctx.root.querySelector('[data-configuration]');
            form.id = options.formId;
            form.querySelector('button').textContent = options.submitLabel;
            ctx.on(
              ctx.root.querySelector('[data-reload-settings]'),
              'click',
              async () => {
                if (
                  draft &&
                  !(await ctx.confirm(
                    'Discard unsaved configuration?',
                    'Reload the saved configuration and discard this local draft.',
                  ))
                )
                  return;
                draft = null;
                await load(ctx);
              },
            );
            ctx.on(form, 'input', () => {
              if (settings)
                draft = {
                  values: values(ctx),
                  revision: draft?.revision ?? settings[options.revisionKey],
                };
            });
            ctx.on(form, 'submit', async (event) => {
              event.preventDefault();
              if (
                !editable() ||
                busy() ||
                (options.requiresStopped && getStatus()?.running)
              )
                return;
              const input = values(ctx),
                params = options.paramsKey
                  ? {[options.paramsKey]: input}
                  : input;
              if (options.revisionKey)
                params[options.revisionKey] =
                  draft?.revision ?? settings[options.revisionKey];
              await startJob(options.action, params);
            });
            await load(ctx);
          },
          async refresh(ctx, reason) {
            if (reason.reason === 'status') update(ctx);
            else {
              if (
                reason.reason === 'operation' &&
                reason.action === options.action &&
                reason.state === 'succeeded'
              )
                draft = null;
              await load(ctx);
            }
          },
        };
      };
    else if (['accounts', 'backups'].includes(screen.component))
      factories[screen.id] = () => {
        let workflow;
        return {
          async mount(ctx) {
            workflow =
              screen.component === 'accounts'
                ? mountAccounts(ctx.root, {
                    request: ctx.request,
                    showHeading: false,
                    session: sessionController,
                    confirm: ctx.confirm,
                    notify,
                    onSignedOut,
                    ...(options.showHeading !== undefined
                      ? {showHeading: options.showHeading}
                      : {}),
                  })
                : mountBackups(ctx.root, {
                    request: ctx.request,
                    showHeading: false,
                    startJob,
                    isAdmin: () => getSession()?.role === 'admin',
                    allow: can,
                    busy,
                    confirm: ctx.confirm,
                    notify,
                    interruption: contract.backup.interruption,
                    description: options.description,
                    restore: options.restore === true,
                    ...(options.showHeading !== undefined
                      ? {showHeading: options.showHeading}
                      : {}),
                  });
            await workflow.load();
          },
          async refresh(_ctx, reason) {
            if (reason.reason === 'status') workflow.setBusy?.();
            else
              await workflow.load({
                preserveSchedule: reason.preserveSchedule === true,
              });
          },
          dispose() {
            workflow?.dispose();
            workflow = null;
          },
        };
      };
    else if (screen.component === 'mod-library')
      factories[screen.id] = () => {
        let workflow;
        return {
          async mount(ctx) {
            paint(ctx, 'mod-library');
            ctx.root.querySelector('[data-description]').textContent =
              options.description;
            const {mountModLibrary} = await import('../mod-library.js');
            if (!ctx.isCurrent()) return;
            workflow = mountModLibrary(ctx.root.querySelector('#mod-library'), {
              api: (route, body) =>
                ctx.request(
                  route,
                  body === undefined ? {} : {method: 'POST', body},
                ),
              job: (...args) =>
                ctx.isCurrent() ? startJob(...args) : undefined,
              manageAccount: getSession()?.role === 'admin',
              busy,
            });
          },
          async refresh(ctx, reason) {
            if (reason.reason !== 'status') {
              workflow?.dispose();
              await this.mount(ctx);
            }
          },
          dispose() {
            workflow?.dispose();
            workflow = null;
          },
        };
      };
    else if (screen.component === 'operations')
      factories[screen.id] = () => {
        let history;
        return {
          async mount(ctx) {
            history = await mountOperationHistory(ctx, {
              onRecovery: () => operations.refresh(),
            });
          },
          async refresh(ctx, reason) {
            await history?.refresh(ctx, reason);
          },
        };
      };
    else if (screen.component === 'diagnostics')
      factories[screen.id] = () => ({
        async mount(ctx) {
          const report = await ctx.request('/diagnostics'),
            {diagnosticsPage, downloadJSON} = await import('../diagnostics.js');
          if (!ctx.isCurrent()) return;
          ctx.render(diagnosticsPage(report));
          const run = ctx.root.querySelector('#run-diagnostics'),
            download = ctx.root.querySelector('#download-diagnostics');
          if (run) ctx.on(run, 'click', () => this.mount(ctx));
          if (download)
            ctx.on(download, 'click', () =>
              downloadJSON(report, 'lobby-goblin-support-report.json'),
            );
        },
        refresh(ctx, reason) {
          if (reason.reason !== 'status') return this.mount(ctx);
        },
      });
    else throw Error('Unknown application component: ' + screen.component);
  }
  return factories;
}
