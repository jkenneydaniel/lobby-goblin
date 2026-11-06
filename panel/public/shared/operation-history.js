import {loadTemplates, part, text} from './templates.js';

// Search only the checked public summary fields, never native payloads or events.
export function selectOperationHistory(records, query, filter) {
  const needle = query.trim().toLowerCase();
  return records.filter((record) => {
    const shown =
      filter === 'all' ||
      (filter === 'review'
        ? record.recovery?.required
        : filter === 'active'
          ? ['queued', 'running'].includes(record.state)
          : record.state === filter);
    return (
      shown &&
      (!needle ||
        [
          record.action,
          record.action.replaceAll('-', ' '),
          record.actor,
          record.sourceLabel,
          record.message,
          record.phase,
          record.id,
          record.sourceId,
          record.parentId,
        ].some(
          (value) =>
            typeof value === 'string' && value.toLowerCase().includes(needle),
        ))
    );
  });
}

// This is a standard product component. Applications supply checked operation
// providers on the server; no per-application history page or recovery dispatcher
// is needed in the browser.
export async function mountOperationHistory(
  ctx,
  {onRecovery = async () => {}, locations = []} = {},
) {
  const template = await loadTemplates(
    '/application/operation-templates.html',
    ctx.signal,
  );
  if (!ctx.isCurrent()) return;
  ctx.render(template('history'));
  const locationControl = part(ctx.root, '[data-operation-location]');
  for (const location of locations) {
    if (!/^(?:\/hosts\/[a-f0-9]{32})?$/.test(location.prefix))
      throw Error('Invalid operation history location.');
    locationControl.append(new Option(location.label, location.prefix));
  }
  if (!locations.length)
    part(ctx.root, '[data-operation-location-label]').remove();
  let generation = 0;
  const prefix = () => (locations.length ? locationControl.value : '');
  let snapshot = null,
    reading = null,
    checked = 0;
  const opened = new Set();
  const search = part(ctx.root, '[data-operation-search]'),
    filterControl = part(ctx.root, '[data-operation-filter]');
  function paint() {
    if (!ctx.isCurrent() || !snapshot) return;
    const list = part(ctx.root, '[data-operation-list]'),
      sources = part(ctx.root, '[data-operation-sources]');
    for (const details of list.querySelectorAll('details')) {
      if (details.open) opened.add(details.dataset.id);
      else opened.delete(details.dataset.id);
    }
    sources.replaceChildren();
    for (const source of snapshot.sources.filter(
      (source) => !source.available,
    )) {
      const view = template('source-unavailable');
      text(view, 'p', source.label + ': ' + source.message);
      sources.append(view);
    }
    list.replaceChildren();
    const records = selectOperationHistory(
      snapshot.operations,
      search.value,
      filterControl.value,
    );
    text(
      ctx.root,
      '[data-operation-count]',
      records.length +
        ' matching of ' +
        snapshot.operations.length +
        ' loaded operations.',
    );
    for (const record of records) {
      const view = template('operation-record'),
        details = part(view, 'details');
      details.dataset.id = record.id;
      details.open = opened.has(record.id);
      text(view, '[data-title]', record.action.replaceAll('-', ' '));
      text(view, '[data-state]', record.state);
      part(view, '[data-state]').dataset.operationState = record.state;
      text(view, '[data-message]', record.message);
      text(
        view,
        '[data-context]',
        record.sourceLabel +
          ' · ' +
          record.actor +
          ' · ' +
          (record.started
            ? new Date(record.started).toLocaleString()
            : 'Start time unavailable') +
          ' · ' +
          record.phase,
      );
      if (record.parentId)
        text(
          view,
          '[data-correlation]',
          'Parent operation: ' + record.parentId,
        );
      else part(view, '[data-correlation]').remove();
      if (record.recorded) part(view, '[data-legacy]').remove();
      for (const event of record.events) {
        const phase = template('phase');
        text(
          phase,
          'li',
          new Date(event.at).toLocaleString() +
            ' · ' +
            event.phase +
            ' · ' +
            event.state,
        );
        part(view, '[data-phases]').append(phase);
      }
      if (!record.recovery?.required) part(view, '[data-recovery]').remove();
      else {
        text(view, '[data-recovery-message]', record.recovery.message);
        for (const action of record.recovery.actions) {
          const control = template(action.id === 'open' ? 'link' : 'action'),
            element = part(control, action.id === 'open' ? 'a' : 'button');
          element.textContent = action.label;
          if (action.id === 'open') {
            if (!/^#[a-z][a-z0-9/-]{0,100}$/.test(action.href))
              throw Error('Invalid workflow recovery link.');
            element.href = action.href;
          } else
            Object.assign(element.dataset, {
              operationSource: record.source,
              operationId: record.sourceId,
              operationAction: action.id,
            });
          part(view, '[data-recovery-actions]').append(control);
        }
      }
      list.append(view);
    }
    if (!records.length) list.append(template('empty'));
  }
  async function refresh() {
    if (reading) return reading;
    const version = generation;
    const pending = (async () => {
      const value = await ctx.request(prefix() + '/operations');
      if (!ctx.isCurrent() || version !== generation) return;
      if (
        value.version !== 1 ||
        !Array.isArray(value.operations) ||
        !Array.isArray(value.sources)
      )
        throw Error('Unsupported operation history response.');
      snapshot = value;
      checked = Date.now();
      paint();
    })();
    reading = pending;
    try {
      await pending;
    } finally {
      if (reading === pending) reading = null;
    }
  }
  ctx.on(locationControl, 'change', async () => {
    generation++;
    reading = null;
    snapshot = null;
    opened.clear();
    part(ctx.root, '[data-operation-list]').replaceChildren();
    part(ctx.root, '[data-operation-sources]').replaceChildren();
    text(ctx.root, '[data-operation-count]', 'Loading operations…');
    await refresh();
  });
  ctx.on(part(ctx.root, '[data-operation-refresh]'), 'click', refresh);
  ctx.on(filterControl, 'change', paint);
  ctx.on(search, 'input', paint);
  ctx.on(search, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    search.value = '';
    paint();
  });
  ctx.on(part(ctx.root, '[data-operation-clear]'), 'click', () => {
    search.value = '';
    filterControl.value = 'all';
    paint();
    search.focus();
  });
  ctx.on(ctx.root, 'click', async (event) => {
    const button = event.target.closest('button[data-operation-action]');
    if (!button || !ctx.root.contains(button)) return;
    const operation = button.dataset.operationAction,
      version = generation,
      locationPrefix = prefix();
    if (
      operation !== 'inspect' &&
      !(await ctx.confirm(
        'Acknowledge this operation?',
        'Confirm you reviewed its current status and recovery details. Its original interrupted or failed outcome remains recorded.',
      ))
    )
      return;
    if (!ctx.isCurrent() || version !== generation) return;
    button.disabled = true;
    try {
      await ctx.request(locationPrefix + '/operations/recovery', {
        method: 'POST',
        body: {
          source: button.dataset.operationSource,
          id: button.dataset.operationId,
          operation,
          confirm: true,
        },
      });
      await onRecovery();
      await refresh();
    } finally {
      if (ctx.isCurrent()) button.disabled = false;
    }
  });
  await refresh();
  return {
    async refresh(_ctx, reason = {}) {
      if (
        (reason.reason !== 'status' &&
          reason.reason !== 'poll' &&
          reason.reason !== 'model') ||
        Date.now() - checked > 5000
      )
        await refresh();
    },
  };
}
