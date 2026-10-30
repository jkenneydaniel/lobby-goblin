// Fresh CI engine only. Owns every temporary path/container it creates and never
// reads a deployment environment, existing volume, or game save.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareOfflineMap,validateMapCompletion} from '../applications/factorio/map-offline.js';
import {validateMap} from '../applications/factorio/map-export.js';

assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.FACTORIO_OFFLINE_DISPOSABLE,'true');
const execute=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-map-profiles-')),id=crypto.randomUUID(),prefix='goblin-map-acceptance-'+id,containers=[];
const bundled='ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.3',runtime='ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1';
const run=async args=>(await execute('docker',args,{timeout:300000,maxBuffer:4*1024**2})).stdout.trim();
const report={disposable:true,profiles:[]};
try{
 await run(['pull',bundled]);await run(['pull',runtime]);
 const sourceName=prefix+'-source';containers.push(sourceName);
 await run(['create','--name',sourceName,'--network','none','--entrypoint','/opt/factorio/bin/x64/factorio',bundled,'--version']);
 for(const copied of [false,true]){
  const name=prefix+(copied?'-runtime':'-bundled'),folder=path.join(root,copied?'runtime':'bundled');await fs.mkdir(folder);
  for(const dir of ['saves','mods','map-export'])await fs.mkdir(path.join(folder,dir));
  await fs.writeFile(path.join(folder,'mods/mod-list.json'),JSON.stringify({mods:[{name:'base',enabled:true},...['space-age','quality','elevated-rails'].map(name=>({name,enabled:false}))]}));
  if(copied){await fs.mkdir(path.join(folder,'engine'));await run(['cp',sourceName+':/opt/factorio/.',path.join(folder,'engine')]);}
  const command=await prepareOfflineMap({write:async(name,bytes)=>{const file=path.join(folder,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}}, {env:copied?['FACTORIO_RUNTIME_HELPER=true']:[]},id);
  await execute('sudo',['chown','-R','845:845',folder]);
  await run(['run','--rm','--network','none','--mount','type=bind,source='+folder+',target=/factorio','--entrypoint','/opt/factorio/bin/x64/factorio',bundled,'--create','/factorio/saves/source.zip','--mod-directory','/factorio/mods']);
  const before=crypto.createHash('sha256').update(await fs.readFile(path.join(folder,'saves/source.zip'))).digest('hex'),mods=await fs.readFile(path.join(folder,'mods/mod-list.json'),'utf8');
  const mounts=['--mount','type=bind,source='+folder+',target=/factorio',...(copied?['--mount','type=bind,source='+path.join(folder,'engine')+',target=/opt/factorio,readonly']:[])];
  containers.push(name);
  await run(['create','--name',name,'--network','none','--memory','1g','--cpu-shares','128','--pids-limit','256','--cap-drop','ALL',...['CHOWN','SETUID','SETGID','DAC_OVERRIDE'].flatMap(cap=>['--cap-add',cap]),'--security-opt','no-new-privileges:true',...mounts,'--entrypoint',command.Entrypoint[0],copied?runtime:bundled,...command.Entrypoint.slice(1),...command.Cmd]);
  await run(['start',name]);const exit=Number(await run(['wait',name]));
  if(exit!==0){report.workerState=JSON.parse(await run(['inspect',name]))[0].State;report.factorioLog=await fs.readFile(path.join(folder,'factorio-current.log'),'utf8').catch(()=> 'No Factorio log');}
  assert.equal(exit,0,JSON.stringify(report));
  const info=JSON.parse(await run(['inspect',name]))[0];assert.equal(info.State.OOMKilled,false);assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(Object.keys(info.HostConfig.PortBindings||{}).length,0);assert.equal(info.HostConfig.Memory,1024**3);assert.deepEqual(info.HostConfig.CapAdd.map(cap=>cap.replace(/^CAP_/,'' )).sort(),['CHOWN','DAC_OVERRIDE','SETGID','SETUID']);
  const value=JSON.parse(await fs.readFile(path.join(folder,'script-output/panel-map.json'),'utf8'));
  for(const key of ['chunks','palette','entities','players','tags'])if(!Array.isArray(value[key])&&Object.keys(value[key]).length===0)value[key]=[];
  validateMap(value);validateMapCompletion(JSON.parse(await fs.readFile(path.join(folder,'script-output/panel-map.complete.json'),'utf8')),value,id);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(folder,'saves/source.zip'))).digest('hex'),before);assert.equal(await fs.readFile(path.join(folder,'mods/mod-list.json'),'utf8'),mods);
  report.profiles.push({mode:copied?'runtime-overlay':'bundled-image',completed:true,sourceSaveAndModsUnchanged:true,network:'none',memory:info.HostConfig.Memory});
 }
}catch(error){report.error=error.message;for(const name of containers)report[name]=await execute('docker',['logs','--tail','30',name]).then(r=>r.stdout+r.stderr).catch(()=> 'Unavailable');process.exitCode=1;}
finally{
 const output=path.resolve('output/factorio-map-worker');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
 for(const name of containers)await run(['rm','-f','-v',name]).catch(()=>{});await execute('sudo',['rm','-rf','--',root]);
}
console.log(JSON.stringify(report));
