import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

// Anonymous probes of fixed public manifest endpoints only. Emit no addresses,
// response bodies, headers, arbitrary errors or environment values.
const hosts = ['client-download.steampowered.com', 'media.steampowered.com', 'cdn.steamstatic.com'];
const failures = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const code = error => failures.has(error?.code) ? error.code : 'request_failed';
const results = await Promise.all(hosts.map(async host => {
  let resolution;
  try {
    await dns.lookup(host);
    resolution = 'resolved';
  } catch (error) {
    resolution = code(error);
  }
  const protocols = await Promise.all([['http:', http], ['https:', https]].map(([protocol, client]) => new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({protocol, ...value});
    };
    const request = client.get({protocol, hostname: host, path: '/client/steam_cmd_linux'}, response => {
      finish({status: response.statusCode});
      response.destroy();
    });
    const deadline = setTimeout(() => {
      finish({error: 'timeout'});
      request.destroy();
    }, 5000);
    request.on('error', error => finish({error: code(error)}));
  })));
  return {host, resolution, protocols};
}));
console.log(JSON.stringify({manifestNetwork: results}));
