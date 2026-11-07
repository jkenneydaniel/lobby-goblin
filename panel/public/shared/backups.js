import {serverPath} from '../scope.js';
import {retentionView, bindRetention} from '../backup-retention.js';
import {escapeHTML as esc, formatBytes, formatDate} from './view.js';

const verificationState = (item) =>
  item.validation?.ok ? 'verified' : item.validation ? 'failed' : 'unverified';

// Select only loaded public archive names and the existing row-label states.
export function selectBackupArchives(archives, query, state) {
  const needle = query.trim().toLowerCase();
  return archives.filter(
    (item) =>
      (!needle || item.relative.toLowerCase().includes(needle)) &&
      (state === 'all' || verificationState(item) === state),
  );
}

// Show only existing public verification observations, never the adapter's
// arbitrary metadata or unstructured errors that can contain archive contents.
// Integrity is distinct from successful game-load recovery.
export function backupEvidenceView(validation) {
  const recorded =
      validation &&
      typeof validation === 'object' &&
      !Array.isArray(validation),
    checked =
      recorded &&
      typeof validation.checked === 'string' &&
      Number.isFinite(Date.parse(validation.checked))
        ? formatDate(validation.checked)
        : 'Unknown',
    sha256 =
      recorded &&
      validation.ok === true &&
      typeof validation.sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(validation.sha256)
        ? validation.sha256
        : 'Not available in this recorded check',
    failure =
      recorded && validation.ok === false
        ? '<p>Recorded integrity check failed.</p>'
        : '';
  return `<details><summary>Integrity check details</summary>${recorded ? `<p>Checked: ${esc(checked)}</p><p>SHA256: <code>${esc(sha256)}</code></p>${failure}` : validation == null ? '<p>No matching integrity check is recorded for this archive.</p>' : '<p>Recorded integrity check details are unavailable.</p>'}<p class="hint">Archive integrity checks do not prove that the game can load or recover this backup.</p></details>`;
}

export function backupHealthView(health) {
  if (!health) return '';
  return `<div class="product-backup-health">${health.alerts.map((message) => `<p class="warning">${esc(message)}</p>`).join('')}<p>${health.verifiedCount} verified archives · Latest backup: ${esc(formatDate(health.latestAt))}</p></div>`;
}

