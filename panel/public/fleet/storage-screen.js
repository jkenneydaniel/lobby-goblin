import {escapeHTML as esc, formatBytes, formatDate} from '../shared/view.js';
import {serverKey} from './host-paths.js';

export function createStorageScreen({model, notice}) {
  let items = [],
    problems = [],
    problem = '',
    loading = false,
    revision = '';
  const drafts = new Map();
  function paint(ctx) {
    if (!ctx.isCurrent()) return;
    ctx.render(
      `<h1>Retained storage</h1><p class="hint">Removed servers keep their original data here. Inspect storage before recovering a new server or permanently deleting it. Published snapshots are managed separately in the <a href="#library">snapshot library</a>.</p>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ''}${problems.map((message) => `<p role="status">${esc(message)}</p>`).join('')}${loading && !items.length ? '<p role="status">Loading retained storage…</p>' : ''}<div class="grid">${items
        .map((item) => {
          const key = serverKey(item),
            review = item.storageReview,
            deleted =
              !!item.storageDeletedAt ||
              item.storageStatus?.state === 'deleted',
            fresh =
              review?.token &&
              Date.now() - Date.parse(review.inspectedAt) < 15 * 60 * 1000,
            draft = drafts.get(key) || {},
            unavailable =
              item.storageStatus?.state === 'missing' ||
              item.storageStatus?.state === 'unavailable';
          return `<article class="card" data-storage="${esc(key)}"><h2>${esc(item.name)}</h2><p>${esc(item.game)} · ${esc(item.hostName)}</p><p>Removed ${esc(formatDate(item.removedAt))}</p><p role="status">${deleted ? 'Data permanently deleted.' : unavailable ? esc(item.storageStatus.message) : review ? `${esc(formatBytes(review.summary.bytes))} · ${esc(review.summary.files)} files · inspected ${esc(formatDate(review.inspectedAt))}` : 'Data retained. Inspect to check its size and recovery readiness.'}</p>${
            deleted
              ? ''
              : `<button data-inspect-storage="${esc(key)}">${review ? 'Inspect again' : 'Inspect storage'}</button>${
                  review
                    ? `<details><summary>Storage details</summary><p><code>${esc(item.volume)}</code></p><dl>${Object.entries(
                        review.summary.sections,
                      )
                        .map(
                          ([name, value]) =>
                            `<dt>${esc(name)}</dt><dd>${esc(formatBytes(value.bytes))} · ${esc(value.files)} files</dd>`,
                        )
                        .join(
                          '',
                        )}</dl></details>${!fresh ? '<p>Inspection expired. Inspect again to continue.</p>' : ''}${review.recovery.ready ? `<details><summary>Recover into a new server</summary><p>Copies worlds, player data, settings, backups and installed software. The new game stays stopped and receives fresh management credentials. The original data stays here. Allow enough free space for another copy.</p><form data-recover-storage="${esc(key)}"><label>New server name<input name="newName" value="${esc(draft.newName || item.name.slice(0, 70) + ' recovered')}" maxlength="80" required></label><label>Type “${esc(item.name)}” to confirm the source<input name="name" value="${esc(draft.recoverName || '')}" autocomplete="off" required></label><label class="check"><input name="confirm" type="checkbox" required ${draft.recoverConfirm ? 'checked' : ''}>I want an independent copy, including any installed mods or plugins.</label><button class="primary" ${fresh ? '' : 'disabled'}>Recover stopped server</button></form></details>` : `<p>Recovery needs review: ${esc(review.recovery.reason)}</p>`}<details><summary>Permanently delete retained data</summary><p>This deletes this removed server’s original worlds, player progress, settings, software and backups. Shared snapshots are kept.</p><form data-delete-storage="${esc(key)}"><label>Type “${esc(item.name)}” to confirm deletion<input name="name" value="${esc(draft.deleteName || '')}" autocomplete="off" required></label><label class="check"><input name="confirm" type="checkbox" required ${draft.deleteConfirm ? 'checked' : ''}>Permanently delete this retained data.</label><button class="danger" ${fresh ? '' : 'disabled'}>Delete retained data</button></form></details>`
                    : ''
                }`
          }</article>`;
        })
        .join(
          '',
        )}</div>${!loading && !items.length ? '<p>No removed server storage is registered on the available hosts.</p>' : ''}<p class="hint">Storage operations appear in <a href="#operations">Operations</a>.</p>`,
    );
    ctx.on(ctx.root, 'input', (event) => {
      const form = event.target.closest('form'),
        key = form?.dataset.recoverStorage || form?.dataset.deleteStorage;
      if (!key) return;
      const current = drafts.get(key) || {},
        recover = !!form.dataset.recoverStorage;
      if (recover)
        Object.assign(current, {
          newName: form.elements.newName.value,
          recoverName: form.elements.name.value,
          recoverConfirm: form.elements.confirm.checked,
        });
      else
        Object.assign(current, {
          deleteName: form.elements.name.value,
          deleteConfirm: form.elements.confirm.checked,
        });
      drafts.set(key, current);
    });
    ctx.on(ctx.root, 'click', async (event) => {
      const button = event.target.closest('[data-inspect-storage]');
      if (!button || button.disabled) return;
      const item = items.find(
        (value) => serverKey(value) === button.dataset.inspectStorage,
      );
      if (!item) return;
      button.disabled = true;
      try {
        await submit(ctx, item, 'inspect', {});
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
    ctx.on(ctx.root, 'submit', async (event) => {
      const form = event.target.closest(
        '[data-recover-storage],[data-delete-storage]',
      );
      if (!form) return;
      event.preventDefault();
      const key = form.dataset.recoverStorage || form.dataset.deleteStorage,
        item = items.find((value) => serverKey(value) === key);
      if (!item) return;
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      try {
        await submit(
          ctx,
          item,
          form.dataset.recoverStorage ? 'recover' : 'remove',
          {
            name: form.elements.name.value,
            confirm: form.elements.confirm.checked,
            reviewToken: item.storageReview?.token,
            ...(form.dataset.recoverStorage
              ? {newName: form.elements.newName.value}
              : {}),
          },
        );
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  async function submit(ctx, item, action, body) {
    try {
      await ctx.request(
        model.route(item.hostId, '/removed-servers/' + item.id + '/' + action),
        {method: 'POST', body},
      );
      if (!ctx.isCurrent()) return;
      problem = '';
      revision = '';
      notice(
        action === 'inspect'
          ? 'Inspecting retained storage. Progress appears in Operations.'
          : action === 'recover'
            ? 'Recovering an independent stopped server. Original storage is kept.'
            : 'Deleting the selected retained data. Shared snapshots are kept.',
      );
      await model.refresh();
      await load(ctx);
    } catch (error) {
      if (ctx.isCurrent()) {
        problem = error.message;
        paint(ctx);
      }
    }
  }
  async function load(ctx) {
    if (loading) return;
    loading = true;
    const next = [],
      failures = [];
    await Promise.all(
      model.snapshot.hosts.map(async (host) => {
        if (!host.connected) {
          failures.push(
            host.name + ' is offline. Its retained storage is unavailable.',
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
              hostId: host.id,
              hostName: host.name,
            })),
          );
        } catch (error) {
          failures.push(host.name + ': ' + error.message);
        }
      }),
    );
    loading = false;
    if (!ctx.isCurrent()) return;
    next.sort((a, b) => serverKey(a).localeCompare(serverKey(b)));
    failures.sort();
    const nextRevision = JSON.stringify([
      next,
      failures,
      next.map(
        (i) =>
          !!i.storageReview &&
          Date.now() - Date.parse(i.storageReview.inspectedAt) < 15 * 60 * 1000,
      ),
    ]);
    if (nextRevision !== revision) {
      items = next;
      problems = failures;
      revision = nextRevision;
      paint(ctx);
    }
  }
  return {
    async mount(ctx) {
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
