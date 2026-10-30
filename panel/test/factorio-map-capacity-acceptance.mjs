// Fresh GitHub-hosted runner only. Every engine, container and save belongs to
// this fixture. No installation configuration, existing volume or world is read.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {headlessChecksums,headlessVersion} from '../applications/factorio/headless-releases.js';
import {prepareOfflineMap,offlineMapScript,validateMapCompletion} from '../applications/factorio/map-offline.js';
import {validateMap} from '../applications/factorio/map-export.js';
import {encodeMapPayload,readMapPayload} from '../applications/factorio/public/map-payload.js';
import {mapObjectLimit,mapChunkLimit,mapExportByteLimit} from '../applications/factorio/public/map-limits.js';
import {gzipSync} from 'node:zlib';

assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'linux');assert.equal(process.env.FACTORIO_OFFLINE_DISPOSABLE,'true');
const version=process.env.PROBE_FACTORIO_VERSION;assert.ok(headlessVersion(version));
const execute=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-map-capacity-')),id=crypto.randomUUID(),name='goblin-capacity-'+id,containers=[];
const run=async args=>(await execute('docker',args,{timeout:300000,maxBuffer:4*1024**2})).stdout.trim();
const image='ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1',report={version,disposable:true,requested:{objects:mapObjectLimit,chunks:mapChunkLimit},cases:[]};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
try{
 const expected=(await headlessChecksums()).get(version);assert.ok(expected);
 const response=await fetch('https://factorio.com/get-download/'+version+'/headless/linux64',{signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;assert.ok(size<=512*1024**2);parts.push(part);}
 const archive=Buffer.concat(parts);assert.equal(hash(archive),expected);await fs.writeFile(path.join(root,'engine.tar.xz'),archive);
 await execute('tar',['-xJf',path.join(root,'engine.tar.xz'),'-C',root],{timeout:120000});await fs.rename(path.join(root,'factorio'),path.join(root,'engine'));
 for(const dir of ['saves','mods','map-export'])await fs.mkdir(path.join(root,dir));
 const mod='goblin-capacity-fixture',folder=path.join(root,'mods',mod+'_1.0.0');await fs.mkdir(folder);
 await fs.writeFile(path.join(folder,'info.json'),JSON.stringify({name:mod,title:'Disposable capacity fixture',version:'1.0.0',author:'Lobby Goblin',factorio_version:version.split('.').slice(0,2).join('.'),dependencies:['base']}));
 await fs.writeFile(path.join(folder,'control.lua'),[
 'script.on_init(function()',
 'local s=game.surfaces.nauvis;s.request_to_generate_chunks({0,0},32);s.force_generate_chunk_requests()',
 'for i=0,'+mapObjectLimit+' do',
 'local chunk=i%4096;local slot=math.floor(i/4096);local x=(chunk%64-32)*32+1+(slot%8)*4;local y=(math.floor(chunk/64)-32)*32+1+math.floor(slot/8)*4',
 'local resource=i%5==0;assert(s.create_entity{name=resource and "iron-ore" or "wooden-chest",position={x,y},force=resource and "neutral" or "player",amount=1000+i})',
 'end',
 'storage.sentinel=123;storage.updates=0;storage.configurationChanges=0',
 'end)',
 'script.on_configuration_changed(function()storage.configurationChanges=storage.configurationChanges+1 end)',
 'script.on_event(defines.events.on_tick,function()storage.updates=storage.updates+1 end)',
 'remote.add_interface("goblin-capacity-fixture",{state=function()return {sentinel=storage.sentinel,updates=storage.updates,configurationChanges=storage.configurationChanges}end})',
 ].join('\n'));
 await fs.writeFile(path.join(root,'mods/mod-list.json'),JSON.stringify({mods:[{name:'base',enabled:true},...['space-age','quality','elevated-rails','recycler'].map(name=>({name,enabled:false})),{name:mod,enabled:true}]}));
 await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({seed:12345,width:2048,height:2048,water:0,autoplace_settings:{entity:{treat_missing_as_default:false,settings:{}},decorative:{treat_missing_as_default:false,settings:{}}}}));
 const workspace={write:async(relative,bytes)=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}};
 const command=await prepareOfflineMap(workspace,{env:['FACTORIO_RUNTIME_HELPER=true']},id);
 const init=await fs.readFile(new URL('../map-init.lua',import.meta.url),'utf8');
 // Playerless headless saves do not complete chart requests. Only this fixture
 // supplies visibility for its known generated rectangle; collection stays real.
 const initialization='local before=remote.call("goblin-capacity-fixture","state");assert(before.sentinel==123 and before.updates==0 and before.configurationChanges==0)\n'+init.replace('local f=game.forces.player','local real=game.forces.player;local f=setmetatable({is_chunk_charted=function(_,c)local x=c.x or c[1];local y=c.y or c[2];return x>=-32 and x<32 and y>=-32 and y<32 end},{__index=function(_,key)return real[key]end})');
 await workspace.write('engine/data/base/instrument-control.lua',offlineMapScript(id,{initialization}));
 await run(['pull',image]);
 const mounts=['--mount','type=bind,source='+root+',target=/factorio','--mount','type=bind,source='+path.join(root,'engine')+',target=/opt/factorio,readonly'];
 const creator=name+'-create';containers.push(creator);
 await run(['create','--name',creator,'--network','none',...mounts,'--entrypoint','/opt/factorio/bin/x64/factorio',image,'--config','/factorio/map-export/config.ini','--mod-directory','/factorio/mods','--map-gen-settings','/factorio/settings.json','--create','/factorio/saves/source.zip']);
 await run(['start',creator]);assert.equal(Number(await run(['wait',creator])),0,'Fixture creation failed');
 const before=hash(await fs.readFile(path.join(root,'saves/source.zip'))),mods=hash(await fs.readFile(path.join(root,'mods/mod-list.json')));
 // Read cgroup peak usage after the real process exits. The wrapper and its
 // paths exist only in this fresh-engine test, not in the production policy.
 for(const mode of ['mixed']){
  const worker=name+'-'+mode;containers.push(worker);
  const wrapper='/opt/factorio/bin/x64/factorio "$@"; result=$?; cat /sys/fs/cgroup/memory.peak > /factorio/map-export/memory-peak.txt; exit "$result"';
  await run(['create','--name',worker,'--network','none','--memory','1g','--cpus','1','--cpu-shares','128','--pids-limit','256','--cap-drop','ALL',...['CHOWN','SETUID','SETGID','DAC_OVERRIDE'].flatMap(cap=>['--cap-add',cap]),'--security-opt','no-new-privileges:true',...mounts,'--entrypoint','/bin/sh',image,'-c',wrapper,'goblin-capacity',...command.Cmd]);
  const start=Date.now();await run(['start',worker]);const exit=Number(await run(['wait',worker])),elapsedMs=Date.now()-start,info=JSON.parse(await run(['inspect',worker]))[0];
  report.state=info.State;assert.equal(exit,0);assert.equal(info.State.OOMKilled,false);assert.ok(elapsedMs<180000);
  const peakBytes=Number(await fs.readFile(path.join(root,'map-export/memory-peak.txt'),'utf8'));assert.ok(peakBytes>0&&peakBytes<1024**3);
  const raw=await fs.readFile(path.join(root,'script-output/panel-map.json'));assert.ok(raw.length<=mapExportByteLimit);
  const value=validateMap(JSON.parse(raw));validateMapCompletion(JSON.parse(await fs.readFile(path.join(root,'script-output/panel-map.complete.json'),'utf8')),value,id);
  assert.equal(value.chunks.length,mapChunkLimit);assert.equal(value.entities.length,mapObjectLimit);assert.equal(value.entitiesLimited,true);assert.equal(value.totalChunks,mapChunkLimit);
  const packed=gzipSync(JSON.stringify(encodeMapPayload(value)),{level:6}),decoded=await readMapPayload(packed);assert.deepEqual(decoded,value);
  report.cases.push({mode,chunks:value.chunks.length,objects:value.entities.length,entitiesLimited:value.entitiesLimited,elapsedMs,peakBytes,memoryBudgetBytes:info.HostConfig.Memory,rawBytes:raw.length,gzipBytes:packed.length,exactWireRoundTrip:true});
 }
 assert.equal(hash(await fs.readFile(path.join(root,'saves/source.zip'))),before);assert.equal(hash(await fs.readFile(path.join(root,'mods/mod-list.json'))),mods);report.sourceSaveAndModsUnchanged=true;
}catch(error){report.error=error.stack;process.exitCode=1;for(const name of containers)report[name]=await execute('docker',['logs','--tail','25',name]).then(r=>r.stdout+r.stderr).catch(()=> 'Unavailable');}
finally{const output=path.resolve('output/factorio-map-capacity');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');for(const name of containers)await run(['rm','-f','-v',name]).catch(()=>{});await execute('sudo',['rm','-rf','--',root]);}
console.log(JSON.stringify(report));
