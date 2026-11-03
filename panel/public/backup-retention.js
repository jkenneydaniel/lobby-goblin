import {escapeHTML as esc, formatBytes as bytes} from './shared/view.js';
const date = (value) => new Date(value).toLocaleString();
export function retentionView(record, draft = null) {
  const saved = record || {
    policy: {
      enabled: false,
      days: 30,
      includeManual: false,
      includeSafety: false,
    },
    revision: 0,
  };
  const policy = draft?.policy ?? saved.policy,
    revision = draft?.revision ?? saved.revision,
    {lastRun} = saved;
  return `<section class="product-card"><div class="product-card-header"><h2>Keep room for what’s next.</h2><span class="product-workflow-badge">${saved.policy.enabled ? 'Daily cleanup on' : 'Manual cleanup'}</span></div><div class="product-card-content"><p class="form-note">Clear older backup archives with a retention window that suits your server.</p>
  <form id="retention-form" data-revision="${revision}"><label>Keep backups for (days)<input type="number" name="days" min="1" max="3650" value="${esc(policy.days)}" required aria-describedby="retention-days-note"></label><p class="hint" id="retention-days-note">For example: 7, 30 or 90 days. Scheduled backups are included.</p>
  <label class="check-label"><input type="checkbox" name="enabled" ${policy.enabled ? 'checked' : ''}>Clean up automatically each day</label>
  <details class="retention-options"><summary>Include other backup types</summary><label class="check-label"><input type="checkbox" name="includeManual" ${policy.includeManual ? 'checked' : ''}>Include manual backups</label><label class="check-label"><input type="checkbox" name="includeSafety" ${policy.includeSafety ? 'checked' : ''}>Include backups taken before changes</label><p class="hint">These copies are excluded unless you choose to include them.</p></details>
  <p class="form-note">Always keeps the newest two of each type, the most recent verified archive, and copies required for update recovery. World libraries and game autosaves are outside cleanup.</p>
  <div class="button-group"><button class="button primary" type="submit" data-retention-button>Save cleanup settings</button><button class="button" type="button" id="review-cleanup" data-retention-button>Review cleanup</button><button class="button" type="button" id="reload-retention" data-retention-button>Reload saved cleanup settings</button></div>
  ${draft ? `<p class="hint" id="retention-draft-note">${revision !== saved.revision ? 'Saved cleanup settings changed. Your draft is retained; reload before saving.' : 'Your unsaved cleanup settings are retained.'}</p>` : ''}
  <p class="hint retention-status" id="retention-status" role="status">${lastRun ? 'Last automatic cleanup attempt: ' + esc(date(lastRun)) + '. Check activity for the result.' : saved.policy.enabled ? 'Daily cleanup is enabled. The first run is due while the controller is running.' : 'Automatic cleanup is off until you enable and confirm it.'}</p></form>
  <div id="retention-review" class="retention-review" hidden></div></div></section>`;
}
export function bindRetention({
  api,
  confirmAction,
  startJob,
  toast,
  render,
  busy,
  draft = null,
  root = document,
}) {
  const form = root.querySelector('#retention-form');
  if (!form) return;
  const review = root.querySelector('#retention-review'),
    status = root.querySelector('#retention-status');
  let plan = null,
    reviewEpoch = 0,
    working = false,
    dirty = draft !== null,
    disposed = false;
  const isBusy = typeof busy === 'function' ? busy : () => !!busy;
  const policy = () => ({
    enabled: form.elements.enabled.checked,
    days: Number(form.elements.days.value),
    includeManual: form.elements.includeManual.checked,
    includeSafety: form.elements.includeSafety.checked,
  });
  const setWorking = (value) => {
    working = value;
    if (disposed) return;
    form
      .querySelectorAll('input,[data-retention-button]')
      .forEach((element) => (element.disabled = value || isBusy()));
  };
  setWorking(false);
  const clearReview = () => {
    if (disposed) return;
    reviewEpoch++;
    plan = null;
    review.hidden = true;
    review.replaceChildren();
    status.textContent =
      'Settings changed. Review cleanup to see which backups would be deleted.';
  };
  form.addEventListener('input', () => {
    dirty = true;
    clearReview();
  });
  async function preview() {
    const epoch = ++reviewEpoch;
    const value = await api('/backup-retention', {
      method: 'POST',
      body: {operation: 'preview', policy: policy()},
    });
    if (disposed || epoch !== reviewEpoch) return null;
    plan = value;
    review.innerHTML = `<h3 tabindex="-1">${value.candidates.length ? value.candidates.length + ' old backup' + (value.candidates.length === 1 ? '' : 's') + ' ready to clear' : 'Nothing to clean up'}</h3><p class="form-note">${esc(bytes(value.bytes))} to free · Older than ${esc(date(value.cutoff))}. This review expires in 10 minutes.</p>${value.candidates.length ? `<ul class="retention-files" aria-label="Backups to delete">${value.candidates.map((item) => `<li><span>${esc(item.relative)}</span><span>${esc(bytes(item.size))}</span></li>`).join('')}</ul><p class="hint">Deletion is permanent. Download any copies you want to keep first. Newest and protected backups stay in place.</p><button class="button danger" type="button" id="delete-old-backups">Delete ${value.candidates.length} old backup${value.candidates.length === 1 ? '' : 's'}</button>` : '<p class="hint">All backup archives are within the window, excluded, or protected.</p>'}<details class="retention-protected"><summary>${value.protected.length} backup${value.protected.length === 1 ? '' : 's'} kept — see why</summary><ul class="retention-files">${value.protected.map((item) => `<li><span>${esc(item.relative)}<small>${esc(item.reason)}</small></span></li>`).join('')}</ul></details>`;
    review.hidden = false;
    status.textContent =
      'Review uses the settings above. Reviewing and deleting now do not save the daily cleanup policy.';
    review.querySelector('h3').focus();
    review
      .querySelector('#delete-old-backups')
      ?.addEventListener('click', async () => {
        if (disposed || working || isBusy() || plan !== value) return;
        if (
          !(await confirmAction(
            'Delete ' + value.candidates.length + ' old backups?',
            `Permanently delete the ${value.candidates.length} listed backup archive(s), freeing ${bytes(value.bytes)}. Protected backups and the current game remain unchanged.`,
            'Delete old backups',
          ))
        )
          return;
        if (disposed || working || isBusy() || plan !== value) return;
        setWorking(true);
        review.querySelector('#delete-old-backups').disabled = true;
        try {
          await startJob('cleanup-backups', {planId: value.id, confirm: true});
        } finally {
          setWorking(false);
          if (!disposed && review.isConnected) clearReview();
        }
      });
    return value;
  }
  root.querySelector('#review-cleanup').addEventListener('click', async () => {
    if (disposed || working || isBusy() || !form.reportValidity()) return;
    setWorking(true);
    try {
      await preview();
    } catch (error) {
      if (!disposed) {
        clearReview();
        status.textContent = error.message;
        toast(error.message, true);
      }
    } finally {
      setWorking(false);
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (disposed || working || isBusy() || !form.reportValidity()) return;
    setWorking(true);
    try {
      const value = policy();
      let reviewed = null;
      if (value.enabled) {
        reviewed = await preview();
        if (!reviewed || disposed) return;
        if (
          !(await confirmAction(
            'Enable daily backup cleanup?',
            `Keep eligible backups for ${value.days} days. ${reviewed.candidates.length} archive(s) are currently eligible. The first automatic cleanup can run within a minute, then daily while the controller is running. Future eligible archives will be permanently deleted without another confirmation.`,
            'Enable daily cleanup',
          ))
        )
          return;
        if (disposed || isBusy() || plan !== reviewed) return;
      }
      if (disposed || isBusy()) return;
      await api('/backup-retention', {
        method: 'POST',
        body: {
          operation: 'save',
          policy: value,
          revision: Number(form.dataset.revision),
          ...(reviewed ? {planId: reviewed.id, confirm: true} : {}),
        },
      });
      if (disposed) return;
      dirty = false;
      await render();
      toast('Backup cleanup settings saved.');
    } catch (error) {
      if (!disposed) {
        status.textContent = error.message;
        toast(error.message, true);
      }
    } finally {
      setWorking(false);
    }
  });
  root
    .querySelector('#reload-retention')
    .addEventListener('click', async () => {
      if (disposed || working || isBusy()) return;
      const previousDirty = dirty;
      setWorking(true);
      try {
        if (
          dirty &&
          !(await confirmAction(
            'Discard unsaved cleanup settings?',
            'Reload the saved cleanup policy and discard this local draft.',
          ))
        )
          return;
        if (disposed || isBusy()) return;
        dirty = false;
        await render();
      } catch (error) {
        if (!disposed) {
          dirty = previousDirty;
          status.textContent = error.message;
          toast(error.message, true);
        }
      } finally {
        setWorking(false);
      }
    });
  return {
    setBusy: () => setWorking(working),
    invalidateReview: clearReview,
    get draft() {
      return dirty
        ? {
            policy: {...policy(), days: form.elements.days.value},
            revision: Number(form.dataset.revision),
          }
        : null;
    },
    dispose() {
      disposed = true;
      reviewEpoch++;
      plan = null;
    },
  };
}
