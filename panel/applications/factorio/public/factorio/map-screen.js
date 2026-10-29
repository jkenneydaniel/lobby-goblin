import {createMapViews} from './map-views.js';
import {mountMap} from '../map.js';
import {pollEvery} from '../client.js';

export function createMapScreen({getState, ui, startJob, bindCommon, notify}) {
  const {mapPage, mapRefreshLabel} = createMapViews(getState, ui);
  let context = null,
    renderedContext = null,
    cleanMap = () => {},
    created = null,
    scope = null,
    positions = null,
    polling = false,
    cached = null,
    checkedAt = 0,
    liveAt = 0,
    cooldownUntil = 0,
    playersKey = null,
    manualPending = false,
    loading = null;
  const $ = (selector) => context?.root.querySelector(selector);
  function applyPlayers(value) {
    if (!context?.isCurrent() || !scope) return;
    cleanMap.updatePlayers?.(value);
    const label = $('#live-player-state'),
      list = $('#live-player-list'),
      button = $('#toggle-live-players');
    if (!label || !list) return;
    const matches = value.world === scope.world && value.seed === scope.seed;
    const messages = {
      disabled:
        'Showing saved positions. Live tracking is off; enabling it disables achievements for this world.',
      offline: 'Factorio is stopped or restarting. Live markers are hidden.',
      unavailable:
        'Live positions are temporarily unavailable. Markers are hidden until the next update.',
      'different-world':
        'Live tracking was approved for another world. Enable it separately for the current world.',
    };
    label.textContent =
      value.state === 'live'
        ? matches
          ? `${value.players.length} online · updates every 5 seconds · checked ${new Date(value.updatedAt).toLocaleTimeString()}`
          : 'The live server is running a different world from this map. Refresh the map to show its players.'
        : messages[value.state] || 'Checking live positions…';
    const key = JSON.stringify([value.state, matches, value.players]);
    if (key !== playersKey) {
      playersKey = key;
      list.replaceChildren();
      if (value.state === 'live' && matches) {
        if (!value.players.length) list.append(ui.template('live-empty'));
        for (const player of value.players) {
          const row = ui.template('live-player'),
            button = row.querySelector('button');
          row.querySelector('span').textContent =
            `${player.name} · X ${player.x.toFixed(1)} · Y ${player.y.toFixed(1)} · ${player.surface}`;
          if (player.surface === scope.surface) {
            button.textContent = 'Center on ' + player.name;
            button.dataset.centerPlayer = player.name;
          } else button.remove();
          list.append(row);
        }
      }
    }
    if (button) {
      button.disabled = !!getState().busyJob;
      button.textContent = value.enabled
        ? 'Turn off live tracking'
        : 'Enable live tracking';
    }
  }
  async function live(ctx, force = false) {
    if (
      !ctx.isCurrent() ||
      document.hidden ||
      polling ||
      !scope ||
      (!force &&
        Date.now() - liveAt < (positions?.enabled === false ? 60000 : 5000))
    )
      return;
    polling = true;
    liveAt = Date.now();
    try {
      positions = await ctx.request('/live-players');
      applyPlayers(positions);
    } catch {
      if (ctx.isCurrent()) {
        positions = {enabled: true, state: 'unavailable', players: []};
        applyPlayers(positions);
      }
    } finally {
      polling = false;
    }
  }
  function updateCooldown(value) {
    if (value)
      cooldownUntil =
        performance.now() + Math.max(0, value.availableAt - value.serverNow);
    const button = $('[data-map-refresh]'),
      label = $('#map-manual-state');
    if (!button) return;
    const seconds = Math.max(
        0,
        Math.ceil((cooldownUntil - performance.now()) / 1000),
      ),
      state = getState();
    button.disabled = !!(
      seconds ||
      manualPending ||
      state.busyJob ||
      state.recoveryRequired ||
      state.status?.imageMigration ||
      !state.canAction('refresh-map')
    );
    const text = button.querySelector('[data-part=label]');
    const buttonLabel = seconds
      ? `Refresh map in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : state.busyJob?.action === 'refresh-map'
        ? 'Refreshing map…'
        : 'Refresh map';
    if (text && text.textContent !== buttonLabel)
      text.textContent = buttonLabel;
    const explanation = seconds
      ? 'A recent map refresh is cooling down. This limit is shared by everyone viewing this server.'
      : 'Refresh map saves current progress and rebuilds the snapshot. Automatic refresh uses completed saves without requesting an extra save.';
    if (label && label.textContent !== explanation)
      label.textContent = explanation;
  }
  function paintPins(ctx, data) {
    const list = $('[data-part=pins]');
    if (!list) return;
    list.replaceChildren();
    for (const pin of data.pins) {
      const row = ui.template('pin'),
        button = row.querySelector('[data-map-pin]');
      button.dataset.mapPin = pin.id;
      button.textContent = pin.label + ' · ' + pin.x + ', ' + pin.y;
      const remove = row.querySelector('[data-remove-pin]');
      if (getState().can('application.factorio.map.pins'))
        remove.dataset.removePin = pin.id;
      else remove.remove();
      list.append(row);
    }
    if (!data.pins.length) list.append(ui.template('pins-empty'));
    cleanMap.updatePins?.(data.pins);
  }
  function bind(ctx) {
    ctx.on(ctx.root, 'click', async (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-map-refresh')) {
        manualPending = true;
        button.disabled = true;
        try {
          await startJob('refresh-map', {});
        } finally {
          manualPending = false;
          if (ctx.isCurrent()) await load(ctx, true);
        }
      } else if (button.dataset.centerPlayer) {
        cleanMap.centerPlayer?.(button.dataset.centerPlayer);
        $('#world-map')?.scrollIntoView({behavior: 'smooth', block: 'center'});
      } else if (button.dataset.mapPin)
        cleanMap.centerPin?.(button.dataset.mapPin);
      else if (button.dataset.removePin) {
        await ctx.request('/pins', {
          method: 'POST',
          body: {remove: button.dataset.removePin},
        });
        await load(ctx, true);
        notify('Pin removed.');
      }
    });
    const settings = $('#map-refresh-form');
    if (settings)
      ctx.on(settings, 'submit', async (event) => {
        event.preventDefault();
        const button = settings.querySelector('button');
        button.disabled = true;
        try {
          const automatic = await ctx.request('/map-settings', {
            method: 'POST',
            body: {
              enabled: settings.elements.enabled.checked,
              intervalMinutes: Number(settings.elements.intervalMinutes.value),
            },
          });
          $('#map-refresh-state').textContent = mapRefreshLabel(automatic);
          $('#map-settings-result').textContent = 'Map refresh settings saved.';
        } finally {
          button.disabled = false;
        }
      });
    const toggle = $('#toggle-live-players');
    if (toggle)
      ctx.on(toggle, 'click', async () => {
        const enabled = !positions?.enabled;
        if (
          enabled &&
          !(await ctx.confirm(
            'Enable live positions and disable achievements?',
            'Factorio treats the read-only coordinate query as a Lua console command, which permanently disables achievements for this world. A backup will be created first. Turning tracking off later will not restore achievements. PC and Switch play remain compatible.',
          ))
        )
          return;
        if (!ctx.isCurrent()) return;
        await startJob('live-tracking', {
          enabled,
          ...(enabled
            ? {confirm: true, world: scope.world, seed: scope.seed}
            : {}),
        });
        await live(ctx, true);
      });
    const form = $('#pin-form');
    if (form)
      ctx.on(form, 'submit', async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.target));
        body.x = Number(body.x);
        body.y = Number(body.y);
        await ctx.request('/pins', {method: 'POST', body});
        await load(ctx, true);
        notify('Shared pin added.');
      });
  }
  async function read(ctx, preserve) {
    const query = cached?.revision
      ? '?revision=' + encodeURIComponent(cached.revision)
      : '';
    let data = await ctx.request('/map' + query);
    if (data.unchanged) {
      if (!cached?.snapshot) data = await ctx.request('/map');
      else data = {...cached, ...data, snapshot: cached.snapshot};
    }
    const same =
      cached?.snapshot &&
      data.snapshot &&
      cached.staleWorld === data.staleWorld &&
      (data.revision
        ? data.revision === cached.revision
        : data.snapshot.created === cached.snapshot.created);
    cached = data;
    checkedAt = Date.now();
    updateCooldown(data.manual);
    if (same && renderedContext === ctx && $('#world-map')) {
      const label = $('#map-refresh-state');
      if (label) label.textContent = mapRefreshLabel(data.automatic);
      paintPins(ctx, data);
      return;
    }
    const view = preserve ? cleanMap.getView?.() : null;
    cleanMap();
    ctx.render(mapPage(data));
    ctx.root.className = '';
    playersKey = null;
    created = data.snapshot?.created || null;
    scope = data.snapshot
      ? {
          world: data.snapshot.world,
          seed: data.snapshot.seed,
          surface: data.snapshot.surface,
        }
      : null;
    if (data.snapshot) {
      cleanMap = mountMap(data, view);
      if (positions) applyPlayers(positions);
      void live(ctx);
    } else cleanMap = () => {};
    updateCooldown(data.manual);
    bindCommon(ctx);
    bind(ctx);
    renderedContext = ctx;
  }
  async function load(ctx, preserve = false) {
    if (loading?.ctx === ctx) return loading.promise;
    const current = {ctx};
    current.promise = read(ctx, preserve).finally(() => {
      if (loading === current) loading = null;
    });
    loading = current;
    return current.promise;
  }
  return {
    async mount(ctx, options) {
      context = ctx;
      await load(ctx, options.preserveMap === true);
      const timer = pollEvery(() => live(ctx), 5000),
        cooldown = setInterval(() => updateCooldown(), 1000);
      ctx.onDispose(() => {
        clearInterval(timer);
        clearInterval(cooldown);
      });
    },
    async refresh(ctx, options) {
      if (options.reason !== 'status')
        return load(ctx, options.preserveMap === true);
      updateCooldown();
      if (
        document.hidden ||
        Date.now() - checkedAt <
          (getState().busyJob?.action === 'refresh-map' ? 5000 : 30000)
      )
        return;
      checkedAt = Date.now();
      const latest = await ctx.request('/map-status'),
        label = $('#map-refresh-state'),
        banner = $('.job-banner');
      updateCooldown(latest.manual);
      if (label)
        label.textContent = mapRefreshLabel(latest.automatic, latest.active);
      if (banner && !getState().busyJob) {
        if (latest.active)
          banner.querySelector('span:last-child').textContent =
            latest.active.message;
        else banner.remove();
      }
      if (
        (latest.revision
          ? latest.revision !== cached?.revision
          : latest.created !== created) &&
        !getState().busyJob &&
        !cleanMap.isInteracting?.() &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName,
        ) &&
        !document.querySelector('dialog[open]')
      )
        await load(ctx, true);
    },
    dispose() {
      cleanMap();
      cleanMap = () => {};
      context = null;
      renderedContext = null;
    },
  };
}
