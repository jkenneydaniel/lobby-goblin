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
    const url = new URL(server.webProtocol + '://' + server.address + '/');
    const hostname = url.hostname.replace(/\.$/, '');
    if (
      !hostname.startsWith('[') &&
      (hostname.length > 253 ||
        !hostname
          .split('.')
          .every((label) =>
            /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
          ))
    )
      return '';
    return url.href;
  } catch {
    return '';
  }
}

export function applicationLink(
  server,
  unavailable = false,
  panelHostname = globalThis.location?.hostname,
) {
  const url = applicationURL(server);
  if (!url || unavailable || server.state === 'removed' || !panelHostname)
    return '';
  const canonicalHost = (value) => value.toLowerCase().replace(/\.$/, '');
  if (canonicalHost(new URL(url).hostname) === canonicalHost(panelHostname))
    return '<p class="hint">Public application uses the panel hostname. Use a separate application hostname to keep panel sign-in cookies separate.</p>';
  return `<div class="application-access"><a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open application</a><p class="hint">Public ${server.webProtocol.toUpperCase()} endpoint · separate from panel sign-in${server.webProtocol === 'http' ? ' · not encrypted' : ''}.</p></div>`;
}
