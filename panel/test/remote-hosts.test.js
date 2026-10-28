import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ssh2 from 'ssh2';
const {Server}=ssh2;
import {Readable} from 'node:stream';
import {createFactorio} from '../applications/factorio/controller.js';
import {startFleetController} from '../fleet/controller.js';
import {startFleetWeb} from '../fleet/web.js';
import {startHostAgentWeb} from '../fleet/agent-web.js';
import {RemoteHosts,remoteRoute,hostOrigin} from '../fleet/hosts.js';
import {HostSetup,setupInput,setupScript} from '../fleet/host-setup.js';
import {probeSSH,runSSH} from '../fleet/ssh.js';
import {runAgentUpdate} from '../fleet/agent-update-worker.js';
import {AgentUpdater,agentVersion} from '../fleet/agent-update.js';
import {optionsFor} from '../install.js';
import {prepareHostInstallation,readHostInstallation,startHostInstallation,hostInstallationFiles} from '../host-install.js';
import {readJSON,writeJSON} from '../common.js';
import {hashPassword} from '../auth.js';

const one='a'.repeat(32),two='b'.repeat(32),serverId='c'.repeat(32),imageId='sha256:'+'d'.repeat(64),version='0.3.5-alpha';
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lobby-remote-hosts-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function wireFetch(url,options={}){return new Promise((resolve,reject)=>{const req=http.request(url,{method:options.method||'GET',headers:options.headers,signal:options.signal},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});}
function close(t,server){t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));}
async function controller(t,id,{hostFetch,agent=true,setupDependencies}={}){
 const root=await temporary(t),calls=[],env={FLEET_ROOT:path.join(root,'state'),FLEET_LIBRARY:path.join(root,'library'),FLEET_WEB_ROOT:path.join(root,'web'),FLEET_ID:id,FLEET_STATE_VOLUME:'lobby-goblin-fleet-'+id+'-state',FLEET_LIBRARY_VOLUME:'lobby-goblin-fleet-'+id+'-library',FLEET_IMAGE:'test:remote',FLEET_HOST_CONTAINER:'host',FLEET_AGENT_ONLY:String(agent)};
 const docker=async(method,route)=>{calls.push({method,route});assert.equal(method,'GET','This fixture must not mutate Docker');if(route==='/info')return {MemTotal:32*1024**3};if(route==='/containers/host/json')return {Id:'host-id',Config:{Labels:{'io.lobby-goblin.fleet':id,'io.lobby-goblin.role':'host-controller'}}};throw Object.assign(Error('Unavailable fixture container'),{status:404});};
 const result=await startFleetController({env,docker,hostFetch,setupDependencies,hostname:'127.0.0.1',port:0});close(t,result.server);const origin='http://127.0.0.1:'+result.server.address().port,token=(await fs.readFile(path.join(root,'web/secrets/controller-token'),'utf8')).trim();return {...result,root,env,origin,token,calls};
}
async function pair(t){
 const remote=await controller(t,two),origin='https://host.example.test';
 const edge=await startHostAgentWeb({hostname:'127.0.0.1',port:0,env:{PANEL_ORIGIN:origin,CONTROLLER_TOKEN_FILE:path.join(remote.root,'web/secrets/controller-token'),CONTROLLER_URL:remote.origin}});close(t,edge);
 let offline=false;const fetcher=(url,options)=>{if(offline)throw Error('Offline');assert.ok(url.startsWith(origin+'/remote/v1/'));return wireFetch('http://127.0.0.1:'+edge.address().port+new URL(url).pathname+new URL(url).search,{...options,headers:{...options.headers,host:'host.example.test'}});};
 const central=await controller(t,one,{hostFetch:fetcher,agent:false}),code=(await remote.hosts.enrollment({operation:'create'})).code;
 const host=await central.hosts.add({origin,name:'Remote game host',code,confirm:true});return {central,remote,host,origin,edge,setOffline:value=>offline=value};
}
test('pairing is single-use, expiring, persisted and exposes no credentials; repeat handshakes recover a lost response',async t=>{
 const root=await temporary(t);let now=1000;const hosts=new RemoteHosts({root,fleet:two},{now:()=>now});await hosts.init();const enrollment=await hosts.enrollment({operation:'create'}),input={code:enrollment.code,centralId:one,pairId:serverId,name:'Main panel',token:crypto.randomBytes(32).toString('base64url')};
 const result=await hosts.accept(input);assert.equal(result.id,two);assert.deepEqual(await hosts.accept(input),result);await assert.rejects(hosts.accept({...input,pairId:'d'.repeat(32),centralId:'e'.repeat(32)}),/expired/);assert.equal(hosts.authenticate(input.token).centralId,one);
 assert.ok(!JSON.stringify(hosts.pairingStatus()).includes(input.token));assert.ok(!JSON.stringify(hosts.pairingStatus()).includes(enrollment.code));const raw=await fs.readFile(hosts.file,'utf8');assert.ok(!raw.includes(input.token));assert.ok(!raw.includes(enrollment.code));assert.equal((await fs.stat(hosts.file)).mode&0o777,0o600);
 const reloaded=new RemoteHosts({root,fleet:two},{now:()=>now});await reloaded.init();assert.equal(reloaded.authenticate(input.token).id,serverId);await reloaded.enrollment({operation:'revoke',id:serverId});assert.throws(()=>reloaded.authenticate(input.token),/revoked/);
 const expired=await reloaded.enrollment({operation:'create'});now+=600001;await assert.rejects(reloaded.accept({...input,code:expired.code}),/expired/);await assert.rejects(reloaded.enrollment(null));
});
test('host addresses require HTTPS and remote protocol refuses account, federation and arbitrary Docker routes',()=>{
 for(const value of ['http://host.test','https://name:password@host.test','https://host.test/path','https://host.test/?token=secret','https://host.test/#x','file:///tmp/a'])assert.throws(()=>hostOrigin(value));assert.equal(hostOrigin('https://host.test:8443/'),'https://host.test:8443');
 for(const route of ['/accounts','/host-pairing','/hosts','/host-setup','/containers/json','/servers/'+serverId+'/controller/unknown'])assert.equal(remoteRoute('POST',route),false,route);assert.equal(remoteRoute('POST','/servers'),true);assert.equal(remoteRoute('GET','/agent-status'),true);assert.equal(remoteRoute('DELETE','/servers'),false);
});
test('agent-only pairing and scoped creation work through HTTPS-origin gateways without a remote panel or accounts',async t=>{
 const f=await pair(t);await assert.rejects(fs.stat(path.join(f.remote.root,'web/auth')),/ENOENT/);const value=await f.central.hosts.list();assert.equal(value.hosts.length,2);assert.equal(value.hosts[1].connected,true);assert.equal(value.hosts[1].aligned,true);
 const forwarded=[];f.remote.manager.submit=async(action,input,actor)=>{forwarded.push({action,input,actor});return {id:'job',state:'running'};};
 const headers={authorization:'Bearer '+f.central.token,'content-type':'application/json','x-panel-user':'Admin'};
 const response=await fetch(f.central.origin+'/hosts/'+two+'/servers',{method:'POST',headers,body:JSON.stringify({hostId:two,game:'factorio',name:'On remote host'})});assert.equal(response.status,202);assert.equal(forwarded.length,1);assert.equal(forwarded[0].input.hostId,two);assert.match(forwarded[0].actor,/remote:.*Admin/);assert.equal(f.central.manager.state.servers.length,0);
 assert.equal((await fetch(f.central.origin+'/servers',{method:'POST',headers,body:JSON.stringify({hostId:two})})).status,409);
 const outgoing=f.central.hosts.host(two),machineHeaders={host:'host.example.test',origin:f.origin,authorization:'Bearer '+outgoing.token};
 const call=(route,options={})=>wireFetch('http://127.0.0.1:'+f.edge.address().port+'/remote/v1'+route,{...options,headers:{...machineHeaders,...options.headers}});
 assert.equal((await call('/accounts')).status,404);assert.equal((await call('/hosts')).status,404);assert.equal((await call('/servers',{method:'POST',body:'{}',headers:{origin:'https://wrong.test'}})).status,403);assert.equal((await call('/status',{headers:{authorization:'Bearer invalid'}})).status,401);
 assert.equal((await wireFetch('http://127.0.0.1:'+f.edge.address().port+'/',{headers:{host:'host.example.test'}})).status,404);
 f.setOffline(true);const offline=await f.central.hosts.list();assert.equal(offline.hosts[0].connected,true);assert.equal(offline.hosts[1].connected,false);f.setOffline(false);
 await f.remote.hosts.enrollment({operation:'revoke',id:outgoing.pairId});assert.equal((await call('/status')).status,401);assert.equal((await call('/servers',{method:'POST',body:'{}'})).status,401);assert.ok(f.central.calls.every(c=>c.method==='GET'));assert.ok(f.remote.calls.every(c=>c.method==='GET'));
});
test('central login keeps remote reads, administrator changes and CSRF checks scoped to host and server',async t=>{
 const f=await pair(t),auth=path.join(f.central.root,'accounts');await fs.mkdir(auth);await writeJSON(path.join(auth,'users.json'),{Admin:{...hashPassword('test-admin-long-password'),role:'admin'},Viewer:{...hashPassword('test-viewer-long-password'),role:'viewer'}});
 f.remote.manager.state.servers=[{id:serverId,game:'factorio',name:'Remote factory',state:'installed',memoryGiB:2,cpu:1,gamePort:35000}];
 const web=await startFleetWeb({env:{AUTH_DIR:auth,CONTROLLER_TOKEN_FILE:path.join(f.central.root,'web/secrets/controller-token'),CONTROLLER_URL:f.central.origin,PANEL_HOSTS:'127.0.0.1'},port:0,hostname:'127.0.0.1'});close(t,web);const origin='http://127.0.0.1:'+web.address().port;
 const login=async(username,password)=>{const r=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...await r.json()};};const admin=await login('Admin','test-admin-long-password'),viewer=await login('Viewer','test-viewer-long-password');
 const call=(route,user=admin,body,csrf=true)=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{origin,cookie:user.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':user.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await call('/api/hosts',viewer)).status,200);assert.equal((await call('/api/host-pairing',viewer)).status,403);assert.equal((await call('/api/host-setup',viewer)).status,403);assert.equal((await call('/api/host-setup-plan',viewer,{})).status,403);assert.equal((await call('/api/hosts',admin,{},false)).status,403);
 const prefix='/hosts/'+two+'/servers/'+serverId;const html=await call(prefix+'/');assert.equal(html.status,200);const markup=await html.text(),entry=new URL(markup.match(/<script[^>]+src="([^"]+)"/)[1],origin+prefix+'/');assert.equal(entry.pathname,prefix+'/app.js');assert.equal((await call(entry.pathname)).status,200);assert.equal((await(await call(prefix+'/application-definition.json')).json()).id,'factorio');assert.equal((await call(prefix+'/api/session',viewer)).status,200);assert.equal((await call(prefix+'/api/jobs',viewer,{action:'start'})).status,403);assert.equal((await call(prefix+'/api/mod-library',viewer)).status,403);assert.equal((await call(prefix+'/api/jobs',admin,{action:'start'},false)).status,403);
 const body=JSON.stringify(await(await call('/api/hosts')).json());assert.ok(!body.includes(f.central.hosts.host(two).token));
 const removed=await call('/api/hosts/'+two+'/disconnect',admin,{name:'Remote game host',confirm:true});assert.equal(removed.status,200);assert.equal((await call(prefix+'/')).status,404);assert.equal(f.remote.manager.state.servers[0].state,'installed');
});
test('manual host preparation has no panel/accounts and refuses edited files or existing installations',async t=>{
 const root=await temporary(t),directory=path.join(root,'agent'),options=optionsFor({mode:'hosted',domain:'host.example.test',address:'host.example.test',memory:16},version);
 const record=await prepareHostInstallation(directory,options),compose=JSON.parse(await fs.readFile(path.join(directory,'host.compose.json'),'utf8'));assert.ok(!compose.services['fleet-web']);assert.equal(compose.services['host-agent'].environment.MODE,'host-agent-web');assert.equal(compose.services['fleet-controller'].environment.FLEET_AGENT_ONLY,'true');assert.ok(!JSON.stringify(compose.services['host-agent']).includes('docker.sock'));assert.equal((await prepareHostInstallation(directory,options)).id,record.id);
 const calls=[];const execute=async(command,args)=>{calls.push(args);if(args[0]==='volume'&&args[1]==='ls')return '';if(args[0]==='context')return 'unix:///var/run/docker.sock';if(args[0]==='info')return JSON.stringify({OSType:'linux',Architecture:'x86_64',ServerVersion:'29.0',MemTotal:32*1024**3,SecurityOptions:[]});if(args[0]==='compose'&&args.includes('version'))return '2.30.0';if(args.includes('ps'))return 'existing-agent';throw Error('Must not alter existing containers');};
 assert.equal((await startHostInstallation(directory,record,{execute,log:()=>{}})).started,false);assert.ok(!calls.some(args=>args.includes('up')||args.includes('pull')));
 await fs.appendFile(path.join(directory,'host.compose.json'),' ');await assert.rejects(readHostInstallation(directory),/changed/);await assert.rejects(prepareHostInstallation(directory,options),/changed/);assert.throws(()=>hostInstallationFiles({...options,mode:'local'}),/HTTPS/);
});
test('SSH setup reviews bind fingerprint, actor, expiry and exact options; credentials never enter saved plans or jobs',async t=>{
 const root=await temporary(t),calls=[],hosts={manager:{root},add:async input=>{calls.push(input);return {id:two};}};let now=1000;
 const setup=new HostSetup(hosts,{now:()=>now,probe:async()=> 'SHA256:'+'a'.repeat(43),execute:async(options,script)=>{assert.equal(options.password,'very-private-password');assert.match(script,/docker run/);return 'Pairing code: lg1.'+'c'.repeat(64)+'.'+'b'.repeat(43);}});await setup.init();
 const input={name:'Game host',host:'host.example.test',username:'root',domain:'host.example.test',memory:16,useSudo:false,installDocker:false};const plan=await setup.plan({...input,password:'must-not-save'},'Admin');assert.ok(!JSON.stringify(plan).includes('must-not-save'));assert.equal(setup.plans.get(plan.id).password,undefined);
 await assert.rejects(setup.install({planId:plan.id,confirm:true,auth:{password:'very-private-password'}},'Other'),/another administrator/);await assert.rejects(setup.install({planId:plan.id,confirm:false,auth:{}},'Admin'),/confirm/);
 const job=await setup.install({planId:plan.id,confirm:true,auth:{password:'very-private-password'}},'Admin');for(let n=0;n<100&&job.state==='running';n++)await sleep(5);assert.equal(job.state,'succeeded',job.message);assert.equal(job.hostId,two);assert.equal(calls.length,1);assert.equal(calls[0].confirm,true);assert.equal(calls[0].code,'lg1.'+'c'.repeat(64)+'.'+'b'.repeat(43));assert.equal(calls[0].origin,'https://host.example.test:24443');assert.ok(!(await fs.readFile(setup.file,'utf8')).includes('very-private-password'));assert.ok(!(await fs.readFile(setup.file,'utf8')).includes('b'.repeat(43)));
 const expired=await setup.plan(input,'Admin');now+=15*60000+1;await assert.rejects(setup.install({planId:expired.id,confirm:true,auth:{password:'x'}},'Admin'),/expired/);
 const script=await setupScript(plan);const file=path.join(root,'script.sh');await fs.writeFile(file,script);await run('sh',['-n',file]);assert.ok(!script.includes('private-password'));assert.match(script,/mkdir -m 700/);for(const host of ['x; touch anything','--option','https://host.test','a\nrm'])assert.throws(()=>setupInput({...input,host},version));
});
test('actual loopback SSH handshake verifies a fingerprint before auth and rejects changed keys before executing',async t=>{
 const privateKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}),server=new Server({hostKeys:[privateKey]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>{authentications++;ctx.username==='test'&&ctx.method==='password'&&ctx.password==='secret'?ctx.accept():ctx.reject();});client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,reject,info)=>{commands.push(info.command);const stream=accept();stream.on('data',()=>{});stream.on('end',()=>{stream.write('Pairing code: '+'x'.repeat(43));stream.exit(0);stream.end();});})));});let authentications=0;const commands=[];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const options={host:'127.0.0.1',port:server.address().port,username:'test'},pin=await probeSSH(options);assert.match(pin,/^SHA256:/);assert.equal(authentications,0);
 const output=await runSSH({...options,fingerprint:pin,password:'secret'},'synthetic setup script');assert.match(output,/Pairing code/);assert.deepEqual(commands,['sh -s']);const before=authentications;
 await assert.rejects(runSSH({...options,fingerprint:'SHA256:'+'z'.repeat(43),password:'secret'},'must not execute'),/fingerprint changed/);assert.equal(authentications,before);assert.equal(commands.length,1);
});

