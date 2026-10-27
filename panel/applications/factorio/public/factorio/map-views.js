import {fragment, part, text} from '../shared/templates.js';

export function createMapViews(getState, ui) {
  const {
    template,
    date,
    heading,
    readonly,
    jobBanner,
    card,
    empty,
    actionButton,
  } = ui;
  function mapPage(payload) {
    const {can} = getState(),
      map = payload.snapshot;
    const view = template(map ? 'map' : 'map-empty');
    text(view, '#map-refresh-state', mapRefreshLabel(payload.automatic));
    if (getState().can('application.factorio.map.configure')) {
      const controls = template('map-refresh-settings');
      part(controls, '[name=enabled]').checked =
        payload.automatic?.enabled !== false;
      part(controls, '[name=intervalMinutes]').value = String(
        payload.automatic?.intervalMinutes || 0,
      );
      part(view, '[data-part=map-settings]').append(controls);
    }
    part(view, '[data-part=banners]').append(jobBanner());
    if (map) {
      if (!payload.staleWorld) part(view, '[data-part=stale]').remove();
      if (!map.limited && !map.entitiesLimited)
        part(view, '[data-part=limited]').remove();
      if (map.enemyUnits) part(view, '[data-part=older]').remove();
      text(view, '[data-part=world]', map.world.replace(/\.zip$/, ''));
      text(view, '[data-part=created]', 'Snapshot ' + date(map.created));
      text(
        view,
        '[data-part=counts]',
        map.chunks.length.toLocaleString() +
          ' explored chunks · ' +
          map.entities.length.toLocaleString() +
          ' objects',
      );
      text(view, '[data-part=seed]', 'Seed ' + map.seed);
      const pins = part(view, '[data-part=pins]');
      for (const pin of payload.pins) {
        const row = template('pin'),
          select = part(row, '[data-map-pin]');
        select.dataset.mapPin = pin.id;
        select.textContent = pin.label + ' · ' + pin.x + ', ' + pin.y;
        if (can('application.factorio.map.pins'))
          part(row, '[data-remove-pin]').dataset.removePin = pin.id;
        else part(row, '[data-remove-pin]').remove();
        pins.append(row);
      }
      if (!payload.pins.length) pins.append(template('pins-empty'));
      if (!can('application.factorio.map.pins'))
        part(view, '#pin-form').remove();
      if (!getState().canAction('live-tracking'))
        part(view, '#toggle-live-players').remove();
    } else
      part(view, '[data-part=empty]').append(
        card(
          'Your first map',
          empty(
            'Ready to explore?',
            'Refresh the map to draw the explored area from an isolated copy of your latest save.',
          ),
        ),
      );
    return fragment(
      heading(
        'YOUR SHARED WORLD',
        'A view of the factory.',
        'Explore your saved world without joining the game.',
        getState().canAction('refresh-map')
          ? actionButton('Refresh map', 'refresh-map', true)
          : null,
      ),
      readonly(),
      view,
    );
  }
  function mapRefreshLabel(automatic, active) {
    if (active) return 'Updating after a save · ' + active.message;
    if (automatic?.running)
      return 'Updating the map from the latest completed save…';
    if (automatic?.enabled === false)
      return 'Automatic refresh is off. Use Refresh map to update this snapshot.';
    if (automatic?.lastError)
      return 'Automatic refresh will retry: ' + automatic.lastError;
    if (automatic?.pending)
      return 'A save completed. Map refresh is queued for the next allowed refresh.';
    return automatic?.enabled
      ? automatic.intervalMinutes
        ? `Refreshes from completed saves, at most once every ${automatic.intervalMinutes} minutes.`
        : 'Refreshes automatically after completed saves.'
      : 'Use Refresh map to update this snapshot.';
  }
  return {mapPage, mapRefreshLabel};
}
