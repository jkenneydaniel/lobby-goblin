import {escapeHTML as esc, formatBytes} from '../shared/view.js';
import {playerCount} from '../client.js';
import {icon} from '../icons.js';
import {applicationLink} from './application-link.js';
import {serverKey} from './host-paths.js';
const connectionAddress = (server) =>
  `<p class="server-address"><code>${esc(server.address || '')}</code>${server.address ? `<button type="button" class="quiet" data-copy-address="${esc(server.manageUrl)}">Copy address</button>` : ''}</p>`;
const sampleNote =
  'Most recently received resource sample. CPU: 100% = one core. Memory is container usage.';
const formatSample = (value, format) =>
  value == null ? 'Unavailable' : format(value);
// Display and ordering share eligibility and independently checked raw values.
export function serverResourceSample(server, snapshot) {
  if (snapshot.assigned) return null;
  const status = snapshot.live.get(serverKey(server));
  if (
    !snapshot.hosts.find((host) => host.id === server.hostId)?.connected ||
    server.unavailable ||
    !['installed', 'starting', 'attention'].includes(server.state) ||
    status?.running !== true ||
    status?.state === 'exited'
  )
    return null;
  const valid = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  return {cpu: valid(status.cpu), memory: valid(status.memory)};
}
// Keep fleet filtering and the visible card label on the same classification.
export function serverStatus(server, {hosts, live}) {
  const status = live.get(serverKey(server));
  return server.state === 'removed'
    ? 'Removed · data kept'
    : !hosts.find((host) => host.id === server.hostId)?.connected ||
        server.unavailable
      ? 'Host unavailable'
      : status?.ready
        ? 'Ready'
        : status?.running
          ? 'Starting'
          : status?.state === 'exited'
            ? 'Stopped'
            : server.state === 'attention'
              ? 'Needs attention'
              : server.state === 'creating'
                ? 'Creating'
                : 'Checking';
}
function serverPresentation(server, snapshot) {
  const status = snapshot.live.get(serverKey(server)),
    unavailable =
      !snapshot.hosts.find((host) => host.id === server.hostId)?.connected ||
      server.unavailable,
    // The first refresh publication can retain the preceding live map.
    sample = serverResourceSample(server, snapshot);
  return {
    removed: server.state === 'removed',
    unavailable,
    busy: !!snapshot.hostJobs.get(server.hostId),
    state: serverStatus(server, snapshot),
    cpuSample: formatSample(
      sample?.cpu,
      (value) => `${Number(value.toFixed(1))}%`,
    ),
    memorySample: formatSample(sample?.memory, formatBytes),
    players:
      unavailable || status?.players == null
        ? '—'
        : (playerCount(status.players) ?? '—'),
  };
}
function statusLabel(presentation) {
  return `<span class="status" data-availability="${esc(presentation.state)}">${esc(presentation.state)}</span>`;
}
function managementActions(server, {unavailable, busy}) {
  const target = serverKey(server),
    disabled = busy || unavailable ? 'disabled' : '';
  return `${server.resourceLimits ? `<button class="quiet" data-edit-limits="${esc(target)}" data-server-focus="edit-limits:${esc(target)}" ${disabled}>Edit limits</button>` : ''}<button data-snapshot="${esc(target)}" data-server-focus="snapshot:${esc(target)}" ${disabled}>Publish snapshot</button><button class="quiet" data-remove="${esc(target)}" data-server-focus="remove:${esc(target)}" ${disabled}>Remove</button>`;
}
const removalNote =
  '<p class="remove-note">Your isolated storage and published snapshots were retained.</p>';
