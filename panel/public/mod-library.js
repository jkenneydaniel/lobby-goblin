import {downloadJSON} from './diagnostics.js';

export function installedInventoryReport(value) {
  const text = (input) => (typeof input === 'string' ? input : null);
  return {
    game: text(value.game),
    scope: text(value.scope),
    reportedScopeVersion: text(value.version),
    items: value.items.map((item) => ({
      id: text(item.id),
      title: text(item.title),
      version: text(item.version),
      enabled: item.enabled === true,
      managed: item.managed === true,
      modified: item.modified === true,
      sha256:
        typeof item.sha256 === 'string' && /^[a-f\d]{64}$/i.test(item.sha256)
          ? item.sha256
          : null,
    })),
  };
}

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        char
      ],
  );
const saved = new Map(),
  mounts = new WeakMap();
export function mountModLibrary(
  root,
  {api, job, busy = () => false, manageAccount = true} = {},
) {
  const key = location.pathname,
    state = saved.get(key) || {
      tab: 'browse',
      query: '',
      page: 1,
      mode: 'stopped',
    };
  saved.set(key, state);
  mounts.get(root)?.();
  const events = new AbortController();
  let disposed = false;
  let value = null,
    inventory = null,
    loading = false,
    request = 0,
    review = null;
  const dispose = () => {
    disposed = true;
    inventory = null;
    inventoryButton.disabled = true;
    request++;
    events.abort();
    if (mounts.get(root) === dispose) mounts.delete(root);
  };
  mounts.set(root, dispose);
  root.classList.add('mod-library');
  root.innerHTML = `<div class="ml-heading"><div><h2>Mod library</h2><p>Find something new. Keep your favourites up to date.</p></div><button type="button" data-refresh>Refresh catalogue</button></div>
    <div class="ml-tabs" role="tablist" aria-label="Mod library"><button role="tab" data-tab="browse">Browse</button><button role="tab" data-tab="installed">Installed</button><button role="tab" data-tab="updates">Updates</button></div>
    <p class="ml-error" role="alert" hidden></p><p class="ml-status" role="status" aria-live="polite"></p>
    <div class="ml-controls"><form data-search><label>Find a mod<input name="query" type="search" maxlength="100" placeholder="Search names and descriptions"></label><button type="submit">Search</button></form><label>When applying changes<select data-mode><option value="stopped">Keep server stopped · start it myself</option><option value="restart">Save, stop, apply, and start automatically</option></select></label></div>
    <div data-inventory hidden><button type="button" data-download-inventory disabled>Download installed inventory</button><p>Loaded file observations only. Factorio built-ins are excluded; Rust scope version is not its Steam build. Enabled files do not prove runtime loading. This is not an importable modpack or backup.</p></div>
    <p class="ml-impact"></p><button data-recover type="button" hidden>Recover mod change</button>
    <div class="ml-results" role="tabpanel" aria-label="Mods" aria-busy="true"></div><div class="ml-pagination"></div>
    <details class="ml-account" hidden><summary>Factorio download account</summary><p>Use your Factorio username and service token. The token stays on this controller and is never sent back to your browser.</p><form data-account><label>Factorio username<input name="username" autocomplete="username" maxlength="100" required></label><label>Service token<input name="token" type="password" autocomplete="off" maxlength="256" required></label><button type="submit">Connect account</button><button type="button" data-disconnect hidden>Disconnect</button></form><p data-account-state></p></details>
    <dialog class="ml-review" aria-labelledby="ml-review-title"><h2 id="ml-review-title">Review mod change</h2><p data-review-error class="ml-error" role="alert" hidden></p><div data-review-content></div><div class="ml-review-actions"><button type="button" data-cancel>Cancel</button><button type="button" data-apply>Apply reviewed change</button></div></dialog>`;
  const inventoryContainer = root.querySelector('[data-inventory]'),
    inventoryButton = root.querySelector('[data-download-inventory]');
  const $ = (selector) => root.querySelector(selector),
    all = (selector) => [...root.querySelectorAll(selector)],
    error = (text) => {
      if (disposed) return;
      for (const element of all('.ml-error')) {
        element.textContent = text;
        element.hidden = !text;
      }
    };
  function inventoryControl() {
    inventoryContainer.hidden = state.tab !== 'installed';
    inventoryButton.disabled =
      disposed || loading || !inventory || state.tab !== 'installed';
  }
  function impact() {
    const mode = $('[data-mode]').value;
    $('.ml-impact').textContent =
      mode === 'hot'
        ? 'Rust stays online. Plugin code will load or reload immediately; check compilation in Logs.'
        : mode === 'restart'
          ? 'Connected players will be disconnected. The server saves, stops, applies the reviewed changes, and starts again.'
          : 'Stop the server yourself before applying changes. It will stay stopped afterward.';
  }
  function row(item) {
    const installed = state.tab === 'installed',
      installedVersion = installed ? item.version : item.installedVersion;
    const primary = installed
      ? `<button data-mod="${esc(item.id)}" data-operation="${item.enabled ? 'disable' : 'enable'}">${item.enabled ? 'Disable' : 'Enable'}</button><button data-mod="${esc(item.id)}" data-operation="remove">Remove</button>`
      : `<button data-mod="${esc(item.id)}" data-operation="install" ${item.available === false || installedVersion === item.version ? 'disabled' : ''}>${installedVersion === item.version ? 'Installed' : installedVersion ? 'Review update' : 'Review install'}</button>`;
    return `<article class="ml-item"><div class="ml-item-main"><h3>${esc(item.title || item.name || item.id)}</h3><p>${esc(item.summary || '')}</p><div class="ml-meta">${item.author ? `<span>By ${esc(item.author)}</span>` : ''}<span>${installedVersion ? 'Installed ' + esc(installedVersion) : 'Version ' + esc(item.version || 'unknown')}${!installed && installedVersion ? ' → ' + esc(item.version) : ''}</span>${installed ? `<span>${item.enabled ? 'Enabled' : 'Disabled'}</span>${item.modified ? '<span>Modified locally · automatic matching paused</span>' : !item.source ? '<span>Added manually</span>' : ''}` : ''}</div>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">View on ${esc(value.source)}</a>` : ''}</div><div class="ml-item-actions">${primary}</div></article>`;
  }
  function render() {
    if (disposed || !root.isConnected) return;
    all('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === state.tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    $('[data-search]').hidden = state.tab !== 'browse';
    $('[data-search] input').value = state.query;
    if (value.hotAvailable && !$('[value="hot"]'))
      $('[data-mode]').insertAdjacentHTML(
        'beforeend',
        '<option value="hot">Apply while running · Rust plugins</option>',
      );
    if (!value.hotAvailable && state.mode === 'hot') state.mode = 'stopped';
    $('[data-mode]').value = state.mode;
    impact();
    $('.ml-status').textContent =
      value.source +
      ' · ' +
      (value.scope === 'none'
        ? 'Choose a framework in the tools below.'
        : value.version
          ? value.game === 'factorio'
            ? 'Factorio ' + value.version
            : value.scope + ' ' + value.version
          : value.scope) +
      (value.stale
        ? ' · Showing a cached catalogue; upstream is unavailable.'
        : '') +
      (value.checkedAt
        ? ' · Checked ' + new Date(value.checkedAt).toLocaleTimeString()
        : '');
    if (value.errors?.length)
      error(
        'Some update checks failed: ' +
          value.errors.join(', ') +
          '. Refresh to try again.',
      );
    $('.ml-results').innerHTML = value.items.length
      ? value.items.map(row).join('')
      : `<div class="ml-empty"><h3>${state.tab === 'updates' ? 'No updates found' : state.tab === 'installed' ? 'No mods installed yet' : 'No matching mods'}</h3><p>${state.tab === 'updates' ? 'Installed versions stay unchanged until you approve an update. Locally modified or unmatched plugins are skipped.' : state.tab === 'installed' ? 'Open Browse to find a mod for this server.' : 'Try a different search.'}</p></div>`;
    $('.ml-results').setAttribute('aria-busy', 'false');
    $('.ml-pagination').innerHTML =
      value.pages > 1
        ? `<button data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${state.page} of ${value.pages}</span><button data-page="${state.page + 1}" ${state.page >= value.pages ? 'disabled' : ''}>Next</button>`
        : '';
    $('[data-recover]').hidden = !value.recoveryRequired;
    $('.ml-account').hidden = value.game !== 'factorio' || !manageAccount;
    $('[data-account-state]').textContent = value.account?.connected
      ? 'Account connected.'
      : 'Connect an account to download mods. Browsing does not require an account.';
    $('[data-disconnect]').hidden = !value.account?.connected;
    all('[data-mod]').forEach(
      (button) =>
        (button.disabled ||=
          busy() ||
          value.recoveryRequired ||
          (state.mode === 'stopped' && value.running) ||
          (state.mode === 'hot' && !value.running) ||
          value.scope === 'none'),
    );
  }
  async function load(refresh = false) {
    const current = ++request;
    const tab = state.tab;
    inventory = null;
    loading = true;
    inventoryControl();
    error('');
    $('.ml-results').setAttribute('aria-busy', 'true');
    $('.ml-status').textContent = 'Checking the mod library…';
    try {
      const result = await api(
        '/mod-library?' +
          new URLSearchParams({
            tab: state.tab,
            query: state.query,
            page: String(state.page),
            refresh: String(refresh),
          }),
      );
      if (disposed || current !== request || !root.isConnected) return;
      value = result;
      if (tab === 'installed' && result.tab === 'installed')
        inventory = installedInventoryReport(result);
      render();
    } catch (problem) {
      if (current === request) {
        error(problem.message);
        $('.ml-status').textContent = 'Your installed mods have not changed.';
        $('.ml-results').setAttribute('aria-busy', 'false');
      }
    } finally {
      if (current === request) {
        loading = false;
        inventoryControl();
      }
    }
  }
  async function guarded(work) {
    try {
      error('');
      await work();
    } catch (problem) {
      error(problem.message);
    }
  }
  root.addEventListener(
    'click',
    (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-download-inventory')) {
        if (
          !disposed &&
          root.isConnected &&
          !loading &&
          inventory &&
          state.tab === 'installed'
        )
          downloadJSON(inventory, 'lobby-goblin-installed-mod-inventory.json');
      }
      if (button.dataset.tab) {
        state.tab = button.dataset.tab;
        state.page = 1;
        void load();
      }
      if (button.hasAttribute('data-refresh')) void load(true);
      if (button.dataset.page) {
        state.page = Number(button.dataset.page);
        void load();
      }
      if (button.dataset.mod)
        void guarded(async () => {
          if (loading || busy()) return;
          button.disabled = true;
          try {
            review = await api('/mod-library-plan', {
              id: button.dataset.mod,
              operation: button.dataset.operation,
              mode: state.mode,
            });
            if (disposed) return;
            $('[data-review-content]').innerHTML =
              `<p class="ml-review-impact">${esc(review.message)}</p>${review.releases.map((item) => `<div class="ml-review-release"><strong>${esc(item.title)} · ${esc(item.version)}</strong>${item.dependencies.length ? `<p>Dependencies: ${esc(item.dependencies.join(', '))}</p>` : ''}${item.note ? `<p>${esc(item.note)}</p>` : ''}<details><summary>Download verification</summary><code>SHA-256 ${esc(item.sha256)}</code></details></div>`).join('')}<details><summary>${review.files.length} reviewed file changes</summary><ul>${review.files.map((file) => `<li>${file.remove ? 'Remove' : 'Write'} ${esc(file.name)}</li>`).join('')}</ul></details><p>This review expires in 15 minutes. Changes to installed files require a new review.</p>`;
            $('[data-apply]').textContent =
              review.mode === 'hot'
                ? 'Apply while Rust stays online'
                : review.mode === 'restart'
                  ? 'Apply and start server'
                  : 'Apply and leave stopped';
            $('.ml-review').showModal();
          } finally {
            button.disabled = false;
          }
        });
      if (button.hasAttribute('data-cancel')) $('.ml-review').close();
      if (button.hasAttribute('data-apply'))
        void guarded(async () => {
          if (!review || busy()) return;
          button.disabled = true;
          try {
            await job('mod-library-install', {
              planId: review.id,
              confirm: true,
            });
            if (disposed) return;
            $('.ml-review').close();
            review = null;
            await load();
          } finally {
            button.disabled = false;
          }
        });
      if (button.hasAttribute('data-recover'))
        void guarded(async () => {
          if (
            !window.confirm(
              'Restore previous mod files? Stop the server first. It will remain stopped.',
            )
          )
            return;
          await job('mod-library-recover', {confirm: true});
          await load();
        });
      if (button.hasAttribute('data-disconnect'))
        void guarded(async () => {
          await api('/mod-library-account', {disconnect: true});
          await load();
        });
    },
    {signal: events.signal},
  );
  $('.ml-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = all('[data-tab]'),
      index = tabs.indexOf(document.activeElement),
      next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 2
            : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    tabs[next].click();
    tabs[next].focus();
  });
  $('[data-search]').addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = event.target.elements.query.value.trim();
    state.page = 1;
    void load();
  });
  $('[data-mode]').addEventListener('change', (event) => {
    state.mode = event.target.value;
    if (value) render();
  });
  $('[data-account]').addEventListener('submit', (event) => {
    event.preventDefault();
    void guarded(async () => {
      await api(
        '/mod-library-account',
        Object.fromEntries(new FormData(event.target)),
      );
      event.target.reset();
      await load();
    });
  });
  void load();
  return {refresh: load, dispose};
}
