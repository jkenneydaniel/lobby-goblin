// Exploratory native acceptance. Only GitHub-hosted disposable runners may run
// it. Creates its own worlds and engine; never reads installation paths/Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {headlessChecksums,headlessVersion} from '../applications/factorio/headless-releases.js';

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
  'local s=game.surfaces.nauvis; s.request_to_generate_chunks({0,0},2); s.force_generate_chunk_requests(); game.forces.player.chart_all(s)',
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
 // Warm only this newly generated fixture, chart it, pause it and save a
 // baseline. This distinguishes a real saved chart from --create's queued chart.
 const defaults=JSON.parse(await fs.readFile(path.join(root,'factorio/data/server-settings.example.json'),'utf8'));
 const serverSettings=path.join(source,'server-settings.json');await fs.writeFile(serverSettings,JSON.stringify({...defaults,name:'Disposable offline probe',visibility:{public:false,lan:false},auto_pause:false,require_user_verification:false,autosave_interval:0}));
 const child=spawn(executable,['--config',await config(source),'--start-server',save,'--bind','127.0.0.1','--port','0','--mod-directory',mods,'--server-settings',serverSettings],{cwd:root,stdio:['pipe','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});const closed=new Promise(resolve=>child.once('close',resolve));
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(predicate){for(let i=0;i<300;i++){if(await predicate())return;assert.equal(child.exitCode,null,logs);await wait(100);}throw Error('Disposable fixture preparation timed out: '+logs);}
 try{
  await until(()=>/Hosting game at|changing state from\(CreatingGame\) to\(InGame\)/.test(logs));
  child.stdin.write('/silent-command game.forces.player.chart_all(game.surfaces.nauvis)\n/silent-command game.forces.player.chart_all(game.surfaces.nauvis)\n');await wait(1000);
  child.stdin.write('/silent-command game.tick_paused=true;local n=0;for c in game.surfaces.nauvis.get_chunks()do if game.forces.player.is_chunk_charted(game.surfaces.nauvis,c)then n=n+1 end end;helpers.write_file("baseline.json",helpers.table_to_json({tick=game.tick,charted=n,state=remote.call("goblin-offline-fixture","state")}))\n/server-save offline-ready\n');
  await until(()=>fs.stat(path.join(source,'saves/offline-ready.zip')).then(()=>true).catch(()=>false));
  child.kill('SIGTERM');await closed;
 }finally{if(child.exitCode===null){child.kill('SIGKILL');await closed;}await fs.writeFile(path.join(output,version+'.fixture.log'),logs);}
 const prepared=path.join(source,'saves/offline-ready.zip');results.baseline=JSON.parse(await fs.readFile(path.join(source,'script-output/baseline.json'),'utf8'));assert.ok(results.baseline.charted>0);
 const before=hash(await fs.readFile(prepared));results.sourceHash=before;
 const instrument=[
  'log("GOBLIN_INSTRUMENT_STATE="..script.mod_name)',
  'local done=false',
  'local function export()',
  'if done then return end;done=true',
  'local s=game.surfaces.nauvis; local n=0;for c in s.get_chunks() do if game.forces.player.is_chunk_charted(s,c) then n=n+1 end end',
  'local result={mod=script.mod_name,tick=game.tick,charted=n,state=remote.call("goblin-offline-fixture","state"),activeMods=script.active_mods,furnaces=s.count_entities_filtered{name="stone-furnace"}}',
  'helpers.write_file("probe-"..script.mod_name..".json",helpers.table_to_json(result));log("GOBLIN_OFFLINE_PROBE_OK="..script.mod_name)',
  'end',
  'script.on_event(defines.events.on_tick,export)',
  'script.on_nth_tick(1,export)',
 ].join('\n');
 for(const enabled of [false,true,'base']){
  const folder=path.join(root,String(enabled)),copy=path.join(folder,'mods');await fs.mkdir(folder);await fs.cp(mods,copy,{recursive:true});
  const probe=path.join(copy,'goblin-offline-probe_1.0.0');await fs.mkdir(probe);
  await fs.writeFile(path.join(probe,'info.json'),JSON.stringify({name:'goblin-offline-probe',version:'1.0.0',title:'Offline export probe',author:'Lobby Goblin',factorio_version:version.split('.').slice(0,2).join('.'),dependencies:['base']}));
  await fs.writeFile(path.join(probe,'instrument-control.lua'),instrument);await fs.writeFile(path.join(probe,'control.lua'),'');
  await fs.writeFile(path.join(copy,'mod-list.json'),JSON.stringify({mods:[...selection.mods,{name:'goblin-offline-probe',enabled:enabled===true}]}));
  if(enabled==='base')await fs.writeFile(path.join(root,'factorio/data/base/instrument-control.lua'),instrument);
  const copied=path.join(folder,'source.zip');await fs.copyFile(prepared,copied);
  const args=['--config',await config(folder),'--mod-directory',copy,'--instrument-mod',enabled==='base'?'base':'goblin-offline-probe','--benchmark',copied,'--benchmark-ticks','1','--benchmark-runs','1'];
  const start=Date.now(),ran=command(executable,args);await fs.writeFile(path.join(output,version+'.'+enabled+'.log'),ran.stdout+ran.stderr);
  const reports=[];for(const name of await fs.readdir(path.join(folder,'script-output')).catch(()=>[]))if(name.startsWith('probe-'))reports.push(JSON.parse(await fs.readFile(path.join(folder,'script-output',name),'utf8')));
  results.cases.push({enabled,status:ran.status,error:ran.error,elapsedMs:Date.now()-start,reports});
  assert.equal(hash(await fs.readFile(prepared)),before);assert.equal(hash(await fs.readFile(copied)),before);
 }
 results.sourceUnchanged=true;
}catch(error){results.error=error.message;process.exitCode=1;}
finally{await fs.writeFile(path.join(output,version+'.json'),JSON.stringify(results,null,2)+'\n');await fs.rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(results));
