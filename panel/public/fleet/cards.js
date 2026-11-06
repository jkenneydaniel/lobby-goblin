import {escapeHTML as esc, formatBytes} from '../shared/view.js';
import {playerCount} from '../client.js';
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
        : playerCount(status.players),
  };
}
function statusLabel(server, presentation) {
  return `<span class="status ${presentation.unavailable || server.state === 'attention' ? 'attention' : ''}">${esc(presentation.state)}</span>`;
}
function serverActions(server, {removed, unavailable, busy}, admin) {
  return removed
    ? '<p class="remove-note">Your isolated storage and published snapshots were retained.</p>'
    : `<div class="actions"><a class="button primary" href="${esc(server.manageUrl)}">${server.applicationKind === 'application' ? 'Manage application' : 'Open server'}</a>${applicationLink(server, unavailable)}${admin ? `<button data-snapshot="${serverKey(server)}" ${busy || unavailable ? 'disabled' : ''}>Publish snapshot</button><button class="quiet" data-remove="${serverKey(server)}" ${busy || unavailable ? 'disabled' : ''}>Remove</button>` : ''}</div>`;
}
export function serverCards(snapshot, admin) {
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
    ? servers
        .map((server) => {
          const presentation = serverPresentation(server, snapshot);
          return `<article class="card"><span class="game">${esc((server.applicationName || server.game).toUpperCase())} · ${esc(server.hostName)}</span><h2>${esc(server.name)}</h2>${statusLabel(server, presentation)}${connectionAddress(server)}<div class="stats">${server.applicationKind === 'application' ? '' : `<div><strong>${presentation.players}</strong>players</div>`}<div><strong>${esc(server.cpu)} cores</strong>configured CPU limit</div><div><strong>${esc(server.memoryGiB)} GiB</strong>configured memory limit</div></div><div class="stats resource-sample"><div><strong>${esc(presentation.cpuSample)}</strong>sampled CPU</div><div><strong>${esc(presentation.memorySample)}</strong>sampled container memory</div></div><p class="hint">${sampleNote}</p>${serverActions(server, presentation, admin)}</article>`;
        })
        .join('')
    : '<div class="empty"><h2>Your first server starts here.</h2><p>Create a Factorio factory or a Rust island on this machine or a paired game host.</p></div>';
}
export function serverTable(snapshot, admin) {
  // Keep assigned records on their minimal cards, even if a stale view is supplied.
  if (snapshot.assigned || !snapshot.servers.length)
    return serverCards(snapshot, admin);
  return `<div class="server-table-scroll" role="region" aria-label="Fleet servers table" tabindex="0"><table class="server-table"><caption>Fleet servers · Configured CPU and memory are limits. ${sampleNote}</caption><thead><tr><th scope="col">Name</th><th scope="col">Application</th><th scope="col">Host</th><th scope="col">Status</th><th scope="col">Address</th><th scope="col">Configured CPU</th><th scope="col">Configured memory</th><th scope="col">Players</th><th scope="col">Sampled CPU</th><th scope="col">Sampled container memory</th><th scope="col">Actions</th></tr></thead><tbody>${snapshot.servers
    .map((server) => {
      const presentation = serverPresentation(server, snapshot);
      return `<tr><th scope="row">${esc(server.name)}</th><td>${esc(server.applicationName || server.game)}</td><td>${esc(server.hostName)}</td><td>${statusLabel(server, presentation)}</td><td>${connectionAddress(server)}</td><td>${esc(server.cpu)} cores</td><td>${esc(server.memoryGiB)} GiB</td><td>${server.applicationKind === 'application' ? '—' : presentation.players}</td><td>${esc(presentation.cpuSample)}</td><td>${esc(presentation.memorySample)}</td><td>${serverActions(server, presentation, admin)}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
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
