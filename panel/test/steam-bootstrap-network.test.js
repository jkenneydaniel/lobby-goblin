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
      const expectedPath = options.hostname === 'client-update.steamstatic.com' ? '/steam_cmd_linux' : '/client/steam_cmd_linux';
      if (options.path !== expectedPath || Object.keys(options).some(key => !['protocol','hostname','path'].includes(key))) throw Error('unexpected request');
      const request = new EventEmitter(); request.destroy = () => {};
      queueMicrotask(() => {
        if(options.hostname.startsWith('client-download')) request.emit('error', Object.assign(new Error('private-network-message'),{code:'unexpected-private-code'}));
        else {
          const response = Object.assign(new EventEmitter(), {statusCode: options.protocol === 'https:' ? 200 : 403, complete:true, headers:{secret:'private-header'}, destroy(){}});
          callback(response);
          if(options.hostname === 'client-update.steamstatic.com') {response.emit('data', Buffer.from('public manifest')); response.emit('end');}
        }
      }); return request;
    }; http.get=get; https.get=get;`;
  const script = fileURLToPath(new URL('../providers/steamcmd/images/bootstrap-network-probe.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script], {env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 8192});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('private'));
  const parsed = JSON.parse(result.stdout), records = parsed.manifestNetwork;
  assert.equal(parsed.proxyConfigured, false);
  assert.deepEqual(records.map(record => record.host), ['client-download.steampowered.com', 'media.steampowered.com', 'cdn.steamstatic.com', 'client-update.steamstatic.com']);
  assert.deepEqual(records[0], {host: 'client-download.steampowered.com', resolution: 'ENOTFOUND', protocols: [{protocol: 'http:', error: 'request_failed'}, {protocol: 'https:', error: 'request_failed'}]});
  assert.deepEqual(records[1].protocols, [{protocol: 'http:', status: 403}, {protocol: 'https:', status: 200}]);
  assert.equal(records[3].protocols[1].complete, true);
  assert.equal(records[3].protocols[1].bytes, 15);
  assert.match(records[3].protocols[1].sha256, /^[a-f0-9]{64}$/);
});

test('modern probe bounds response bodies and retains TLS failure codes without private error text', () => {
  const preload = `import dns from 'node:dns/promises'; import http from 'node:http'; import https from 'node:https'; import {EventEmitter} from 'node:events';
    dns.lookup = async () => ({address:'private-address'});
    const get = (options, callback) => {
      const request = new EventEmitter(); request.destroy = () => {};
      queueMicrotask(() => {
        if(options.hostname === 'client-update.steamstatic.com' && options.protocol === 'https:') {request.emit('error',Object.assign(new Error('private-certificate-message'),{code:'CERT_HAS_EXPIRED'}));return;}
        const response=Object.assign(new EventEmitter(),{statusCode:200,complete:false,destroy(){}});callback(response);
        if(options.hostname === 'client-update.steamstatic.com') response.emit('data',Buffer.from('private-response'.repeat(5000)));
      });return request;
    };http.get=get;https.get=get;`;
  const script = fileURLToPath(new URL('../providers/steamcmd/images/bootstrap-network-probe.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), script], {env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 8192});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('private'));
  const modern = JSON.parse(result.stdout).manifestNetwork.at(-1);
  assert.deepEqual(modern.protocols, [
    {protocol:'http:',status:200,complete:false,error:'body_limit'},
    {protocol:'https:',error:'CERT_HAS_EXPIRED'},
  ]);
});
