import {serverPath} from '../scope.js';
import {retentionView, bindRetention} from '../backup-retention.js';
import {escapeHTML as esc, formatBytes, formatDate} from './view.js';

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
    retentionControls = null;
  const view = root.querySelector('[data-backup-view]') || root;
  function setBusy() {
    for (const [selector, permission] of [
      ['[data-backup-create],[data-backup-verify]', 'backups.create'],
      ['a[href*="kind=backup"]', 'backups.download'],
      ['[data-backup-restore]', 'backups.restore'],
    ])
      if (!allow(permission))
        view.querySelectorAll(selector).forEach((element) => element.remove());
    if (!allow('backups.schedule'))
      view.querySelector('#schedule-form')?.closest('section').remove();
    if (!allow('backups.cleanup'))
      view.querySelector('#retention-form')?.closest('section').remove();
    view
      .querySelectorAll(
        '[data-backup-create],[data-backup-verify],[data-backup-restore],#schedule-form button',
      )
      .forEach(
        (button) =>
          (button.disabled =
            busy() ||
            (savingSchedule && button.closest('#schedule-form') !== null)),
      );
    retentionControls?.setBusy();
  }
  async function load({preserveSchedule = false} = {}) {
    const version = ++loading,
      result = await request('/backups', {signal: abort.signal});
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
    record = result;
    view.innerHTML = `<div class="product-workflow">${showHeading ? '<h1>Backups</h1>' : ''}<p>${esc(description)}</p>${showTools() ? `<button type="button" data-backup-create ${busy() ? 'disabled' : ''}>Create backup</button>` : ''}${backupHealthView(result.health)}<section class="product-card"><h2>Saved archives</h2>${result.backups.length ? `<div class="table-wrap"><table><thead><tr><th>Archive</th><th>Created</th><th>Size</th><th>Actions</th></tr></thead><tbody>${result.backups.map((item) => `<tr><td>${esc(item.relative)}<small>${item.validation?.ok ? 'Archive integrity verified' : item.validation ? 'Verification failed' : 'Not verified'}</small></td><td>${esc(formatDate(item.modified))}</td><td>${formatBytes(item.size)}</td><td>${showTools() ? `<button data-backup-verify="${esc(item.relative)}" ${busy() ? 'disabled' : ''}>Verify</button><a class="button" href="${serverPath('/api/download')}?kind=backup&amp;name=${encodeURIComponent(item.relative)}">Download</a>${restore ? `<button data-backup-restore="${esc(item.relative)}" ${busy() ? 'disabled' : ''}>Restore</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p>${esc(empty)}</p>`}</section>${showTools() ? `<div class="product-workflow-grid"><section class="product-card"><h2>Automatic backups</h2><form id="schedule-form"><label class="check-label"><input name="enabled" type="checkbox" ${(draft?.enabled ?? result.schedule.enabled) ? 'checked' : ''}>Create backups on a schedule</label><label>Every (hours)<input name="hours" type="number" min="1" max="168" value="${esc(draft?.hours ?? result.schedule.hours)}" required></label><label>Scheduled backups to keep<input name="keep" type="number" min="2" max="100" value="${esc(draft?.keep ?? result.schedule.keep)}" required></label><p>${interruption ? 'Each backup saves, stops and resumes the game. Connected players will be disconnected.' : 'The host and Docker must be running.'} The count limit removes older scheduled copies.</p><button ${busy() ? 'disabled' : ''}>Save schedule</button></form></section>${retentionView(result.retention, retentionDraft)}</div>` : ''}</div>`;
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
        busy,
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