function serverActions(server, presentation, admin) {
  const {removed, unavailable} = presentation;
  return removed
    ? removalNote
    : `<div class="actions"><a class="button primary" href="${esc(server.manageUrl)}">${server.applicationKind === 'application' ? 'Manage application' : 'Open server'}</a>${applicationLink(server, unavailable)}${admin ? managementActions(server, presentation) : ''}</div>`;
}
function hostGroups(servers, collapsed) {
  if (!collapsed) return [{servers}];
  const groups = new Map();
  for (const server of servers) {
    if (!groups.has(server.hostId))
      groups.set(server.hostId, {
        id: server.hostId,
        label: server.hostName,
        collapsed: collapsed.has(server.hostId),
        servers: [],
      });
    groups.get(server.hostId).servers.push(server);
  }
  return [...groups.values()];
}
function hostHeading(group) {
  const size = group.servers.length;
  return `<button class="server-host-toggle" type="button" data-server-focus="host:${esc(group.id)}" data-server-host="${esc(group.id)}" aria-expanded="${!group.collapsed}" aria-controls="host-servers-${esc(group.id)}">${icon('chevron-down')}${icon('device-desktop')}<strong>${esc(group.label)}</strong><span>${size} ${size === 1 ? 'server' : 'servers'}</span></button>`;
}
export function serverCards(snapshot, admin, collapsed) {
  const {servers, assigned} = snapshot;
  if (assigned)
    return servers.length
      ? servers
          .map(
            (item) =>
              `<article class="card"><h2>${esc(item.name)}</h2><p>${esc(item.applicationName || item.game)}</p>${connectionAddress(item)}${applicationLink(item)}<a class="button" href="${esc(item.manageUrl)}">${item.applicationKind === 'application' ? 'Manage application' : 'Open server'}</a></article>`,
          )
          .join('')
      : '<p>No servers have been assigned to your account yet. Ask an administrator for access.</p>';
  return servers.length
    ? hostGroups(servers, collapsed)
        .map(
          (group) =>
            `${group.id ? hostHeading(group) : ''}<div class="grid" ${group.id ? `id="host-servers-${esc(group.id)}"` : ''} ${group.collapsed ? 'hidden' : ''}>${group.servers
              .map((server) => {
                const presentation = serverPresentation(server, snapshot);
                return `<article class="card"><span class="game">${esc((server.applicationName || server.game).toUpperCase())} · ${esc(server.hostName)}</span><h2>${esc(server.name)}</h2>${statusLabel(presentation)}${connectionAddress(server)}<div class="stats">${server.applicationKind === 'application' ? '' : `<div><strong>${presentation.players}</strong>players</div>`}<div><strong>${esc(server.cpu)} cores</strong>configured CPU limit</div><div><strong>${esc(server.memoryGiB)} GiB</strong>configured memory limit</div></div><div class="stats resource-sample"><div><strong>${esc(presentation.cpuSample)}</strong>sampled CPU</div><div><strong>${esc(presentation.memorySample)}</strong>sampled container memory</div></div><p class="hint">${sampleNote}</p>${serverActions(server, presentation, admin)}</article>`;
              })
              .join('')}</div>`,
        )
        .join('')
    : '<div class="empty"><h2>Your first server starts here.</h2><p>Create a Factorio factory or a Rust island on this machine or a paired game host.</p></div>';
}
function tableActions(server, presentation, admin) {
  if (presentation.removed) return removalNote;
  const target = esc(server.manageUrl),
    openLabel =
      server.applicationKind === 'application'
        ? 'Manage application'
        : 'Open server';
  return `<div class="server-direct-actions"><a class="button quiet" href="${target}" data-server-focus="open:${target}" aria-label="${openLabel}">${icon('arrow-right')}<span>Open</span></a><button class="quiet server-copy" type="button" data-server-focus="copy:${target}" data-copy-address="${target}" aria-label="Copy address" title="Copy address" ${server.address ? '' : 'disabled'}>${icon('copy')}<span>Copy address</span></button><details class="server-row-details" data-server-details="${target}"><summary data-server-focus="details:${target}" aria-label="Details for ${esc(server.name)}" title="Server details">${icon('dots')}</summary><div class="server-detail-panel"><dl><dt>Address</dt><dd><code>${esc(server.address || '—')}</code></dd><dt>CPU limit</dt><dd>${esc(server.cpu)} cores</dd><dt>Memory limit</dt><dd>${esc(server.memoryGiB)} GiB</dd><dt>Sampled CPU</dt><dd>${esc(presentation.cpuSample)}</dd><dt>Sampled memory</dt><dd>${esc(presentation.memorySample)}</dd></dl>${admin ? managementActions(server, presentation) : ''}</div></details></div>${applicationLink(server, presentation.unavailable)}`;
}
export function serverTable(snapshot, admin, collapsed) {
  // Keep assigned records on their minimal cards, even if a stale view is supplied.
  if (snapshot.assigned || !snapshot.servers.length)
    return serverCards(snapshot, admin);
  return `<div class="server-table-scroll" role="region" aria-label="Fleet servers table" tabindex="0"><table class="server-table" role="table"><caption class="fleet-visually-hidden">Fleet servers · Configured CPU and memory are limits. ${sampleNote}</caption><thead role="rowgroup"><tr role="row">${['Server', 'Status', 'Players', 'CPU', 'Memory', 'Actions'].map((label) => `<th scope="col" role="columnheader">${label}</th>`).join('')}</tr></thead>${hostGroups(
    snapshot.servers,
    collapsed,
  )
    .map(
      (group) =>
        `${group.id ? `<tbody class="server-host-heading" role="rowgroup"><tr role="row"><td colspan="6" role="cell">${hostHeading(group)}</td></tr></tbody>` : ''}<tbody class="server-host-rows" role="rowgroup" ${group.id ? `id="host-servers-${esc(group.id)}"` : ''} ${group.collapsed ? 'hidden' : ''}>${group.servers
          .map((server) => {
            const presentation = serverPresentation(server, snapshot),
              appIcon =
                server.game === 'factorio'
                  ? 'grid-dots'
                  : server.game === 'rust'
                    ? 'shield-check'
                    : 'server',
              players =
                server.applicationKind === 'application'
                  ? '—'
                  : presentation.players;
            return `<tr class="server-row" role="row"><th class="server-name" scope="row" role="rowheader" aria-label="${esc(server.name)}"><span class="server-game-icon ${appIcon}">${icon(appIcon)}</span><span><strong>${esc(server.name)}</strong><small>${esc(server.applicationName || server.game)}${group.id ? '' : ' · ' + esc(server.hostName)}</small></span></th><td class="server-state" role="cell">${statusLabel(presentation)}</td><td class="server-players" role="cell">${players}${players === '—' ? '' : '<span> players</span>'}</td><td class="server-metric" role="cell">${esc(presentation.cpuSample)}</td><td class="server-metric" role="cell">${esc(presentation.memorySample)} <small>/ ${esc(server.memoryGiB)} GiB</small></td><td class="server-row-actions" role="cell">${tableActions(server, presentation, admin)}</td></tr>`;
          })
          .join('')}</tbody>`,
    )
    .join('')}</table></div>`;
}
export function snapshotCards({snapshots, hostJobs}, admin) {
  const hostBusy = (id) => !!hostJobs.get(id);
  return snapshots.length
    ? snapshots
        .map(
          (s) =>
            `<article class="card"><span class="game">${esc(s.game.toUpperCase())} · ${esc(s.hostName)}</span><h2>${esc(s.title)}</h2><p>From ${esc(s.sourceName)} · ${esc(new Date(s.created).toLocaleDateString())}</p><p class="hint">${s.files} verified ${s.files === 1 ? 'file' : 'files'} · ${esc(formatBytes(s.bytes))}${s.includesPlayerData ? ' · Includes player progress and blueprints' : ''}</p>${s.unavailable ? '<p class="hint">Host unavailable · last known snapshot information.</p>' : ''}${admin ? `<div class="actions"><button data-inspect="${serverKey(s)}" ${s.unavailable ? 'disabled' : ''}>View contents</button><button class="danger" data-delete-snapshot="${serverKey(s)}" ${hostBusy(s.hostId) || s.unavailable ? 'disabled' : ''}>Delete snapshot</button><button data-clone="${serverKey(s)}" class="primary" ${hostBusy(s.hostId) || s.unavailable ? 'disabled' : ''}>Create server on this host</button></div>` : ''}</article>`,
        )
        .join('')
    : '<div class="empty"><h2>A library worth returning to.</h2><p>Publish a consistent saved world from a managed server. Each snapshot stays on its source host; clones become independent servers there.</p></div>';
}