function updateFixture({failWeb=false}={}){
 const fleet=one,volume='lobby-goblin-fleet-'+fleet+'-state',calls=[],containers=new Map();let serial=0;
 for(const [suffix,role] of [['host','host-controller'],['agent','host-agent-web']]){const name='lobby-goblin-'+suffix+'-'+fleet;containers.set(name,{Id:'original-'+suffix,Name:'/'+name,Image:'old-image',Config:{Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.role':role},Env:role==='host-controller'?['FLEET_AGENT_ONLY=true']:[]},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[{Type:'volume',Name:volume,Destination:'/fleet'}],NetworkSettings:{Networks:{}},State:{Running:true,Health:{Status:'healthy'}}});}
 const game={Id:'game-never-change',State:{Running:true},world:'sentinel'};containers.set('game',game);
 const docker=async(method,route,data)=>{
  calls.push({method,route,data});const url=new URL(route,'http://docker');
  if(url.pathname==='/containers/create'){const name=url.searchParams.get('name'),id='new-'+(++serial),role=data.Labels['io.lobby-goblin.role'];containers.set(name,{...structuredClone(data),Id:id,Name:'/'+name,Config:{Labels:data.Labels,Env:data.Env},Mounts:[{Type:'volume',Name:volume,Destination:'/fleet'}],State:{Running:false,Health:{Status:failWeb&&role==='host-agent-web'?'unhealthy':'healthy'}},HostConfig:data.HostConfig});return {Id:id};}
  const match=url.pathname.match(/^\/containers\/([^/]+)(?:\/(json|start|stop|update|rename))?$/);assert.ok(match,'Unexpected Docker route: '+route);const key=decodeURIComponent(match[1]),entry=[...containers.entries()].find(([name,value])=>name===key||value.Id===key);if(!entry)throw Object.assign(Error('Not found'),{status:404});const [name,item]=entry;assert.notEqual(name,'game','Updater must never inspect or mutate game containers');
  if(method==='GET')return structuredClone(item);if(method==='DELETE'){containers.delete(name);return null;}if(match[2]==='start')item.State.Running=true;else if(match[2]==='stop')item.State.Running=false;else if(match[2]==='update')item.HostConfig.RestartPolicy=data.RestartPolicy;else if(match[2]==='rename'){containers.delete(name);containers.set(url.searchParams.get('name'),item);}else assert.fail('Unexpected mutation');return null;
 };
 const state={id:two,fleet,stateVolume:volume,state:'running',target:'ghcr.io/jkenneydaniel/lobby-goblin@sha256:'+'e'.repeat(64),imageId,entries:[],containers:[['host','host-controller'],['agent','host-agent-web']].map(([suffix,role])=>({id:'original-'+suffix,name:'lobby-goblin-'+suffix+'-'+fleet,role}))};return {state,docker,calls,containers,game};
}
test('agent update replaces only two management containers after healthy checks and leaves games identical',async()=>{
 const f=updateFixture(),before=structuredClone(f.game),saved=[];await runAgentUpdate(f.state,{docker:f.docker,save:async state=>saved.push(structuredClone(state)),wait:async()=>{}});assert.equal(f.state.state,'complete');assert.deepEqual(f.game,before);assert.equal(f.containers.size,3);assert.ok(f.calls.some(c=>c.data?.Env?.includes('FLEET_SKIP_MIGRATIONS=true')));assert.ok(saved.every(s=>!JSON.stringify(s).includes('game-never-change')));
});
test('agent updates preserve the dedicated port, pinned identity volume and transport settings',async()=>{
 const f=updateFixture(),project='lobby-goblin-fleet-'+one;
 for(const [name,item] of f.containers){
  if(name==='game')continue;
  item.Config.Env.push(item.Config.Labels['io.lobby-goblin.role']==='host-controller'?'FLEET_AGENT_TRANSPORT=persistent':'AGENT_TRANSPORT=persistent');
  item.Mounts.push({Type:'volume',Name:project+'-web',Destination:'/web-state',RW:false});
  item.HostConfig.PortBindings={'8080/tcp':[{HostIp:'',HostPort:'25443'}]};
  item.HostConfig.Binds=[project+'-web:/web-state:ro'];
 }
 await runAgentUpdate(f.state,{docker:f.docker,save:async()=>{},wait:async()=>{}});assert.equal(f.state.state,'complete');
 const created=f.calls.filter(call=>call.route.startsWith('/containers/create'));
 for(const call of created){assert.deepEqual(call.data.HostConfig.PortBindings,{'8080/tcp':[{HostIp:'',HostPort:'25443'}]});assert.ok(call.data.HostConfig.Binds.includes(project+'-web:/web-state:ro'));assert.ok(call.data.Env.some(value=>value.endsWith('TRANSPORT=persistent')));}
 assert.equal(f.game.State.Running,true);
});
test('unhealthy management replacement restores both originals, with no game stop or volume deletion',async()=>{
 const f=updateFixture({failWeb:true});await runAgentUpdate(f.state,{docker:f.docker,save:async()=>{},wait:async()=>{}});assert.equal(f.state.state,'failed');assert.equal(f.state.rolledBack,true);assert.equal(f.containers.get('lobby-goblin-host-'+one).Id,'original-host');assert.equal(f.containers.get('lobby-goblin-agent-'+one).Id,'original-agent');assert.equal(f.game.State.Running,true);assert.ok(!f.calls.some(c=>c.route.includes('/volumes/')));
});
test('agent update refuses foreign labels and provides a durable recovery state instead of touching unknown containers',async()=>{
 const f=updateFixture();f.containers.get('lobby-goblin-agent-'+one).Config.Labels['io.lobby-goblin.fleet']=two;await runAgentUpdate(f.state,{docker:f.docker,save:async()=>{},wait:async()=>{}});assert.ok(['failed','attention'].includes(f.state.state));assert.ok(!f.calls.some(c=>c.method!=='GET'));assert.equal(f.game.State.Running,true);
});

test('agent update reviews expire, reject changed containers, and pin the published matching runtime before launching a helper',async t=>{
 const root=await temporary(t),f=updateFixture(),current=await agentVersion(),next=(Number(current.split('.')[0])+1)+'.0.0-alpha';let now=1000,releasePull;const pulled=new Promise(resolve=>releasePull=resolve),calls=[];
 const manager={root,fleet:one,stateVolume:f.state.stateVolume,hostContainer:'lobby-goblin-host-'+one,docker:async(method,route,data)=>{
  calls.push({method,route,data});if(route.startsWith('/images/create')){await pulled;return '';}
  if(route.startsWith('/images/'))return {Id:imageId,Os:'linux',Architecture:'amd64',Config:{Labels:{'io.lobby-goblin.runtime':'1','org.opencontainers.image.version':next,'org.opencontainers.image.source':'https://github.com/jkenneydaniel/lobby-goblin'}},RepoDigests:['ghcr.io/jkenneydaniel/lobby-goblin@sha256:'+'e'.repeat(64)]};
  if(route.startsWith('/containers/create'))return {Id:'helper'};if(route.endsWith('/start'))return null;return f.docker(method,route,data);
 }};
 const updater=new AgentUpdater(manager,{enabled:true,now:()=>now});await assert.rejects(updater.plan({version:current}),/already current/);
 const expired=await updater.plan({version:next});now+=900001;await assert.rejects(updater.apply({planId:expired.id,confirm:true}),/expired/);
 const stale=await updater.plan({version:next});f.containers.get(manager.hostContainer).Id='changed';await assert.rejects(updater.apply({planId:stale.id,confirm:true}),/changed since review/);f.containers.get(manager.hostContainer).Id='original-host';
 const plan=await updater.plan({version:next});await assert.rejects(updater.apply({planId:plan.id,confirm:false}),/Confirm/);await updater.apply({planId:plan.id,confirm:true});
 await assert.rejects(updater.apply({recover:true,confirm:true}),/Wait/);assert.equal(calls.filter(c=>c.route.startsWith('/images/create')).length,1);releasePull();
 for(let n=0;n<100&&updater.busy;n++)await sleep(5);assert.equal(updater.busy,false);const state=await readJSON(updater.file);assert.equal(state.imageId,imageId);assert.match(state.target,/@sha256:/);
 const helper=calls.find(c=>c.route.startsWith('/containers/create'));assert.equal(helper.data.Image,imageId);assert.equal(helper.data.HostConfig.NetworkMode,'none');assert.deepEqual(helper.data.HostConfig.Mounts.map(m=>m.Target),['/var/run/docker.sock','/fleet']);assert.equal(helper.data.HostConfig.AutoRemove,true);assert.ok(!calls.some(c=>/\/(stop|rename)/.test(c.route)));
});
test('agent recovery refuses a running helper and exposes interrupted updates for recovery after a restart',async t=>{
 const root=await temporary(t),f=updateFixture();let running=true;const manager={root,fleet:one,stateVolume:f.state.stateVolume,hostContainer:'lobby-goblin-host-'+one,docker:async(method,route)=>{
  assert.equal(method,'GET','Recovery review must not mutate a running helper');assert.match(route,/lobby-goblin-agent-update-/);if(!running)throw Object.assign(Error('gone'),{status:404});return {Id:'helper',State:{Running:true},Config:{Labels:{'io.lobby-goblin.fleet':one,'io.lobby-goblin.role':'agent-updater'}}};
 }};const updater=new AgentUpdater(manager,{enabled:true});await writeJSON(updater.file,f.state);await assert.rejects(updater.apply({recover:true,confirm:true}),/still running/);assert.equal((await updater.status()).update.state,'running');running=false;assert.equal((await updater.status()).update.state,'attention');assert.equal((await readJSON(updater.file)).state,'attention');
});
test('a lost Docker start response keeps a live agent update locked instead of reporting a safe failure',async t=>{
 const root=await temporary(t),f=updateFixture(),current=await agentVersion(),next=(Number(current.split('.')[0])+1)+'.0.0-alpha';let helperRunning=false;
 const manager={root,fleet:one,stateVolume:f.state.stateVolume,hostContainer:'lobby-goblin-host-'+one,docker:async(method,route,data)=>{
  if(route.startsWith('/images/create'))return '';
  if(route.startsWith('/images/'))return {Id:imageId,Os:'linux',Architecture:'amd64',Config:{Labels:{'io.lobby-goblin.runtime':'1','org.opencontainers.image.version':next,'org.opencontainers.image.source':'https://github.com/jkenneydaniel/lobby-goblin'}},RepoDigests:['ghcr.io/jkenneydaniel/lobby-goblin@sha256:'+'e'.repeat(64)]};
  if(route.startsWith('/containers/create'))return {Id:'helper'};
  if(route.endsWith('/start')){helperRunning=true;throw Error('Response lost');}
  if(route.includes('/lobby-goblin-agent-update-'))return {Id:'helper',State:{Running:helperRunning},Config:{Labels:{'io.lobby-goblin.fleet':one,'io.lobby-goblin.role':'agent-updater'}}};
  return f.docker(method,route,data);
 }};const updater=new AgentUpdater(manager,{enabled:true}),plan=await updater.plan({version:next});await updater.apply({planId:plan.id,confirm:true});for(let n=0;n<100&&updater.busy;n++)await sleep(5);assert.equal(manager.agentUpdating,true);assert.equal((await updater.status()).update.state,'running');await assert.rejects(updater.apply({recover:true,confirm:true}),/still running/);
});

test('paired panel administrators retain separate Factorio preview sessions without accessing game workers',async t=>{
 const root=await temporary(t),actor='remote:'+one+':Admin';
 const ctx={config:{data:path.join(root,'data'),state:path.join(root,'state'),backups:path.join(root,'backups'),container:'fixture',library:path.join(root,'library'),backupDir:path.join(root,'backups')},env:{},active:{action:'fixture-hold'},updater:{busy:false},jobs:[],backups:{create:()=>assert.fail('No game backup')},host:{info:async()=>({Image:'fixture-image',Config:{Image:'fixture:2.0.77'},State:{Running:false}}),control:()=>assert.fail('No game lifecycle changes')},docker:()=>assert.fail('No Docker access')};
 const factorio=await createFactorio(ctx);
 async function request(owner,body){const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=body?'POST':'GET';req.headers={'x-panel-user':owner};let result;await factorio.handle(req,{writeHead(){},end(value){result=JSON.parse(value);}},new URL('http://fixture/world-preview'));return result;}
 const preview=await request(actor,{seed:123,configuration:{map_gen_settings:{},map_settings:{}}});assert.equal(preview.state,'queued');
 assert.equal((await request(actor)).id,preview.id);assert.equal((await request('remote:'+two+':Admin')).state,'idle');assert.equal((await request('Admin')).state,'idle');
 await assert.rejects(request('remote:'+one+':../Admin'),/administrator session/);
});
test('agent recovery uses the current owned runtime without registry access or an image pull',async t=>{
 const root=await temporary(t),f=updateFixture(),calls=[],runtime='sha256:'+'9'.repeat(64);
 const manager={root,fleet:one,stateVolume:f.state.stateVolume,hostContainer:'lobby-goblin-host-'+one,docker:async(method,route,data)=>{
  calls.push({method,route,data});assert.ok(!route.startsWith('/images/'),'Recovery must not contact the registry');
  if(route.includes('/lobby-goblin-agent-update-'))throw Object.assign(Error('No previous helper'),{status:404});
  if(route==='/containers/'+manager.hostContainer+'/json'){const container=f.containers.get(manager.hostContainer);return {...container,Image:runtime};}
  if(route.startsWith('/containers/create'))return {Id:'recovery-helper'};if(route.endsWith('/start'))return null;assert.fail('Unexpected recovery request: '+route);
 }};
 const updater=new AgentUpdater(manager,{enabled:true});await writeJSON(updater.file,{...f.state,state:'attention'});await updater.apply({recover:true,confirm:true});
 for(let n=0;n<100&&updater.busy;n++)await sleep(5);
 const helper=calls.find(call=>call.route.startsWith('/containers/create'));assert.ok(helper,'Recovery should launch a helper with the cached current image');assert.equal(helper.data.Image,runtime);assert.equal(helper.data.HostConfig.NetworkMode,'none');assert.equal(f.game.State.Running,true);
});

test('game-only update context survives paired host and agent gateways to the instance controller',async t=>{
 const f=await pair(t),forwarded=[],original=globalThis.fetch;
 f.remote.manager.state.servers=[{id:serverId,game:'factorio',state:'installed',controller:'synthetic-controller',controllerToken:'synthetic-instance-token'}];
 f.remote.manager.ownedContainer=async()=>({Id:'synthetic-owned-controller'});
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).startsWith('http://synthetic-controller:8081/')){forwarded.push(options.headers);assert.equal(options.headers.authorization,'Bearer synthetic-instance-token');return new Response('{"id":"game-update"}',{status:202,headers:{'content-type':'application/json'}});}
  return original(url,options);
 });
 const response=await fetch(f.central.origin+'/hosts/'+two+'/servers/'+serverId+'/controller/update-install',{method:'POST',headers:{authorization:'Bearer '+f.central.token,'content-type':'application/json','x-panel-user':'Assigned','x-panel-update-kind':'game'},body:JSON.stringify({planId:'fixture',confirm:true})});
 assert.equal(response.status,202,await response.clone().text());assert.equal(forwarded.length,1);assert.equal(forwarded[0]['x-panel-update-kind'],'game');assert.match(forwarded[0]['x-panel-user'],/remote:.*Assigned/);
});


test('SSH bootstrap carries a closed set of installer imports including the broker compose definition',async t=>{
 const root=await temporary(t),payload=path.join(root,'payload'),source=fileURLToPath(new URL('../',import.meta.url)),version=JSON.parse(await fs.readFile(path.join(source,'package.json'))).version;
 const plan={...setupInput({name:'Fixture',host:'host.example.test',username:'root',domain:'host.example.test',memory:16,useSudo:false,installDocker:false},version),id:'e'.repeat(32)};
 const staged=[];await setupScript(plan,{read:async file=>{const relative=path.relative(source,file);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));const bytes=await fs.readFile(file),target=path.join(payload,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);staged.push(relative);return bytes;}});
 assert.ok(staged.includes('fleet/broker-compose.js'));
 assert.ok(staged.includes('core/management-installation.js'));
 const installer=await import(pathToFileURL(path.join(payload,'host-install.js')).href),files=installer.hostInstallationFiles(plan.options,'f'.repeat(32)),compose=JSON.parse(files['host.compose.json']);
 assert.equal(compose.services['docker-broker'].labels['io.lobby-goblin.role'],'docker-broker');assert.equal(compose.services['fleet-controller'].environment.DOCKER_BROKER_SOCKET,'/broker/socket/docker.sock');
});
