import {escapeHTML as esc} from '../shared/view.js';
import {
  serverCards,
  serverTable,
  serverStatus,
  serverResourceSample,
} from './cards.js';
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
        serverKey(a).localeCompare(serverKey(b)) ||
        a.manageUrl.localeCompare(b.manageUrl),
    );
  } else if (
    !snapshot.assigned &&
    ['sample-cpu', 'sample-memory'].includes(filters.sort)
  ) {
    const metric = filters.sort === 'sample-cpu' ? 'cpu' : 'memory',
      samples = new Map(
        servers.map((server) => [
          server,
          serverResourceSample(server, snapshot)?.[metric] ?? null,
        ]),
      );
    servers.sort((a, b) => {
      const left = samples.get(a),
        right = samples.get(b),
        order =
          left === null
            ? right === null
              ? 0
              : 1
            : right === null
              ? -1
              : right - left;
      return (
        order ||
        a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) ||
        serverKey(a).localeCompare(serverKey(b)) ||
        a.manageUrl.localeCompare(b.manageUrl)
      );
    });
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
    // Ignore only the status choice: retain context while showing alternatives.
    availability = new Map(),
    context = snapshot.assigned
      ? []
      : selectServers(snapshot, {...filters, status: '', sort: 'host'}),
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
  for (const item of context) {
    const state = serverStatus(item, snapshot);
    availability.set(state, (availability.get(state) || 0) + 1);
  }
  for (const state of statuses.keys())
    statuses.set(state, `${state} (${availability.get(state) || 0})`);
  const incomplete =
    !snapshot.assigned &&
    (snapshot.hosts.some(
      (host) => (!filters.host || host.id === filters.host) && !host.connected,
    ) ||
      snapshot.servers.some(
        (item) =>
          (!filters.host || item.hostId === filters.host) && item.unavailable,
      ));
  const availabilitySummary = snapshot.assigned
    ? ''
    : `<section class="server-availability" aria-label="Loaded server availability"><p><strong>Loaded availability</strong> · ${context.length} ${context.length === 1 ? 'server' : 'servers'} matching search, application and host filters (before status).</p><p>${
        [...availability]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([state, count]) => `${esc(state)}: ${count}`)
          .join(' · ') || 'No matching loaded servers.'
      }</p><p class="hint">Most recently received observations.${incomplete ? ' Unavailable hosts may have servers missing from this loaded inventory.' : ''}</p></section>`;
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
  return `<div class="server-filters" role="search" aria-label="Find servers"><label>Find servers<input type="search" data-server-filter="search" maxlength="200" value="${esc(filters.search)}" placeholder="Name, application, host or address"></label><label>Filter by application<select data-server-filter="application"><option value="">All applications</option>${options(applications, filters.application, 'Selected application (not in current list)')}</select></label>${snapshot.assigned ? '' : `<label>Filter by host<select data-server-filter="host"><option value="">All hosts</option>${options(hosts, filters.host, 'Selected host (not in current list)')}</select></label><label>Filter by status<select data-server-filter="status"><option value="">All statuses</option>${options(statuses, filters.status, `${filters.status} (0)`)}</select></label>`}<label>Sort servers<select data-server-filter="sort"><option value="host" ${(filters.sort || 'host') === 'host' ? 'selected' : ''}>Current host order</option><option value="name" ${filters.sort === 'name' ? 'selected' : ''}>Name A–Z</option><option value="name-desc" ${filters.sort === 'name-desc' ? 'selected' : ''}>Name Z–A</option>${snapshot.assigned ? '' : `<option value="sample-cpu" ${filters.sort === 'sample-cpu' ? 'selected' : ''}>Sampled CPU, high to low</option><option value="sample-memory" ${filters.sort === 'sample-memory' ? 'selected' : ''}>Sampled memory, high to low</option>`}</select></label>${snapshot.assigned ? '' : `<label>View servers<select data-server-filter="view"><option value="cards" ${filters.view !== 'table' ? 'selected' : ''}>Cards</option><option value="table" ${filters.view === 'table' ? 'selected' : ''}>Table</option></select></label>`}<button type="button" data-clear-server-filters ${active ? '' : 'disabled'}>Clear filters</button></div>
    <p class="server-count" role="status" aria-live="polite" aria-atomic="true">Showing ${servers.length} of ${snapshot.servers.length} ${snapshot.servers.length === 1 ? 'server' : 'servers'}</p>
    ${availabilitySummary}
    ${!servers.length && snapshot.servers.length ? '<div class="empty server-no-matches"><h2>No matching servers</h2><p>Try another search or clear the filters to see all your servers.</p></div>' : (filters.view === 'table' ? serverTable : serverCards)({...snapshot, servers}, admin)}`;
}
