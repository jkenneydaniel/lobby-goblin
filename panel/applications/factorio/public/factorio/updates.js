import {bindGameUpdate} from '../game-update.js';
import {mountVersionPicker, versionLabel} from '../shared/version-picker.js';
import {compareVersions} from '../shared/versions.js';

export function createUpdateWorkflow({
  getState,
  request: api,
  shell,
  notify: toast,
  releaseView,
}) {
  const $ = (selector) => document.querySelector(selector);
  let generation = 0;
  let panelRelease = null,
    lastReleasePoll = 0,
    updateState = null,
    updateReviewPending = false,
    releaseChecking = false,
    context = null,
    statusViewKey = null,
    controls = new AbortController();
  function refreshReleaseView() {
    const {currentPage} = getState();
    if (!context?.isCurrent()) return false;
    if (
      currentPage !== 'settings' ||
      location.hash !== '#settings/updates' ||
      updateReviewPending ||
      $('#game-update-form')?.contains(document.activeElement) ||
      $('#software-update-form')?.querySelector(
        'input:focus,select:focus,textarea:focus',
      ) ||
      document.querySelector('dialog[open]')
    )
      return false;
    const section = $('#panel-updates');
    if (section) {
      section.replaceWith(releaseView());
      bindUpdates();
      return true;
    }
    return false;
  }
  async function refreshUpdates() {
    const {can, user} = getState();
    if (!can('images.change')) return;
    const signedUser = user;
    try {
      const result = await api('/update-status');
      if (getState().user !== signedUser) return;
      const {status} = getState();
      const nextStatusKey = JSON.stringify([
        status?.software?.mode,
        status?.version,
        status?.softwareRecovery,
        status?.activeJob?.id,
        status?.activeJob?.state,
      ]);
      const changed =
        JSON.stringify(result) !== JSON.stringify(updateState) ||
        nextStatusKey !== statusViewKey;
      updateState = result;
      if (changed && refreshReleaseView()) statusViewKey = nextStatusKey;
    } catch {}
  }
  function bindUpdates(ctx = context) {
    if (!ctx?.isCurrent()) return;
    context = ctx;
    controls.abort();
    controls = new AbortController();
    const {status} = getState();
    const listen = (element, type, listener) =>
      element?.addEventListener(type, listener, {
        signal: AbortSignal.any([ctx.signal, controls.signal]),
      });
    if (status.software?.mode === 'runtime') {
      const form = $('#software-update-form'),
        select = form?.elements.release,
        button = form?.querySelector('button');
      async function changeSoftware(action, version) {
        if (updateReviewPending) return;
        updateReviewPending = true;
        try {
          const recover = action === 'software-recover';
          const older =
            !recover && compareVersions(version, getState().status.version) < 0;
          if (
            await ctx.confirm(
              recover
                ? 'Recover Factorio software?'
                : 'Install Factorio ' + version + '?',
              recover
                ? 'Restore the recorded pre-update world, settings, mods and previous Factorio release. Current data is retained in the recovery library.'
                : (older
                    ? 'This is an older release. Worlds saved by a newer version may not load. Recovery restores the pre-change software and data together. '
                    : '') +
                    'Stop Factorio, create a backup, install the checksum-verified release and check startup. Players disconnect; clients and mods must match. The server returns to its previous running or stopped state.',
              recover ? 'Restore previous release' : 'Install software',
            )
          ) {
            await ctx.request('/jobs', {
              method: 'POST',
              body: {
                action,
                params: {confirm: true, ...(version ? {version} : {})},
              },
            });
            toast(
              'Software operation started. Follow progress under Operations.',
            );
          }
        } catch (error) {
          if (ctx.isCurrent()) toast(error.message, true);
        } finally {
          updateReviewPending = false;
        }
      }
      listen($('#software-recover'), 'click', () =>
        changeSoftware('software-recover'),
      );
      if (form && !form.hidden) {
        button.disabled = true;
        void ctx
          .request('/application-releases')
          .then((data) => {
            if (!ctx.isCurrent() || !form.isConnected) return;
            const choices = (data.stale ? [] : data.choices).filter(
              (choice) => choice.kind === 'software',
            );
            select.replaceChildren(
              ...choices.map(
                (choice) =>
                  new Option(
                    versionLabel(choice, status.version),
                    choice.version,
                  ),
              ),
            );
            if (!choices.length)
              select.append(
                new Option('No other verified release available', ''),
              );
            // An update is always an explicit selection; never default to the
            // first (often experimental) release when loading the catalogue.
            select.value = choices.some(
              (choice) => choice.version === status.version,
            )
              ? status.version
              : '';
            form.querySelector('[data-part=software-status]').textContent =
              data.error ||
              'Factorio 2.x releases · Stable: ' +
                data.stable +
                (data.experimental
                  ? ' · Experimental: ' + data.experimental
                  : '') +
                (data.console ? ' · Console: ' + data.console : '');
            const choose = () => {
              const choice = choices.find(
                  (value) => value.version === select.value,
                ),
                link = form.querySelector('[data-part=software-notes]');
              link.hidden = !choice;
              if (choice) link.href = choice.notesUrl;
              button.disabled =
                !choice ||
                choice.version === status.version ||
                !!status.activeJob;
            };
            listen(select, 'change', choose);
            mountVersionPicker(select, {
              choices: choices.map((choice) => ({
                value: choice.version,
                display: choice.version,
                label: versionLabel(choice, status.version),
              })),
              signal: AbortSignal.any([ctx.signal, controls.signal]),
            });
            choose();
          })
          .catch((error) => {
            if (ctx.isCurrent())
              form.querySelector('[data-part=software-status]').textContent =
                error.message;
          });
        listen(form, 'submit', (event) => {
          event.preventDefault();
          if (select.value && !button.disabled)
            void changeSoftware('software-update', select.value);
        });
      }
      return;
    }
    listen($('#check-panel-updates'), 'click', async () => {
      if (releaseChecking) return;
      releaseChecking = true;
      refreshReleaseView();
      try {
        await refreshReleases(true);
        if (panelRelease?.state !== 'unavailable')
          toast(
            'Release check complete. Repeated checks within one minute use the latest result.',
          );
      } catch (error) {
        if (ctx.isCurrent()) toast(error.message, true);
      } finally {
        releaseChecking = false;
        refreshReleaseView();
      }
    });
    async function review(kind, target, selection = {}) {
      if (updateReviewPending) return;
      updateReviewPending = true;
      const version = generation;
      try {
        const plan = await ctx.request('/update-plan', {
          method: 'POST',
          body: {kind, target, ...selection},
        });
        const message = `${plan.current} → ${plan.targetImage || plan.target}. ${plan.impact} ${plan.backup} ${plan.notes}`;
        if (
          await ctx.confirm(
            plan.operation === 'image-change'
              ? 'Change Factorio image?'
              : 'Install ' +
                  (kind === 'game' ? 'Factorio ' : 'Lobby Goblin ') +
                  plan.target +
                  '?',
            message,
            'Install update',
          )
        ) {
          await ctx.request('/update-install', {
            method: 'POST',
            body: {planId: plan.id, confirm: true},
          });
          toast(
            'Update started. The panel may reconnect; sign in again when it returns.',
          );
        }
      } catch (error) {
        if (ctx.isCurrent()) toast(error.message, true);
      } finally {
        if (version === generation && context === ctx) {
          updateReviewPending = false;
          await refreshUpdates();
        }
      }
    }
    listen($('#review-panel-update'), 'click', () =>
      review('panel', panelRelease.latest.tag.replace(/^v/, '')),
    );
    bindGameUpdate(status?.image, review, toast, {
      request: ctx.request,
      signal: AbortSignal.any([ctx.signal, controls.signal]),
    });
  }
  async function refreshReleases(force = false) {
    const {admin, user} = getState();
    if (!admin() || (!force && Date.now() - lastReleasePoll < 60000)) return;
    lastReleasePoll = Date.now();
    const signedUser = user;
    try {
      const result = await api(
        force ? '/updates/check' : '/updates',
        force ? {method: 'POST', body: {}} : {},
      );
      if (getState().user !== signedUser) return;
      const changed = JSON.stringify(result) !== JSON.stringify(panelRelease);
      panelRelease = result;
      shell.attention(
        'settings',
        result.available ? 'Panel update available' : '',
      );
      const notice = $('#release-notice');
      if (notice) {
        notice.hidden = !result.available;
        notice.textContent = result.latest
          ? 'Panel ' + result.latest.tag + ' available'
          : 'Panel update available';
      }
      if (changed) refreshReleaseView();
    } catch (error) {
      if (force) throw error;
    }
  }

  return {
    get model() {
      return {
        panelRelease,
        updateState,
        updateReviewPending,
        releaseChecking,
      };
    },
    refreshUpdates,
    refreshReleases,
    bindUpdates,
    detach() {
      context = null;
      controls.abort();
    },
    reset() {
      generation++;
      context = null;
      controls.abort();
      panelRelease = null;
      lastReleasePoll = 0;
      updateState = null;
      statusViewKey = null;
      updateReviewPending = false;
      releaseChecking = false;
    },
  };
}