export function mountBackups(
  root,
  {
    request,
    startJob,
    isAdmin,
    busy,
    allow = () => isAdmin(),
    confirm,
    notify,
    showHeading = true,
    restore = false,
    interruption = false,
    description = 'Verified copies of your server data.',
    empty = 'Create a backup after the game has written its first save.',
  },
) {
  const showTools = () =>
    isAdmin() ||
    [
      'backups.create',
      'backups.download',
      'backups.restore',
      'backups.schedule',
      'backups.cleanup',
    ].some(allow);
  const abort = new AbortController();
  let record = null,
    loading = 0,
    disposed = false,
    savingSchedule = false,
    savingRetention = false,
    retentionControls = null;
  const view = root.querySelector('[data-backup-view]') || root;
  // Keep these native controls for this mount. Local selection replaces only
  // archive rows, so schedule/cleanup drafts, reviews and pending saves stay put.
  const archives = document.createElement('section');
  archives.className = 'product-card';
  archives.innerHTML =
    '<h2>Saved archives</h2><label>Find archives<input type="search" maxlength="80" data-archive-query></label><label>Show archives<select data-archive-state><option value="all">All</option><option value="verified">Integrity verified</option><option value="failed">Verification failed</option><option value="unverified">Not verified</option></select></label><button type="button" data-archive-clear>Clear filters</button><p class="hint">Filters cover the loaded archive list and existing verification observations; finding an archive does not verify it.</p><p data-archive-count role="status"></p><div data-archive-rows></div>';
  const query = archives.querySelector('[data-archive-query]'),
    state = archives.querySelector('[data-archive-state]'),
    rows = archives.querySelector('[data-archive-rows]');
  let composing = false;
  function setArchiveBusy() {
    for (const [selector, permission] of [
      ['[data-backup-verify]', 'backups.create'],
      ['a[href*="kind=backup"]', 'backups.download'],
      ['[data-backup-restore]', 'backups.restore'],
    ])
      if (!allow(permission))
        archives
          .querySelectorAll(selector)
          .forEach((element) => element.remove());
    archives
      .querySelectorAll('[data-backup-verify],[data-backup-restore]')
      .forEach((button) => (button.disabled = busy()));
  }
  function paintArchives() {
    if (disposed || !record || composing) return;
    const matches = selectBackupArchives(
      record.backups,
      query.value,
      state.value,
    );
    archives.querySelector('[data-archive-count]').textContent =
      matches.length +
      ' matching of ' +
      record.backups.length +
      ' loaded archives.';
    rows.innerHTML = matches.length
      ? `<div class="table-wrap"><table><thead><tr><th>Archive</th><th>Created</th><th>Size</th><th>Actions</th></tr></thead><tbody>${matches.map((item) => `<tr><td><span data-archive-label>${esc(item.relative)}<small>${item.validation?.ok ? 'Archive integrity verified' : item.validation ? 'Verification failed' : 'Not verified'}</small></span>${backupEvidenceView(item.validation)}</td><td>${esc(formatDate(item.modified))}</td><td>${formatBytes(item.size)}</td><td>${showTools() ? `<button data-backup-verify="${esc(item.relative)}" ${busy() ? 'disabled' : ''}>Verify</button><a class="button" href="${serverPath('/api/download')}?kind=backup&amp;name=${encodeURIComponent(item.relative)}">Download</a>${restore ? `<button data-backup-restore="${esc(item.relative)}" ${busy() ? 'disabled' : ''}>Restore</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : `<p>${record.backups.length ? 'No matching loaded archives.' : esc(empty)}</p>`;
    setArchiveBusy();
  }
  query.addEventListener(
    'input',
    (event) => {
      if (!event.isComposing) paintArchives();
    },
    {signal: abort.signal},
  );
  query.addEventListener(
    'compositionstart',
    () => {
      composing = true;
    },
    {signal: abort.signal},
  );
  query.addEventListener(
    'compositionend',
    () => {
      composing = false;
      paintArchives();
    },
    {signal: abort.signal},
  );
  query.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.isComposing || composing) return;
      event.preventDefault();
      query.value = '';
      paintArchives();
    },
    {signal: abort.signal},
  );
  state.addEventListener('change', paintArchives, {signal: abort.signal});
  archives.querySelector('[data-archive-clear]').addEventListener(
    'click',
    () => {
      composing = false;
      query.value = '';
      state.value = 'all';
      paintArchives();
      query.focus();
    },
    {signal: abort.signal},
  );
  function setBusy() {
    setArchiveBusy();
    if (!allow('backups.create'))
      view
        .querySelectorAll('[data-backup-create]')
        .forEach((element) => element.remove());
    if (!allow('backups.schedule'))
      view.querySelector('#schedule-form')?.closest('section').remove();
    if (!allow('backups.cleanup'))
      view.querySelector('#retention-form')?.closest('section').remove();
    view
      .querySelectorAll('[data-backup-create],#schedule-form button')
      .forEach(
        (button) =>
          (button.disabled =
            busy() ||
            (savingSchedule && button.closest('#schedule-form') !== null)),
      );
    retentionControls?.setBusy();
  }
  async function saveRetention(body) {
    if (disposed || savingRetention || busy()) return;
    savingRetention = true;
    setBusy();
    let saved = false;
    try {
      const policy = await request('/backup-retention', {
        method: 'POST',
        body,
      });
      saved = true;
      if (disposed) return;
      // Controls may have been replaced by an unrelated backup refresh. The
      // mounted workflow owns this result and keeps replacements disabled until
      // it reconciles the saved revision, so no newer edits are discarded.
      loading++;
      record.retention = policy;
      retentionControls?.saved(policy);
      await load({preserveSchedule: true});
      if (!disposed) notify('Backup cleanup settings saved.');
    } catch (error) {
      if (!disposed) {
        const message = saved
          ? 'Backup cleanup settings saved, but refreshing backups failed: ' +
            error.message
          : error.message;
        const status = view.querySelector('#retention-status');
        if (status) status.textContent = message;
        notify(message, true);
      }
    } finally {
      savingRetention = false;
      if (!disposed) setBusy();
    }
  }
  async function load({preserveSchedule = false} = {}) {
    const version = ++loading;
    retentionControls?.invalidateReview();
    const result = await request('/backups', {signal: abort.signal});
    if (disposed || version !== loading) return;
    const oldForm = view.querySelector('#schedule-form'),
      draft =
        preserveSchedule && oldForm
          ? {
              enabled: oldForm.elements.enabled.checked,
              hours: oldForm.elements.hours.value,
              keep: oldForm.elements.keep.value,
            }
          : null;
    const retentionDraft = preserveSchedule ? retentionControls?.draft : null;
    retentionControls?.dispose();
    const focused =
        archives.contains(document.activeElement) &&
        document.activeElement.matches(
          '[data-archive-query],[data-archive-state],[data-archive-clear]',
        )
          ? document.activeElement
          : null,
      range =
        focused === query ? [query.selectionStart, query.selectionEnd] : null;
    record = result;
    view.innerHTML = `<div class="product-workflow">${showHeading ? '<h1>Backups</h1>' : ''}<p>${esc(description)}</p>${showTools() ? `<button type="button" data-backup-create ${busy() ? 'disabled' : ''}>Create backup</button>` : ''}${backupHealthView(result.health)}<div data-archive-slot></div>${showTools() ? `<div class="product-workflow-grid"><section class="product-card"><h2>Automatic backups</h2><form id="schedule-form"><label class="check-label"><input name="enabled" type="checkbox" ${(draft?.enabled ?? result.schedule.enabled) ? 'checked' : ''}>Create backups on a schedule</label><label>Every (hours)<input name="hours" type="number" min="1" max="168" value="${esc(draft?.hours ?? result.schedule.hours)}" required></label><label>Scheduled backups to keep<input name="keep" type="number" min="2" max="100" value="${esc(draft?.keep ?? result.schedule.keep)}" required></label><p>${interruption ? 'Each backup saves, stops and resumes the game. Connected players will be disconnected.' : 'The host and Docker must be running.'} The count limit removes older scheduled copies.</p><button ${busy() ? 'disabled' : ''}>Save schedule</button></form></section>${retentionView(result.retention, retentionDraft)}</div>` : ''}</div>`;
    view.querySelector('[data-archive-slot]').replaceWith(archives);
    paintArchives();
    if (focused) {
      focused.focus({preventScroll: true});
      if (range) query.setSelectionRange(...range);
    }
    setBusy();
    view
      .querySelector('#schedule-form')
      ?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          enabled = form.elements.enabled.checked;
        if (busy() || savingSchedule || disposed) return;
        savingSchedule = true;
        setBusy();
        try {
          if (
            enabled &&
            interruption &&
            !(await confirm(
              'Schedule game interruptions?',
              'Every scheduled backup will save, stop and resume the game. Connected players will be disconnected. Older scheduled archives beyond the count limit may be removed.',
            ))
          )
            return;
          if (disposed || busy()) return;
          await request('/schedule', {
            method: 'POST',
            body: {
              enabled,
              hours: Number(form.elements.hours.value),
              keep: Number(form.elements.keep.value),
              ...(interruption ? {confirmDowntime: enabled} : {}),
            },
          });
          if (!disposed) notify('Backup schedule saved.');
        } catch (error) {
          if (!disposed) notify(error.message, true);
        } finally {
          savingSchedule = false;
          if (!disposed) setBusy();
        }
      });
    if (allow('backups.cleanup'))
      retentionControls = bindRetention({
        root: view,
        api: request,
        confirmAction: confirm,
        startJob,
        toast: (...args) => {
          if (!disposed) notify(...args);
        },
        render: () => load({preserveSchedule: true}),
        savePolicy: saveRetention,
        busy: () => busy() || savingRetention,
        draft: retentionDraft,
      });
  }
  view.addEventListener(
    'click',
    (event) => {
      const button = event.target.closest(
        '[data-backup-create],[data-backup-verify],[data-backup-restore]',
      );
      if (!button || busy()) return;
      void (async () => {
        button.disabled = true;
        try {
          if (button.hasAttribute('data-backup-create'))
            await startJob('backup');
          if (button.dataset.backupVerify)
            await startJob('verify-backup', {
              name: button.dataset.backupVerify,
            });
          if (
            button.dataset.backupRestore &&
            (await confirm(
              'Restore this backup?',
              'The current world, settings and mods will be backed up before this archive is restored. Connected players will be disconnected.',
            ))
          )
            await startJob('restore', {
              name: button.dataset.backupRestore,
              confirm: true,
            });
        } catch (error) {
          notify(error.message, true);
        } finally {
          if (!disposed) button.disabled = busy();
        }
      })();
    },
    {signal: abort.signal},
  );
  return {
    load,
    setBusy,
    get record() {
      return record;
    },
    dispose() {
      disposed = true;
      loading++;
      retentionControls?.dispose();
      abort.abort();
    },
  };
}
