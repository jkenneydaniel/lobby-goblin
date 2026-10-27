import {createMapViews} from './map-views.js';
import {mountMap} from '../map.js';
import {pollEvery} from '../client.js';

export function createMapScreen({getState, ui, startJob, bindCommon, notify}) {
  const {mapPage, mapRefreshLabel} = createMapViews(getState, ui);
  let context = null,
    cleanMap = () => {},
    created = null,
    scope = null,
    positions = null,
    polling = false;
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
          ? `${value.players.length} online · updates every 2 seconds · checked ${new Date(value.updatedAt).toLocaleTimeString()}`
          : 'The live server is running a different world from this map. Refresh the map to show its players.'
        : messages[value.state] || 'Checking live positions…';
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
          context.on(button, 'click', () => {
            cleanMap.centerPlayer?.(player.name);
            $('#world-map')?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          });
        } else button.remove();
        list.append(row);
      }
    }
    if (button) {
      button.disabled = !!getState().busyJob;
      button.textContent = value.enabled
        ? 'Turn off live tracking'
        : 'Enable live tracking';
    }
  }
  async function live(ctx) {
    if (!ctx.isCurrent() || document.hidden || polling || !scope) return;
    polling = true;
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
  function bind(ctx) {
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
        await live(ctx);
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
    for (const button of ctx.root.querySelectorAll('[data-remove-pin]'))
      ctx.on(button, 'click', async () => {
        await ctx.request('/pins', {
          method: 'POST',
          body: {remove: button.dataset.removePin},
        });
        await load(ctx, true);
        notify('Pin removed.');
      });
  }
  async function load(ctx, preserve = false) {
    const view = preserve ? cleanMap.getView?.() : null;
    const data = await ctx.request('/map');
    cleanMap();
    ctx.render(mapPage(data));
    ctx.root.className = '';
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
    }
    bindCommon(ctx);
    bind(ctx);
  }
  return {
    async mount(ctx, options) {
      context = ctx;
      await load(ctx, options.preserveMap === true);
      const timer = pollEvery(() => live(ctx), 2000);
      ctx.onDispose(() => clearInterval(timer));
    },
    async refresh(ctx, options) {
      if (options.reason !== 'status')
        return load(ctx, options.preserveMap === true);
      const latest = await ctx.request('/map-status'),
        label = $('#map-refresh-state'),
        banner = $('.job-banner');
      if (label)
        label.textContent = mapRefreshLabel(latest.automatic, latest.active);
      if (banner && !getState().busyJob) {
        if (latest.active)
          banner.querySelector('span:last-child').textContent =
            latest.active.message;
        else banner.remove();
      }
      if (
        latest.created !== created &&
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
    },
  };
}
