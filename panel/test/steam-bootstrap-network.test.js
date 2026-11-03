import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('bootstrap network probe emits fixed destinations and bounded public fields without raw errors or responses', () => {
  // Exercise the actual probe with in-process transport doubles, never network.
  const preload = `import dns from 'node:dns/promises';
    import http from 'node:http'; import https from 'node:https';
    import {EventEmitter} from 'node:events';
    dns.lookup = async host => { if(host.startsWith('client-download')) throw Object.assign(new Error('private-dns-message'), {code:'ENOTFOUND'}); return {address:'private-address'}; };
    const get = (options, callback) => {
      if (options.path !== '/client/steam_cmd_linux' || Object.keys(options).some(key => !['protocol','hostname','path'].includes(key))) throw Error('unexpected request');
      const request = new EventEmitter(); request.destroy = () => {};
      queueMicrotask(() => {
        if(options.hostname.startsWith('client-download')) request.emit('error', Object.assign(new Error('private-network-message'),{code:'unexpected-private-code'}));
        else callback({statusCode: options.protocol === 'https:' ? 200 : 403, headers:{secret:'private-header'}, destroy(){}});
      }); return request;
    }; http.get=get; https.get=get;`;
  const script = fileURLToPath(new URL('../providers/steamcmd/images/bootstrap-network-probe.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script], {env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 8192});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('private'));
  const records = JSON.parse(result.stdout).manifestNetwork;
  assert.deepEqual(records.map(record => record.host), ['client-download.steampowered.com', 'media.steampowered.com', 'cdn.steamstatic.com']);
  assert.deepEqual(records[0], {host: 'client-download.steampowered.com', resolution: 'ENOTFOUND', protocols: [{protocol: 'http:', error: 'request_failed'}, {protocol: 'https:', error: 'request_failed'}]});
  assert.deepEqual(records[1].protocols, [{protocol: 'http:', status: 403}, {protocol: 'https:', status: 200}]);
});
