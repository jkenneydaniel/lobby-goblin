import {slicePage, listPageControls} from '../shared/list-pages.js';
import {escapeHTML as esc} from '../shared/view.js';
import {
  serverCards,
  serverTable,
  serverStatus,
  serverResourceSample,
} from './cards.js';
import {serverKey} from './host-paths.js';
import {icon} from '../icons.js';

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
    visible = slicePage(servers, filters.page),
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
    statuses = new Set(
      snapshot.assigned
        ? []
        : snapshot.servers.map((item) => serverStatus(item, snapshot)),
    ),
    active = !!(
      filters.search ||
      filters.application ||
      filters.host ||
      filters.status
    );
  if (filters.status) statuses.add(filters.status);
  for (const item of context) {
    const state = serverStatus(item, snapshot);
    availability.set(state, (availability.get(state) || 0) + 1);
  }
  const incomplete =
    !snapshot.assigned &&
    (snapshot.hosts.some(
      (host) => (!filters.host || host.id === filters.host) && !host.connected,
    ) ||
      snapshot.servers.some(
        (item) =>
          (!filters.host || item.hostId === filters.host) && item.unavailable,
      ));
  const statusOrder = [
    'Ready',
    'Stopped',
    'Needs attention',
    'Host unavailable',
    'Starting',
    'Creating',
    'Checking',
  ];
  const statusButtons = snapshot.assigned
    ? ''
    : `<div class="server-status-filters" role="group" aria-label="Filter by status">${['', ...[...statuses].sort((a, b) => (statusOrder.indexOf(a) + 1 || 99) - (statusOrder.indexOf(b) + 1 || 99) || a.localeCompare(b))].map((status) => `<button type="button" aria-pressed="${status === filters.status}" data-server-choice="status" data-server-focus="status:${esc(status)}" value="${esc(status)}">${status ? `<span aria-hidden="true" class="status-dot" data-availability="${esc(status)}"></span>` : ''}<span>${esc(status || 'All')}</span><strong>${status ? availability.get(status) || 0 : context.length}</strong></button>`).join('')}</div>`;
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
  const table = filters.view === 'table',
    toolbar = `<div class="server-filters" role="search" aria-label="Find servers"><label class="server-search">${icon('search')}<input aria-label="Find servers" type="search" data-server-filter="search" maxlength="200" value="${esc(filters.search)}" placeholder="Search servers"></label><button type="button" class="server-filter-toggle" data-toggle-server-filters data-server-focus="filters" aria-controls="server-filter-options" aria-expanded="${!!filters.showOptions}">${icon('adjustments')} Filters</button><div id="server-filter-options" class="server-filter-options" data-expanded="${!!filters.showOptions}"><select aria-label="Filter by application" data-server-filter="application"><option value="">All applications</option>${options(applications, filters.application, 'Selected application (not in current list)')}</select>${snapshot.assigned ? '' : `<select aria-label="Filter by host" data-server-filter="host"><option value="">All hosts</option>${options(hosts, filters.host, 'Selected host (not in current list)')}</select>`}<select aria-label="Sort servers" data-server-filter="sort"><option value="host" ${(filters.sort || 'host') === 'host' ? 'selected' : ''}>${snapshot.assigned ? 'Current order' : 'Group by host'}</option><option value="name" ${filters.sort === 'name' ? 'selected' : ''}>Name A–Z</option><option value="name-desc" ${filters.sort === 'name-desc' ? 'selected' : ''}>Name Z–A</option>${snapshot.assigned ? '' : `<option value="sample-cpu" ${filters.sort === 'sample-cpu' ? 'selected' : ''}>Sampled CPU, high to low</option><option value="sample-memory" ${filters.sort === 'sample-memory' ? 'selected' : ''}>Sampled memory, high to low</option>`}</select>${
      snapshot.assigned
        ? ''
        : `<div class="server-view-choice" role="group" aria-label="View servers">${[
            ['table', 'list', 'List view'],
            ['cards', 'layout-grid', 'Card view'],
          ]
            .map(
              ([value, glyph, label]) =>
                `<button type="button" data-server-choice="view" data-server-focus="view:${value}" value="${value}" aria-label="${label}" title="${label}" aria-pressed="${(value === 'table') === table}">${icon(glyph)}</button>`,
            )
            .join('')}</div>`
    }</div></div>`,
    inventory =
      !servers.length && snapshot.servers.length
        ? '<div class="empty server-no-matches"><h2>No matching servers</h2><p>Try another search or clear the filters to see all your servers.</p></div>'
        : (table ? serverTable : serverCards)(
            {...snapshot, servers: visible.items},
            admin,
            filters.sort === 'host' ? filters.collapsed || new Set() : null,
          );
  return `<div class="server-collection">${statusButtons}${toolbar}
    ${listPageControls(visible)}
    ${inventory}
    <div class="server-list-footer"><p class="server-count" role="status" aria-live="polite" aria-atomic="true">${visible.pages > 1 ? '' : 'Showing '}${servers.length}${visible.pages > 1 ? ' matching' : ''} of ${snapshot.servers.length} ${snapshot.servers.length === 1 ? 'server' : 'servers'}</p><button type="button" class="quiet" data-clear-server-filters ${active ? '' : 'hidden disabled'}>Clear filters</button></div>
    ${incomplete ? '<p class="server-inventory-note" role="status">Unavailable hosts may have servers missing from this loaded inventory.</p>' : ''}</div>`;
}
