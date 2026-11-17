import {escapeHTML as esc, formatDate} from './view.js';

export function mountAuditHistory(root, {request, notify}) {
  const abort = new AbortController();
  let applied = null,
    cursors = [null],
    nextBefore = null,
    version = 0;
  root.classList.add('audit-history');
  root.innerHTML =
    '<form class="compact-toolbar" data-audit-filter><label>History<select name="source"><option value="audit">Access and management requests</option><option value="operation-audit">Operation outcomes on this host or server</option></select></label><label>Filter actor, action or server<input name="search" maxlength="80" type="search"></label><button>Refresh audit history</button></form><p class="hint" data-audit-retention></p><nav class="list-pages" aria-label="Audit pages" hidden><button type="button" data-audit-newer>Newer events</button><span role="status" tabindex="-1" data-audit-page></span><button type="button" data-audit-older>Older events</button></nav><div class="table-wrap" role="region" aria-label="Audit history table" tabindex="0"><table><caption>Recorded requests and outcomes. Accepted requests may still be running.</caption><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead><tbody data-audit-events></tbody></table></div>';
  const form = root.querySelector('form'),
    rows = root.querySelector('[data-audit-events]'),
    pages = root.querySelector('nav'),
    pageLabel = root.querySelector('[data-audit-page]'),
    newer = root.querySelector('[data-audit-newer]'),
    older = root.querySelector('[data-audit-older]');

  async function read(filters, trail, fromButton) {
    const current = ++version;
    const query = new URLSearchParams({search: filters.search});
    const before = trail.at(-1);
    if (before) query.set('before', before);
    newer.disabled = older.disabled = true;
    rows.setAttribute('aria-busy', 'true');
    try {
      const result = await request('/' + filters.source + '?' + query, {
        signal: abort.signal,
      });
      if (abort.signal.aborted || current !== version) return;
      const events = result.events || [];
      rows.innerHTML =
        events
          .map(
            (event) =>
              `<tr><td>${esc(formatDate(event.at))}</td><td>${esc(event.actor)}</td><td>${esc(event.action)}${event.operationId ? `<small>Operation ${esc(event.operationId)}</small>` : ''}</td><td>${esc(event.target || event.scope)}${event.accessChange ? `<details><summary>Access change</summary><pre>${esc(JSON.stringify(event.accessChange, null, 2))}</pre></details>` : ''}</td><td>${esc(event.outcome)}${event.status ? ' · HTTP ' + esc(event.status) : ''}</td></tr>`,
          )
          .join('') ||
        '<tr><td colspan="5">No matching recorded events.</td></tr>';
      applied = filters;
      cursors = trail;
      nextBefore = result.nextBefore;
      pages.hidden = cursors.length === 1 && !nextBefore;
      pageLabel.textContent =
        'Page ' + cursors.length + ' · ' + events.length + ' events';
      if (
        fromButton &&
        (document.activeElement === fromButton ||
          document.activeElement === document.body)
      )
        (pages.hidden ? form.querySelector('button') : pageLabel).focus();
      root.querySelector('[data-audit-retention]').textContent =
        'Retains up to ' +
        (result.limit || 10000) +
        ' events per store. ' +
        (result.prunedThrough
          ? 'Older events through sequence ' +
            result.prunedThrough +
            ' have expired.'
          : 'No older events have expired.');
    } catch (error) {
      if (!abort.signal.aborted && current === version)
        notify(error.message, true);
    } finally {
      if (!abort.signal.aborted && current === version) {
        newer.disabled = cursors.length === 1;
        older.disabled = !nextBefore;
        rows.removeAttribute('aria-busy');
      }
    }
  }

  function load() {
    return read(
      {
        source: form.elements.source.value,
        search: form.elements.search.value,
      },
      [null],
    );
  }
  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void load();
    },
    {signal: abort.signal},
  );
  older.addEventListener(
    'click',
    () => {
      if (nextBefore) void read(applied, [...cursors, nextBefore], older);
    },
    {signal: abort.signal},
  );
  newer.addEventListener(
    'click',
    () => {
      if (cursors.length > 1) void read(applied, cursors.slice(0, -1), newer);
    },
    {signal: abort.signal},
  );
  return {load, dispose: () => abort.abort()};
}
