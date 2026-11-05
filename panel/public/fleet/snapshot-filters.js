import {escapeHTML as esc} from '../shared/view.js';
import {snapshotCards} from './cards.js';
import {serverKey} from './host-paths.js';

const applicationName = (snapshot, item) =>
  item.applicationName ||
  snapshot.games.find((game) => game.id === item.game)?.name ||
  item.game.replaceAll('-', ' ');

// Presentation only: order a copy of the session-scoped, already loaded records.
export function selectSnapshots(snapshot, filters) {
  const query = filters.search.trim().toLocaleLowerCase();
  return snapshot.snapshots
    .filter(
      (item) =>
        (!filters.application || item.game === filters.application) &&
        (!filters.host || item.hostId === filters.host) &&
        (!query ||
          [
            item.title,
            item.sourceName,
            item.game,
            applicationName(snapshot, item),
            item.hostName,
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort((a, b) => {
      let order = 0;
      if (filters.sort === 'title') {
        order = a.title
          .toLocaleLowerCase()
          .localeCompare(b.title.toLocaleLowerCase());
      } else {
        const left = Date.parse(a.created),
          right = Date.parse(b.created);
        if (Number.isFinite(left) !== Number.isFinite(right))
          return Number.isFinite(left) ? -1 : 1;
        if (Number.isFinite(left))
          order = filters.sort === 'oldest' ? left - right : right - left;
      }
      return order || serverKey(a).localeCompare(serverKey(b));
    });
}

export function snapshotCollection(snapshot, admin, filters) {
  const snapshots = selectSnapshots(snapshot, filters),
    applications = new Map(
      snapshot.snapshots.map((item) => [
        item.game,
        applicationName(snapshot, item),
      ]),
    ),
    hosts = new Map(
      snapshot.snapshots.map((item) => [item.hostId, item.hostName]),
    ),
    active = !!(filters.search || filters.application || filters.host);
  const options = (items, selected, missing) => {
    const values = [...items].sort((a, b) =>
      String(a[1]).localeCompare(String(b[1])),
    );
    if (selected && !items.has(selected)) values.push([selected, missing]);
    return values
      .map(
        ([value, label]) =>
          `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`,
      )
      .join('');
  };
  return `<div class="snapshot-filters" role="search" aria-label="Find snapshots"><label>Find snapshots<input type="search" data-snapshot-filter="search" maxlength="200" value="${esc(filters.search)}" placeholder="Title, source, application or host"></label><label>Filter snapshots by application<select data-snapshot-filter="application"><option value="">All applications</option>${options(applications, filters.application, 'Selected application (not in current list)')}</select></label><label>Filter snapshots by host<select data-snapshot-filter="host"><option value="">All hosts</option>${options(hosts, filters.host, 'Selected host (not in current list)')}</select></label><label>Sort snapshots<select data-snapshot-filter="sort">${options(
    new Map([
      ['newest', 'Newest first'],
      ['oldest', 'Oldest first'],
      ['title', 'Title'],
    ]),
    filters.sort,
    filters.sort,
  )}</select></label><button type="button" data-clear-snapshot-filters ${active ? '' : 'disabled'}>Clear filters</button></div>
    <p class="snapshot-count" role="status" aria-live="polite" aria-atomic="true">Showing ${snapshots.length} of ${snapshot.snapshots.length} ${snapshot.snapshots.length === 1 ? 'snapshot' : 'snapshots'}</p>
    ${!snapshots.length && snapshot.snapshots.length ? '<div class="empty snapshot-no-matches"><h2>No matching snapshots</h2><p>Try another search or clear the filters to see all your snapshots.</p></div>' : snapshotCards({...snapshot, snapshots}, admin)}`;
}
