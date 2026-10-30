import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {exportMap} from '../applications/factorio/map-export.js';

for(const failure of ['worker','memory','receipt'])test('offline '+failure+' failure retains the prior map and removes only its own helper',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-map-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),state=path.join(root,'state');
 for(const dir of ['mods','saves'])await fs.mkdir(path.join(data,dir),{recursive:true});await fs.mkdir(state);
 await fs.writeFile(path.join(data,'saves/source.zip'),'Synthetic save input');await fs.writeFile(path.join(state,'map.json'),'previous-map');
 const job={id:crypto.randomUUID()},helper='factorio-panel-map-'+job.id,work=path.join(state,'.panel-work',job.id),calls=[];
 const server={Image:'synthetic-image',Config:{Image:'synthetic-image'},Mounts:[{Type:'bind',Source:data,Destination:'/factorio'}]};
 const docker=async(method,route,body)=>{
  calls.push({method,route});
  if(route==='/containers/fixture-controller/json')return {Mounts:[{Type:'bind',Source:state,Destination:state}]};
  if(route.startsWith('/containers/create?')){assert.ok(body.Cmd.includes('--benchmark'));assert.equal(body.HostConfig.NetworkMode,'none');return {Id:helper};}
  if(route.endsWith('/wait?condition=not-running')){
   if(failure==='receipt'){
    await fs.mkdir(path.join(work,'script-output'));await fs.writeFile(path.join(work,'script-output/panel-map.json'),JSON.stringify({version:1,step:2,seed:1,tick:123,chunks:[],entities:[],palette:[],players:[],tags:[]}));return {StatusCode:0};
   }
   return {StatusCode:1};
  }
  if(route==='/containers/'+helper+'/json')return {State:{OOMKilled:failure==='memory'}};
  if(route.includes('/logs?'))return Buffer.from('Private fixture diagnostics.');
  assert.ok(route.startsWith('/containers/'+helper+'/')||method==='DELETE'&&route==='/containers/'+helper,'No active game operation is allowed.');
  return {};
 };
 const operation=()=>exportMap({data,state,env:{CONTROLLER_CONTAINER:'fixture-controller'},server,source:'source.zip',job,running:false,stageMessage:async()=>{}},{docker});
 await assert.rejects(operation(),error=>{
  assert.equal(error.status,409);assert.match(error.message,failure==='memory'?/memory budget/:failure==='receipt'?/did not complete/:/exit code 1/);
  assert.ok(!error.message.includes('Private fixture'));if(failure!=='receipt')assert.match(error.cause.message,/Private fixture/);return true;
 });
 assert.equal(await fs.readFile(path.join(state,'map.json'),'utf8'),'previous-map');
 assert.equal(await fs.readFile(path.join(data,'saves/source.zip'),'utf8'),'Synthetic save input');
 assert.ok(calls.some(call=>call.method==='DELETE'&&call.route==='/containers/'+helper));
 await assert.rejects(fs.stat(work),{code:'ENOENT'});
});
