import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {offlineMapScript,prepareOfflineMap,bundledMapEntrypoint,validateMapCompletion} from '../applications/factorio/map-offline.js';
import definition from '../applications/factorio/definition.json' with {type:'json'};

const job='12345678-1234-1234-1234-123456789abc';
test('offline helpers use a declared exact wrapper or a prepared read-only runtime overlay',async()=>{
 for(const copied of [false,true]){
  const writes=new Map(),workspace={write:async(name,bytes)=>writes.set(name,bytes)};
  const command=await prepareOfflineMap(workspace,{env:copied?['FACTORIO_RUNTIME_HELPER=true']:[]},job);
  assert.deepEqual(command.Entrypoint,copied?['/opt/factorio/bin/x64/factorio']:bundledMapEntrypoint);
  assert.ok(command.Cmd.includes('--benchmark'));assert.ok(command.Cmd.includes('--enable-unsafe-lua-debug-api'));assert.ok(!command.Cmd.includes('--start-server'));
  assert.equal(writes.has('engine/data/base/instrument-control.lua'),copied);
  assert.ok(writes.get('map-export/config.ini').includes('read-data='+(copied?'/opt/factorio/data':'/factorio/map-export/data')));
  assert.ok(![...writes.keys()].some(name=>name.startsWith('mods/')||name.startsWith('saves/')));
 }
 assert.deepEqual(definition.services[0].configuration.helpers.previewWorker.entrypoints,[bundledMapEntrypoint]);
 assert.throws(()=>offlineMapScript('bad"; code'));
});
test('map completion must match this exact job and the validated snapshot',()=>{
 const value={tick:123,chunks:[{}],entities:[]},receipt={format:1,jobId:job,tick:123,chunks:1,entities:0,engine:'2.0.77'};
 assert.equal(validateMapCompletion(receipt,value,job),receipt);
 for(const patch of [{jobId:'other'},{format:2},{tick:124},{chunks:2},{entities:1},{engine:'unknown'}])assert.throws(()=>validateMapCompletion({...receipt,...patch},value,job));
 assert.throws(()=>validateMapCompletion(null,value,job));
});
const lua=spawnSync('lua',['-v'],{encoding:'utf8'});
test('offline instrumentation handles replaced or cleared callbacks and snapshots before scenario updates',{skip:lua.error?'Lua interpreter unavailable':false},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-offline-lua-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'instrument.lua');await fs.writeFile(file,offlineMapScript(job));
 const harness=fileURLToPath(new URL('./map-offline.lua',import.meta.url));
 const result=spawnSync('lua',[harness,file],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
});
