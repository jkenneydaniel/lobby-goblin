import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {mapObjectLimit,mapChunkLimit,mapExportByteLimit} from '../applications/factorio/public/map-limits.js';
import {validateMap} from '../applications/factorio/map-export.js';
import {encodeMapPayload,decodeMapPayload,readMapPayload} from '../applications/factorio/public/map-payload.js';
import {mapPayloadFixture} from './map-payload-fixture.js';

test('Lua collection, validation, delivery and the visible limit warning share the capacity contract',async()=>{
 const [init,batch,html]=await Promise.all(['../map-init.lua','../map-batch.lua','../applications/factorio/public/factorio/map.html'].map(file=>fs.readFile(new URL(file,import.meta.url),'utf8')));
 assert.equal(Number(init.match(/#chunks<(\d+)/)[1]),mapChunkLimit);
 assert.equal(Number(batch.match(/slot>(\d+)/)[1]),mapObjectLimit);
 assert.equal(Number(batch.match(/slot<=(\d+)/)[1]),mapObjectLimit);
 assert.ok(html.includes(mapChunkLimit.toLocaleString('en-US'))&&html.includes(mapObjectLimit.toLocaleString('en-US')));
});
test('the larger complete snapshot survives validation and compressed delivery, while each overflow is refused',async()=>{
 const snapshot=mapPayloadFixture();assert.equal(snapshot.entities.length,160000);assert.equal(snapshot.chunks.length,4096);
 // Alternating tile samples exercise the larger raw budget rather than relying
 // on uniformly colored chunks and unusually small run-length terrain.
 snapshot.palette.push({name:'stone-path',color:[100,100,100]});
 for(const chunk of snapshot.chunks)chunk.tiles=Array.from({length:512},(_,i)=>i%2?1:1+(i/2)%2);
 assert.equal(validateMap(snapshot),snapshot);
 const raw=Buffer.byteLength(JSON.stringify(snapshot));assert.ok(raw>24*1024**2&&raw<=mapExportByteLimit);
 const encoded=encodeMapPayload(snapshot);assert.deepEqual(await readMapPayload(gzipSync(JSON.stringify(encoded))),snapshot);
 assert.throws(()=>validateMap({...snapshot,entities:[...snapshot.entities,snapshot.entities[0]]}));
 assert.throws(()=>encodeMapPayload({...snapshot,entities:[...snapshot.entities,snapshot.entities[0]]}));
 assert.throws(()=>validateMap({...snapshot,chunks:[...snapshot.chunks,snapshot.chunks[0]]}));
 assert.throws(()=>decodeMapPayload({...encoded,rows:[...encoded.rows,encoded.rows[0]]}));
 assert.throws(()=>decodeMapPayload({...encoded,metadata:{...encoded.metadata,chunks:[...snapshot.chunks,snapshot.chunks[0]]}}));
});
