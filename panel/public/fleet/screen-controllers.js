import {createStorageScreen} from './storage-screen.js';
import {createUpdatesScreen} from './updates-screen.js';
import {createSnapshotScreen} from './snapshot-screen.js';
import {mountOperationHistory} from '../shared/operation-history.js';
import {serverCollection} from './server-filters.js';
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
  function paintServers(ctx, filters, focusSearch = false) {
    if (!ctx.isCurrent() || filters.composing) return;
    const active = document.activeElement,
      previousTable = ctx.root.querySelector('.server-table-scroll'),
      tableScrollLeft = previousTable?.scrollLeft ?? 0,
      focused = ctx.root.contains(active)
        ? active?.dataset?.serverFilter
        : null,
      range =
        focused === 'search' && active.selectionStart != null
          ? [active.selectionStart, active.selectionEnd]
          : null;
    ctx.render(serverCollection(model.snapshot, admin(), filters));
    const table = ctx.root.querySelector('.server-table-scroll'),
      input = ctx.root.querySelector(
        `[data-server-filter="${focusSearch ? 'search' : focused}"]`,
      );
    if (previousTable && table) {
      if (active === previousTable && !focusSearch)
        table.focus({preventScroll: true});
      table.scrollLeft = tableScrollLeft;
    }
    if (input) {
      input.focus({preventScroll: !focusSearch});
      if (range && !focusSearch) input.setSelectionRange(...range);
    }
    ctx.on(ctx.root, 'input', (event) => {
      if (event.target.dataset.serverFilter !== 'search') return;
      filters.search = event.target.value;
      if (event.isComposing || filters.composing) return;
      paintServers(ctx, filters);
    });
    ctx.on(ctx.root, 'compositionstart', (event) => {
      if (event.target.dataset.serverFilter === 'search')
        filters.composing = true;
    });
    ctx.on(ctx.root, 'compositionend', (event) => {
      if (event.target.dataset.serverFilter !== 'search') return;
      filters.composing = false;
      filters.search = event.target.value;
      paintServers(ctx, filters);
    });
    ctx.on(ctx.root, 'change', (event) => {
      const key = event.target.dataset.serverFilter;
      if (!['application', 'host', 'status', 'sort', 'view'].includes(key))
        return;
      filters[key] = event.target.value;
      paintServers(ctx, filters);
    });
    ctx.on(ctx.root, 'click', async (event) => {
      const copy = event.target.closest('[data-copy-address]');
      if (copy && ctx.root.contains(copy)) {
        // Assigned records omit hostId but retain their scoped management URL.
        const item = model.snapshot.servers.find(
          (server) => server.manageUrl === copy.dataset.copyAddress,
        );
        if (!item?.address) return;
        notice('');
        error('');
        try {
          await navigator.clipboard.writeText(item.address);
          if (ctx.isCurrent()) notice('Server address copied.');
        } catch {
          if (ctx.isCurrent())
            error(
              'Clipboard unavailable. Select and copy the address shown ' +
                (filters.view === 'table'
                  ? 'in the server table.'
                  : 'on the server card.'),
            );
        }
        return;
      }
      if (event.target.closest('[data-clear-server-filters]')) {
        filters.search =
          filters.application =
          filters.host =
          filters.status =
            '';
        paintServers(ctx, filters, true);
        return;
      }
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
    servers: () => {
      const filters = {
        search: '',
        application: '',
        host: '',
        status: '',
        sort: 'host',
        view: 'cards',
        composing: false,
      };
      return {
        async mount(ctx) {
          await model.refresh();
          paintServers(ctx, filters);
          ctx.onDispose(() => {
            filters.composing = false;
            $('#snapshot-dialog').close();
            $('#remove-dialog').close();
            creation.cancel();
          });
        },
        async refresh(ctx, options) {
          if (options.reason !== 'model') await model.refresh();
          paintServers(ctx, filters);
        },
      };
    },
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
            request: (...args) => {
              if (!context?.isCurrent())
                throw new DOMException('Screen closed', 'AbortError');
              return context.request(...args);
            },
            getSession,
            error: (message) => {
              if (context?.isCurrent()) error(message, '#host-error');
            },
          });
          component.bind();
          await model.refresh();
          if (!ctx.isCurrent()) return;
          component.setHosts(model.snapshot.hosts);
          await component.load();
        },
        async refresh(ctx, options) {
          if (options.reason !== 'model') await model.refresh();
          if (!ctx.isCurrent()) return;
          const changed = component.setHosts(model.snapshot.hosts);
          if (options.reason !== 'model' || changed) await component.load();
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
            readCapacity: (route, options) => ctx.request(route, options),
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
