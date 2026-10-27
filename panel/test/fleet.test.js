import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {catalog,validateCreation,resources,labels} from '../fleet/catalog.js';import {runWorker} from '../fleet/worker.js';import {publishSnapshot,verifySnapshot} from '../fleet/snapshots.js';import {writeArchive} from '../applications/rust/archive.js';import {makeZip} from '../core/archive.js';import {ownedDocker} from '../core/owned-docker.js';import {legacyHelperMount} from '../applications/factorio/helper-mount.js';import {FleetManager} from '../fleet/manager.js';import {startFleetWeb} from '../fleet/web.js';import {writeJSON,readJSON} from '../common.js';import {hashPassword} from '../auth.js';import {selectedApplication} from '../applications/index.js';
import {waitForIdleJob} from './fixtures.js';
import {runtimeImagePolicy,runtimeSoftware} from '../applications/factorio/runtime.js';
import {runtimeFixture} from './fixtures/runtime-choice.js';
import {arena as arenaModule} from './fixtures/arena-game.js';
const fleet='a'.repeat(32),one='b'.repeat(32),two='c'.repeat(32),snap='d'.repeat(32),token='e'.repeat(64);
const world=makeZip([{name:'world/level.dat',data:Buffer.from('disposable world content')}]);
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lobby-fleet-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const library=path.join(root,'library');await fs.mkdir(library);return {root,library};}
async function directory(root,name){const p=path.join(root,name);await fs.mkdir(p,{recursive:true});return p;}
const provision=(id,game='factorio',extra={})=>({action:'provision',fleet,id,game,name:'Private test server',image:catalog[game].image,seed:456,worldSize:1000,maxPlayers:7,controllerToken:id.repeat(2),rconPassword:id+'different_rcon_password_1234567890',...extra});
async function factorioBackup(instance){const file=path.join(instance,'backup.zip');await fs.writeFile(file,makeZip([{name:'saves/world.zip',data:world},{name:'config/rconpw',data:Buffer.from('NEVER_SHARE_THIS_SECRET')},{name:'config/server-adminlist.json',data:Buffer.from('["private-admin"]')},{name:'mods/mod-list.json',data:Buffer.from('{"mods":[{"name":"base","enabled":true}]}')},{name:'panel-manifest.json',data:Buffer.from(JSON.stringify({activeSave:'world.zip'}))}]));return file;}
test('creation rejects commands, unsupported games, resource overcommit inputs and caller image overrides',()=>{
 assert.equal(validateCreation({game:'factorio',name:'Friday'}).memoryGiB,2);assert.equal(validateCreation({game:'rust',name:'Island'}).memoryGiB,12);
 for(const input of [{game:'other',name:'x'},{game:'factorio',name:'name\nquit'},{game:'rust',name:'x',memoryGiB:2},{game:'factorio',name:'x',cpu:.7},{game:'rust',name:'x',worldSize:1337},{game:'factorio',name:'x',seed:0}])assert.throws(()=>validateCreation(input));
 const value=validateCreation({game:'factorio',name:'Friday',image:'evil/image',hostPath:'/production'});assert.equal(value.image,undefined);assert.equal(value.hostPath,undefined);
});
test('Factorio snapshots strip credentials and clone into independent initialized storage',async t=>{
 const f=await fixture(t),a=await directory(f.root,'a'),b=await directory(f.root,'b');await runWorker(provision(one),{instance:a,library:f.library});
 const backup=await factorioBackup(a),result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Shared world',sourceName:'Source',game:'factorio',image:catalog.factorio.image}});
 const manifest=await verifySnapshot(f.library,snap,result.manifestSha256);assert.deepEqual(manifest.files.map(f=>f.name),['mods/mod-list.json','world.zip']);assert.equal(manifest.credentialsIncluded,false);
 await runWorker(provision(two,'factorio',{snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:b,library:f.library});assert.deepEqual(await fs.readFile(path.join(b,'data/saves/world.zip')),world);
 assert.equal(await fs.stat(path.join(a,'data/config/rconpw')).catch(()=>null),null,'fresh boot must not look like a broken existing identity');const oldPassword=provision(one).rconPassword,newPassword=await fs.readFile(path.join(b,'data/config/rconpw'),'utf8');assert.notEqual(oldPassword,newPassword);assert.ok(!newPassword.includes('NEVER_SHARE'));
 await fs.writeFile(path.join(b,'data/saves/world.zip'),'changed clone');assert.deepEqual(await fs.readFile(path.join(f.library,snap,'content/world.zip')),world);assert.equal((await readJSON(path.join(a,'.fleet-owner.json'))).id,one);
 await assert.rejects(runWorker(provision(two),{instance:a,library:f.library}),/empty, unowned/);
});
test('snapshot tampering and incompatible games fail before any cloned world is written',async t=>{
 const f=await fixture(t),a=await directory(f.root,'a'),b=await directory(f.root,'b');const backup=await factorioBackup(a),result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Shared',game:'factorio',image:catalog.factorio.image}});
 await fs.appendFile(path.join(f.library,snap,'content/world.zip'),'corrupt');await assert.rejects(verifySnapshot(f.library,snap,result.manifestSha256),/hashes/);
 await assert.rejects(runWorker(provision(two,'factorio',{snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:b,library:f.library}),/hashes/);assert.deepEqual(await fs.readdir(path.join(b,'data/saves')),[]);
});
test('runtime snapshots retain exact software identity and clone it into a verified bootstrap with fresh credentials',async t=>{
 const f=await fixture(t),source=await directory(f.root,'source-runtime'),destination=await directory(f.root,'clone-runtime');
 const software={version:1,provider:'factorio-headless',softwareVersion:'2.0.77',sha256:'a'.repeat(64)};
 const backup=path.join(source,'runtime-backup.zip');await fs.writeFile(backup,makeZip([{name:'saves/world.zip',data:world},{name:'mods/mod-list.json',data:Buffer.from('{"mods":[]}')},{name:'panel-manifest.json',data:Buffer.from(JSON.stringify({activeSave:'world.zip',software}))}]));
 const result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Runtime world',game:'factorio',image:runtimeImagePolicy.defaultImage}});
 const manifest=await verifySnapshot(f.library,snap,result.manifestSha256);assert.deepEqual(manifest.software,software);assert.ok(manifest.files.some(file=>file.name==='software.json'));
 const module=selectedApplication('factorio'),input=module.managed.creationFromSnapshot({game:'factorio',name:'Clone'},manifest);assert.equal(input.softwareMode,'runtime');assert.deepEqual(input.softwareReceipt,software);
 await runWorker(provision(two,'factorio',{image:runtimeImagePolicy.defaultImage,software:runtimeSoftware,softwareMode:'runtime',softwareReceipt:software,snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:destination,library:f.library});
 assert.deepEqual(await readJSON(path.join(destination,'data/runtime/bootstrap.json')),software);
 assert.deepEqual(await fs.readFile(path.join(destination,'data/saves/world.zip')),world);
 assert.equal(await fs.readFile(path.join(destination,'data/config/rconpw'),'utf8'),two+'different_rcon_password_1234567890');
});
test('Rust snapshot clones preserve world/player data and replace config and credentials',async t=>{
 const f=await fixture(t),source=await directory(f.root,'identity'),a=await directory(f.root,'a');await fs.mkdir(path.join(source,'cfg'));await fs.writeFile(path.join(source,'cfg/server.cfg'),'rcon.password private_rcon\nserver.hostname Old');await fs.writeFile(path.join(source,'cfg/users.cfg'),'private administrator');await fs.writeFile(path.join(source,'proceduralmap.1000.456.289.sav'),'real-format-is-separate-runtime-test');await fs.writeFile(path.join(source,'player.blueprints.5.db'),'blueprints');
 const backup=path.join(f.root,'rust.tar.gz');await writeArchive(backup,source,{identity:'lobby-goblin-rust',instance:one,label:'test'});const result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Island',game:'rust',image:catalog.rust.image,seed:456,worldSize:1000}});
 const manifest=await verifySnapshot(f.library,snap,result.manifestSha256);assert.equal(manifest.includesPlayerData,true);assert.equal(manifest.seed,456);assert.ok(manifest.files.every(file=>!file.name.includes('/cfg/')));
 await runWorker(provision(two,'rust',{snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:a,library:f.library});assert.equal(await fs.readFile(path.join(a,'data/server/lobby-goblin-rust/player.blueprints.5.db'),'utf8'),'blueprints');const cfg=await fs.readFile(path.join(a,'data/server/lobby-goblin-rust/cfg/server.cfg'),'utf8');assert.match(cfg,/Private test server/);assert.ok(!cfg.includes('private_rcon'));assert.equal((await readJSON(path.join(a,'data/server/.lobby-goblin-rust.json'))).instance,two);
});
test('legacy data mount conversion retains named-volume and standalone bind normalization',()=>{
 const server={Mounts:[{Type:'volume',Name:'own-volume',Destination:'/factorio'}],HostConfig:{Mounts:[{Type:'volume',Source:'own-volume',Target:'/factorio',VolumeOptions:{Subpath:'data'}}]}};assert.deepEqual(legacyHelperMount(server,'.panel-work/job').VolumeOptions,{NoCopy:true,Subpath:'data/.panel-work/job'});assert.throws(()=>legacyHelperMount(server,'../other'));
 assert.equal(legacyHelperMount({Mounts:[{Type:'bind',Source:'C:\\games\\own',Destination:'/factorio'}]},'.panel-work/job').Source,'/run/desktop/mnt/host/c/games/own/.panel-work/job');
});
test('a managed controller rejects foreign containers, alternate game IDs, unsafe mounts and global cleanup',async()=>{
 const volume=resources(fleet,one,'factorio').volume,game='lobby-goblin-factorio-'+one,calls=[];
 const owned={Id:'owned-id',Name:'/'+game,Config:{Image:'game@sha256:test',Labels:labels(fleet,one,'factorio')},Image:'image-id',Mounts:[{Type:'volume',Name:volume,Destination:'/factorio'}],HostConfig:{Mounts:[{Type:'volume',Source:volume,Target:'/factorio',VolumeOptions:{Subpath:'data'}}]}};
 const request=async(method,route,data)=>{calls.push({method,route,data});if(route.includes('/json')&&route.startsWith('/containers/')&&!route.startsWith('/containers/json'))return route.includes('foreign')?{...owned,Config:{...owned.Config,Labels:{}}}:structuredClone(owned);if(route.startsWith('/containers/json'))return [];return {Id:'worker'};};
 const fenced=ownedDocker(request,{FLEET_ID:fleet,FLEET_INSTANCE:one,FLEET_VOLUME:volume,FACTORIO_CONTAINER:game,GAME_MODULE:'factorio'},{container:game,...selectedApplication('factorio').managed});
 await assert.rejects(fenced('POST','/containers/foreign/stop'),/different installation/);await assert.rejects(fenced('DELETE','/containers/owned-id'),/Unsupported/);assert.equal(calls.filter(c=>c.method!=='GET').length,0);
 await fenced('GET','/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify({label:['factorio-panel.preview=true']})));const filter=JSON.parse(new URL(calls.at(-1).route,'http://docker').searchParams.get('filters'));assert.ok(filter.label.includes('io.lobby-goblin.instance='+one));
 const data={Image:'image-id',HostConfig:{NetworkMode:'none',Memory:1024**3,Mounts:[{Type:'volume',Source:'foreign',Target:'/factorio',VolumeOptions:{Subpath:'state/.panel-work/test'}}]}};await assert.rejects(fenced('POST','/containers/create?name=test',data),/outside/);data.HostConfig.Mounts[0].Source=volume;await fenced('POST','/containers/create?name=test',data);assert.equal(calls.at(-1).data.Labels['io.lobby-goblin.instance'],one);assert.equal(calls.at(-1).data.HostConfig.NanoCpus,1e9);
 await assert.rejects(fenced('DELETE','/volumes/foreign'),/cannot operate/);
});
async function fakeManager(t,{gameModules,broker}={}){
 const f=await fixture(t),root=await directory(f.root,'state'),volumes=new Map(),containers=new Map(),networks=new Map(),calls=[];const host='host-test';containers.set(host,{Id:'host-id',Image:'sha256:manager-runtime',Config:{Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.role':'host-controller'}},State:{Running:true}});
 const docker=async(method,route,data)=>{calls.push({method,route,data});const u=new URL(route,'http://docker'),bits=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);const missing=()=>{throw Object.assign(Error('Not found'),{status:404});};if(route==='/info')return {OSType:'linux',Architecture:'x86_64',ServerVersion:'29.0.0',MemTotal:32*1024**3};if(bits[0]==='images'){const reference=bits[1],repo=reference.split('@')[0].slice(0,reference.split('@')[0].lastIndexOf(':'));return {Id:'sha256:'+'f'.repeat(64),Architecture:'amd64',Os:'linux',RepoDigests:[repo+'@sha256:'+'a'.repeat(64)],Config:{Labels:reference.includes('/arena:')?{game:'arena',revision:'1'}:{'io.lobby-goblin.image-revision':reference.includes('rust-server')?'2':'3','factorio.version':'2.0.77','io.lobby-goblin.compatibility':'1','io.lobby-goblin.game':reference.includes('rust-server')?'rust':'factorio'}}};}if(u.pathname==='/containers/json')return u.searchParams.has('filters')?[]:[{Ports:[{Type:'udp',PublicPort:35000}]}];
 if(method==='POST'&&u.pathname==='/volumes/create'){volumes.set(data.Name,data);return data;}if(bits[0]==='volumes')return volumes.get(bits[1])||missing();
 if(method==='POST'&&u.pathname==='/networks/create'){networks.set(data.Name,{...data,Labels:data.Labels,Containers:{}});return {Id:data.Name};}if(bits[0]==='networks'){const n=networks.get(bits[1])||missing();if(method==='GET')return n;if(bits[2]==='connect')n.Containers['host-id']={};if(bits[2]==='disconnect')delete n.Containers['host-id'];if(method==='DELETE')networks.delete(bits[1]);return null;}
 if(method==='POST'&&u.pathname==='/containers/create'){const name=u.searchParams.get('name');containers.set(name,{...data,Name:'/'+name,Id:name,Config:{Image:data.Image,Labels:data.Labels,Env:data.Env},State:{Running:false,ExitCode:0,OOMKilled:false}});return {Id:name};}
 if(bits[0]==='containers'){const c=containers.get(bits[1])||missing();if(method==='GET')return c;if(bits[2]==='start')c.State.Running=true;if(bits[2]==='stop')c.State.Running=false;if(method==='DELETE')containers.delete(bits[1]);return null;}throw Error('Unexpected fake API '+route);};
 const manager=new FleetManager({docker,broker,brokerVolume:broker?`lobby-goblin-fleet-${fleet}-broker-transport`:undefined,root,library:f.library,fleet,stateVolume:`lobby-goblin-fleet-${fleet}-state`,libraryVolume:`lobby-goblin-fleet-${fleet}-library`,image:'manager:test',hostContainer:host,memoryBudgetGiB:16,gameModules});await manager.init();const instanceRoots=new Map();
 manager.helper=async(item,config)=>{let instance=instanceRoots.get(item.id);if(!instance){instance=await directory(f.root,item.id);instanceRoots.set(item.id,instance);}return runWorker({...config,fleet,id:item.id,game:item.game},{instance,library:f.library,resolveGame:id=>manager.module(id)});};
 // Exercise the real manager.request transport and ownership checks. The child
 // accepts a start job before the game is ready; creation means handoff accepted.
 const childRequests=[];let beforeStart=async()=>{};
 const backend=http.createServer(async(req,res)=>{
  const id=req.headers['x-test-controller'];const item=manager.state.servers.find(item=>item.controller===id);
  assert.ok(item);assert.equal(req.headers.authorization,'Bearer '+item.controllerToken);
  assert.equal(req.method,'POST');assert.equal(req.url,'/jobs');
  let body='';for await(const chunk of req)body+=chunk;
  const value=JSON.parse(body);assert.equal(value.action,'start');assert.equal(value.actor,'administrator');childRequests.push({id,value});
  await beforeStart();res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify({id:'child-start',state:'running'}));
 });await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{backend.closeAllConnections();backend.close(resolve);}));
 const realFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',(url,options)=>{
  const target=new URL(url);assert.ok(manager.state.servers.some(item=>item.controller===target.hostname));
  return realFetch('http://127.0.0.1:'+backend.address().port+target.pathname,{...options,headers:{...options.headers,'x-test-controller':target.hostname}});
 });
 const settled=async job=>{
  const result=await waitForIdleJob(async()=>({jobs:manager.state.jobs,active:manager.active}),job.id,{attempts:1000,pause:()=>new Promise(resolve=>setTimeout(resolve,10))});
  await manager.queue; // include the final registry write before fixture cleanup
  return result;
 };
 async function submit(input){const job=await settled(await manager.submit('create',input));assert.equal(job.state,'succeeded',job.message);return manager.server(job.result.serverId);}
 return {...f,manager,submit,settled,calls,containers,volumes,networks,instanceRoots,childRequests,holdStart:callback=>{beforeStart=callback;}};
}
test('a failed initial registry write releases the host lock without running an operation',async t=>{
 const f=await fakeManager(t),before=structuredClone(f.manager.state.jobs),persist=f.manager.persist.bind(f.manager);let fail=true;
 f.manager.persist=async(...args)=>{if(fail){fail=false;throw Object.assign(Error('Simulated full disk'),{code:'ENOSPC'});}return persist(...args);};
 await assert.rejects(f.manager.submit('create',{game:'factorio',name:'Rejected'}),/full disk/);
 assert.equal(f.manager.active,null);assert.deepEqual(f.manager.state.jobs,before);assert.equal(f.manager.state.servers.length,0);assert.equal(f.calls.length,0);
 assert.equal((await f.submit({game:'factorio',name:'Retry'})).state,'installed');
});

test('host creation returns the original reservation for duplicate requests',async t=>{
 const f=await fakeManager(t),input={game:'factorio',name:'One server',requestId:'browser-create-request'};
 const first=await f.manager.submit('create',input),second=await f.manager.submit('create',input);assert.equal(first.id,second.id);
 await f.settled(first);assert.equal(f.manager.state.servers.length,1);
 assert.equal((await f.manager.submit('create',input)).id,first.id);
 await assert.rejects(f.manager.submit('create',{...input,name:'Different'}),/different request/);
});

test('host restart reconciles recorded creation with owned resources using reads only',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Recorded server'});
 f.manager.state.jobs=[{id:'interrupted-create',action:'create',state:'running',phase:'handoff',target:{serverId:item.id}}];await f.manager.persist();
 const before=f.calls.length,restarted=new FleetManager({...f.manager,gameModules:[...f.manager.modules.values()]});await restarted.init();
 assert.equal(f.calls.length,before,'Startup does not replay a host operation');
 await assert.rejects(restarted.submit('create',{game:'factorio',name:'Blocked'}),/Review interrupted/);
 const result=await restarted.operations.recover({id:'interrupted-create',operation:'inspect'},'Owner');
 assert.equal(result.state,'succeeded');assert.equal(result.result.serverId,item.id);
 assert.ok(f.calls.slice(before).every(call=>call.method==='GET'));
 assert.equal(restarted.operations.blocked,false);assert.ok(f.volumes.has(item.volume));
});

test('host removal recovery verifies absent resources while retaining the data volume',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Removed server'});
 f.containers.delete(item.container);f.containers.delete(item.controller);f.networks.delete(item.network);
 f.manager.state.jobs=[{id:'interrupted-remove',action:'remove',state:'running',target:{serverId:item.id}}];await f.manager.persist();
 const restarted=new FleetManager({...f.manager,gameModules:[...f.manager.modules.values()]});await restarted.init();const before=f.calls.length;
 const result=await restarted.operations.recover({id:'interrupted-remove',operation:'inspect'},'Owner');
 assert.equal(result.state,'succeeded');assert.equal(restarted.server(item.id).state,'removed');assert.ok(f.volumes.has(item.volume));
 assert.ok(f.calls.slice(before).every(call=>call.method==='GET'));
});

