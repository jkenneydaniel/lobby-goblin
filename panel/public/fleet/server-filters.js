import {escapeHTML as esc} from '../shared/view.js';
import {serverCards, serverStatus} from './cards.js';
import {serverKey} from './host-paths.js';

// Presentation only: use the session-scoped model, never fetch more resources.
export function selectServers(snapshot, filters) {
  const applicationName = (item) =>
      item.applicationName ||
      snapshot.games.find((game) => game.id === item.game)?.name ||
      item.game,
    query = filters.search.trim().toLocaleLowerCase(),
    servers = snapshot.servers.filter(
      (item) =>
        (!filters.application || item.game === filters.application) &&
        (!filters.host || item.hostId === filters.host) &&
        (snapshot.assigned ||
          !filters.status ||
          serverStatus(item, snapshot) === filters.status) &&
        (!query ||
          [
            item.name,
            item.game,
            applicationName(item),
            item.game.replaceAll('-', ' '),
            item.hostName,
            item.address,
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)),
    );
  if (filters.sort === 'name' || filters.sort === 'name-desc') {
    const direction = filters.sort === 'name-desc' ? -1 : 1;
    servers.sort(
      (a, b) =>
        direction *
          a.name
            .toLocaleLowerCase()
            .localeCompare(b.name.toLocaleLowerCase()) ||
        serverKey(a).localeCompare(serverKey(b)),
    );
  }
  return servers;
}

export function serverCollection(snapshot, admin, filters) {
  const applicationName = (item) =>
      item.applicationName ||
      snapshot.games.find((game) => game.id === item.game)?.name ||
      item.game,
    servers = selectServers(snapshot, filters),
    applications = new Map(
      snapshot.servers.map((item) => [item.game, applicationName(item)]),
    ),
    hosts = new Map(
      snapshot.servers
        .filter((item) => item.hostId)
        .map((item) => [item.hostId, item.hostName]),
    ),
    statuses = new Map(
      snapshot.assigned
        ? []
        : snapshot.servers.map((item) => {
            const state = serverStatus(item, snapshot);
            return [state, state];
          }),
    ),
    active = !!(
      filters.search ||
      filters.application ||
      filters.host ||
      filters.status
    );
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
  return `<div class="server-filters" role="search" aria-label="Find servers"><label>Find servers<input type="search" data-server-filter="search" maxlength="200" value="${esc(filters.search)}" placeholder="Name, application, host or address"></label><label>Filter by application<select data-server-filter="application"><option value="">All applications</option>${options(applications, filters.application, 'Selected application (not in current list)')}</select></label>${snapshot.assigned ? '' : `<label>Filter by host<select data-server-filter="host"><option value="">All hosts</option>${options(hosts, filters.host, 'Selected host (not in current list)')}</select></label><label>Filter by status<select data-server-filter="status"><option value="">All statuses</option>${options(statuses, filters.status, filters.status)}</select></label>`}<label>Sort servers<select data-server-filter="sort"><option value="host" ${(filters.sort || 'host') === 'host' ? 'selected' : ''}>Current host order</option><option value="name" ${filters.sort === 'name' ? 'selected' : ''}>Name A–Z</option><option value="name-desc" ${filters.sort === 'name-desc' ? 'selected' : ''}>Name Z–A</option></select></label><button type="button" data-clear-server-filters ${active ? '' : 'disabled'}>Clear filters</button></div>
    <p class="server-count" role="status" aria-live="polite" aria-atomic="true">Showing ${servers.length} of ${snapshot.servers.length} ${snapshot.servers.length === 1 ? 'server' : 'servers'}</p>
    ${!servers.length && snapshot.servers.length ? '<div class="empty server-no-matches"><h2>No matching servers</h2><p>Try another search or clear the filters to see all your servers.</p></div>' : serverCards({...snapshot, servers}, admin)}`;
}
