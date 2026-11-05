import {escapeHTML as esc} from '../shared/view.js';

// This is a user-selected public listener, never a panel proxy or a probe.
export function applicationURL(server) {
  if (
    server.applicationKind !== 'application' ||
    !['http', 'https'].includes(server.webProtocol) ||
    typeof server.address !== 'string' ||
    !/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):[0-9]{1,5}$/.test(
      server.address,
    )
  )
    return '';
  const port = Number(
    server.address.slice(server.address.lastIndexOf(':') + 1),
  );
  if (port < 1 || port > 65535) return '';
  try {
    return new URL(server.webProtocol + '://' + server.address + '/').href;
  } catch {
    return '';
  }
}

export function applicationLink(server, unavailable = false) {
  const url = applicationURL(server);
  if (!url || unavailable || server.state === 'removed') return '';
  return `<div class="application-access"><a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open application</a><p class="hint">Public ${server.webProtocol.toUpperCase()} endpoint · separate from panel sign-in${server.webProtocol === 'http' ? ' · not encrypted' : ''}.</p></div>`;
}
