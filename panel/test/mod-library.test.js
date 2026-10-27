import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import http from 'node:http';
import {makeZip} from '../core/archive.js';
import {createModDownloads,digest} from '../core/mod-downloads.js';
import {createModStore} from '../core/mod-store.js';
import {createFactorioModLibrary} from '../applications/factorio/mod-library.js';
import {createRustModLibrary} from '../applications/rust/mod-library.js';
import {createModManager} from '../applications/rust/mods.js';
import {validateLibraryAction} from '../core/mod-library.js';
import {startWeb} from '../core/web.js';
import {hashPassword} from '../auth.js';
import {factorio as factorioModule} from '../applications/factorio/index.js';
import {rust as rustModule} from '../applications/rust/index.js';
import {inventory as archiveInventory} from '../applications/rust/archive.js';

async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lg-mod-library-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function request(library,route,body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={};let result;await library.handle(req,{writeHead(){},end(value){result=JSON.parse(value);}},new URL(route,'http://fixture'));return result;}
const view=(library,tab='installed',extra={})=>library.view(new URLSearchParams({tab,...extra}));
async function factorio(t){
  const root=await temporary(t),data=path.join(root,'game'),state=path.join(root,'state');await fs.mkdir(path.join(data,'mods'),{recursive:true});await fs.mkdir(path.join(data,'saves'));await fs.mkdir(state);
  await fs.writeFile(path.join(data,'saves/world.zip'),'WORLD SENTINEL');await fs.writeFile(path.join(data,'mods/mod-settings.dat'),'SETTINGS SENTINEL');await fs.writeFile(path.join(data,'mods/mod-list.json'),JSON.stringify({mods:[{name:'base',enabled:true},{name:'space-age',enabled:false}]}));
  const packages=new Map(),mods=new Map();
  function release(name,version,dependencies=['base >= 2.0.0'],factorioVersion='2.0'){const info={name,version,title:name,factorio_version:factorioVersion,dependencies},data=makeZip([{name:name+'_'+version+'/info.json',data:Buffer.from(JSON.stringify(info))},{name:name+'_'+version+'/control.lua',data:Buffer.from('-- fixture')}]),value={version,info_json:info,sha1:digest(data,'sha1'),download_url:'/download/'+name+'/'+version};packages.set(value.download_url,data);const mod=mods.get(name)||{name,title:name,summary:'A useful fixture',owner:'fixture',downloads_count:42,releases:[]};mod.releases.push(value);mod.latest_release=value;mods.set(name,mod);return value;}
  release('dependency','1.0.0');release('example','1.0.0',['base >= 2.0.0','dependency >= 1.0.0']);
  let running=false,corrupt=false,starts=0,stops=0,startError=false,afterStop=async()=>{};const calls=[];
  const fetcher=async input=>{const url=new URL(input);calls.push(url.pathname);if(url.pathname==='/api/mods')return Response.json({results:[...mods.values()]});if(url.pathname.startsWith('/api/mods/')){const id=decodeURIComponent(url.pathname.split('/')[3]);return mods.has(id)?Response.json(mods.get(id)):new Response('',{status:404});}if(packages.has(url.pathname))return new Response(corrupt?Buffer.from('tampered'):packages.get(url.pathname));return new Response('',{status:404});};
  const ctx={config:{data,state},host:{info:async()=>({State:{Running:running},Image:'fixture-image',Config:{Image:'fixture:2.0.77'}})},docker:async()=>({Config:{Labels:{'factorio.version':'2.0.77'}}}),active:null,imageMigrationPending:false,updater:{busy:false}};
  const library=createFactorioModLibrary(ctx,{fetcher,start:async()=>{starts++;if(startError)throw Error('fixture startup failure');running=true;},stop:async()=>{stops++;running=false;await afterStop();}});
  const connect=()=>request(library,'/mod-library-account',{username:'fixture',token:'fixture_token_12345678901234567890'});
  return {root,data,state,library,ctx,release,mods,calls,connect,run:value=>running=value,corrupt:()=>corrupt=true,failStart:()=>startError=true,onStop:work=>afterStop=work,lifecycle:()=>({running,starts,stops})};
}
async function rust(t){
  const root=await temporary(t),game=path.join(root,'game'),state=path.join(root,'state');await fs.mkdir(path.join(game,'RustDedicated_Data/Managed'),{recursive:true});await fs.mkdir(state);await fs.mkdir(path.join(game,'server'),{recursive:true});await fs.writeFile(path.join(game,'server/world.sav'),'WORLD SENTINEL');
  let version='1.0.0',running=false,commands=[],starts=0,stops=0,failReload=false,externalEdit=false,afterStop=async()=>{};
  const source=()=>Buffer.from('[Info("Example", "Fixture", "'+version+'")]\nclass Example : RustPlugin {}');
  const metadata=()=>({name:'Example',slug:'example',title:'Example plugin',description:'Fixture plugin',author:'Fixture',distribution:'download',status_detail:{value:1},games_detail:[{slug:'rust'}],latest_release_version:version,latest_release_version_checksum:digest(source(),'sha1')});
  const archive=makeZip([{name:'RustDedicated_Data/Managed/Assembly-CSharp.dll',data:Buffer.from('patched fixture')},{name:'RustDedicated_Data/Managed/Oxide.Rust.dll',data:Buffer.from('framework fixture')}]);
  const fetcher=async input=>{const url=new URL(input);if(url.hostname==='api.github.com')return Response.json({tag_name:'fixture',assets:[{name:'Oxide.Rust-linux.zip',state:'uploaded',size:archive.length,digest:'sha256:'+digest(archive),browser_download_url:'https://github.com/OxideMod/Oxide.Rust/releases/download/fixture/Oxide.Rust-linux.zip'}]});if(url.hostname==='github.com')return new Response(archive);if(url.pathname==='/plugins/search.json')return Response.json({current_page:1,last_page:1,data:[metadata()]});if(url.pathname==='/plugins/example.json')return Response.json(metadata());if(url.pathname==='/plugins/Example.cs')return new Response(source());if(url.pathname==='/plugins/Example.json')return Response.json({branches:{master:{[version]:{checksum:digest(source(),'sha1'),requires:{}}}}});return new Response('',{status:404});};
  const command=async value=>{commands.push(value);if(externalEdit&&value.includes('reload')){await fs.writeFile(path.join(game,'oxide/plugins/Example.cs'),'OUTSIDE EDIT');throw Error('fixture reload failure');}if(failReload&&value.includes('reload'))throw Error('fixture reload failure');return 'Loaded';};
  const owned=async()=>({State:{Running:running}}),stopCheck=async()=>assert(!running,'Rust must be stopped');
  const mods=createModManager({root:game,state,assertStopped:stopCheck,command,fetcher});await mods.install((await mods.plan('oxide')).id);
  await fs.mkdir(path.join(game,'oxide/plugins'),{recursive:true});
  const ctx={config:{installRoot:game,state},active:null,updater:{busy:false},imageMigrationPending:false};
  const library=createRustModLibrary(ctx,{mods,owned,fetcher,command,ready:async()=>assert(running,'Rust is not ready'),start:async()=>{starts++;running=true;},stop:async()=>{stops++;running=false;await afterStop();}});
  return {root,game,state,library,ctx,fetcher,mods,commands,version:value=>version=value,run:value=>running=value,failReload:()=>failReload=true,editOnReload:()=>externalEdit=true,onStop:work=>afterStop=work,lifecycle:()=>({running,starts,stops})};
}
test('Factorio catalogue needs no upstream account, downloads need a private account, and review never mutates game files',async t=>{
  const f=await factorio(t),browse=await view(f.library,'browse');assert.equal(browse.items.length,2);assert.equal(browse.account.connected,false);
  await assert.rejects(f.library.plan({id:'example'}),/Connect a Factorio account/);await f.connect();
  const before=await fs.readdir(path.join(f.data,'mods')),plan=await f.library.plan({id:'example'});assert.equal(plan.releases.length,2);assert.deepEqual(await fs.readdir(path.join(f.data,'mods')),before);
  const response=JSON.stringify(await view(f.library,'installed'));assert(!response.includes('fixture_token'));assert(!response.includes('fixture"'));
  assert.equal((await fs.stat(path.join(f.state,'factorio-mod-account.json'))).mode&0o777,0o600);
  await f.library.install(plan.id);const installed=await view(f.library);assert.equal(installed.items.length,2);assert(installed.items.every(item=>item.enabled&&item.managed));assert.deepEqual(f.lifecycle(),{running:false,starts:0,stops:0});
  assert.equal(await fs.readFile(path.join(f.data,'saves/world.zip'),'utf8'),'WORLD SENTINEL');assert.equal(await fs.readFile(path.join(f.data,'mods/mod-settings.dat'),'utf8'),'SETTINGS SENTINEL');
});
test('Factorio Updates selects compatible releases, preserves settings, and only updates after confirmation',async t=>{
  const f=await factorio(t);await f.connect();await f.library.install((await f.library.plan({id:'example'})).id);f.release('example','1.1.0',['base >= 2.0.0','dependency >= 1.0.0']);
  const updates=await view(f.library,'updates',{refresh:'true'});assert.equal(updates.items[0].version,'1.1.0');assert.equal((await view(f.library)).items.find(item=>item.id==='example').version,'1.0.0');
  await f.library.install((await f.library.plan({id:'example'})).id);assert.equal((await view(f.library)).items.find(item=>item.id==='example').version,'1.1.0');assert(! (await fs.readdir(path.join(f.data,'mods'))).includes('example_1.0.0.zip'));
});
test('Factorio runtime mod views and plans use the installed receipt and invalidate reviews after a software change',async t=>{
  const f=await factorio(t),server=await f.ctx.host.info();f.ctx.host.info=async()=>({...server,Config:{Image:'ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1',Labels:{'io.lobby-goblin.software-delivery':'runtime'}}});f.ctx.docker=async()=>assert.fail('Runtime software versions must not come from image metadata');
  const file=path.join(f.data,'runtime/installed.json');await fs.mkdir(path.dirname(file));const receipt={version:1,provider:'factorio-headless',softwareVersion:'2.1.23',sha256:'a'.repeat(64)};await fs.writeFile(file,JSON.stringify(receipt));
  f.release('future','1.0.0',['base >= 2.1.0'],'2.1');f.release('future','2.0.0',['base >= 2.2.0'],'2.2');f.release('supported','1.0.0',['base >= 2.1.0'],'2.1');
  const browse=await view(f.library,'browse');assert.equal(browse.version,'2.1.23');assert.deepEqual(browse.items.map(item=>item.id),['supported']);
  await f.connect();const plan=await f.library.plan({id:'future'});assert.equal(plan.releases[0].version,'1.0.0');await f.library.install(plan.id);
  f.release('future','1.1.0',['base >= 2.1.0'],'2.1');assert.equal((await view(f.library,'updates',{refresh:'true'})).items[0].version,'1.1.0');assert.equal((await view(f.library,'installed')).version,'2.1.23');
  const stale=await f.library.plan({id:'future'});await fs.writeFile(file,JSON.stringify({...receipt,softwareVersion:'2.2.1',sha256:'b'.repeat(64)}));await assert.rejects(f.library.install(stale.id),/installation changed/);assert.equal((await view(f.library)).items[0].version,'1.0.0');assert.deepEqual(f.lifecycle(),{running:false,starts:0,stops:0});
});
test('Factorio runtime mod inventory refuses missing or invalid receipts instead of falling back to an image version',async t=>{
  const f=await factorio(t),server=await f.ctx.host.info();f.ctx.host.info=async()=>({...server,Config:{...server.Config,Labels:{'io.lobby-goblin.software-delivery':'runtime'}}});f.ctx.docker=async()=>assert.fail('Invalid runtime receipts must not fall back to image metadata');
  await assert.rejects(view(f.library),error=>error.status===409&&/runtime is not installed yet/.test(error.message));
  const file=path.join(f.data,'runtime/installed.json');await fs.mkdir(path.dirname(file));await fs.writeFile(file,JSON.stringify({version:1,provider:'factorio-headless',softwareVersion:'2.1.23',sha256:'invalid'}));await assert.rejects(view(f.library),/Invalid installed Factorio runtime receipt/);
  await assert.rejects(f.library.plan({id:'example'}),/Invalid installed Factorio runtime receipt/);assert.deepEqual(f.lifecycle(),{running:false,starts:0,stops:0});
});
test('bundled Factorio mod inventory retains the numeric image-tag fallback without reading runtime storage',async t=>{
  const f=await factorio(t);f.ctx.docker=async()=>({Config:{Labels:{}}});await fs.writeFile(path.join(f.data,'runtime'),'NOT RUNTIME STORAGE');assert.equal((await view(f.library)).version,'2.0.77');
});
test('Factorio refuses conflicts, disabling required dependencies, tampered packages, stale reviews and hot changes',async t=>{
  const f=await factorio(t);await f.connect();await assert.rejects(f.library.plan({id:'example',mode:'hot'}),/requires a restart/);
  await f.library.install((await f.library.plan({id:'example'})).id);await assert.rejects(f.library.plan({id:'dependency',operation:'disable'}),/requires dependency/);
  f.release('conflict','1.0.0',['base','! example']);await assert.rejects(f.library.plan({id:'conflict'}),/No compatible mod set/);
  const plan=await f.library.plan({id:'example',operation:'disable'});await fs.writeFile(path.join(f.data,'mods/mod-settings.dat'),'CHANGED');await assert.rejects(f.library.install(plan.id),/installation changed/);
  f.release('example','1.2.0');f.corrupt();await assert.rejects(f.library.plan({id:'example'}),/changed while being reviewed/);
});
test('Factorio stop/apply/start is opt-in and no lifecycle action happens during review',async t=>{
  const f=await factorio(t);await f.connect();f.run(true);await assert.rejects(f.library.plan({id:'example'}),/Stop Factorio/);
  const plan=await f.library.plan({id:'example',mode:'restart'});assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});await f.library.install(plan.id);assert.deepEqual(f.lifecycle(),{running:true,starts:1,stops:1});
});
test('automatic mode starts an already stopped server and reports startup failure separately from installed files',async t=>{
  const f=await factorio(t);await f.connect();f.failStart();const plan=await f.library.plan({id:'example',mode:'restart'});await assert.rejects(f.library.install(plan.id),/files were installed.*did not become ready/);assert.deepEqual(f.lifecycle(),{running:false,starts:1,stops:0});assert.equal((await view(f.library)).items.length,2);await f.library.assertReady();
});
test('expired reviews and modified staged bytes fail before automatic stop or game-file writes',async t=>{
  const f=await factorio(t);await f.connect();f.run(true);const expired=await f.library.plan({id:'example',mode:'restart'}),file=path.join(f.state,'mod-library/plan-'+expired.id+'/plan.json'),record=JSON.parse(await fs.readFile(file));record.created=0;await fs.writeFile(file,JSON.stringify(record));await assert.rejects(f.library.install(expired.id),/expired/);
  const changed=await f.library.plan({id:'example',mode:'restart'});await fs.writeFile(path.join(f.state,'mod-library/plan-'+changed.id+'/0'),'CHANGED CACHE');await assert.rejects(f.library.install(changed.id),/failed verification/);assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});assert.equal((await view(f.library)).items.length,0);
});
test('Rust supports Browse, tracked Updates, disabled plugin updates, and preserves plugin data/config',async t=>{
  const f=await rust(t);assert.equal((await view(f.library,'browse')).items[0].title,'Example plugin');await f.library.install((await f.library.plan({id:'example'})).id);
  await fs.mkdir(path.join(f.game,'oxide/config'),{recursive:true});await fs.writeFile(path.join(f.game,'oxide/config/Example.json'),'{"keep":true}');
  await f.library.install((await f.library.plan({id:'example',operation:'disable'})).id);f.version('1.1.0');assert.equal((await view(f.library,'updates',{refresh:'true'})).items[0].version,'1.1.0');await f.library.install((await f.library.plan({id:'example'})).id);
  const item=(await view(f.library)).items[0];assert.equal(item.version,'1.1.0');assert.equal(item.enabled,false);assert.equal(item.id,'example');assert.equal(await fs.readFile(path.join(f.game,'oxide/config/Example.json'),'utf8'),'{"keep":true}');assert.equal(await fs.readFile(path.join(f.game,'server/world.sav'),'utf8'),'WORLD SENTINEL');
});
test('Rust hot installation/reload is explicit, keeps the game online, and performs no stop/start',async t=>{
  const f=await rust(t);f.run(true);await assert.rejects(f.library.plan({id:'example'}),/Stop Rust/);await f.library.install((await f.library.plan({id:'example',mode:'hot'})).id);assert.deepEqual(f.commands,['oxide.load Example']);f.version('1.1.0');await f.library.install((await f.library.plan({id:'example',mode:'hot'})).id);assert.deepEqual(f.commands,['oxide.load Example','oxide.reload Example']);assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});
});
test('managed Rust advertises stop/restart plugin changes and refuses hot writes before download or lifecycle changes',async t=>{
  const f=await rust(t);f.ctx.config.softwareManaged=true;f.run(true);
  assert.equal((await view(f.library)).hotAvailable,false);
  await assert.rejects(f.library.plan({id:'example',mode:'hot'}),/stopped Rust or automatic stop\/start/);
  assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});
  assert.deepEqual(f.commands,[]);
});
test('Carbon adapter hot changes use its own plugin directory and command namespace',async t=>{
  const f=await rust(t),commands=[],mods={...f.mods,status:async()=>({available:true,framework:'carbon',version:'fixture'})},library=createRustModLibrary(f.ctx,{mods,owned:async()=>({State:{Running:true}}),fetcher:f.fetcher,ready:async()=>{},start:async()=>assert.fail('Hot apply must not start Rust'),stop:async()=>assert.fail('Hot apply must not stop Rust'),command:async value=>{commands.push(value);return 'Loaded';}});
  await fs.mkdir(path.join(f.game,'carbon/plugins'),{recursive:true});await library.install((await library.plan({id:'example',mode:'hot'})).id);assert.deepEqual(commands,['c.load Example']);assert.match(await fs.readFile(path.join(f.game,'carbon/plugins/Example.cs'),'utf8'),/RustPlugin/);
  await library.install((await library.plan({id:'example',operation:'disable',mode:'hot'})).id);assert.deepEqual(commands,['c.load Example','c.unload Example']);assert.equal((await view(library)).items[0].enabled,false);
});
test('hot updates refuse private file permissions and default plugin writes stay game-readable despite a private umask',async t=>{
  const f=await rust(t);await f.library.install((await f.library.plan({id:'example'})).id);const file=path.join(f.game,'oxide/plugins/Example.cs');await fs.chmod(file,0o600);f.run(true);f.version('1.1.0');await assert.rejects(f.library.plan({id:'example',mode:'hot'}),/Private plugin file permissions/);assert.equal(f.commands.length,0);
  const root=await temporary(t),store=createModStore(path.join(root,'plugins')),old=process.umask(0o077);try{await store.write('Readable.cs',Buffer.from('source'));}finally{process.umask(old);}assert.equal((await fs.stat(path.join(root,'plugins/Readable.cs'))).mode&0o777,0o644);assert.equal((await fs.stat(path.join(root,'plugins'))).mode&0o777,0o755);
});
test('Rust optional restart saves/stops through its adapter and starts only after applying files',async t=>{
  const f=await rust(t);f.run(true);const plan=await f.library.plan({id:'example',mode:'restart'});assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});await f.library.install(plan.id);assert.deepEqual(f.lifecycle(),{running:true,starts:1,stops:1});
});
test('local plugin edits are visible and block stale reviews instead of overwriting changed files',async t=>{
  const f=await rust(t);await f.library.install((await f.library.plan({id:'example'})).id);f.version('1.1.0');const plan=await f.library.plan({id:'example'});await fs.writeFile(path.join(f.game,'oxide/plugins/Example.cs'),'manual edit');await assert.rejects(f.library.install(plan.id),/installation changed/);assert.equal((await view(f.library)).items[0].modified,true);assert.equal((await view(f.library,'updates',{refresh:'true'})).items.length,0);
});
test('interrupted hot changes retain a recovery gate and restore previous plugin bytes with the game stopped',async t=>{
  const f=await rust(t);await f.library.install((await f.library.plan({id:'example'})).id);const previous=await fs.readFile(path.join(f.game,'oxide/plugins/Example.cs'));f.run(true);f.version('1.1.0');const plan=await f.library.plan({id:'example',mode:'hot'});f.failReload();await assert.rejects(f.library.install(plan.id),/interrupted/);await assert.rejects(f.library.assertReady(),/needs recovery/);f.run(false);await f.library.recover();await f.library.assertReady();assert.deepEqual(await fs.readFile(path.join(f.game,'oxide/plugins/Example.cs')),previous);
});
test('rollback preserves outside edits and explicit recovery keeps a private copy before restoring',async t=>{
  const f=await rust(t);await f.library.install((await f.library.plan({id:'example'})).id);const source=path.join(f.game,'oxide/plugins/Example.cs'),previous=await fs.readFile(source);f.run(true);f.version('1.1.0');const plan=await f.library.plan({id:'example',mode:'hot'});f.editOnReload();
  await assert.rejects(f.library.install(plan.id),/interrupted/);assert.equal(await fs.readFile(source,'utf8'),'OUTSIDE EDIT');f.run(false);await f.library.recover();assert.deepEqual(await fs.readFile(source),previous);
  const files=await archiveInventory(path.join(f.state,'mods'),{requireSave:false,prefix:'mod-state/'}),copy=files.find(file=>file.name.includes('/external-'));assert(copy,'Recovery must retain the outside edit');assert.equal(await fs.readFile(path.join(f.state,'mods',copy.name),'utf8'),'OUTSIDE EDIT');
  assert(files.some(file=>file.name==='mod-library/installed.json'),'Complete mod backups must include library matching metadata');assert((await f.mods.backupRoots()).some(value=>value.prefix==='mod-state'&&value.root===path.join(f.state,'mods')));
});
test('Rust refuses duplicate enabled/disabled sources instead of overwriting either copy',async t=>{
  const f=await rust(t);await f.library.install((await f.library.plan({id:'example'})).id);const file=path.join(f.game,'oxide/plugins/Example.cs');await fs.writeFile(file+'.disabled','KEEP DISABLED COPY');await assert.rejects(f.library.plan({id:'example',operation:'disable'}),/Both enabled and disabled/);assert.equal(await fs.readFile(file+'.disabled','utf8'),'KEEP DISABLED COPY');
});
test('downloads restrict redirect hosts, bound response bytes, cache metadata and never include account secrets in errors',async()=>{
  const downloads=createModDownloads(async()=>new Response('',{status:302,headers:{location:'https://untrusted.invalid/plugin.cs'}}));await assert.rejects(downloads.bytes('https://umod.org/plugins/Example.cs',{hosts:['umod.org']}),/Unexpected mod download/);
  const huge=createModDownloads(async()=>new Response('12345'));await assert.rejects(huge.bytes('https://umod.org/file',{hosts:['umod.org'],limit:4}),/size limit/);
  const failure=createModDownloads(async()=>{throw Error('https://mods.factorio.com/?token=secret');});await assert.rejects(failure.bytes('https://mods.factorio.com/download?token=secret',{hosts:['mods.factorio.com'],secret:true}),error=>!error.message.includes('secret')&&error.cause===undefined);
  const streamFailure=createModDownloads(async()=>new Response(new ReadableStream({start(controller){controller.error(Error('token=secret'));}})));await assert.rejects(streamFailure.bytes('https://mods.factorio.com/download?token=secret',{hosts:['mods.factorio.com'],secret:true}),error=>!error.message.includes('secret')&&error.cause===undefined);
  let now=0,available=true,count=0;const cached=createModDownloads(async()=>{count++;if(!available)throw Error('offline');return Response.json({value:42});},{now:()=>now});const options={hosts:['umod.org']};await cached.json('https://umod.org/catalogue',options);await cached.json('https://umod.org/catalogue',options);assert.equal(count,1);available=false;now=300001;assert.equal((await cached.json('https://umod.org/catalogue',options)).stale,true);await assert.rejects(cached.json('https://umod.org/catalogue',{...options,refresh:true}),/unavailable/);now=86400001;await assert.rejects(cached.json('https://umod.org/catalogue',options),/unavailable/);
});
test('mod stores refuse linked roots and linked files; library jobs require reviewed confirmation',async t=>{
  const root=await temporary(t),outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(root,'linked'));await assert.rejects(createModStore(path.join(root,'linked')).write('Example.cs',Buffer.from('source')),/symbolic links/);await fs.writeFile(path.join(outside,'file'),'sentinel');await fs.symlink(path.join(outside,'file'),path.join(root,'Example.cs'));await assert.rejects(createModStore(root).write('Example.cs',Buffer.from('source')),/regular files/);assert.equal(await fs.readFile(path.join(outside,'file'),'utf8'),'sentinel');
  for(const action of ['mod-library-install','mod-library-recover'])assert.throws(()=>validateLibraryAction(action,{}),/confirm|Confirm/);
});
test('both real web modules restrict library reads, reviews and account changes to administrators with CSRF',async t=>{
  const root=await temporary(t),users={admin:{...hashPassword('fixture-admin-password'),role:'admin'},viewer:{...hashPassword('fixture-viewer-password'),role:'viewer'}};await fs.writeFile(path.join(root,'users.json'),JSON.stringify(users));
  let proxied=0;const controller=http.createServer((req,res)=>{proxied++;assert.equal(req.headers.authorization,'Bearer fixture-token');res.writeHead(200,{'content-type':'application/json'});res.end('{}');});await new Promise(resolve=>controller.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{controller.closeAllConnections();controller.close(resolve);}));
  for(const module of [factorioModule,rustModule]){
    const web=await startWeb(module,{env:{AUTH_DIR:root,CONTROLLER_URL:'http://127.0.0.1:'+controller.address().port,RELEASE_CHECKS:'false',PANEL_HOSTS:'127.0.0.1'},controllerToken:'fixture-token',port:0,hostname:'127.0.0.1'});t.after(()=>new Promise(resolve=>{web.closeAllConnections();web.close(resolve);}));const origin='http://127.0.0.1:'+web.address().port;
    const login=async username=>{const response=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password:'fixture-'+username+'-password'})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],...await response.json()};};
    const admin=await login('admin'),viewer=await login('viewer'),before=proxied;
    assert.equal((await fetch(origin+'/api/mod-library')).status,401);assert.equal((await fetch(origin+'/api/mod-library',{headers:{cookie:viewer.cookie}})).status,403);
    for(const route of ['/api/mod-library-plan','/api/mod-library-account','/api/jobs'])for(const [user,csrf]of [[viewer,true],[admin,false]])assert.equal((await fetch(origin+route,{method:'POST',headers:{origin,cookie:user.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':user.csrf}:{})},body:'{}'})).status,403);
    assert.equal(proxied,before,'Unauthorized requests must not reach the controller');
    assert.equal((await fetch(origin+'/api/mod-library',{headers:{cookie:admin.cookie}})).status,200);assert.equal((await fetch(origin+'/api/mod-library-plan',{method:'POST',headers:{origin,cookie:admin.cookie,'x-csrf-token':admin.csrf,'content-type':'application/json'},body:'{}'})).status,200);
  }
});

for(const [game,fixture] of [['Factorio',factorio],['Rust',rust]]){
 test(game+' resumes a server it stopped when recovery-copy setup fails before mod writes',async t=>{
  const f=await fixture(t);if(f.connect)await f.connect();f.run(true);
  const storage=path.join(f.state,game==='Rust'?'mods/mod-library':'mod-library'),plan=await f.library.plan({id:'example',mode:'restart'});
  await fs.writeFile(path.join(storage,'history'),'BLOCK HISTORY CREATION');
  await assert.rejects(f.library.install(plan.id),/Mod directories/);
  assert.deepEqual(f.lifecycle(),{running:true,starts:1,stops:1});assert.equal((await view(f.library)).items.length,0);await f.library.assertReady();
  assert.equal(await fs.readFile(game==='Rust'?path.join(f.game,'server/world.sav'):path.join(f.data,'saves/world.zip'),'utf8'),'WORLD SENTINEL');
 });
 test(game+' leaves an already stopped server stopped when pre-transaction setup fails',async t=>{
  const f=await fixture(t);if(f.connect)await f.connect();
  const storage=path.join(f.state,game==='Rust'?'mods/mod-library':'mod-library'),plan=await f.library.plan({id:'example',mode:'restart'});
  await fs.writeFile(path.join(storage,'history'),'BLOCK HISTORY CREATION');
  await assert.rejects(f.library.install(plan.id),/Mod directories/);assert.deepEqual(f.lifecycle(),{running:false,starts:0,stops:0});
 });
 test(game+' resumes after a post-stop revision mismatch without replacing outside edits',async t=>{
  const f=await fixture(t);if(f.connect)await f.connect();f.run(true);
  const plan=await f.library.plan({id:'example',mode:'restart'}),changed=game==='Rust'?path.join(f.game,'oxide/plugins/Outside.cs'):path.join(f.data,'mods/mod-settings.dat');
  f.onStop(()=>fs.writeFile(changed,'OUTSIDE EDIT'));
  await assert.rejects(f.library.install(plan.id),/Mod files changed after review/);assert.deepEqual(f.lifecycle(),{running:true,starts:1,stops:1});
  assert.equal(await fs.readFile(changed,'utf8'),'OUTSIDE EDIT');await f.library.assertReady();
 });
}
test('a failed restart after pre-transaction failure reports the stopped state and preserves the original failure',async t=>{
 const f=await factorio(t);await f.connect();f.run(true);f.failStart();
 const plan=await f.library.plan({id:'example',mode:'restart'});await fs.writeFile(path.join(f.state,'mod-library/history'),'BLOCK HISTORY CREATION');
 await assert.rejects(f.library.install(plan.id),error=>/before applying.*files.*could not be restarted/i.test(error.message)&&/Mod directories/.test(error.cause?.message));
 assert.deepEqual(f.lifecycle(),{running:false,starts:1,stops:1});await f.library.assertReady();
});

test('pre-transaction cleanup never bypasses an existing recovery gate to restart the game',async t=>{
 const f=await factorio(t);await f.connect();f.run(true);
 const storage=path.join(f.state,'mod-library'),plan=await f.library.plan({id:'example',mode:'restart'});
 f.onStop(async()=>{await fs.writeFile(path.join(storage,'history'),'BLOCK HISTORY CREATION');await fs.writeFile(path.join(storage,'transaction.json'),JSON.stringify({phase:'applying'}));});
 await assert.rejects(f.library.install(plan.id),/could not be restarted/);assert.deepEqual(f.lifecycle(),{running:false,starts:0,stops:1});await assert.rejects(f.library.assertReady(),/needs recovery/);
});
test('a Rust hot-apply preparation failure leaves the server online without a lifecycle action',async t=>{
 const f=await rust(t);f.run(true);const plan=await f.library.plan({id:'example',mode:'hot'});await fs.writeFile(path.join(f.state,'mods/mod-library/history'),'BLOCK HISTORY CREATION');
 await assert.rejects(f.library.install(plan.id),/Mod directories/);assert.deepEqual(f.lifecycle(),{running:true,starts:0,stops:0});assert.equal((await view(f.library)).items.length,0);assert.deepEqual(f.commands,[]);
});