test('host creation reserves unique storage/secrets/ports and never changes unrelated servers',async t=>{
 const f=await fakeManager(t),first=await f.submit({game:'factorio',name:'First'}),second=await f.submit({game:'factorio',name:'Second',autoStart:false});assert.notEqual(first.volume,second.volume);assert.notEqual(first.controllerToken,second.controllerToken);assert.notEqual(first.rconPassword,second.rconPassword);assert.equal(first.gamePort,35003);assert.equal(second.gamePort,35006);
 const game=f.containers.get(first.container);assert.ok(game.Env.includes('GENERATE_NEW_SAVE=false'),'world switches must never trigger empty-world generation');assert.equal(game.HostConfig.Mounts[0].VolumeOptions.Subpath,'data');assert.equal(game.HostConfig.Memory,2*1024**3);assert.equal(f.containers.get(second.container).HostConfig.RestartPolicy.Name,'no');assert.equal(f.containers.get(first.controller).Image,'sha256:manager-runtime');
 assert.ok(!JSON.stringify(f.manager.list()).includes(first.controllerToken));assert.ok(!f.calls.some(c=>c.method!=='GET'&&/factorio-server|production/.test(c.route)));
 const job=await f.manager.submit('create',{game:'rust',name:'Over budget',memoryGiB:12});await f.settled(job);assert.equal(job.state,'failed');assert.match(job.message,/budget/);assert.equal(f.manager.state.servers.length,2);
});
test('host creation stays active until the child accepts start and persists the completed handoff',{timeout:15000},async t=>{
 const f=await fakeManager(t);let release,entered;
 const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
 f.holdStart(async()=>{entered();await held;});
 const job=await f.manager.submit('create',{game:'factorio',name:'Slow controller'});
 await requested;await new Promise(resolve=>setTimeout(resolve,650));
 assert.equal(job.state,'running');assert.equal(f.manager.state.servers[0].state,'starting');
 await assert.rejects(f.manager.submit('create',{game:'factorio',name:'Overlap'}),/current host operation/);
 release();const result=await f.settled(job);assert.equal(result.state,'succeeded',result.message);
 const item=f.manager.server(result.result.serverId);assert.equal(item.state,'installed');
 assert.equal(f.childRequests.length,1);assert.equal(f.containers.get(item.container).State.Running,true);
 const saved=await readJSON(path.join(f.manager.root,'registry.json'));
 assert.equal(saved.jobs.find(j=>j.id===job.id).state,'succeeded');assert.equal(saved.servers[0].state,'installed');
});
test('host registry refuses another fleet marker before Docker mutations',async t=>{const f=await fixture(t),root=await directory(f.root,'state');await writeJSON(path.join(root,'.fleet-owner.json'),{fleet:'f'.repeat(32)});const m=new FleetManager({docker:()=>assert.fail('Must not call Docker'),root,library:f.library,fleet,stateVolume:`lobby-goblin-fleet-${fleet}-state`,libraryVolume:`lobby-goblin-fleet-${fleet}-library`,image:'test',hostContainer:'test'});await assert.rejects(m.init(),/another installation/);});
test('one fleet login opens scoped game controls; viewer/CSRF boundaries survive delegation',async t=>{
 const f=await fixture(t),auth=await directory(f.root,'auth'),tokenFile=path.join(f.root,'token');await fs.writeFile(tokenFile,token);await writeJSON(path.join(auth,'users.json'),{admin:{...hashPassword('test-admin-password'),role:'admin'},viewer:{...hashPassword('test-viewer-password'),role:'viewer'}});
 const forwarded=[];const backend=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);const route=req.url;res.setHeader('content-type','application/json');if(route==='/snapshots')return res.end('{"snapshots":[]}');if(route==='/removed-servers')return res.end('{"servers":[]}');if(route==='/servers/'+one)return res.end(JSON.stringify({id:one,game:'factorio',state:'installed'}));if(route==='/update-status')return res.end(JSON.stringify({busy:false}));if(route==='/servers/'+one+'/controller/status')return res.end(JSON.stringify({ready:true,players:[]}));if(route==='/servers/'+one+'/controller/jobs'){let body='';for await(const b of req)body+=b;forwarded.push(JSON.parse(body));res.statusCode=202;return res.end('{"id":"job"}');}if(route==='/host-settings')return res.end(JSON.stringify({memoryBudgetGiB:24}));if(route==='/catalog')return res.end(JSON.stringify({games:Object.values(catalog)}));res.statusCode=404;res.end('{"error":"Not found"}');});await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{backend.closeAllConnections();backend.close(r);}));
 const server=await startFleetWeb({env:{AUTH_DIR:auth,CONTROLLER_TOKEN_FILE:tokenFile,CONTROLLER_URL:'http://127.0.0.1:'+backend.address().port,PANEL_HOSTS:'127.0.0.1'},port:0,hostname:'127.0.0.1'});t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 const login=async name=>{const r=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:name,password:'test-'+name+'-password'})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...await r.json()};};const admin=await login('admin'),viewer=await login('viewer');
 assert.equal((await fetch(origin+'/api/snapshots',{headers:{cookie:viewer.cookie}})).status,200);
 for(const route of ['/snapshots/'+snap,'/removed-servers','/application-releases?game=factorio'])assert.equal((await fetch(origin+'/api'+route,{headers:{cookie:viewer.cookie}})).status,403);
 assert.equal((await fetch(origin+'/api/removed-servers',{headers:{cookie:admin.cookie}})).status,200);
 assert.equal((await fetch(origin+'/api/snapshots/'+snap+'/remove',{method:'POST',headers:{origin,cookie:admin.cookie,'content-type':'application/json'},body:JSON.stringify({confirm:true,title:'World'})})).status,403);

 const html=await fetch(origin+'/servers/'+one+'/',{headers:{cookie:admin.cookie}});assert.equal(html.status,200);const text=await html.text();const entry=new URL(text.match(/<script[^>]+src="([^"]+)"/)[1],origin+`/servers/${one}/`);assert.equal(entry.pathname,`/servers/${one}/app.js`);assert.equal((await fetch(entry,{headers:{cookie:admin.cookie}})).status,200);const definition=await fetch(origin+`/servers/${one}/application-definition.json`,{headers:{cookie:admin.cookie}});assert.equal((await definition.json()).id,'factorio');assert.ok(!text.includes(token));const childSession=await fetch(origin+`/servers/${one}/api/session`,{headers:{cookie:admin.cookie}});assert.equal((await childSession.json()).username,'admin');
 const post=(user,csrf)=>fetch(origin+`/servers/${one}/api/jobs`,{method:'POST',headers:{origin,cookie:user.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':user.csrf}:{})},body:JSON.stringify({action:'start',actor:'forged'})});assert.equal((await post(viewer,true)).status,403);assert.equal((await post(admin,false)).status,403);assert.equal((await post(admin,true)).status,202);assert.equal(forwarded[0].actor,'admin');
 const create=await fetch(origin+'/api/servers',{method:'POST',headers:{origin,cookie:viewer.cookie,'x-csrf-token':viewer.csrf,'content-type':'application/json'},body:'{}'});assert.equal(create.status,403);
 const settingsPost=(user,csrf)=>fetch(origin+'/api/host-settings',{method:'POST',headers:{origin,cookie:user.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':user.csrf}:{})},body:JSON.stringify({memoryBudgetGiB:24,revision:0})});
 assert.equal((await fetch(origin+'/api/host-settings')).status,401);assert.equal((await fetch(origin+'/api/host-settings',{headers:{cookie:viewer.cookie}})).status,200);assert.equal((await settingsPost(viewer,true)).status,403);assert.equal((await settingsPost(admin,false)).status,403);assert.equal((await settingsPost(admin,true)).status,200);

});

 test('restart reconnects registered owned bridges and removal preserves volumes and library entries',async t=>{
 const f=await fakeManager(t),a=await f.submit({game:'factorio',name:'One'}),b=await f.submit({game:'factorio',name:'Two'});
 f.networks.get(a.network).Containers={};f.networks.get(b.network).Containers={};await f.manager.reconnect();assert.ok(f.networks.get(a.network).Containers['host-id']);assert.ok(f.networks.get(b.network).Containers['host-id']);
 f.containers.get(a.container).State.Running=false;const job=await f.manager.submit('remove',{serverId:a.id,name:a.name,confirm:true});await f.settled(job);assert.equal(job.state,'succeeded',job.message);assert.ok(f.volumes.has(a.volume));assert.ok(!f.containers.has(a.container));assert.ok(!f.networks.has(a.network));assert.ok(f.containers.get(b.container).State.Running);assert.ok(f.networks.has(b.network));assert.equal(a.state,'removed');
 });
 test('creation failure preserves its volume and records attention without changing a neighboring server',async t=>{const f=await fakeManager(t),a=await f.submit({game:'factorio',name:'Neighbor'});f.manager.helper=async()=>{throw Error('disposable failure');};const job=await f.manager.submit('create',{game:'factorio',name:'Interrupted'});await f.settled(job);assert.equal(job.state,'failed');const b=f.manager.state.servers.at(-1);assert.equal(b.state,'attention');assert.ok(f.volumes.has(b.volume));assert.ok(f.containers.get(a.container).State.Running);});

test('saved world presets are scoped by account and server and are removed with their account',async t=>{
 const f=await fixture(t),root=await directory(f.root,'accounts');const {Accounts}=await import('../applications/factorio/accounts.js');const accounts=new Accounts(root);
 for(const username of ['Owner','Other']){const invite=await accounts.invite('admin','test');await accounts.register({token:invite.token,username,password:'temporary long test password'});}
 const configuration=JSON.parse(await fs.readFile(new URL('../world-defaults.json',import.meta.url),'utf8'));
 await accounts.worldSetups('Owner',{operation:'save-preset',revision:0,name:'Only in first server',configuration,image:catalog.factorio.image},one);
 assert.equal((await accounts.worldSetups('Owner',undefined,one)).presets.length,1);assert.equal((await accounts.worldSetups('Owner',undefined,two)).presets.length,0);assert.equal((await accounts.worldSetups('Other',undefined,one)).presets.length,0);assert.equal((await accounts.worldSetups('Owner')).presets.length,0);
 await accounts.worldSetups('Owner',{operation:'save-preset',revision:0,name:'Only in second server',configuration,image:catalog.factorio.image},two);assert.equal((await accounts.worldSetups('Owner',undefined,one)).presets[0].name,'Only in first server');
 await accounts.update({username:'Owner',operation:'delete',confirm:true});assert.deepEqual(await fs.readdir(path.join(root,'world-setups')),[]);
});

test('a higher host budget admits default Rust while existing Factorio limits and runtime are unchanged',async t=>{
 const f=await fakeManager(t),first=await f.submit({game:'factorio',name:'Existing factory',memoryGiB:3});const before=structuredClone(f.containers.get(first.container));
 await f.manager.updateHostSettings({memoryBudgetGiB:24,revision:0});const rust=await f.submit({game:'rust',name:'New island',memoryGiB:12});assert.equal(rust.state,'installed');assert.deepEqual(f.containers.get(first.container),before);assert.equal((await f.manager.hostSettings()).allocatedMemoryGiB,17);
});

test('a third game provisions TCP ports and its own storage, publishes and clones through generic fleet services',async t=>{
 const arena=arenaModule('/unused-arena-fixture');
 const f=await fakeManager(t,{gameModules:[arena]});
 const first=await f.submit({game:'arena',name:'First match',tickRate:30});
 const container=f.containers.get(first.container);
 assert.deepEqual(container.Env,['ARENA_TICK_RATE=30']);assert.equal(container.HostConfig.Mounts[0].Target,'/arena');assert.equal(container.ExposedPorts['7777/tcp']!==undefined,true);
 assert.deepEqual(await readJSON(path.join(f.instanceRoots.get(first.id),'data/settings.json')),{tickRate:30});
 const backup=path.join(f.root,'match-backup.zip');await fs.writeFile(backup,makeZip([{name:'score.json',data:Buffer.from(JSON.stringify({score:42}))}]));
 const record={id:snap,sourceId:first.id,game:'arena',image:first.image,title:'Saved match'};
 const published=await publishSnapshot({library:f.library,record,backup,module:arena});
 f.manager.state.snapshots.push({...record,...published});
 const clone=await f.submit({game:'arena',name:'Independent match',tickRate:40,snapshotId:snap});
 assert.notEqual(first.volume,clone.volume);assert.notEqual(first.controllerToken,clone.controllerToken);
 assert.deepEqual(await readJSON(path.join(f.instanceRoots.get(clone.id),'data/matches/current.json')),{score:42});
 await fs.writeFile(path.join(f.instanceRoots.get(clone.id),'data/matches/current.json'),'changed clone');
 assert.deepEqual(await readJSON(path.join(f.library,snap,'content/match.json')),{score:42});
 await assert.rejects(f.manager.submit('create',{game:'arena',name:'Invalid tick rate',tickRate:33}),/Tick rate/);
});
test('removed servers leave the active list but retain recovery identity without credentials',async t=>{
 const f=await fakeManager(t);const first=await f.submit({game:'factorio',name:'Retired'}),second=await f.submit({game:'factorio',name:'Active'});
 first.state='removed';first.removedAt=new Date().toISOString();await f.manager.persist();
 assert.deepEqual(f.manager.list().map(item=>item.id),[second.id]);
 const retained=f.manager.removedServers();assert.equal(retained[0].id,first.id);assert.equal(retained[0].volume,first.volume);
 assert.equal(retained[0].controllerToken,undefined);assert.equal(retained[0].rconPassword,undefined);
 await f.manager.init();assert.deepEqual(f.manager.list().map(item=>item.id),[second.id]);
});
test('snapshot inspection verifies inventory; deletion removes only the chosen library copy',async t=>{
 const f=await fakeManager(t),instance=await directory(f.root,'snapshot-source');
 const backup=await factorioBackup(instance),result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Keep my source',sourceName:'Source',game:'factorio',image:catalog.factorio.image}});
 f.manager.state.snapshots.push({id:snap,title:'Keep my source',...result});await f.manager.persist();
 const details=await f.manager.snapshotDetails(snap);assert.equal(details.manifest.files.length,2);assert.ok(details.verifiedAt);
 await assert.rejects(f.manager.submit('removeSnapshot',{snapshotId:snap,title:'wrong',confirm:true}),/snapshot title/);
 await assert.rejects(f.manager.submit('removeSnapshot',{snapshotId:snap,title:'Keep my source',confirm:false}),/snapshot title/);
 const job=await f.settled(await f.manager.submit('removeSnapshot',{snapshotId:snap,title:'Keep my source',confirm:true}));
 assert.equal(job.state,'succeeded',job.message);assert.deepEqual(f.manager.state.snapshots,[]);
 await assert.rejects(fs.stat(path.join(f.library,snap)),{code:'ENOENT'});assert.ok((await fs.stat(backup)).isFile());
});
test('snapshot deletion refuses a linked library entry and preserves its external target',async t=>{
 const f=await fakeManager(t),outside=await directory(f.root,'outside');await fs.writeFile(path.join(outside,'world'),'protected');
 await fs.symlink(outside,path.join(f.library,snap));f.manager.state.snapshots.push({id:snap,title:'Linked'});await f.manager.persist();
 const job=await f.settled(await f.manager.submit('removeSnapshot',{snapshotId:snap,title:'Linked',confirm:true}));
 assert.equal(job.state,'failed');assert.match(job.message,/cannot be a link/);assert.equal(await fs.readFile(path.join(outside,'world'),'utf8'),'protected');assert.equal(f.manager.state.snapshots.length,1);
});
test('removal can publish a verified library snapshot before deleting containers and retains the source volume',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Recover me'});const source=f.instanceRoots.get(item.id),backup=await factorioBackup(source);await fs.copyFile(backup,path.join(await directory(source,'backups/panel-backups'),'backup.zip'));f.containers.get(item.container).State.Running=false;
 f.manager.request=async(_item,_route,body)=>{if(body)assert.equal(f.containers.get(item.container).State.Running,false,'Snapshot source must already be stopped');return body?{id:'before-removal'}:{jobs:[{id:'before-removal',state:'succeeded',result:'Backup created: backup.zip'}],active:null};};
 const job=await f.settled(await f.manager.submit('remove',{serverId:item.id,name:item.name,confirm:true,publishSnapshot:true}));
 assert.equal(job.state,'succeeded',job.message);assert.equal(item.state,'removed');assert.ok(f.volumes.has(item.volume));
 assert.equal(f.manager.state.snapshots.length,1);assert.equal(f.manager.state.snapshots[0].id,item.removalSnapshotId);
 assert.equal((await f.manager.snapshotDetails(item.removalSnapshotId)).manifest.sourceId,item.id);assert.deepEqual(f.manager.list(),[]);
});
test('failed pre-removal snapshot prevents container deletion and keeps the server visible',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Preserve me'});f.containers.get(item.container).State.Running=false;const before=structuredClone(f.containers.get(item.container));
 f.manager.publish=async()=>{throw Object.assign(Error('Snapshot unavailable; no server resources were removed.'),{status:409});};
 const job=await f.settled(await f.manager.submit('remove',{serverId:item.id,name:item.name,confirm:true,publishSnapshot:true}));
 assert.equal(job.state,'failed');assert.deepEqual(f.containers.get(item.container),before);assert.equal(f.manager.list()[0].id,item.id);assert.ok(f.volumes.has(item.volume));
});

test('named runtime creation preserves legacy requests and hands preparation to the controller before game start',async t=>{
 const module=arenaModule('/unused',{runtimeDefinition:runtimeFixture()}),broker={grant:async()=>{}};
 const f=await fakeManager(t,{gameModules:[module],broker});
 const old=await f.settled(await f.manager.submit('create',{game:'arena',name:'Legacy',softwareMode:'runtime'}));
 assert.equal(old.state,'succeeded',old.message);
 const legacy=f.manager.server(old.result.serverId);
 assert.equal(legacy.image.split('@')[0],module.managed.catalog.image);
 assert.equal(legacy.software.provider,'old-installer');assert.equal(f.containers.get(legacy.container).State.Running,true);
 const created=await f.settled(await f.manager.submit('create',{game:'arena',name:'Prepared',softwareMode:'managed'}));
 assert.equal(created.state,'succeeded',created.message);
 const item=f.manager.server(created.result.serverId);
 assert.equal(item.softwareMode,'managed');assert.equal(item.software.provider,'steamcmd');
 assert.equal(item.image.split('@')[0],module.managed.runtime.imagePolicy.defaultImage);
 assert.equal(f.containers.get(item.container).State.Running,false);
 assert.equal(f.containers.get(item.controller).State.Running,true);
 assert.ok(f.containers.get(item.controller).Config.Env.includes('ARENA_INSTALL_ROOT=/instance/data/engine'));
 assert.ok(f.childRequests.some(request=>request.id===item.controller));
 assert.ok(!f.calls.some(call=>call.route===`/containers/${item.container}/start`));
});
test('controller-prepared creation refuses an old host before reserving resources or Docker mutations',async t=>{
 const module=arenaModule('/unused',{runtimeDefinition:runtimeFixture()}),f=await fakeManager(t,{gameModules:[module]});
 const mark=f.calls.length,job=await f.settled(await f.manager.submit('create',{game:'arena',name:'Refused',softwareMode:'managed'}));
 assert.equal(job.state,'failed');assert.match(job.message,/brokered host/);assert.equal(f.manager.state.servers.length,0);
 assert.ok(f.calls.slice(mark).every(call=>call.method==='GET'));
});

test('managed Rust snapshots and fresh clone bootstrap retain exact Steam software while replacing credentials',async t=>{
 const f=await fixture(t),a=await directory(f.root,'managed-rust-source'),b=await directory(f.root,'managed-rust-clone'),module=selectedApplication('rust'),image=module.managed.runtime.imagePolicy.defaultImage;
 const software={format:1,selection:{format:1,provider:'steamcmd',application:'rust',platform:'linux/amd64',softwareVersion:'123',source:{kind:'steam',appId:'258550',branch:'public',buildId:'123',depots:[{id:'258552',manifest:'123'}]}},inventory:{sha256:'a'.repeat(64),files:2,bytes:100}};
 await runWorker(provision(one,'rust',{image,softwareMode:'managed'}),{instance:a,library:f.library});
 const identity=path.join(a,'data/server/lobby-goblin-rust');await fs.writeFile(path.join(identity,'proceduralmap.1000.456.289.sav'),'synthetic copied world');await fs.writeFile(path.join(identity,'player.blueprints.5.db'),'synthetic players');
 const backup=path.join(f.root,'managed-rust.tar.gz');await writeArchive(backup,identity,{identity:'lobby-goblin-rust',instance:one,label:'managed',software});
 const result=await publishSnapshot({library:f.library,backup,record:{id:snap,sourceId:one,title:'Exact Rust copy',game:'rust',image,seed:456,worldSize:1000}}),manifest=await verifySnapshot(f.library,snap,result.manifestSha256);
 assert.deepEqual(manifest.software,software);assert.ok(manifest.files.some(file=>file.name==='software.json'));assert.ok(!manifest.files.some(file=>file.name.includes('/cfg/')));
 const input=module.managed.creationFromSnapshot({game:'rust',name:'Managed clone'},manifest);assert.equal(input.softwareMode,'managed');assert.deepEqual(input.softwareReceipt,software);
 await runWorker(provision(two,'rust',{...input,image,snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:b,library:f.library});
 const bootstrap=await readJSON(path.join(b,'control/managed-rust-bootstrap.json'));assert.deepEqual(bootstrap.selection,software.selection);assert.ok(bootstrap.inventory.files>=4);
 assert.equal(await fs.readFile(path.join(b,'data/server/lobby-goblin-rust/proceduralmap.1000.456.289.sav'),'utf8'),'synthetic copied world');
 assert.equal(await fs.readFile(path.join(b,'control/rcon-password'),'utf8'),provision(two).rconPassword);
 assert.equal(await fs.lstat(path.join(b,'data/.lobby-goblin-clone.json')).catch(()=>null),null);assert.deepEqual(await fs.readdir(path.join(b,'data/engine')),[]);
 const legacy=path.join(f.root,'legacy-rust.tar.gz');await writeArchive(legacy,identity,{identity:'lobby-goblin-rust',instance:one,label:'legacy'});
 await assert.rejects(publishSnapshot({library:f.library,backup:legacy,record:{id:'e'.repeat(32),sourceId:one,title:'Missing software',game:'rust',image,seed:456,worldSize:1000}}),/exact software identity/);
 assert.throws(()=>module.managed.creationFromSnapshot({softwareMode:'managed'},{seed:456,worldSize:1000}),/no exact managed software/);
});

test('real isolated helper reports bounded storage failures and cleans only its request and worker',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Private backup'}),neighbor=await f.submit({game:'factorio',name:'Neighbor'}),original=f.manager.docker;
 f.manager.docker=async(method,route,data,...rest)=>{
  if(route.includes('/wait?')){
   const spec=f.calls.filter(call=>call.route.startsWith('/containers/create?')).at(-1).data;
   assert.deepEqual(spec.HostConfig.CapAdd,['DAC_OVERRIDE']);assert.deepEqual(spec.HostConfig.CapDrop,['ALL']);
   assert.equal(spec.HostConfig.Mounts[1].ReadOnly,true);assert.equal(spec.HostConfig.NetworkMode,'none');
   await writeJSON(path.join(f.manager.root,spec.HostConfig.Mounts[0].VolumeOptions.Subpath,'failure.json'),{version:1,error:'Storage is full. Free space for the snapshot before retrying.'});
   const worker=f.containers.get(new URL(route,'http://docker').pathname.split('/')[2]);worker.State.Running=false;
   return {StatusCode:1};
  }
  return original(method,route,data,...rest);
 };
 await assert.rejects(FleetManager.prototype.helper.call(f.manager,item,{action:'snapshot'}),/Storage is full/);
 assert.deepEqual(await fs.readdir(path.join(f.manager.root,'requests')),[]);
 assert.ok(f.volumes.has(item.volume));assert.equal(f.containers.get(neighbor.container).State.Running,true);
 assert.ok(![...f.containers.keys()].some(name=>name.startsWith('lobby-goblin-worker-')));
});
test('requested snapshot failure blocks removal and preserves source storage and neighboring resources',async t=>{
 const f=await fakeManager(t),item=await f.submit({game:'factorio',name:'Keep source'}),neighbor=await f.submit({game:'factorio',name:'Neighbor'});
 f.containers.get(item.container).State.Running=false;
 f.manager.publish=async()=>{throw Object.assign(Error('Storage access was denied.'),{status:409});};
 const before=f.calls.length,job=await f.settled(await f.manager.submit('remove',{serverId:item.id,name:item.name,confirm:true,publishSnapshot:true}));
 assert.equal(job.state,'failed');assert.match(job.message,/access was denied/);
 assert.notEqual(item.state,'removed');assert.ok(f.volumes.has(item.volume));assert.ok(f.containers.has(item.container));assert.ok(f.containers.has(item.controller));assert.ok(f.networks.has(item.network));
 assert.equal(f.containers.get(neighbor.container).State.Running,true);
 assert.ok(!f.calls.slice(before).some(call=>call.method==='DELETE'));
});

test('Rust creation enforces its signed seed range while Factorio retains uint32 seeds',()=>{
 assert.equal(validateCreation({game:'rust',name:'Boundary',seed:2147483647}).seed,2147483647);
 for(const seed of [2147483648,3532793187,4294967295])assert.throws(()=>validateCreation({game:'rust',name:'Overflow',seed}),/2147483647/);
 assert.equal(validateCreation({game:'factorio',name:'Unsigned',seed:3532793187}).seed,3532793187);
 assert.equal(validateCreation({game:'factorio',name:'Unsigned maximum',seed:4294967295}).seed,4294967295);
});
test('random server seeds use the application creation range including its upper boundary',async t=>{
 const {default:crypto}=await import('node:crypto');
 const ranges=[];t.mock.method(crypto,'randomInt',(min,max)=>{ranges.push([min,max]);return max-1;});
 const f=await fakeManager(t),rust=await f.submit({game:'rust',name:'Random Rust'});
 assert.equal(rust.seed,2147483647);assert.deepEqual(ranges.at(-1),[1,2147483648]);
 f.manager.memoryBudgetGiB=32;
 const factorio=await f.submit({game:'factorio',name:'Random Factorio'});
 assert.equal(factorio.seed,4294967295);assert.deepEqual(ranges.at(-1),[1,4294967296]);
});
test('legacy Rust overflow registration snapshots keep the verified clamped world identity and clone it independently',async t=>{
 const f=await fixture(t),identity=await directory(f.root,'legacy-rust'),destination=await directory(f.root,'rust-clone');
 const name='proceduralmap.2000.2147483647.289.sav',bytes=Buffer.from('synthetic Rust clamped world');
 await fs.mkdir(path.join(identity,'cfg'));await fs.writeFile(path.join(identity,'cfg/server.cfg'),'rcon.password private-never-copy');await fs.writeFile(path.join(identity,name),bytes);
 const backup=path.join(f.root,'legacy-overflow.tar.gz');await writeArchive(backup,identity,{identity:'lobby-goblin-rust',instance:one,label:'before-removal'});
 const before=await fs.readFile(backup),record={id:snap,sourceId:one,title:'Legacy overflow world',game:'rust',image:catalog.rust.image,seed:3532793187,worldSize:2000};
 const result=await publishSnapshot({library:f.library,backup,record}),manifest=await verifySnapshot(f.library,snap,result.manifestSha256);
 assert.equal(manifest.seed,2147483647);assert.equal(manifest.worldSize,2000);assert.equal(record.seed,3532793187);
 assert.ok(!manifest.files.some(file=>file.name.includes('/cfg/')));assert.deepEqual(await fs.readFile(backup),before);assert.deepEqual(await fs.readFile(path.join(identity,name)),bytes);
 const module=selectedApplication('rust'),input=module.managed.creationFromSnapshot({game:'rust',name:'Independent copy'},manifest);assert.equal(input.seed,2147483647);
 await runWorker(provision(two,'rust',{...input,snapshotId:snap,snapshotHash:result.manifestSha256}),{instance:destination,library:f.library});
 assert.deepEqual(await fs.readFile(path.join(destination,'data/server/lobby-goblin-rust',name)),bytes);
 for(const [seed,worldSize] of [[1234,2000],[3532793187,3000],[4294967296,2000]]){
  await assert.rejects(publishSnapshot({library:f.library,backup,record:{...record,id:'e'.repeat(32),seed,worldSize}}),/source server seed and size|invalid registered seed/);
  assert.equal(await fs.stat(path.join(f.library,'e'.repeat(32))).catch(()=>null),null);
 }
});
