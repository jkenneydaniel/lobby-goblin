import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const lua=spawnSync('lua',['-v'],{encoding:'utf8'});
test('map export bounds chunk selection and deduplication without losing entity details',{skip:lua.error?'Lua interpreter unavailable; native export acceptance also exercises this source':false},()=>{
 const files=['./map-export-algorithms.lua','../map-init.lua','../map-batch.lua'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
 const result=spawnSync('lua',files,{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
