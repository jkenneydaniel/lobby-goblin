import {escapeHTML as esc, formatDate} from '../shared/view.js';

export function createUpdatesScreen({model, notice}) {
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
    const item = server(),
      latest = release?.latest;
    ctx.render(
      `<div class="heading"><div><h1>Updates</h1><p>Review management releases and application versions before making a change.</p></div><button data-check-updates ${checking || !settings?.enabled ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check for updates'}</button></div>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ''}<section class="card"><h2>Panel and controllers</h2><p class="version-path">Installed <strong>${esc(release?.current || host?.version || 'Checking…')}</strong>${latest ? ` → <strong>${esc(latest.tag)}</strong>` : ''}</p><p role="status">${esc(release?.error || (!release ? 'Checking releases…' : release.available ? 'A newer management release is available.' : release.state === 'disabled' ? 'Release checks are off. Enable them below to check GitHub for management releases.' : release.state === 'current' ? 'You have the newest release in this channel.' : 'No eligible release is available.'))}</p>${managementView()}${settings?.editable ? `<form data-release-settings><h3>Release checks</h3><label class="check"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}> Check GitHub for management releases</label><label>Release channel<select name="channel" ${saving ? 'disabled' : ''}><option value="stable" ${settings.channel === 'stable' ? 'selected' : ''}>Stable releases</option><option value="preview" ${settings.channel === 'preview' ? 'selected' : ''}>Preview and stable releases</option></select></label><p class="hint">Checks run every six hours while enabled. Saving these settings does not install an update or restart servers.</p><button type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save release settings'}</button></form>` : ''}<p class="hint">Channel: ${esc(release?.channel || '—')} · Last checked: ${esc(formatDate(release?.checkedAt))}</p>${latest ? `<a class="button" href="${esc(latest.url)}" target="_blank" rel="noopener noreferrer">Release notes and download</a><details><summary>What changed</summary><pre class="release-notes">${esc(latest.notes || 'Open the release notes for details.')}</pre></details>` : ''}<p><a href="/#hosts">Review connected host agents</a> · Agent alignment controls are available under Hosts.</p></section><section class="card"><h2>Application versions</h2><label>Server<select data-update-server><option value="">Choose a server</option>${model.snapshot.servers.map((value) => `<option value="${esc(value.hostId + ':' + value.id)}" ${selected === value.hostId + ':' + value.id ? 'selected' : ''}>${esc(value.name)} · ${esc(value.hostName)}</option>`).join('')}</select></label>${loading ? '<p role="status">Checking published releases…</p>' : ''}<div data-application-releases>${applicationView(item, catalogue)}</div></section>`,
    );
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
    ctx.on(
      ctx.root.querySelector('[data-management-host]'),
      'change',
      async (event) => {
        managementHost = event.target.value;
        management = null;
        managementError = '';
        managementActionError = null;
        await loadManagement(ctx);
      },
    );
    for (const button of ctx.root.querySelectorAll('[data-management-action]'))
      ctx.on(button, 'click', () =>
        managementAction(ctx, button.dataset.managementAction),
      );
    const form = ctx.root.querySelector('[data-release-settings]');
    if (form)
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
              revision: settings.revision,
            },
          });
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
  function managementView() {
    const update = management?.update;
    const busy =
      managementBusy || ['planning', 'running'].includes(update?.state);
    const label = {
      apply: 'Install management update',
      cancel: 'Cancel review',
      resume: 'Resume update',
      rollback: 'Restore previous management',
      reset: 'Reset failed review',
    };
    const canReview =
      management?.supported &&
      !busy &&
      (!update ||
        ['complete', 'rolled-back', 'failed'].includes(update.state)) &&
      targetVersion() &&
      targetVersion() !== management.currentVersion;
    return `<div class="management-update"><h3>Update management services</h3><label>Management host<select data-management-host ${managementBusy ? 'disabled' : ''}>${model.snapshot.hosts.map((value) => `<option value="${esc(value.id)}" ${selectedHost()?.id === value.id ? 'selected' : ''}>${esc(value.name)}</option>`).join('')}</select></label><p>Updates replace the panel, broker and registered controllers together, with recovery copies. Game containers keep running.</p>${managementError ? `<p class="error" role="alert">${esc(managementError)}</p>` : ''}${management?.currentVersion ? `<p>Host management version: <strong>${esc(management.currentVersion)}</strong></p>` : ''}${
      update
        ? `<p role="status">${esc(update.message)}</p><p>Release <strong>${esc(update.version)}</strong>${update.phase ? ` · ${esc(update.phase)}` : ''}</p>${update.services ? `<p>${update.services.management} management services · ${update.services.applications} application containers preserved</p>` : ''}<p class="hint">Update ID: <code>${esc(update.id)}</code></p>${update.image ? `<details><summary>Verified runtime image</summary><p class="wrap">${esc(update.image)}</p></details>` : ''}${update.state === 'reviewed' ? `<p>Review expires ${esc(formatDate(update.expires))}. Installation temporarily disconnects the panel; sign in again after it reconnects.</p>` : ''}<div class="actions">${(
            update.actions || []
          )
            .filter((action) => label[action])
            .map(
              (action) =>
                `<button class="${action === 'apply' ? 'primary' : ''}" data-management-action="${esc(action)}" ${busy || (action === 'apply' && update.expires <= Date.now()) ? 'disabled' : ''}>${label[action]}</button>`,
            )
            .join('')}</div>`
        : ''
    }${canReview ? `<button class="primary" data-management-action="plan" ${busy ? 'disabled' : ''}>Review management update to ${esc(targetVersion())}</button>` : ''}${!management ? '<p role="status">Checking panel update support…</p>' : !management.supported ? '<p>This host needs one host-side upgrade to enable coordinated panel updates. Follow the host update guide for this installation.</p>' : ''}<details><summary>Host recovery and older installations</summary><p>If the panel cannot reconnect, retain the update ID and use the coordinated updater on the host to inspect, resume or roll back. After activation is committed, recovery proceeds forward. Windows, macOS and Linux use the same coordinated updater with Docker running Linux containers. Older versions need one host-side upgrade to enable it; custom layouts require review.</p><a href="https://github.com/jkenneydaniel/lobby-goblin/blob/main/docs/MANAGEMENT_UPDATES.md" target="_blank" rel="noopener noreferrer">Open host update guide</a></details></div>`;
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
          'Waiting for management to reconnect. Keep this page open; you may need to sign in again. Use the host recovery guide if it stays unavailable.';
      else {
        management = {supported: false, update: null};
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
          ? 'Install management update?'
          : action === 'cancel'
            ? 'Cancel this review?'
            : 'Recover management update?',
        'The panel, broker and controllers are managed together. Game containers and worlds are preserved. Keep the update ID for host recovery if the panel cannot reconnect.',
        action === 'apply' ? 'Install management update' : 'Confirm',
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
        ...management?.update,
        state: action === 'plan' ? 'planning' : 'running',
        message: 'Starting the management coordinator…',
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
    if (!item)
      return '<p>Choose a server to compare its installed version with published releases.</p>';
    if (!['factorio', 'rust'].includes(item.game))
      return '<p>This application has no configured release provider.</p>';
    if (!data) return '';
    if (data.stale) return `<p role="status">${esc(data.error)}</p>`;
    const status = model.snapshot.live.get(item.hostId + ':' + item.id);
    const current = status?.version || 'Not reported by the server';
    const runtimeImage = item.image || status?.image || 'Unavailable';
    const runtimeSoftware = data.software?.mode === 'runtime';
    const introduction = `<p>Installed software: <strong>${esc(current)}</strong></p><p class="hint">Container image: <code>${esc(runtimeImage)}</code></p><p>${runtimeSoftware ? 'Software versions are managed independently of the container image.' : 'Software is bundled with the container image.'}</p><p class="hint">${esc(data.source)} · Checked ${esc(formatDate(data.checkedAt))}</p>`;
    if (item.game === 'rust')
      return (
        introduction +
        `<p>${esc(data.message)}</p><p class="hint">Latest announcements describe the game; they are not a list of selectable dedicated-server builds.</p>${data.news.map((news) => `<article><h3><a href="${esc(news.url)}" target="_blank" rel="noopener noreferrer">${esc(news.title)}</a></h3><p class="hint">${esc(formatDate(news.published))}</p><p>${esc(news.text)}</p></article>`).join('')}`
      );
    if (runtimeSoftware)
      return (
        introduction +
        `<p>Latest stable: <strong>${esc(data.stable)}</strong>${data.experimental ? ' · Experimental: ' + esc(data.experimental) : ''}</p><label>Available software version<select data-release-choice ${data.choices.length ? '' : 'disabled'}>${data.choices.map((choice) => `<option value="${esc(choice.version)}">${esc(choice.version)} · ${esc(choice.channel)}</option>`).join('')}</select></label><a class="button" data-version-notes href="${esc(data.choices[0]?.notesUrl || data.notesUrl)}" target="_blank" rel="noopener noreferrer">Version changes</a><p class="hint"><a class="button" href="${esc(item.manageUrl)}#settings/updates">Open software update controls</a> An independently installed version is stored in the application volume and preserved when the container is recreated. Open the server to review and install a software version, or recover a failed change.</p>`
      );
    return (
      introduction +
      `<p>Latest stable: <strong>${esc(data.stable)}</strong>${data.experimental ? ` · Experimental: ${esc(data.experimental)}` : ''}</p><label>Published server version<select data-release-choice ${data.choices.length ? '' : 'disabled'}>${data.choices.length ? data.choices.map((choice) => `<option value="${esc(choice.image)}">${esc(choice.version)} · image revision ${choice.imageRevision} · ${esc(choice.channel)}</option>`).join('') : '<option>No installable versions could be verified</option>'}</select></label><p>${esc(data.imageError || 'Only published Lobby Goblin 2.0.x images are listed. Newer upstream release lines require explicit compatibility support. Clients and mods must match the selected version.')}</p><div class="actions"><a class="button" data-version-notes href="${esc(data.choices[0]?.notesUrl || data.notesUrl)}" target="_blank" rel="noopener noreferrer">Version changes</a><a class="button" href="${esc(item.manageUrl)}#settings/updates">Open server update controls</a></div><p class="hint">Managed-server image installation is not supported by this release. The version catalogue is read-only; host management updates do not upgrade games.</p>`
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
      if (force && ctx.isCurrent())
        notice(
          'Release check complete. Checks within one minute reuse the latest result.',
        );
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
