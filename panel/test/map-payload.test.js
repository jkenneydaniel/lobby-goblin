import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {encodeMapPayload,decodeMapPayload,readMapPayload,mapPayloadLimit} from '../applications/factorio/public/map-payload.js';
import {MapDelivery} from '../applications/factorio/map-delivery.js';
import {SnapshotMetadata} from '../applications/factorio/snapshot-metadata.js';
import {writeJSON} from '../common.js';
import {mapPayloadFixture} from './map-payload-fixture.js';

const fixture=()=>mapPayloadFixture(30,4);
test('compact snapshots preserve exact geometry, metadata, entity order and optional fields',async()=>{
 const snapshot=fixture();
 snapshot.entities.push({...snapshot.entities[2],w:5,h:3,recipe:'rotated-recipe',unknown:{future:'value'}});
 snapshot.entities.push({name:'legacy',type:'furnace',category:'buildings',x:-0.125,y:123456789.0625,color:[1,2,3],amount:null,recipe:null});
 snapshot.entities.push({...snapshot.entities[0],amount:0});
 const encoded=encodeMapPayload(snapshot);
 assert.ok(encoded.prototypes.length<snapshot.entities.length);assert.deepEqual(decodeMapPayload(JSON.parse(JSON.stringify(encoded))),snapshot);
 assert.deepEqual(await readMapPayload(gzipSync(JSON.stringify(encoded))),snapshot);
 assert.equal(snapshot.entities[0].x,-256,'The source remains unchanged');
});
test('compact decoders reject bad rows, dictionary references, metadata and compressed bombs',async()=>{
 const original=encodeMapPayload(fixture());
 for(const mutate of [v=>{v.format='future';},v=>{v.metadata.version=2;},v=>{v.rows[0][0]=-1;},v=>{v.rows[0][0]=9999;},v=>{v.rows[0][1]=null;},v=>{v.rows[0].push(99);},v=>{v.rows[2]=[0,1,2,2,999];},v=>{v.prototypes[0].x=1;},v=>{v.rows=Array(80001).fill(v.rows[0]);}]){
  const value=structuredClone(original);mutate(value);assert.throws(()=>decodeMapPayload(value),/Invalid compact/);
 }
 await assert.rejects(readMapPayload(Buffer.from('invalid gzip')));
 await assert.rejects(readMapPayload(gzipSync(Buffer.alloc(mapPayloadLimit+1,32))),/Invalid compact/);
});
test('delivery coalesces compression, reuses only bounded bytes, and leaves legacy source readable',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin-map-delivery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'map.json'),metadata=new SnapshotMetadata(file);let encoded=0;
 const delivery=new MapDelivery(metadata,{encode:value=>{encoded++;return encodeMapPayload(value);}});
 assert.deepEqual(await delivery.document(),{snapshot:null,revision:null});
 const snapshot=fixture();await writeJSON(file,snapshot);const original=await fs.readFile(file);
 const first=await delivery.document();assert.equal(first.mapScope.seed,snapshot.seed);assert.ok(first.payload);assert.equal(first.snapshot,undefined);
 const copies=await Promise.all(Array.from({length:8},()=>delivery.bytes(first.revision)));
 assert.equal(encoded,1);for(const bytes of copies)assert.equal(bytes,copies[0]);
 assert.deepEqual(await readMapPayload(copies[0]),snapshot);assert.equal(delivery.cached.snapshot,undefined);assert.equal(metadata.value.entities,undefined);
 assert.deepEqual((await metadata.document()).snapshot,snapshot);assert.deepEqual(await fs.readFile(file),original);
 assert.equal((await delivery.document(first.revision)).unchanged,true);assert.equal(encoded,1);
 snapshot.entities[0].amount=123;await writeJSON(file,snapshot);const next=await delivery.document(first.revision);assert.notEqual(next.revision,first.revision);
 await assert.rejects(delivery.bytes(first.revision),{status:409});assert.equal(encoded,1);
 assert.deepEqual(await readMapPayload(await delivery.bytes(next.revision)),snapshot);assert.equal(encoded,2);
 await fs.unlink(file);assert.deepEqual(await delivery.document(),{snapshot:null,revision:null});assert.equal(delivery.cached,null);await assert.rejects(delivery.bytes(next.revision),{status:409});
});
test('delivery cannot label old compressed bytes with a concurrently replaced snapshot',async()=>{
 let inode=1,body=JSON.stringify(fixture()),replace=false;
 const metadata=new SnapshotMetadata('fixture',{stat:async()=>({dev:1,ino:inode,size:body.length,mtimeMs:inode,ctimeMs:inode}),readFile:async()=>body});
 const delivery=new MapDelivery(metadata,{zip:async text=>{if(replace){inode++;body=JSON.stringify({...fixture(),world:'Replacement.zip'});}return gzipSync(text);}});
 const first=await delivery.document();replace=true;await assert.rejects(delivery.bytes(first.revision),{status:409});assert.equal(delivery.cached,null);
 replace=false;const next=await delivery.document();assert.notEqual(next.revision,first.revision);assert.equal(JSON.parse(gunzipSync(await delivery.bytes(next.revision))).metadata.world,'Replacement.zip');
});
