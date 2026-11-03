import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';

// Anonymous probes of fixed public manifest endpoints only. Emit no addresses,
// response bodies, headers, arbitrary errors or environment values.
const hosts = ['client-download.steampowered.com', 'media.steampowered.com', 'cdn.steamstatic.com', 'client-update.steamstatic.com'];
const failures = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
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
    const modern = host === 'client-update.steamstatic.com';
    const request = client.get({protocol, hostname: host, path: modern ? '/steam_cmd_linux' : '/client/steam_cmd_linux'}, response => {
      if (!modern) {
        finish({status: response.statusCode});
        response.destroy();
        return;
      }
      let bytes = 0;
      const digest = createHash('sha256');
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) {
          finish({status: response.statusCode, complete: false, error: 'body_limit'});
          response.destroy();
          return;
        }
        digest.update(chunk);
      });
      response.on('end', () => finish({status: response.statusCode, complete: response.complete === true, bytes, sha256: digest.digest('hex')}));
      response.on('aborted', () => finish({status: response.statusCode, complete: false, error: 'aborted'}));
      response.on('error', error => finish({status: response.statusCode, complete: false, error: code(error)}));
    });
    const deadline = setTimeout(() => {
      finish({error: 'timeout'});
      request.destroy();
    }, 5000);
    request.on('error', error => finish({error: code(error)}));
  })));
  return {host, resolution, protocols};
}));
console.log(JSON.stringify({proxyConfigured: ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(key => Boolean(process.env[key])), manifestNetwork: results}));
