// Native acceptance. Only GitHub-hosted disposable runners may run
// it. Creates its own worlds and engine; never reads installation paths/Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {headlessChecksums,headlessVersion} from '../applications/factorio/headless-releases.js';
import {offlineMapScript,validateMapCompletion} from '../applications/factorio/map-offline.js';
import {validateMap} from '../applications/factorio/map-export.js';
import {makeZip,zipEntries} from '../core/archive.js';

assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.platform,'linux');
assert.equal(process.env.FACTORIO_OFFLINE_DISPOSABLE,'true');
const version=process.env.PROBE_FACTORIO_VERSION;
assert.ok(headlessVersion(version));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-offline-probe-'));
const output=path.resolve(process.env.PROBE_OUTPUT||'output/offline-probe');
await fs.mkdir(output,{recursive:true});
const results={version,disposable:true,cases:[]};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const init=await fs.readFile(new URL('../map-init.lua',import.meta.url),'utf8'),batch=await fs.readFile(new URL('../map-batch.lua',import.meta.url),'utf8');
// Playerless headless fixture worlds retain chart requests without completing
// them. An explicit local force adapter supplies a known explored region for
// native geometry tests; production never supplies this adapter.
const fixtureInit=init.replace('local f=game.forces.player','local real_force=game.forces.player;local f=setmetatable({is_chunk_charted=function(_,c)local x=c.x or c[1];local y=c.y or c[2];return x>=0 and x<2 and y>=0 and y<2 end},{__index=function(_,key)return real_force[key]end})');
const baselineExport=['local storage={};local rcon={print=function()end}',fixtureInit,'for map_start=1,#storage.panel_map.queue,16 do',batch.replaceAll('MAP_START','map_start'),'end','helpers.write_file("baseline-map.json",helpers.table_to_json(storage.panel_map.output))'].join(' ').replace(/\s+/g,' ');
const command=(program,args,options={})=>{
 const result=spawnSync(program,args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024**2,cwd:root,...options});
 return {status:result.status,error:result.error?.message,stdout:result.stdout||'',stderr:result.stderr||''};
};
try{
 const checksums=await headlessChecksums(),expected=checksums.get(version);
 assert.ok(expected,'Choose an official headless release with a verified checksum');
 const response=await fetch('https://factorio.com/get-download/'+version+'/headless/linux64',{signal:AbortSignal.timeout(120000)});
 assert.equal(response.status,200);
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=512*1024**2);chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);assert.equal(hash(bytes),expected);
 const archive=path.join(root,'engine.tar.xz');await fs.writeFile(archive,bytes);
 const extracted=command('tar',['-xJf',archive,'-C',root]);assert.equal(extracted.status,0,extracted.stderr);
 const executable=path.join(root,'factorio/bin/x64/factorio');
 const help=command(executable,['--help']);await fs.writeFile(path.join(output,version+'.help.txt'),help.stdout+help.stderr);
 results.supportsTestSave=help.stdout.includes('--test-save');
 const source=path.join(root,'source'),mods=path.join(source,'mods');await fs.mkdir(mods,{recursive:true});
 const fixture=path.join(mods,'goblin-offline-fixture_1.0.0');await fs.mkdir(fixture);
 await fs.writeFile(path.join(fixture,'info.json'),JSON.stringify({name:'goblin-offline-fixture',version:'1.0.0',title:'Disposable fixture',author:'Lobby Goblin',factorio_version:version.split('.').slice(0,2).join('.'),dependencies:['base']}));
 await fs.writeFile(path.join(fixture,'control.lua'),[
  'script.on_init(function()',
  'local s=game.surfaces.nauvis; s.request_to_generate_chunks({0,0},2); s.force_generate_chunk_requests()',
  'storage.sentinel=123; storage.configurationChanges=0; storage.updates=0',
  's.create_entity{name="stone-furnace",position={8,8},force="player"}',
  'end)',
  'script.on_configuration_changed(function() storage.configurationChanges=(storage.configurationChanges or 0)+1 end)',
  'script.on_event(defines.events.on_tick,function() storage.updates=(storage.updates or 0)+1 end)',
  'remote.add_interface("goblin-offline-fixture",{state=function()return {sentinel=storage.sentinel,configurationChanges=storage.configurationChanges,updates=storage.updates}end})',
 ].join('\n'));
 const selection={mods:[{name:'base',enabled:true},...['space-age','quality','elevated-rails','recycler'].map(name=>({name,enabled:false})),{name:'goblin-offline-fixture',enabled:true}]};
 await fs.writeFile(path.join(mods,'mod-list.json'),JSON.stringify(selection));
 const settings=path.join(root,'settings.json');await fs.writeFile(settings,JSON.stringify({seed:12345,width:128,height:128}));
 async function config(folder){await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'config.ini');await fs.writeFile(file,'[path]\nread-data='+path.join(root,'factorio/data')+'\nwrite-data='+folder+'\n');return file;}
 const save=path.join(source,'source.zip'),created=command(executable,['--config',await config(source),'--create',save,'--map-gen-settings',settings,'--mod-directory',mods]);
 await fs.writeFile(path.join(output,version+'.create.log'),created.stdout+created.stderr);assert.equal(created.status,0,created.stdout+created.stderr);
 // Warm only this newly generated fixture, request charting, pause it and save
 // a baseline. A playerless force keeps chart requests pending; see fixtureInit.
 const defaults=JSON.parse(await fs.readFile(path.join(root,'factorio/data/server-settings.example.json'),'utf8'));
 await fs.mkdir(path.join(source,'saves'));
 const serverSettings=path.join(source,'server-settings.json');await fs.writeFile(serverSettings,JSON.stringify({...defaults,name:'Disposable offline probe',visibility:{public:false,lan:false},auto_pause:false,require_user_verification:false,autosave_interval:0}));
 const child=spawn(executable,['--config',await config(source),'--start-server',save,'--bind','127.0.0.1','--port','0','--mod-directory',mods,'--server-settings',serverSettings],{cwd:root,stdio:['pipe','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});const closed=new Promise(resolve=>child.once('close',resolve));
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(predicate){for(let i=0;i<300;i++){if(await predicate())return;assert.equal(child.exitCode,null,logs);await wait(100);}throw Error('Disposable fixture preparation timed out: '+logs);}
 try{
  await until(()=>/Hosting game at|changing state from\(CreatingGame\) to\(InGame\)/.test(logs));
  const chart='/silent-command local s=game.surfaces.nauvis;s.request_to_generate_chunks({0,0},2);s.force_generate_chunk_requests();game.forces.player.cancel_charting(s);game.forces.player.chart(s,{{0,0},{32,32}});log("GOBLIN_CHART_REQUESTED")\n';
  child.stdin.write(chart);await wait(200);child.stdin.write(chart);await until(()=>logs.includes('GOBLIN_CHART_REQUESTED'));await wait(5000);
  child.stdin.write('/silent-command game.forces.player.rechart(game.surfaces.nauvis);game.tick_paused=true;local n=0;local total=0;local sample={};for c in game.surfaces.nauvis.get_chunks()do total=total+1;if #sample<3 then sample[#sample+1]=c end;if game.forces.player.is_chunk_charted(game.surfaces.nauvis,c)then n=n+1 end end;helpers.write_file("baseline.json",helpers.table_to_json({tick=game.tick,charted=n,generated=total,sample=sample,originCharted=game.forces.player.is_chunk_charted(game.surfaces.nauvis,{0,0}),namedOriginCharted=game.forces.player.is_chunk_charted(game.surfaces.nauvis,{x=0,y=0}),requested=game.forces.player.is_chunk_requested_for_charting(game.surfaces.nauvis,{0,0}),state=remote.call("goblin-offline-fixture","state")}))\n/server-save offline-ready\n');
  await until(()=>fs.stat(path.join(source,'saves/offline-ready.zip')).then(()=>true).catch(()=>false));
  child.stdin.write('/silent-command '+baselineExport+'\n');await until(()=>fs.stat(path.join(source,'script-output/baseline-map.json')).then(()=>true).catch(()=>false));
  child.kill('SIGTERM');await closed;
 }finally{if(child.exitCode===null){child.kill('SIGKILL');await closed;}await fs.writeFile(path.join(output,version+'.fixture.log'),logs);}
 const prepared=path.join(source,'saves/offline-ready.zip');results.baseline=JSON.parse(await fs.readFile(path.join(source,'script-output/baseline.json'),'utf8'));
 const before=hash(await fs.readFile(prepared));results.sourceHash=before;
 const normalize=value=>{for(const key of ['chunks','palette','entities','players','tags'])if(value[key]&&!Array.isArray(value[key])&&Object.keys(value[key]).length===0)value[key]=[];return validateMap(value);};
 const baselineMap=normalize(JSON.parse(await fs.readFile(path.join(source,'script-output/baseline-map.json'),'utf8')));assert.equal(baselineMap.chunks.length,4);assert.ok(baselineMap.entities.some(e=>e.name==='stone-furnace'));
 for(const mode of ['production','geometry','scenario','partial-failure']){
  const folder=path.join(root,mode),copy=path.join(folder,'mods');await fs.mkdir(folder);await fs.cp(mods,copy,{recursive:true});
  const job='12345678-1234-1234-1234-123456789abc';
  const initialization='helpers.write_file("state-before.json",helpers.table_to_json({tick=game.tick,state=remote.call("goblin-offline-fixture","state")}))\n'+(mode==='production'?init:fixtureInit);
  const collection=mode==='partial-failure'?batch+'\nhelpers.write_file("panel-map.json",helpers.table_to_json(storage.panel_map.output));error("Expected disposable partial-export failure")':batch;
  await fs.writeFile(path.join(root,'factorio/data/base/instrument-control.lua'),offlineMapScript(job,{initialization,collection}));
  const copied=path.join(folder,'source.zip');await fs.copyFile(prepared,copied);
  if(mode==='scenario'){
   const entries=zipEntries(await fs.readFile(copied)),control=entries.find(entry=>entry.name.endsWith('/control.lua'));assert.ok(control);
   const override='\nscript.on_load(function()script.on_event(defines.events.on_tick,function()for _,e in pairs(game.surfaces.nauvis.find_entities_filtered{name="stone-furnace"})do e.destroy()end end)end)\n';
   await fs.writeFile(copied,makeZip(entries.map(entry=>({name:entry.name,data:entry.name===control.name?Buffer.from(entry.read().toString()+override):entry.read()}))));
  }
  const copiedHash=hash(await fs.readFile(copied));
  const args=['--config',await config(folder),'--mod-directory',copy,'--instrument-mod','base','--enable-unsafe-lua-debug-api','--benchmark',copied,'--benchmark-ticks','1','--benchmark-runs','1'];
  const start=Date.now(),ran=command(executable,args);await fs.writeFile(path.join(output,version+'.'+mode+'.log'),ran.stdout+ran.stderr);
  if(mode==='partial-failure'){
   assert.notEqual(ran.status,0);assert.equal(await fs.stat(path.join(folder,'script-output/panel-map.complete.json')).then(()=>true).catch(()=>false),false);
   results.cases.push({mode,failedClosed:true});
  }else{
   assert.equal(ran.status,0,ran.stdout+ran.stderr);const value=normalize(JSON.parse(await fs.readFile(path.join(folder,'script-output/panel-map.json'),'utf8'))),receipt=JSON.parse(await fs.readFile(path.join(folder,'script-output/panel-map.complete.json'),'utf8'));
   validateMapCompletion(receipt,value,job);assert.equal(receipt.engine,version);
   const beforeState=JSON.parse(await fs.readFile(path.join(folder,'script-output/state-before.json'),'utf8'));assert.equal(beforeState.tick,results.baseline.tick);assert.deepEqual(beforeState.state,results.baseline.state);
   if(mode!=='production')assert.deepEqual(value,baselineMap);else assert.equal(value.chunks.length,results.baseline.charted);
   results.cases.push({mode,nativeMapValidated:true,preUpdateStateMatches:true,chunks:value.chunks.length,entities:value.entities.length,geometryParity:mode!=='production',elapsedMs:Date.now()-start});
  }
  assert.equal(hash(await fs.readFile(prepared)),before);assert.equal(hash(await fs.readFile(copied)),copiedHash);
 }
 results.sourceUnchanged=true;
}catch(error){results.error=error.message;process.exitCode=1;}
finally{await fs.writeFile(path.join(output,version+'.json'),JSON.stringify(results,null,2)+'\n');await fs.rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(results));
