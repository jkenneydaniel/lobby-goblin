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
  let limitsDraft = null;
  const apiFor = (ctx) => (route, body) =>
    ctx.request(route, body === undefined ? {} : {method: 'POST', body});
  const showError = (ctx) => (message) => {
    if (ctx.isCurrent()) error(message);
  };
  function bindDialogs(ctx) {
    const limits = $('#limits-dialog'),
      form = $('#edit-limits');
    ctx.on($('#cancel-limits'), 'click', () => limits.close());
    ctx.on(form, 'submit', async (event) => {
      event.preventDefault();
      const draft = limitsDraft,
        save = form.querySelector('[type=submit]');
      if (!draft || save.disabled) return;
      save.disabled = true;
      error('', '#limits-error');
      try {
        const job = await ctx.request(
          model.route(draft.hostId, '/servers/' + draft.id + '/limits'),
          {
            method: 'POST',
            body: {
              cpu: form.elements.cpu.valueAsNumber,
              memoryGiB: form.elements.memoryGiB.valueAsNumber,
              current: draft.current,
            },
          },
        );
        model.trackJob(draft.hostId, job.id);
        if (limitsDraft === draft) limits.close();
        await model.refresh();
      } catch (problem) {
        if (ctx.isCurrent() && limitsDraft === draft && limits.open)
          error(problem.message, '#limits-error');
      } finally {
        if (limitsDraft === draft) save.disabled = false;
      }
    });
    for (const id of ['publish', 'remove'])
      ctx.on($('#' + id), 'submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const hostId = form.elements.hostId.value;
        const route = model.route(
          hostId,
          '/servers/' +
            form.elements.serverId.value +
            (id === 'publish' ? '/snapshot' : '/remove'),
        );
        try {
          const job = await ctx.request(route, {
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
          model.trackJob(hostId, job.id);
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
      pageFocused = ctx.root.contains(active) && active.closest('.list-pages'),
      focused = ctx.root.contains(active) ? active.dataset.serverFilter : null,
      focusKey = ctx.root.contains(active) ? active.dataset.serverFocus : null,
      openDetails = [
        ...ctx.root.querySelectorAll('[data-server-details][open]'),
      ].map((node) => node.dataset.serverDetails),
      range =
        focused === 'search' && active.selectionStart != null
          ? [active.selectionStart, active.selectionEnd]
          : null;
    ctx.render(serverCollection(model.snapshot, admin(), filters));
    const input = ctx.root.querySelector(
      `[data-server-filter="${focusSearch ? 'search' : focused}"]`,
    );
    for (const key of openDetails)
      ctx.root
        .querySelector(`[data-server-details="${CSS.escape(key)}"]`)
        ?.setAttribute('open', '');
    if (pageFocused && !focusSearch)
      ctx.root.querySelector('[data-list-range]')?.focus();
    if (input) {
      input.focus({preventScroll: !focusSearch});
      if (range && !focusSearch) input.setSelectionRange(...range);
    } else if (focusKey)
      ctx.root
        .querySelector(`[data-server-focus="${CSS.escape(focusKey)}"]`)
        ?.focus({preventScroll: true});
    else if (active?.classList.contains('server-table-scroll'))
      ctx.root
        .querySelector('.server-table-scroll')
        ?.focus({preventScroll: true});
    ctx.on(ctx.root, 'input', (event) => {
      if (event.target.dataset.serverFilter !== 'search') return;
      filters.search = event.target.value;
      if (event.isComposing || filters.composing) return;
      filters.page = 1;
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
      filters.page = 1;
      paintServers(ctx, filters);
    });
    ctx.on(ctx.root, 'change', (event) => {
      const key = event.target.dataset.serverFilter;
      if (!['application', 'host', 'sort'].includes(key)) return;
      filters[key] = event.target.value;
      filters.page = 1;
      paintServers(ctx, filters);
    });
    ctx.on(ctx.root, 'click', async (event) => {
      const choice = event.target.closest('[data-server-choice]');
      if (choice) {
        filters[choice.dataset.serverChoice] = choice.value;
        filters.page = 1;
        paintServers(ctx, filters);
        return;
      }
      if (event.target.closest('[data-toggle-server-filters]')) {
        filters.showOptions = !filters.showOptions;
        paintServers(ctx, filters);
        return;
      }
      const host =
        event.target.closest('[data-server-host]')?.dataset.serverHost;
      if (host) {
        if (filters.collapsed.has(host)) filters.collapsed.delete(host);
        else filters.collapsed.add(host);
        paintServers(ctx, filters);
        return;
      }
      const pageButton = event.target.closest(
        '[data-list-page]:not(:disabled)',
      );
      if (pageButton) {
        filters.page = Number(pageButton.dataset.listPage);
        paintServers(ctx, filters);
        return;
      }
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
          if (ctx.isCurrent()) {
            const details = ctx.root.querySelector(
              `[data-server-details="${CSS.escape(item.manageUrl)}"]`,
            );
            if (details) details.open = true;
            error(
              'Clipboard unavailable. Select and copy the address shown ' +
                (details ? 'in the server details.' : 'on the server card.'),
            );
          }
        }
        return;
      }
      if (event.target.closest('[data-clear-server-filters]')) {
        filters.search =
          filters.application =
          filters.host =
          filters.status =
            '';
        filters.page = 1;
        paintServers(ctx, filters, true);
        return;
      }
      const button = event.target.closest(
        '[data-edit-limits],[data-snapshot],[data-remove]',
      );
      if (!button || !ctx.root.contains(button)) return;
      const item = model.snapshot.servers.find(
        (server) =>
          serverKey(server) ===
          (button.dataset.editLimits ||
            button.dataset.snapshot ||
            button.dataset.remove),
      );
      if (!item) return;
      if (button.dataset.editLimits) {
        if (!item.resourceLimits) return;
        const form = $('#edit-limits');
        limitsDraft = {
          id: item.id,
          hostId: item.hostId,
          current: {cpu: item.cpu, memoryGiB: item.memoryGiB},
        };
        $('#limits-server').textContent = item.name + ' · ' + item.hostName;
        form.elements.cpu.value = item.cpu;
        const memory = form.elements.memoryGiB;
        memory.min = item.resourceLimits.minMemoryGiB;
        memory.max = item.resourceLimits.maxMemoryGiB;
        memory.value = item.memoryGiB;
        form.querySelector('[type=submit]').disabled = false;
        error('', '#limits-error');
        $('#limits-dialog').showModal();
        return;
      }
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
          await model.refresh();
          if (!ctx.isCurrent()) return;
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
        view: 'table',
        showOptions: false,
        collapsed: new Set(),
        composing: false,
        page: 1,
      };
      return {
        async mount(ctx, {route}) {
          if (route) {
            Object.assign(filters, {
              host: route,
              search: '',
              application: '',
              status: '',
              page: 1,
              showOptions: true,
            });
            filters.collapsed.clear();
          }
          await model.refresh();
          paintServers(ctx, filters);
          ctx.onDispose(() => {
            filters.composing = false;
            $('#snapshot-dialog').close();
            $('#remove-dialog').close();
            $('#limits-dialog').close();
            limitsDraft = null;
            creation.cancel();
          });
        },
        async refresh(ctx, options) {
          if (!['model', 'poll'].includes(options.reason))
            await model.refresh();
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
        async mount(ctx, {route}) {
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
          component.setHosts(model.snapshot.hosts, route);
          await component.load();
        },
        async refresh(ctx, options) {
          if (!['model', 'poll'].includes(options.reason))
            await model.refresh();
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
            hostBusy: (id) => model.busy(id),
          });
          await model.refresh();
          if (!ctx.isCurrent()) return;
          component.setInventory(model.snapshot);
          await component.pairing();
          await component.progress();
        },
        async refresh(ctx, options) {
          if (!['model', 'poll'].includes(options.reason))
            await model.refresh();
          if (!ctx.isCurrent()) return;
          component.setInventory(model.snapshot);
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
