import {createStorageScreen} from './storage-screen.js';
import {createUpdatesScreen} from './updates-screen.js';
import {createSnapshotScreen} from './snapshot-screen.js';
import {mountOperationHistory} from '../shared/operation-history.js';
import {serverCards} from './cards.js';
import {serverKey} from './host-paths.js';
import {mountAccounts} from '../shared/accounts.js';
import {createHostSettings} from './host-settings.js';
import {mountHosts} from './hosts.js';
import {welcomeView} from './onboarding.js';

export function createFleetScreens({
  model,
  getSession,
  sessionController,
  creation,
  error,
  notice,
  onReady,
}) {
  const $ = (selector) => document.querySelector(selector),
    admin = () => getSession()?.role === 'admin';
  const apiFor = (ctx) => (route, body) =>
    ctx.request(route, body === undefined ? {} : {method: 'POST', body});
  const showError = (ctx) => (message) => {
    if (ctx.isCurrent()) error(message);
  };
  function bindDialogs(ctx) {
    for (const id of ['publish', 'remove'])
      ctx.on($('#' + id), 'submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const route = model.route(
          form.elements.hostId.value,
          '/servers/' +
            form.elements.serverId.value +
            (id === 'publish' ? '/snapshot' : '/remove'),
        );
        try {
          await ctx.request(route, {
            method: 'POST',
            body:
              id === 'publish'
                ? {
                    title: form.elements.title.value,
                    confirm: form.elements.confirm.checked,
                  }
                : {
                    name: form.elements.name.value,
                    confirm: true,
                    publishSnapshot: form.elements.publishSnapshot.checked,
                  },
          });
          $(
            '#' + (id === 'publish' ? 'snapshot' : 'remove') + '-dialog',
          ).close();
          notice(
            id === 'publish'
              ? 'Publishing a verified snapshot. Watch Host operations for progress.'
              : 'Removing only this server’s containers. Its data volume will be kept.',
          );
          await model.refresh();
        } catch (problem) {
          if (!ctx.isCurrent()) return;
          $(
            '#' + (id === 'publish' ? 'snapshot' : 'remove') + '-dialog',
          ).close();
          error(problem.message);
        }
      });
    ctx.on($('#cancel-publish'), 'click', () => $('#snapshot-dialog').close());
    ctx.on($('#cancel-remove'), 'click', () => $('#remove-dialog').close());
  }
  function paintServers(ctx) {
    if (!ctx.isCurrent()) return;
    ctx.render(serverCards(model.snapshot, admin()));
    ctx.on(ctx.root, 'click', (event) => {
      const button = event.target.closest('[data-snapshot],[data-remove]');
      if (!button || !ctx.root.contains(button)) return;
      const item = model.snapshot.servers.find(
        (server) =>
          serverKey(server) ===
          (button.dataset.snapshot || button.dataset.remove),
      );
      if (!item) return;
      const publish = !!button.dataset.snapshot,
        form = $('#' + (publish ? 'publish' : 'remove'));
      form.reset();
      form.elements.serverId.value = item.id;
      form.elements.hostId.value = item.hostId;
      if (publish) {
        form.elements.title.value = item.name + ' snapshot';
        $('#snapshot-help').textContent =
          item.hostName +
          ': ' +
          (model.snapshot.games.find((game) => game.id === item.game)
            ?.snapshotHelp ||
            'The game will save a consistent snapshot. Players may be disconnected.');
      }
      $('#' + (publish ? 'snapshot' : 'remove') + '-dialog').showModal();
    });
    bindDialogs(ctx);
  }
  return {
    updates: () => createUpdatesScreen({model, notice}),
    operations: () => {
      let history;
      return {
        async mount(ctx) {
          history = await mountOperationHistory(ctx, {
            locations: model.snapshot.hosts.map((host) => ({
              label: host.name,
              prefix: host.local ? '' : '/hosts/' + host.id,
            })),
            onRecovery: () => model.refresh(),
          });
        },
        async refresh(ctx, reason) {
          await history?.refresh(ctx, reason);
        },
      };
    },
    servers: () => ({
      async mount(ctx) {
        await model.refresh();
        paintServers(ctx);
        ctx.onDispose(() => {
          $('#snapshot-dialog').close();
          $('#remove-dialog').close();
          creation.cancel();
        });
      },
      async refresh(ctx, options) {
        if (options.reason !== 'model') await model.refresh();
        paintServers(ctx);
      },
    }),
    storage: () => createStorageScreen({model, notice}),
    library: () => createSnapshotScreen({model, getSession, creation, notice}),
    access: () => {
      let workflow;
      return {
        async mount(ctx) {
          workflow = mountAccounts(ctx.root, {
            request: ctx.request,
            session: sessionController,
            confirm: ctx.confirm,
            notify: (text, failed = false) => {
              if (ctx.isCurrent()) failed ? error(text) : notice(text);
            },
            onSignedOut: onReady,
          });
          await workflow.load();
        },
        async refresh(_ctx, options) {
          if (options.reason === 'reload') await workflow.load();
        },
        dispose() {
          workflow?.dispose();
          workflow = null;
        },
      };
    },
    host: () => {
      let context = null,
        component = null;
      return {
        async mount(ctx) {
          context = ctx;
          component ||= createHostSettings({
            api: (...args) => {
              if (!context?.isCurrent())
                throw new DOMException('Screen closed', 'AbortError');
              return apiFor(context)(...args);
            },
            getSession,
            error: (message) => {
              if (context?.isCurrent()) error(message, '#host-error');
            },
          });
          component.bind();
          await component.load();
        },
        async refresh(_ctx, options) {
          if (options.reason !== 'model') await component.load();
        },
        dispose() {
          context = null;
          component?.dispose();
        },
      };
    },
    hosts: () => {
      let component;
      return {
        async mount(ctx) {
          component = mountHosts({
            api: apiFor(ctx),
            getSession,
            error: (message, target) => {
              if (ctx.isCurrent()) error(message, target);
            },
            notice: (message) => {
              if (ctx.isCurrent()) notice(message);
            },
            onChange: () => model.refresh(),
            onCreate: (host) => creation.open(null, host),
          });
          await model.refresh();
          if (!ctx.isCurrent()) return;
          component.setHosts(model.snapshot.hosts);
          await component.pairing();
          await component.progress();
        },
        async refresh(ctx, options) {
          if (options.reason !== 'model') await model.refresh();
          if (!ctx.isCurrent()) return;
          component.setHosts(model.snapshot.hosts);
          if (options.reason !== 'model') await component.progress();
        },
        dispose() {
          component?.dispose();
          component = null;
          creation.cancel();
        },
      };
    },
    welcome: () => ({
      async mount(ctx) {
        try {
          const [status, host] = await Promise.all([
            ctx.request('/status'),
            ctx.request('/host-settings'),
          ]);
          ctx.render(
            welcomeView({
              username: getSession().username,
              origin: location.origin,
              status,
              host,
            }),
          );
          ctx.on($('#retry-installation'), 'click', () => this.mount(ctx));
          ctx.on($('#finish-installation'), 'click', async () => {
            const button = $('#finish-installation');
            button.disabled = true;
            try {
              getSession().onboarding = await ctx.request('/onboarding', {
                method: 'POST',
                body: {complete: true},
              });
              await onReady();
            } finally {
              button.disabled = false;
            }
          });
          error('');
        } catch (problem) {
          if (!ctx.isCurrent()) return;
          ctx.render(
            '<h1>Your account is ready.</h1><p>The host could not be checked. Your progress has been saved.</p><button id="retry-installation">Try again</button>',
          );
          ctx.on($('#retry-installation'), 'click', () => this.mount(ctx));
          showError(ctx)(problem.message);
        }
      },
      refresh(ctx, options) {
        if (options.reason === 'reload') return this.mount(ctx);
      },
    }),
  };
}
