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
    generation = 0;
  const server = () =>
    model.snapshot.servers.find(
      (item) => item.hostId + ':' + item.id === selected,
    );
  function paint(ctx) {
    if (!ctx.isCurrent()) return;
    const item = server(),
      latest = release?.latest;
    ctx.render(
      `<div class="heading"><div><h1>Updates</h1><p>Review management releases and application versions before making a change.</p></div><button data-check-updates ${checking || !settings?.enabled ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check for updates'}</button></div>${problem ? `<p class="error" role="alert">${esc(problem)}</p>` : ''}<section class="card"><h2>Panel and controllers</h2><p class="version-path">Installed <strong>${esc(release?.current || host?.version || 'Checking…')}</strong>${latest ? ` → <strong>${esc(latest.tag)}</strong>` : ''}</p><p role="status">${esc(release?.error || (!release ? 'Checking releases…' : release.available ? 'A newer management release is available.' : release.state === 'disabled' ? 'Release checks are off. Enable them below to check GitHub for management releases.' : release.state === 'current' ? 'You have the newest release in this channel.' : 'No eligible release is available.'))}</p>${settings?.editable ? `<form data-release-settings><h3>Release checks</h3><label class="check"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}> Check GitHub for management releases</label><label>Release channel<select name="channel" ${saving ? 'disabled' : ''}><option value="stable" ${settings.channel === 'stable' ? 'selected' : ''}>Stable releases</option><option value="preview" ${settings.channel === 'preview' ? 'selected' : ''}>Preview and stable releases</option></select></label><p class="hint">Checks run every six hours while enabled. Saving these settings does not install an update or restart servers.</p><button type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save release settings'}</button></form>` : ''}<p class="hint">Channel: ${esc(release?.channel || '—')} · Last checked: ${esc(formatDate(release?.checkedAt))}</p>${latest ? `<a class="button primary" href="${esc(latest.url)}" target="_blank" rel="noopener noreferrer">Release notes and download</a><details><summary>What changed</summary><pre class="release-notes">${esc(latest.notes || 'Open the release notes for details.')}</pre></details>` : ''}<details><summary>Update this host’s management services</summary><p>The host update workflow replaces the panel, broker and all registered controllers together, with recovery copies. Application containers keep running.</p><p>Run the reviewed update from this installation’s host. This panel does not have access to the private operator records required to update itself.</p><ol><li>Download the selected source release and its matching runtime image.</li><li>Follow the host update guide to review the installation, Docker identity and immutable image.</li><li>Apply the reviewed plan on the host. Return here when the panel reconnects.</li></ol><a class="button" href="https://github.com/jkenneydaniel/lobby-goblin/blob/main/docs/MANAGEMENT_UPDATES.md" target="_blank" rel="noopener noreferrer">Open host update guide</a><p class="hint">This workflow supports broker-enabled installations using a local Unix Docker socket. Legacy/custom installations and Windows named-pipe transport require a separate upgrade path.</p></details><p><a href="/#hosts">Review connected host agents</a> · Agent alignment controls are available under Hosts.</p></section><section class="card"><h2>Application versions</h2><label>Server<select data-update-server><option value="">Choose a server</option>${model.snapshot.servers.map((value) => `<option value="${esc(value.hostId + ':' + value.id)}" ${selected === value.hostId + ':' + value.id ? 'selected' : ''}>${esc(value.name)} · ${esc(value.hostName)}</option>`).join('')}</select></label>${loading ? '<p role="status">Checking published releases…</p>' : ''}<div data-application-releases>${applicationView(item, catalogue)}</div></section>`,
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
    },
    async refresh(ctx, options) {
      if (options.reason === 'model') return;
      if (options.reason === 'reload') await check(ctx);
    },
    dispose() {
      generation++;
    },
  };
}
