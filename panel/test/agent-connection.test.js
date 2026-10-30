import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AgentConnection} from '../fleet/agent-connection.js';
import {ensureAgentIdentity,readAgentIdentity,pairingCode} from '../fleet/agent-identity.js';
import {RemoteHosts} from '../fleet/hosts.js';
import {startFleetController} from '../fleet/controller.js';
import {startHostAgentWeb} from '../fleet/agent-web.js';
import {agentOptionsFor} from '../agent-options.js';
import {main,readHostInstallation} from '../host-install.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),one='a'.repeat(32),two='b'.repeat(32);
async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'goblin-connection-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function fixture(t,handler){
 const root=await temporary(t),identity=await ensureAgentIdentity(root),sessions=new Set();let count=0;
 const server=http2.createSecureServer({...identity,minVersion:'TLSv1.3'},handler);server.on('session',session=>{count++;sessions.add(session);session.on('error',()=>{});session.once('close',()=>sessions.delete(session));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{for(const session of sessions)session.destroy();server.close(resolve);}));
 const origin='https://127.0.0.1:'+server.address().port,connection=new AgentConnection(origin,identity.fingerprint,{retry:20,pingInterval:30});t.after(()=>connection.close());
 return {root,identity,server,origin,connection,sessions,count:()=>count};
}
test('agent identity persists across restarts with private keys, and incomplete identity is never replaced',async t=>{
 const root=await temporary(t),identity=await ensureAgentIdentity(root);assert.equal((await ensureAgentIdentity(root)).fingerprint,identity.fingerprint);
 assert.equal((await fs.stat(path.join(root,'secrets/agent-identity/key.pem'))).mode&0o777,0o600);
 const secret='x'.repeat(43);assert.deepEqual(pairingCode('lg1.'+identity.fingerprint+'.'+secret),{fingerprint:identity.fingerprint,secret,code:'lg1.'+identity.fingerprint+'.'+secret});
 await fs.unlink(path.join(root,'secrets/agent-identity/key.pem'));await assert.rejects(ensureAgentIdentity(root));assert.equal((await fs.readFile(path.join(root,'secrets/agent-identity/cert.pem'))).toString(),identity.cert.toString());
});
test('paired clients refuse reserved management paths before opening an agent connection',async t=>{
 let requests=0;const f=await fixture(t,(_req,res)=>{requests++;res.end('ready');});
 for(const route of ['/management/status','/management/activate','/api/session'])await assert.rejects(f.connection.fetch(f.origin+route),/Invalid agent destination/);
 assert.equal(requests,0);assert.equal(f.count(),0);
 assert.equal(await(await f.connection.fetch(f.origin+'/health')).text(),'ready');
});
test('one pinned TLS connection multiplexes requests and streams uploads and large downloads with keepalives',async t=>{
 const payload=Buffer.alloc(4*1024**2,7),f=await fixture(t,async(req,res)=>{
  if(req.url.endsWith('/upload')){let size=0;for await(const chunk of req)size+=chunk.length;res.end(String(size));return;}
  res.setHeader('content-type','application/zip');res.setHeader('content-disposition','attachment; filename="fixture.zip"');
  for(let n=0;n<payload.length;n+=16384)if(!res.write(payload.subarray(n,n+16384)))await once(res,'drain');res.end();
 });
 const responses=await Promise.all(Array.from({length:4},()=>f.connection.fetch(f.origin+'/remote/v1/download')));
 for(const response of responses){assert.equal(response.headers.get('content-type'),'application/zip');assert.equal((await response.arrayBuffer()).byteLength,payload.length);}
 assert.equal(await (await f.connection.fetch(f.origin+'/remote/v1/upload',{method:'POST',body:payload})).text(),String(payload.length));
 await sleep(90);assert.equal(f.count(),1);
});
test('a paused download applies byte-based backpressure instead of buffering the entire archive',async t=>{
 let written=0;const size=32*1024**2,chunk=Buffer.alloc(16384),f=await fixture(t,async(req,res)=>{
  for(let n=0;n<size;n+=chunk.length){written+=chunk.length;if(!res.write(chunk))await once(res,'drain');}res.end();
 });
 const response=await f.connection.fetch(f.origin+'/remote/v1/download');await sleep(60);
 assert.ok(written<1024**2,'The unread response must keep upstream buffering below 1 MiB: '+written);
 assert.equal((await response.arrayBuffer()).byteLength,size);
});
test('a wrong certificate pin is rejected before any pairing secret or credential reaches the endpoint',async t=>{
 let requests=0;const f=await fixture(t,(req,res)=>{requests++;res.end('unexpected');}),wrong=new AgentConnection(f.origin,'f'.repeat(64));t.after(()=>wrong.close());
 await assert.rejects(wrong.fetch(f.origin+'/remote/v1/pair',{method:'POST',headers:{authorization:'Bearer private'},body:'private pairing secret'}),/identity changed/);assert.equal(requests,0);
});
test('dropped commands are not replayed and future requests reconnect automatically with the same pin',async t=>{
 let mutations=0;const f=await fixture(t,(req,res)=>{if(req.method==='POST'){mutations++;req.stream.session.destroy();return;}res.end('ready');});
 await assert.rejects(async()=>{const response=await f.connection.fetch(f.origin+'/remote/v1/servers',{method:'POST',body:'{}'});await response.text();});
 await sleep(100);assert.equal(mutations,1);assert.equal(await (await f.connection.fetch(f.origin+'/remote/v1/status')).text(),'ready');assert.ok(f.count()>=2);assert.equal(mutations,1);
});
test('request cancellation and shutdown settle a stalled handshake without sending application credentials',async t=>{
 const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(resolve);}));
 const origin='https://127.0.0.1:'+server.address().port,connection=new AgentConnection(origin,'e'.repeat(64));t.after(()=>connection.close());
 await assert.rejects(connection.fetch(origin+'/remote/v1/status',{signal:AbortSignal.timeout(20)}),/abort|timeout/i);
 const pending=connection.fetch(origin+'/remote/v1/status');connection.close();await assert.rejects(pending,/closed/);assert.equal(connection.closed,true);
});
test('aborting a download cancels only its stream and a truncated response fails instead of appearing complete',async t=>{
 let cancelled;const closed=new Promise(resolve=>cancelled=resolve);const f=await fixture(t,(req,res)=>{
  if(req.url.endsWith('/cancel')){res.write('part');req.stream.once('close',cancelled);return;}
  if(req.url.endsWith('/truncated')){res.write('part');setTimeout(()=>req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR),10);req.stream.on('error',()=>{});return;}
  res.end('ready');
 });
 const controller=new AbortController(),response=await f.connection.fetch(f.origin+'/remote/v1/cancel',{signal:controller.signal});await response.body.getReader().read();controller.abort();await closed;
 await assert.rejects(async()=>{const response=await f.connection.fetch(f.origin+'/remote/v1/truncated');await response.text();});
 assert.equal(await (await f.connection.fetch(f.origin+'/remote/v1/status')).text(),'ready');assert.equal(f.count(),1);
});
test('dedicated-port preparations accept private IPs and preserve reviewed manifests without contacting Docker',async t=>{
 const root=await temporary(t),directory=path.join(root,'agent'),privateIP=[10,8,0,5].join('.');
 await main(['--prepare','--host',privateIP,'--agent-port','25443','--directory',directory],{execute:()=>assert.fail('Must not contact Docker'),log:()=>{}});
 const record=await readHostInstallation(directory),bytes=await fs.readFile(path.join(directory,'host.compose.json'),'utf8'),compose=JSON.parse(bytes);
 assert.equal(record.options.origin,'https://'+privateIP+':25443');assert.equal(record.options.transport,'persistent');assert.equal(compose.services.gateway,undefined);assert.deepEqual(compose.services['host-agent'].ports,['25443:8080/tcp']);
 assert.equal(compose.services['host-agent'].environment.AGENT_TRANSPORT,'persistent');assert.equal(compose.services['fleet-controller'].environment.FLEET_AGENT_TRANSPORT,'persistent');
 await main(['--prepare','--directory',directory],{execute:()=>assert.fail('Must not contact Docker'),log:()=>{}});assert.equal(await fs.readFile(path.join(directory,'host.compose.json'),'utf8'),bytes);
 assert.equal(agentOptionsFor({domain:'[::1]',address:'games.example.test'},'test').origin,'https://[::1]:24443');
 for(const port of [0,80,443,65536,'invalid'])assert.throws(()=>agentOptionsFor({domain:'host.test',agentPort:port},'test'));
});
test('manual pairing uses a persistent agent connection, survives panel restart and enforces revocation on the existing session',async t=>{
 const root=await temporary(t),env={FLEET_ROOT:path.join(root,'state'),FLEET_LIBRARY:path.join(root,'library'),FLEET_WEB_ROOT:path.join(root,'web'),FLEET_ID:two,FLEET_STATE_VOLUME:'lobby-goblin-fleet-'+two+'-state',FLEET_LIBRARY_VOLUME:'lobby-goblin-fleet-'+two+'-library',FLEET_IMAGE:'test:remote',FLEET_HOST_CONTAINER:'host',FLEET_AGENT_ONLY:'true',FLEET_AGENT_TRANSPORT:'persistent'};
 const calls=[],docker=async(method,route)=>{calls.push({method,route});assert.equal(method,'GET','Fixture must never mutate Docker');if(route==='/info')return {MemTotal:32*1024**3};if(route==='/containers/host/json')return {Id:'host-id',Config:{Labels:{'io.lobby-goblin.fleet':two,'io.lobby-goblin.role':'host-controller'}}};throw Object.assign(Error('Fixture unavailable'),{status:404});};
 const remote=await startFleetController({env,docker,port:0,hostname:'127.0.0.1'});t.after(()=>new Promise(resolve=>{remote.server.closeAllConnections();remote.server.close(resolve);}));
 const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const origin='https://127.0.0.1:'+port,edge=await startHostAgentWeb({hostname:'127.0.0.1',port,env:{AGENT_TRANSPORT:'persistent',FLEET_WEB_ROOT:env.FLEET_WEB_ROOT,PANEL_ORIGIN:origin,CONTROLLER_TOKEN_FILE:path.join(root,'web/secrets/controller-token'),CONTROLLER_URL:'http://127.0.0.1:'+remote.server.address().port}});t.after(()=>new Promise(resolve=>{edge.closeAllConnections();edge.close(resolve);}));
 await promisify(execFile)(process.execPath,[new URL('../health.js',import.meta.url).pathname],{env:{...process.env,MODE:'host-agent-web',AGENT_TRANSPORT:'persistent',FLEET_WEB_ROOT:env.FLEET_WEB_ROOT,PORT:String(port)},timeout:5000});
 const manager={root:path.join(root,'central'),fleet:one},central=new RemoteHosts(manager);await central.init();t.after(()=>central.close());
 const unpaired=new AgentConnection(origin,(await readAgentIdentity(env.FLEET_WEB_ROOT)).fingerprint);t.after(()=>unpaired.close());
 assert.equal((await unpaired.fetch(origin+'/remote/v1/servers',{method:'POST',headers:{origin,authorization:'Bearer '+'z'.repeat(43),'content-type':'application/json'},body:'{}'})).status,401);
 const {code}=await remote.hosts.enrollment({operation:'create'});assert.ok(code.startsWith('lg1.'));await central.add({name:'Disposable agent',origin,code,confirm:true});
 const status=await central.list();assert.equal(status.hosts[1].connection,'persistent');assert.equal(status.hosts[1].connected,true);const session=central.connections.get(origin).current;
 assert.equal((await central.list()).hosts[1].connected,true);assert.equal(central.connections.get(origin).current,session);central.close();
 const restored=new RemoteHosts(manager);await restored.init();t.after(()=>restored.close());assert.equal((await restored.list()).hosts[1].connected,true);
 const host=restored.host(two),connection=restored.connections.get(origin);
 assert.equal((await restored.request(origin,'/host-settings',{token:host.token,body:{memoryBudgetGiB:18,revision:0}})).memoryBudgetGiB,18);assert.equal(remote.manager.memoryBudgetGiB,18);
 assert.equal((await connection.fetch(origin+'/remote/v1/accounts',{headers:{authorization:'Bearer '+host.token,origin}})).status,404);
 await remote.hosts.enrollment({operation:'revoke',id:host.pairId});assert.equal((await restored.list()).hosts[1].connected,false);assert.equal(connection.current!==null,true,'Revocation must be checked even on an open connection');
 assert.equal((await connection.fetch(origin+'/remote/v1/servers',{method:'POST',headers:{origin,authorization:'Bearer '+host.token},body:'{}'})).status,401);
 await restored.disconnect(two,{confirm:true,name:'Disposable agent'});assert.equal(connection.closed,true);assert.equal(restored.state.outgoing.length,0);
 assert.ok(calls.every(call=>call.method==='GET'));assert.equal((await readAgentIdentity(env.FLEET_WEB_ROOT)).fingerprint,host.fingerprint);
});

test('explicit gzip map files survive the pinned HTTP2 agent and panel proxy unchanged',async t=>{
 const {gzipSync}=await import('node:zlib'),{proxyResponse}=await import('../core/proxy.js');
 const bytes=gzipSync(JSON.stringify({synthetic:'map'.repeat(1000)})),f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/vnd.lobby-goblin.map+gzip');res.end(bytes);});
 const proxy=http.createServer((req,res)=>{proxyResponse(req,res,f.origin+'/remote/v1/map-payload',{fetcher:(...args)=>f.connection.fetch(...args)}).catch(()=>res.destroy());});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 const response=await fetch('http://127.0.0.1:'+proxy.address().port);assert.equal(response.headers.get('content-type'),'application/vnd.lobby-goblin.map+gzip');assert.equal(response.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});
