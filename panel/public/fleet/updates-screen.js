import {escapeHTML as esc, formatDate} from '../shared/view.js';
import {version, compareVersions} from '../shared/versions.js';

export function createUpdatesScreen({model, notice}) {
  const expanded = new Set();
  let settingsDraft = null;
  let release = null,
    host = null,
    settings = null,
    saving = false,
    selected = '',
    catalogue = null,
    problem = '',
    checking = false,
    loading = false,
    generation = 0,
    management = null,
    managementHost = '',
    managementBusy = false,
    managementError = '',
    managementActionError = null,
    managementTimer,
    managementGeneration = 0;
  const server = () =>
    model.snapshot.servers.find(
      (item) => item.hostId + ':' + item.id === selected,
    );
  function paint(ctx) {
    if (!ctx.isCurrent()) return;
    for (const element of ctx.root.querySelectorAll(
      '[data-update-disclosure]',
    )) {
      if (element.open) expanded.add(element.dataset.updateDisclosure);
      else expanded.delete(element.dataset.updateDisclosure);
    }
    ctx.render(
      `<div class="heading updates-heading"><h1>Updates</h1><button data-check-updates ${checking || settings?.enabled === false ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check for updates'}</button></div>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ''}<section class="card updates-card" aria-label="Lobby Goblin updates">${managementView()}${settingsView()}${disclosure('help', 'Update help', '<p>If an update is interrupted, use its recovery actions above. If the panel stays unavailable, follow the host recovery guide.</p>' + guide('Open host recovery guide'))}</section><section class="card updates-card" aria-label="Game updates"><h2>Game servers</h2><label>Server<select data-update-server><option value="">Choose a server</option>${model.snapshot.servers.map((value) => `<option value="${esc(value.hostId + ':' + value.id)}" ${selected === value.hostId + ':' + value.id ? 'selected' : ''}>${esc(value.name)} · ${esc(value.hostName)}</option>`).join('')}</select></label>${loading ? '<p role="status">Checking game releases…</p>' : ''}<div data-application-releases>${applicationView(server(), catalogue)}</div></section>`,
    );
    for (const element of ctx.root.querySelectorAll('[data-update-disclosure]'))
      ctx.on(element, 'toggle', () => {
        if (element.open) expanded.add(element.dataset.updateDisclosure);
        else expanded.delete(element.dataset.updateDisclosure);
      });
    const retry = ctx.root.querySelector('[data-retry-management]');
    if (retry) ctx.on(retry, 'click', () => loadManagement(ctx));
    const configure = ctx.root.querySelector('[data-open-update-settings]');
    if (configure)
      ctx.on(configure, 'click', () => {
        const element = ctx.root.querySelector(
          '[data-update-disclosure="settings"]',
        );
        if (element) {
          element.open = true;
          element.querySelector('input')?.focus();
        }
      });
    ctx.on(ctx.root.querySelector('[data-check-updates]'), 'click', () =>
      check(ctx, true),
    );
    ctx.on(
      ctx.root.querySelector('[data-update-server]'),
      'change',
      async (event) => {
        selected = event.target.value;
        await loadApplication(ctx);
      },
    );
    const hostPicker = ctx.root.querySelector('[data-management-host]');
    if (hostPicker)
      ctx.on(hostPicker, 'change', async (event) => {
        managementHost = event.target.value;
        management = null;
        managementError = '';
        managementActionError = null;
        await loadManagement(ctx);
      });
    for (const button of ctx.root.querySelectorAll('[data-management-action]'))
      ctx.on(button, 'click', () =>
        managementAction(ctx, button.dataset.managementAction),
      );
    const form = ctx.root.querySelector('[data-release-settings]');
    if (form) {
      ctx.on(form, 'change', () => {
        const data = new FormData(form);
        settingsDraft = {
          enabled: data.has('enabled'),
          channel: data.get('channel'),
          revision: settingsDraft?.revision ?? settings.revision,
        };
      });
      ctx.on(form, 'submit', async (event) => {
        event.preventDefault();
        if (saving) return;
        const data = new FormData(form);
        saving = true;
        problem = '';
        paint(ctx);
        try {
          settings = await ctx.request('/updates/settings', {
            method: 'POST',
            body: {
              enabled: data.has('enabled'),
              channel: data.get('channel'),
              revision: settingsDraft?.revision ?? settings.revision,
            },
          });
          settingsDraft = null;
          release = await ctx.request(
            settings.enabled ? '/updates/check' : '/updates',
            settings.enabled ? {method: 'POST', body: {}} : {},
          );
          if (ctx.isCurrent()) notice('Release settings saved.');
        } catch (error) {
          if (ctx.isCurrent()) problem = error.message;
        } finally {
          saving = false;
          paint(ctx);
        }
      });
    }
    const select = ctx.root.querySelector('[data-release-choice]');
    if (select)
      ctx.on(select, 'change', () => {
        const choice = catalogue.choices.find(
            (value) => (value.image || value.version) === select.value,
          ),
          link = ctx.root.querySelector('[data-version-notes]');
        if (choice) link.href = choice.notesUrl;
      });
  }
  const selectedHost = () =>
    model.snapshot.hosts.find((value) => value.id === managementHost) ||
    model.snapshot.hosts.find((value) => value.local);
  const managementRoute = () =>
    model.route(selectedHost()?.id, '/management-update');
  const targetVersion = () =>
    release?.latest?.tag?.replace(/^v/, '') ||
    (selectedHost()?.local ? '' : release?.current);
  const guide = (label) =>
    `<a href="https://github.com/jkenneydaniel/lobby-goblin/blob/main/docs/MANAGEMENT_UPDATES.md" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  function disclosure(key, title, body) {
    return `<details data-update-disclosure="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary>${esc(title)}</summary>${body}</details>`;
  }
  function settingsView() {
    if (!settings) return '';
    const draft = settingsDraft || settings;
    return disclosure(
      'settings',
      'Update settings',
      `${settings.editable ? `<form data-release-settings><label class="check"><input type="checkbox" name="enabled" ${draft.enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}> Check for updates automatically</label><label>Release channel<select name="channel" ${saving ? 'disabled' : ''}><option value="stable" ${draft.channel === 'stable' ? 'selected' : ''}>Stable releases</option><option value="preview" ${draft.channel === 'preview' ? 'selected' : ''}>Preview and stable releases</option></select></label><p class="hint">Automatic checks run every six hours.</p><button type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save settings'}</button></form>` : '<p>Release checks are configured by the host administrator.</p>'}<p class="hint">Last checked: ${esc(formatDate(release?.checkedAt))}</p>`,
    );
  }
  function managementView() {
    const update = management?.update;
    const busy =
      managementBusy || ['planning', 'running'].includes(update?.state);
    const current =
      management?.currentVersion ||
      (selectedHost()?.local ? release?.current : selectedHost()?.version) ||
      host?.version;
    const target = targetVersion();
    const knownVersions = version(target) && version(current);
    const available = knownVersions && compareVersions(target, current) > 0;
    const terminal = ['complete', 'rolled-back', 'failed'].includes(
      update?.state,
    );
    const title =
      (available && terminal ? 'Update available' : '') ||
      {
        planning: 'Preparing update…',
        reviewed: 'Ready to install',
        running: 'Updating Lobby Goblin…',
        attention: 'Update needs attention',
        complete: 'Update complete',
        'rolled-back': 'Previous version restored',
        failed: 'Review failed',
      }[update?.state] ||
      (release?.error
        ? 'Could not check updates'
        : available
          ? 'Update available'
          : knownVersions || release?.state === 'current'
            ? 'Up to date'
            : release?.state === 'disabled'
              ? 'Release checks are off'
              : checking || !release
                ? 'Checking for updates…'
                : 'No release available');
    const canReview =
      management?.supported && !busy && (!update || terminal) && available;
    const label = {
      apply: 'Install update',
      cancel: 'Cancel review',
      resume: 'Resume update',
      rollback: 'Restore previous version',
      reset: 'Reset failed review',
    };
    let explanation = '';
    if (update?.state === 'reviewed')
      explanation =
        update.expires <= Date.now()
          ? 'This review expired. Cancel it and review the update again.'
          : 'The panel will restart briefly. Your game servers keep running.';
    else if (update?.state === 'running')
      explanation =
        'The panel will reconnect automatically. You may need to sign in again.';
    else if (update?.state === 'attention')
      explanation = update.cleanupRequired
        ? 'The update is installed. Resume to finish cleanup.'
        : update.actions?.includes('reset')
          ? 'The update did not start. Reset the review to try again.'
          : 'The update was interrupted. Use the recovery actions below to continue.';
    else if (update?.state === 'failed')
      explanation =
        'The release could not be reviewed. Try again or open Update help.';
    return `<div class="management-update"><div class="updates-summary"><div><h2>Lobby Goblin</h2><p class="updates-version">${current ? `Installed ${esc(current)}` : 'Reading installed version…'}${available && (!update || terminal) ? ` <span>→ ${esc(target)}</span>` : update?.version && !['complete', 'rolled-back'].includes(update.state) ? ` <span>→ ${esc(update.version)}</span>` : ''}</p></div><p class="status ${busy || available || ['attention', 'failed'].includes(update?.state) ? 'attention' : ''}" role="status">${esc(title)}</p></div>${model.snapshot.hosts.length > 1 ? `<label class="updates-host">Host<select data-management-host ${managementBusy ? 'disabled' : ''}>${model.snapshot.hosts.map((value) => `<option value="${esc(value.id)}" ${selectedHost()?.id === value.id ? 'selected' : ''}>${esc(value.name)}</option>`).join('')}</select></label>` : ''}${managementError ? `<p class="error" role="alert">${esc(managementError)}</p>${!management ? '<button data-retry-management>Retry update controls</button>' : ''}` : ''}${release?.error ? `<p class="error" role="alert">${esc(release.error)}</p>` : ''}${explanation ? `<p>${esc(explanation)}</p>` : ''}${update?.state === 'attention' && update.id ? `<p class="hint">Update reference: <code>${esc(update.id)}</code></p>` : ''}<div class="actions updates-actions">${(
      update?.actions || []
    )
      .filter((action) => label[action])
      .map(
        (action) =>
          `<button class="${action === 'apply' ? 'primary' : ''}" data-management-action="${esc(action)}" ${busy || (action === 'apply' && update.expires <= Date.now()) ? 'disabled' : ''}>${label[action]}</button>`,
      )
      .join(
        '',
      )}${canReview ? `<button class="primary" data-management-action="plan">Review update</button>` : ''}${release?.latest ? `<a href="${esc(release.latest.url)}" target="_blank" rel="noopener noreferrer">Release notes</a>` : ''}${settings?.editable && !settings.enabled ? '<button class="quiet" data-open-update-settings>Configure release checks</button>' : ''}</div>${management?.supported === false ? `<p class="updates-setup">This host needs a one-time setup before panel updates can be installed. ${guide('Set up panel updates')}</p>` : !management && !managementError ? '<p class="hint">Checking update controls…</p>' : ''}${canReview ? '<p class="hint">Panel updates keep your game servers running.</p>' : ''}${update?.id ? disclosure('update', terminal ? 'Last update details' : 'Update details', `<dl class="updates-details"><div><dt>Update reference</dt><dd><code>${esc(update.id)}</code></dd></div>${update.phase ? `<div><dt>Stage</dt><dd>${esc(update.phase)}</dd></div>` : ''}${update.services ? `<div><dt>Scope</dt><dd>${update.services.management} panel services · ${update.services.applications} game containers preserved</dd></div>` : ''}${update.state === 'reviewed' ? `<div><dt>Review expires</dt><dd>${esc(formatDate(update.expires))}</dd></div>` : ''}${update.image ? `<div><dt>Verified runtime image</dt><dd><code>${esc(update.image)}</code></dd></div>` : ''}</dl>${update.message ? `<p>${esc(update.message)}</p>` : ''}`) : ''}</div>`;
  }
  function pollManagement(ctx) {
    clearTimeout(managementTimer);
    if (
      ctx.isCurrent() &&
      (managementBusy ||
        ['planning', 'running'].includes(management?.update?.state))
    )
      managementTimer = setTimeout(() => loadManagement(ctx), 2000);
  }
  async function loadManagement(ctx) {
    const version = ++managementGeneration;
    clearTimeout(managementTimer);
    try {
      const value = await ctx.request(managementRoute());
      if (version !== managementGeneration || !ctx.isCurrent()) return;
      management = value;
      if (value.update?.requestId === managementActionError?.requestId)
        managementActionError = null;
      managementError = managementActionError?.message || '';
    } catch (error) {
      if (version !== managementGeneration || !ctx.isCurrent()) return;
      if (['planning', 'running'].includes(management?.update?.state))
        managementError =
          'Waiting for the panel to reconnect. You may need to sign in again.';
      else {
        management = null;
        managementError = error.message;
      }
    }
    paint(ctx);
    pollManagement(ctx);
  }
  async function managementAction(ctx, action) {
    if (managementBusy) return;
    if (
      action !== 'plan' &&
      !(await ctx.confirm(
        action === 'apply'
          ? 'Install Lobby Goblin update?'
          : action === 'cancel'
            ? 'Cancel this review?'
            : action === 'reset'
              ? 'Reset this review?'
              : 'Recover this update?',
        action === 'apply'
          ? 'The panel will restart briefly. Game servers keep running and their worlds are preserved.'
          : action === 'cancel'
            ? 'Review the release again when you are ready to install.'
            : action === 'reset'
              ? 'Clear the failed review so you can try again.'
              : 'The panel may restart during recovery. Game servers and their worlds are preserved.',
        action === 'apply' ? 'Install update' : 'Confirm',
      ))
    )
      return;
    const requestId = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    const body =
      action === 'plan'
        ? {action, version: targetVersion(), requestId}
        : {action, id: management.update.id, confirm: true, requestId};
    managementBusy = true;
    managementError = '';
    managementActionError = null;
    management = {
      ...management,
      update: {
        ...(action === 'plan' ? {version: body.version} : management?.update),
        state: action === 'plan' ? 'planning' : 'running',
        message: 'Starting the update…',
      },
    };
    paint(ctx);
    try {
      management = await ctx.request(managementRoute(), {method: 'POST', body});
    } catch (error) {
      // A disconnected response may mean the fixed helper already started.
      // Read status; never automatically resubmit an install.
      managementActionError = {requestId, message: error.message};
      managementError = error.message + ' Checking retained update status…';
    } finally {
      managementBusy = false;
      await loadManagement(ctx);
    }
  }
  function applicationView(item, data) {
    if (!item) return '';
    if (!['factorio', 'rust'].includes(item.game))
      return '<p>This application has no published release catalogue.</p>';
    if (!data) return '';
    const status = model.snapshot.live.get(item.hostId + ':' + item.id);
    const current = status?.version || 'Not reported by the server';
    const controls = `<a class="button" href="${esc(item.manageUrl)}#settings/updates">Manage game updates</a>`;
    if (data.stale) return `<p role="status">${esc(data.error)}</p>${controls}`;
    const introduction = `<div class="updates-game-version"><p>Installed <strong>${esc(current)}</strong></p>${controls}</div>`;
    const metadata = disclosure(
      'application-details-' + item.hostId + ':' + item.id,
      'Version details',
      `<p class="hint">Container image: <code>${esc(item.image || status?.image || 'Unavailable')}</code></p><p class="hint">${esc(data.source)} · Checked ${esc(formatDate(data.checkedAt))}</p>`,
    );
    if (item.game === 'rust')
      return (
        introduction +
        disclosure(
          'application-releases',
          'Release news',
          `<p>Review and install server builds in the server’s update controls.</p>${data.news.map((news) => `<article><h3><a href="${esc(news.url)}" target="_blank" rel="noopener noreferrer">${esc(news.title)}</a></h3><p class="hint">${esc(formatDate(news.published))}</p><p>${esc(news.text)}</p></article>`).join('')}`,
        ) +
        metadata
      );
    const runtimeSoftware = data.software?.mode === 'runtime';
    const choices = data.choices
      .map(
        (choice) =>
          `<option value="${esc(runtimeSoftware ? choice.version : choice.image)}">${esc(choice.version)}${!runtimeSoftware && choice.imageRevision != null ? ' · image revision ' + esc(choice.imageRevision) : ''} · ${esc(choice.channel)}</option>`,
      )
      .join('');
    return (
      introduction +
      disclosure(
        'application-releases',
        'Browse releases',
        `<p>Latest stable: <strong>${esc(data.stable)}</strong>${data.experimental ? ' · Experimental: ' + esc(data.experimental) : ''}</p><label>${runtimeSoftware ? 'Available software version' : 'Published server version'}<select data-release-choice ${data.choices.length ? '' : 'disabled'}>${choices || '<option>No verified versions available</option>'}</select></label>${data.imageError ? `<p>${esc(data.imageError)}</p>` : ''}<a data-version-notes href="${esc(data.choices[0]?.notesUrl || data.notesUrl)}" target="_blank" rel="noopener noreferrer">Version changes</a><p class="hint">${runtimeSoftware ? 'Review and install a software version in the server’s update controls.' : 'This catalogue is read-only. Only verified compatible server images are listed.'}</p>`,
      ) +
      metadata
    );
  }
  async function loadApplication(ctx) {
    const item = server(),
      version = ++generation;
    catalogue = null;
    loading = !!item;
    paint(ctx);
    if (!item || !['factorio', 'rust'].includes(item.game)) {
      loading = false;
      paint(ctx);
      return;
    }
    try {
      const value = await ctx.request(
        model.route(
          item.hostId,
          '/application-releases?serverId=' + encodeURIComponent(item.id),
        ),
      );
      if (version === generation && ctx.isCurrent()) catalogue = value;
    } catch (error) {
      if (ctx.isCurrent()) problem = error.message;
    } finally {
      if (version === generation) {
        loading = false;
        paint(ctx);
      }
    }
  }
  async function check(ctx, force = false) {
    if (checking) return;
    checking = true;
    problem = '';
    paint(ctx);
    try {
      [release, host, settings] = await Promise.all([
        ctx.request(
          force ? '/updates/check' : '/updates',
          force ? {method: 'POST', body: {}} : {},
        ),
        ctx.request('/status'),
        ctx.request('/updates/settings'),
      ]);
      if (force && ctx.isCurrent()) notice('Update check complete.');
    } catch (error) {
      if (ctx.isCurrent()) problem = error.message;
    } finally {
      checking = false;
      paint(ctx);
    }
  }
  return {
    async mount(ctx) {
      await model.refresh();
      await check(ctx);
      await loadManagement(ctx);
    },
    async refresh(ctx, options) {
      if (options.reason === 'model') return;
      if (options.reason === 'reload') {
        await check(ctx);
        await loadManagement(ctx);
      }
    },
    dispose() {
      generation++;
      managementGeneration++;
      clearTimeout(managementTimer);
    },
  };
}
