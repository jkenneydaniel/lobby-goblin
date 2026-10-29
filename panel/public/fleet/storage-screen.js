import {escapeHTML as esc, formatBytes, formatDate} from '../shared/view.js';
import {serverKey} from './host-paths.js';

const freshReview = (item) =>
  item.storageReview?.token &&
  Date.now() - Date.parse(item.storageReview.inspectedAt) < 15 * 60 * 1000 &&
  !['missing', 'unavailable'].includes(item.storageStatus?.state);
const deleted = (item) =>
  !!item.storageDeletedAt || item.storageStatus?.state === 'deleted';

export function createStorageScreen({model, notice}) {
  let items = [],
    problems = [],
    loading = true,
    reading = null,
    revision = '',
    selected = null;
  const filters = {host: '', state: '', search: ''},
    drafts = new Map(),
    pending = new Map(),
    errors = new Map(),
    completed = new Map();
  const offline = (item) =>
    item.unavailable ||
    !model.snapshot.hosts.find((host) => host.id === item.hostId)?.connected;
  const busy = (item) =>
    model.busy(item.hostId) ||
    items.some(
      (value) => value.hostId === item.hostId && pending.has(serverKey(value)),
    );
  const state = (item) =>
    deleted(item)
      ? 'deleted'
      : item.source === 'assigned'
        ? 'assigned'
        : 'retained';

  function actionView(item, key) {
    if (selected?.key !== key)
      return `<div id="storage-action-${esc(key)}" hidden></div>`;
    const action = selected.action,
      review = item.storageReview,
      operation = pending.get(key),
      error = errors.get(key),
      completion = completed.get(key),
      draft = drafts.get(key) || {},
      fresh =
        freshReview(item) &&
        !operation &&
        !offline(item) &&
        !error &&
        !completion,
      title =
        action === 'recover'
          ? 'Recover into a new server'
          : action === 'remove'
            ? 'Delete retained data'
            : 'Storage details';
    return `<section id="storage-action-${esc(key)}" class="storage-action" aria-label="${esc(title)}"><div class="storage-action-heading"><h3 tabindex="-1">${title}</h3><button data-close-storage="${esc(key)}">Close</button></div>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      ${completion ? `<p role="status">The independent server has been created and is stopped. Original storage is kept.</p>${completion.serverId ? `<a class="button" href="${esc(model.route(item.hostId, '/servers/' + completion.serverId + '/'))}">Open recovered server</a>` : '<a href="#servers">View servers</a>'}` : ''}
      ${operation ? `<p role="status">${operation.action === 'inspect' ? 'Checking storage size, ownership and recovery readiness…' : operation.action === 'recover' ? 'Creating an independent stopped server. Original storage is kept…' : 'Deleting the reviewed retained data…'} <a href="#operations">View progress</a></p>` : ''}
      ${review && !operation ? `<p role="status">${esc(formatBytes(review.summary.bytes))} · ${esc(review.summary.files.toLocaleString())} files · checked ${esc(formatDate(review.inspectedAt))}</p>` : ''}
      ${!fresh && !operation && !completion ? `<p>${offline(item) ? 'Reconnect this host to check its storage.' : 'A fresh storage check is required before continuing.'}</p><button data-check-storage="${esc(key)}" ${offline(item) || busy(item) ? 'disabled' : ''}>Check storage again</button>` : ''}
      ${
        fresh && action === 'details'
          ? `<dl class="storage-breakdown">${Object.entries(
              review.summary.sections,
            )
              .map(
                ([name, value]) =>
                  `<dt>${esc(name)}</dt><dd>${esc(formatBytes(value.bytes))} · ${esc(value.files.toLocaleString())} files</dd>`,
              )
              .join('')}</dl>`
          : ''
      }
      ${fresh && action === 'recover' ? (review.recovery.ready ? `<p>Copy worlds, player data, settings, backups and installed software into a new server on ${esc(item.hostName)}. The new game stays stopped. Allow enough free space for another copy.</p><form data-recover-storage="${esc(key)}"><label>New server name<input name="newName" value="${esc(draft.newName ?? item.name.slice(0, 70) + ' recovered')}" maxlength="80" required></label><label>Type “${esc(item.name)}” to confirm the source<input name="name" value="${esc(draft.recoverName || '')}" autocomplete="off" required></label><label class="check"><input name="confirm" type="checkbox" required ${draft.recoverConfirm ? 'checked' : ''}>I want an independent copy, including any installed mods or plugins.</label><button class="primary" ${busy(item) ? 'disabled' : ''}>Recover stopped server</button></form>` : `<p>Recovery needs review: ${esc(review.recovery.reason)}</p>`) : ''}
      ${fresh && action === 'remove' ? `<p>This permanently deletes ${esc(item.name)}’s original worlds, player progress, settings, software and local backups. Shared snapshots and independent copies are kept.</p><form data-delete-storage="${esc(key)}"><label>Type “${esc(item.name)}” to confirm deletion<input name="name" value="${esc(draft.deleteName || '')}" autocomplete="off" required></label><label class="check"><input name="confirm" type="checkbox" required ${draft.deleteConfirm ? 'checked' : ''}>Permanently delete this retained data.</label><button class="danger" ${busy(item) ? 'disabled' : ''}>Permanently delete data</button></form>` : ''}</section>`;
  }
  function card(item) {
    const key = serverKey(item),
      currentState = state(item),
      unavailable = offline(item),
      review = item.storageReview,
      operation = pending.get(key),
      label =
        currentState === 'assigned'
          ? 'Assigned to server'
          : currentState === 'deleted'
            ? 'Deleted'
            : 'Retained data',
      manage =
        item.source === 'assigned'
          ? model.route(item.hostId, '/servers/' + item.id + '/')
          : '';
    return `<article class="storage-entry" data-storage="${esc(key)}"><div class="storage-entry-main"><div class="storage-identity"><span class="game">${esc(model.snapshot.games.find((game) => game.id === item.game)?.name || item.game)} · ${esc(item.hostName)}</span><h2>${esc(item.name)}</h2><p>${currentState === 'assigned' ? 'Worlds, settings and local backups for this server.' : currentState === 'deleted' ? 'Data permanently deleted.' : `Server removed ${esc(formatDate(item.removedAt))}.`}</p><p class="storage-volume"><span>Volume</span> <code>${esc(item.volume || 'Not recorded')}</code></p></div><div class="storage-summary"><span class="storage-state ${currentState}">${label}</span>${unavailable ? '<p>Host offline · last known storage</p>' : currentState === 'retained' ? `<p>${operation?.action === 'inspect' ? 'Checking storage…' : item.storageStatus?.state === 'missing' || item.storageStatus?.state === 'unavailable' ? esc(item.storageStatus.message) : review ? `${esc(formatBytes(review.summary.bytes))} · ${esc(review.summary.files.toLocaleString())} files` : 'Size checked when you choose an action'}</p>` : currentState === 'assigned' ? '<p>Managed by its server</p>' : ''}${currentState === 'retained' && busy(item) && !operation ? '<p class="storage-host-busy">Another operation is in progress on this host. <a href="#operations">View progress</a></p>' : ''}</div><div class="storage-entry-actions">${currentState === 'assigned' ? ` ${unavailable ? '<span class="button" aria-disabled="true">Open server</span>' : `<a class="button" href="${esc(manage)}">Open server</a>`}` : currentState === 'retained' ? `<button data-storage-action="recover" data-key="${esc(key)}" aria-expanded="${selected?.key === key && selected.action === 'recover'}" aria-controls="storage-action-${esc(key)}" ${unavailable || busy(item) ? 'disabled' : ''}>Recover</button><button class="danger quiet" data-storage-action="remove" data-key="${esc(key)}" aria-expanded="${selected?.key === key && selected.action === 'remove'}" aria-controls="storage-action-${esc(key)}" ${unavailable || busy(item) ? 'disabled' : ''}>Delete data</button><button class="quiet" data-storage-action="details" data-key="${esc(key)}" aria-expanded="${selected?.key === key && selected.action === 'details'}" aria-controls="storage-action-${esc(key)}" ${unavailable || busy(item) ? 'disabled' : ''}>View details</button>` : ''}</div></div>${currentState === 'retained' ? actionView(item, key) : ''}</article>`;
  }
  function paint(ctx, focusAction = false) {
    if (!ctx.isCurrent()) return;
    const active = document.activeElement,
      focusFilter = active?.dataset?.storageFilter,
      focusKey = active?.closest('[data-storage]')?.dataset.storage,
      focusName = active?.name,
      focusControl = active?.dataset?.storageAction
        ? `[data-storage-action="${active.dataset.storageAction}"]`
        : active?.dataset?.checkStorage
          ? '[data-check-storage]'
          : active?.dataset?.closeStorage
            ? '[data-close-storage]'
            : active?.matches('.storage-action h3')
              ? '.storage-action h3'
              : '',
      focusRefresh = active?.hasAttribute('data-refresh-storage'),
      range =
        active?.tagName === 'INPUT' && active.selectionStart != null
          ? [active.selectionStart, active.selectionEnd]
          : null,
      query = filters.search.trim().toLocaleLowerCase(),
      visible = items.filter(
        (item) =>
          (!filters.host || item.hostId === filters.host) &&
          (filters.state ? state(item) === filters.state : !deleted(item)) &&
          (!query ||
            [item.name, item.hostName, item.game, item.volume]
              .join(' ')
              .toLocaleLowerCase()
              .includes(query)),
      );
    ctx.render(`<div class="heading storage-heading"><div><h1>Server storage</h1><p>All server data across your hosts, including data kept after removal.</p></div><button data-refresh-storage ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button></div>
      <div class="storage-filters" role="search" aria-label="Filter server storage"><label>Host<select data-storage-filter="host"><option value="">All hosts</option>${model.snapshot.hosts.map((host) => `<option value="${esc(host.id)}" ${filters.host === host.id ? 'selected' : ''}>${esc(host.name)}${host.connected ? '' : ' (offline)'}</option>`).join('')}</select></label><label>Storage status<select data-storage-filter="state">${[
        ['', 'All current storage'],
        ['assigned', 'Assigned to a server'],
        ['retained', 'Retained after removal'],
        ['deleted', 'Deleted history'],
      ]
        .map(
          ([value, text]) =>
            `<option value="${value}" ${filters.state === value ? 'selected' : ''}>${text}</option>`,
        )
        .join(
          '',
        )}</select></label><label>Find storage<input type="search" data-storage-filter="search" value="${esc(filters.search)}" placeholder="Server, application or volume"></label></div>
      ${problems.map((message) => `<p role="status">${esc(message)}</p>`).join('')}
      <p class="storage-count" role="status">${loading && !items.length ? 'Loading server storage…' : `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}`}${!loading && (filters.host || filters.state || filters.search) ? ' · <button class="quiet" data-clear-storage-filters>Clear filters</button>' : ''}</p>
      <div class="storage-list">${visible.map(card).join('')}</div>${!loading && !visible.length ? `<div class="empty"><h2>${items.length ? 'No matching storage' : 'No server storage yet'}</h2><p>${items.length ? 'Try a different host, storage status or search.' : 'Storage will appear here when you create a server on a connected host.'}</p></div>` : ''}
      <p class="hint storage-footnote">Assigned storage stays with its server. Recovery and deletion are available for removed servers after a safety check. Only registered server volumes are listed. Published snapshots are managed in the <a href="#library">snapshot library</a>.</p>`);
    const focus = focusFilter
      ? ctx.root.querySelector(`[data-storage-filter="${focusFilter}"]`)
      : focusName && focusKey
        ? ctx.root.querySelector(
            `[data-storage="${CSS.escape(focusKey)}"] [name="${CSS.escape(focusName)}"]`,
          )
        : focusKey && focusControl
          ? ctx.root.querySelector(
              `[data-storage="${CSS.escape(focusKey)}"] ${focusControl}`,
            )
          : focusRefresh
            ? ctx.root.querySelector('[data-refresh-storage]')
            : null;
    if (focusAction && selected) {
      const heading = ctx.root.querySelector(
        `[data-storage="${CSS.escape(selected.key)}"] .storage-action h3`,
      );
      heading?.focus({preventScroll: true});
      heading?.scrollIntoView({block: 'center'});
    } else if (focus) {
      focus.focus({preventScroll: true});
      if (range && focus.setSelectionRange) focus.setSelectionRange(...range);
    }
    bind(ctx);
  }
  function bind(ctx) {
    ctx.on(ctx.root, 'input', (event) => {
      const filter = event.target.dataset.storageFilter;
      if (filter) {
        filters[filter] = event.target.value;
        paint(ctx);
        return;
      }
      const form = event.target.closest('form'),
        key = form?.dataset.recoverStorage || form?.dataset.deleteStorage;
      if (!key) return;
      const draft = drafts.get(key) || {};
      if (form.dataset.recoverStorage)
        Object.assign(draft, {
          newName: form.elements.newName.value,
          recoverName: form.elements.name.value,
          recoverConfirm: form.elements.confirm.checked,
        });
      else
        Object.assign(draft, {
          deleteName: form.elements.name.value,
          deleteConfirm: form.elements.confirm.checked,
        });
      drafts.set(key, draft);
    });
    ctx.on(ctx.root, 'click', async (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-refresh-storage')) {
        await model.refresh();
        revision = '';
        await load(ctx);
        return;
      }
      if (button.hasAttribute('data-clear-storage-filters')) {
        Object.assign(filters, {host: '', state: '', search: ''});
        paint(ctx);
        return;
      }
      if (button.dataset.closeStorage) {
        const previous = selected;
        selected = null;
        paint(ctx);
        if (previous)
          ctx.root
            .querySelector(
              `[data-storage="${CSS.escape(previous.key)}"] [data-storage-action="${previous.action}"]`,
            )
            ?.focus({preventScroll: true});
        return;
      }
      const key = button.dataset.key || button.dataset.checkStorage,
        item = items.find((value) => serverKey(value) === key);
      if (
        !item ||
        item.source !== 'retained' ||
        deleted(item) ||
        offline(item) ||
        busy(item)
      )
        return;
      const needsCheck = !freshReview(item) || errors.has(key);
      if (button.dataset.storageAction) {
        completed.delete(key);
        selected = {key, action: button.dataset.storageAction};
      }
      if (!selected || selected.key !== key) return;
      errors.delete(key);
      paint(ctx, true);
      if (needsCheck || button.dataset.checkStorage)
        await submit(ctx, item, 'inspect', {});
    });
    ctx.on(ctx.root, 'submit', async (event) => {
      const form = event.target.closest(
        '[data-recover-storage],[data-delete-storage]',
      );
      if (!form) return;
      event.preventDefault();
      const key = form.dataset.recoverStorage || form.dataset.deleteStorage,
        item = items.find((value) => serverKey(value) === key);
      if (
        !item ||
        !freshReview(item) ||
        busy(item) ||
        offline(item) ||
        errors.has(key) ||
        completed.has(key)
      )
        return;
      await submit(
        ctx,
        item,
        form.dataset.recoverStorage ? 'recover' : 'remove',
        {
          name: form.elements.name.value,
          confirm: form.elements.confirm.checked,
          reviewToken: item.storageReview.token,
          ...(form.dataset.recoverStorage
            ? {newName: form.elements.newName.value}
            : {}),
        },
      );
    });
  }
  async function submit(ctx, item, action, body) {
    const key = serverKey(item),
      operation = {action, token: item.storageReview?.token};
    pending.set(key, operation);
    errors.delete(key);
    paint(ctx, true);
    try {
      const job = await ctx.request(
        model.route(item.hostId, '/removed-servers/' + item.id + '/' + action),
        {method: 'POST', body},
      );
      operation.id = job.id;
      if (!ctx.isCurrent()) return;
      if (action !== 'inspect')
        notice(
          action === 'recover'
            ? 'Recovering an independent stopped server. Original storage is kept.'
            : 'Deleting the selected retained data. Shared snapshots are kept.',
        );
      await model.refresh();
      revision = '';
      await load(ctx);
    } catch (error) {
      if (!operation.id) pending.delete(key);
      if (ctx.isCurrent()) {
        errors.set(key, error.message);
        paint(ctx);
      }
    }
  }
  async function read(ctx) {
    loading = true;
    const next = model.snapshot.servers.map((item) => ({
        ...item,
        source: 'assigned',
      })),
      failures = [];
    await Promise.all(
      model.snapshot.hosts.map(async (host) => {
        if (!host.connected) {
          failures.push(
            host.name + ' is offline. Reconnect it to view current storage.',
          );
          next.push(
            ...items
              .filter(
                (item) => item.hostId === host.id && item.source === 'retained',
              )
              .map((item) => ({...item, unavailable: true})),
          );
          return;
        }
        try {
          const result = await ctx.request(
            model.route(host.id, '/removed-servers'),
          );
          next.push(
            ...result.servers.map((item) => ({
              ...item,
              source: 'retained',
              hostId: host.id,
              hostName: host.name,
            })),
          );
        } catch (error) {
          failures.push(host.name + ': ' + error.message);
          next.push(
            ...items
              .filter(
                (item) => item.hostId === host.id && item.source === 'retained',
              )
              .map((item) => ({...item, unavailable: true})),
          );
        }
      }),
    );
    if (!ctx.isCurrent()) return;
    loading = false;
    next.sort(
      (a, b) =>
        a.hostName.localeCompare(b.hostName) ||
        a.name.localeCompare(b.name) ||
        serverKey(a).localeCompare(serverKey(b)),
    );
    failures.sort();
    for (const [key, operation] of pending) {
      const item = next.find((value) => serverKey(value) === key),
        job = model.snapshot.jobs.find(
          (value) =>
            operation.id &&
            value.hostId === item?.hostId &&
            value.id === operation.id &&
            value.action ===
              {
                inspect: 'inspectStorage',
                recover: 'recoverStorage',
                remove: 'deleteStorage',
              }[operation.action],
        ),
        inspected =
          operation.action === 'inspect' &&
          item?.storageReview?.token &&
          item.storageReview.token !== operation.token,
        removed = operation.action === 'remove' && item && deleted(item);
      if (
        inspected ||
        removed ||
        (job && !['queued', 'running'].includes(job.state))
      ) {
        pending.delete(key);
        if (
          operation.action === 'inspect' &&
          job?.state === 'succeeded' &&
          !inspected
        )
          errors.set(
            key,
            'The check finished, but fresh storage details are unavailable. Check storage again before continuing.',
          );
        if (job && !['queued', 'running', 'succeeded'].includes(job.state))
          errors.set(
            key,
            job.message ||
              'The storage operation needs review. See Operations for details.',
          );
        if (operation.action === 'recover' && job?.state === 'succeeded') {
          completed.set(key, {serverId: job.result?.serverId});
          drafts.delete(key);
        }
        if (removed) {
          notice(
            'Retained data permanently deleted. Shared snapshots were kept.',
          );
          drafts.delete(key);
          if (selected?.key === key) selected = null;
        }
      }
    }
    const nextRevision = JSON.stringify([
      next,
      failures,
      next.map((item) => !!freshReview(item)),
      [...pending],
      [...errors],
      [...completed],
      [...model.snapshot.hostJobs],
      model.snapshot.hosts,
    ]);
    if (nextRevision !== revision) {
      items = next;
      problems = failures;
      revision = nextRevision;
      paint(ctx);
    }
  }
  async function load(ctx) {
    if (reading?.ctx === ctx) return reading.promise;
    const current = {ctx};
    current.promise = read(ctx).finally(() => {
      if (reading === current) reading = null;
    });
    reading = current;
    return current.promise;
  }
  return {
    async mount(ctx) {
      loading = true;
      paint(ctx);
      await model.refresh();
      await load(ctx);
    },
    async refresh(ctx, options) {
      if (options.reason !== 'model') await model.refresh();
      await load(ctx);
    },
  };
}
