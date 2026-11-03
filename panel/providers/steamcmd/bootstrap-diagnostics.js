const endpoints = new Set([
  'client-download.steampowered.com',
  'media.steampowered.com',
  'cdn.steamstatic.com',
  'client-update.steamstatic.com',
]);

// Public diagnostic fields only. Never print arbitrary bootstrap text or URLs.
export function bootstrapFailureSummary(text) {
  const events = [];
  for (const line of String(text).slice(-32768).split(/\r?\n/)) {
    const failed = /Download failed: http error (\d{1,3}) \(([^)]+)\)/.exec(line);
    if (failed) {
      try {
        const url = new URL(/^https?:\/\//i.test(failed[2]) ? failed[2] : 'http://' + failed[2]);
        if (!endpoints.has(url.hostname)) continue;
        const resource = ['/client/steam_cmd_linux', '/steam_cmd_linux', '/steam_cmd_steamrt64'].includes(url.pathname) ? url.pathname : '';
        events.push({event: 'manifest_download_failed', code: Number(failed[1]), endpoint: url.hostname + resource});
      } catch {}
    } else if (/Failed to load manifest/.test(line)) {
      events.push({event: 'manifest_unavailable'});
    } else if (/Steamcmd needs to be online to update/.test(line)) {
      events.push({event: 'bootstrap_offline'});
    }
  }
  return {events: events.slice(-16), truncated: events.length > 16 || String(text).length > 32768};
}
