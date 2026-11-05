import {escapeHTML as esc, formatBytes, formatDate} from '../shared/view.js';
import {snapshotCollection} from './snapshot-filters.js';
import {serverKey} from './host-paths.js';

export function createSnapshotScreen({model, getSession, creation, notice}) {
  let selected = null,
    details = null,
    problem = '',
    loading = false;
  const filters = {
    search: '',
    application: '',
    host: '',
    sort: 'newest',
    composing: false,
  };
  const admin = () => getSession()?.role === 'admin';
  function paint(ctx, focusSearch = false) {
    if (!ctx.isCurrent() || filters.composing) return;
    const active = document.activeElement,
      focused = ctx.root.contains(active)
        ? active?.dataset?.snapshotFilter
        : null,
      range =
        focused === 'search' && active.selectionStart != null
          ? [active.selectionStart, active.selectionEnd]
          : null;
    const detail =
      details && selected
        ? `<section class="card snapshot-details" aria-labelledby="snapshot-detail-title"><div class="heading"><h2 id="snapshot-detail-title">${esc(details.title)}</h2><button data-close-details>Close details</button></div><p>Verified ${esc(formatDate(details.verifiedAt))}. ${esc(details.manifest.files.length)} files · ${esc(formatBytes(details.bytes))}.</p><dl><dt>Source server</dt><dd>${esc(details.sourceName)}</dd><dt>Created</dt><dd>${esc(formatDate(details.created))}</dd><dt>Application image</dt><dd><code>${esc(details.image)}</code></dd><dt>Management credentials</dt><dd>Excluded</dd>${details.includesPlayerData ? '<dt>Rust player progress and blueprints</dt><dd>Included</dd>' : ''}</dl><details><summary>Files and integrity hashes</summary><div class="table-scroll"><table class="allocation-table"><thead><tr><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${details.manifest.files
            .slice(0, 200)
            .map(
              (file) =>
                `<tr><td>${esc(file.name)}</td><td>${esc(formatBytes(file.size))}</td><td><code>${esc(file.sha256)}</code></td></tr>`,
            )
            .join(
              '',
            )}</tbody></table></div>${details.manifest.files.length > 200 ? '<p>Showing the first 200 files. Download the manifest for the full inventory.</p>' : ''}</details><button data-manifest>Download manifest</button></section>`
        : '';
    ctx.render(
      `<p class="hint">Inspect a saved world, create an independent server from it, or delete a snapshot you no longer need.</p>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ''}${loading ? '<p role="status">Verifying snapshot files…</p>' : ''}${detail}<div class="grid">${snapshotCollection(model.snapshot, admin(), filters)}</div>${admin() ? '<section class="retained-storage"><h2>Removed server data</h2><p>View all server storage, recover retained data or permanently delete it in <a href="#storage">Server storage</a>.</p></section>' : ''}`,
    );
    const input = ctx.root.querySelector(
      `[data-snapshot-filter="${focusSearch ? 'search' : focused}"]`,
    );
    if (input) {
      input.focus({preventScroll: !focusSearch});
      if (range && !focusSearch) input.setSelectionRange(...range);
    }
    ctx.on(ctx.root, 'input', (event) => {
      if (event.target.dataset.snapshotFilter !== 'search') return;
      filters.search = event.target.value;
      if (!event.isComposing && !filters.composing) paint(ctx);
    });
    ctx.on(ctx.root, 'compositionstart', (event) => {
      if (event.target.dataset.snapshotFilter === 'search')
        filters.composing = true;
    });
    ctx.on(ctx.root, 'compositionend', (event) => {
      if (event.target.dataset.snapshotFilter !== 'search') return;
      filters.composing = false;
      filters.search = event.target.value;
      paint(ctx);
    });
    ctx.on(ctx.root, 'change', (event) => {
      const key = event.target.dataset.snapshotFilter;
      if (!['application', 'host', 'sort'].includes(key)) return;
      filters[key] = event.target.value;
      paint(ctx);
    });
    ctx.on(ctx.root, 'click', async (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-clear-snapshot-filters')) {
        filters.search = filters.application = filters.host = '';
        paint(ctx, true);
        return;
      }
      if (button.hasAttribute('data-close-details')) {
        details = null;
        selected = null;
        paint(ctx);
        return;
      }
      if (button.hasAttribute('data-manifest') && details) {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(details.manifest, null, 2)], {
            type: 'application/json',
          }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'snapshot-' + details.id + '.manifest.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      const key =
        button.dataset.clone ||
        button.dataset.inspect ||
        button.dataset.deleteSnapshot;
      const item = model.snapshot.snapshots.find(
        (value) => serverKey(value) === key,
      );
      if (!item) return;
      if (button.dataset.clone) {
        await creation.open(item);
        return;
      }
      if (button.dataset.inspect) {
        loading = true;
        details = null;
        selected = key;
        problem = '';
        paint(ctx);
        try {
          const result = await ctx.request(
            model.route(item.hostId, '/snapshots/' + item.id),
          );
          if (ctx.isCurrent() && selected === key) details = result;
        } catch (error) {
          if (ctx.isCurrent()) problem = error.message;
        } finally {
          loading = false;
          paint(ctx);
        }
        return;
      }
      if (
        button.dataset.deleteSnapshot &&
        admin() &&
        (await ctx.confirm(
          'Delete “' + item.title + '”?',
          'This permanently deletes this published snapshot from ' +
            item.hostName +
            '. Existing servers, source backups and retained server data are preserved.',
          'Delete snapshot',
        ))
      ) {
        await ctx.request(
          model.route(item.hostId, '/snapshots/' + item.id + '/remove'),
          {method: 'POST', body: {confirm: true, title: item.title}},
        );
        if (!ctx.isCurrent()) return;
        if (selected === key) {
          details = null;
          selected = null;
        }
        notice(
          'Deleting the selected snapshot. Progress appears in Operations.',
        );
        await model.refresh();
        paint(ctx);
      }
    });
  }
  return {
    async mount(ctx) {
      await model.refresh();
      paint(ctx);
      ctx.onDispose(() => {
        filters.composing = false;
        creation.cancel();
      });
    },
    async refresh(ctx, options) {
      if (options.reason !== 'model') await model.refresh();
      if (
        details &&
        !model.snapshot.snapshots.some((item) => serverKey(item) === selected)
      ) {
        details = null;
        selected = null;
      }
      paint(ctx);
    },
  };
}
