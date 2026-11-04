import {escapeHTML as esc, formatBytes} from '../shared/view.js';
import {playerCount} from '../client.js';
import {serverKey} from './host-paths.js';
const connectionAddress = (server) =>
  `<p class="server-address"><code>${esc(server.address || '')}</code>${server.address ? `<button type="button" class="quiet" data-copy-address="${esc(server.manageUrl)}">Copy address</button>` : ''}</p>`;
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
export function serverCards({servers, hosts, live, hostJobs, assigned}, admin) {
  const hostBusy = (id) => !!hostJobs.get(id);
  if (assigned)
    return servers.length
      ? servers
          .map(
            (item) =>
              `<article class="card"><h2>${esc(item.name)}</h2><p>${esc(item.game)}</p>${connectionAddress(item)}<a class="button" href="${esc(item.manageUrl)}">Open server</a></article>`,
          )
          .join('')
      : '<p>No servers have been assigned to your account yet. Ask an administrator for access.</p>';
  return servers.length
    ? servers
        .map((s) => {
          const status = live.get(serverKey(s)),
            removed = s.state === 'removed',
            unavailable =
              !hosts.find((h) => h.id === s.hostId)?.connected || s.unavailable,
            busy = hostBusy(s.hostId),
            state = serverStatus(s, {hosts, live});
          return `<article class="card"><span class="game">${esc(s.game.toUpperCase())} · ${esc(s.hostName)}</span><h2>${esc(s.name)}</h2><span class="status ${unavailable || s.state === 'attention' ? 'attention' : ''}">${esc(state)}</span>${connectionAddress(s)}<div class="stats"><div><strong>${unavailable || status?.players == null ? '—' : playerCount(status.players)}</strong>players</div><div><strong>${esc(s.cpu)}</strong>CPU cores</div><div><strong>${esc(s.memoryGiB)} GiB</strong>memory limit</div></div>${removed ? '<p class="remove-note">Your isolated storage and published snapshots were retained.</p>' : `<div class="actions"><a class="button primary" href="${esc(s.manageUrl)}">Open server</a>${admin ? `<button data-snapshot="${serverKey(s)}" ${busy || unavailable ? 'disabled' : ''}>Publish snapshot</button><button class="quiet" data-remove="${serverKey(s)}" ${busy || unavailable ? 'disabled' : ''}>Remove</button>` : ''}</div>`}</article>`;
        })
        .join('')
    : '<div class="empty"><h2>Your first server starts here.</h2><p>Create a Factorio factory or a Rust island on this machine or a paired game host.</p></div>';
}
export function snapshotCards({snapshots, hostJobs}, admin) {
  const hostBusy = (id) => !!hostJobs.get(id);
  return snapshots.length
    ? snapshots
        .map(
          (s) =>
            `<article class="card"><span class="game">${esc(s.game.toUpperCase())} · ${esc(s.hostName)}</span><h2>${esc(s.title)}</h2><p>From ${esc(s.sourceName)} · ${esc(new Date(s.created).toLocaleDateString())}</p><p class="hint">${s.files} verified ${s.files === 1 ? 'file' : 'files'} · ${esc(formatBytes(s.bytes))}${s.includesPlayerData ? ' · Includes player progress and blueprints' : ''}</p>${admin ? `<div class="actions"><button data-inspect="${serverKey(s)}" ${s.unavailable ? 'disabled' : ''}>View contents</button><button class="danger" data-delete-snapshot="${serverKey(s)}" ${hostBusy(s.hostId) || s.unavailable ? 'disabled' : ''}>Delete snapshot</button><button data-clone="${serverKey(s)}" class="primary" ${hostBusy(s.hostId) || s.unavailable ? 'disabled' : ''}>Create server on this host</button></div>` : ''}</article>`,
        )
        .join('')
    : '<div class="empty"><h2>A library worth returning to.</h2><p>Publish a consistent saved world from a managed server. Each snapshot stays on its source host; clones become independent servers there.</p></div>';
}
