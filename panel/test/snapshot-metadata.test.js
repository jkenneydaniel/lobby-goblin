import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SnapshotMetadata} from '../applications/factorio/snapshot-metadata.js';
import {writeJSON} from '../common.js';

test('unchanged snapshots are parsed once, concurrent polls coalesce, and only metadata is retained',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-index-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'map.json');let reads=0;
  const reader=new SnapshotMetadata(file,{readFile:async(...args)=>{reads++;return fs.readFile(...args);}});
  assert.equal(await reader.read(),null);
  await writeJSON(file,{world:'Factory.zip',sourceVersion:'first',created:'one',entities:[{large:'payload'}],chunks:[1,2,3]});
  const values=await Promise.all(Array.from({length:10},()=>reader.read()));
  assert.equal(reads,1);assert.deepEqual(values[0],{world:'Factory.zip',sourceVersion:'first',created:'one'});
  for(let i=0;i<10;i++)assert.deepEqual(await reader.read(),values[0]);assert.equal(reads,1);
  await writeJSON(file,{world:'Factory.zip',sourceVersion:'second',created:'two'});
  assert.equal((await reader.read()).sourceVersion,'second');assert.equal(reads,2);
  await fs.unlink(file);assert.equal(await reader.read(),null);
  await writeJSON(file,{world:'Next.zip',sourceVersion:'third',created:'three'});
  assert.equal((await reader.read()).world,'Next.zip');assert.equal(reads,3);
});

test('replacement identity invalidates equal-size/equal-mtime cache entries, and read races are not cached',async()=>{
  let inode=1,body='{"world":"First.zip"}',reads=0,replaceDuringRead=false;
  const reader=new SnapshotMetadata('fixture',{stat:async()=>({dev:1,ino:inode,size:20,mtimeMs:100,ctimeMs:100}),readFile:async()=>{reads++;if(replaceDuringRead){inode++;replaceDuringRead=false;}return body;}});
  assert.equal((await reader.read()).world,'First.zip');assert.equal(reads,1);
  inode++;body='{"world":"Other.zip"}';assert.equal((await reader.read()).world,'Other.zip');assert.equal(reads,2);
  inode++;replaceDuringRead=true;await reader.read();assert.equal(reads,3);
  await reader.read();assert.equal(reads,4,'A replacement during parsing must force the next read to recheck contents');
  await reader.read();assert.equal(reads,4);
});

test('invalid snapshots and filesystem failures never silently reuse old metadata',async()=>{
  let body='{"world":"First.zip"}',revision=1,problem=null;
  const reader=new SnapshotMetadata('fixture',{stat:async()=>{if(problem)throw problem;return {dev:1,ino:revision,size:20,mtimeMs:100,ctimeMs:100};},readFile:async()=>body});
  await reader.read();revision++;body='{';await assert.rejects(reader.read(),SyntaxError);
  body='{"world":"Recovered.zip"}';assert.equal((await reader.read()).world,'Recovered.zip');
  problem=Object.assign(new Error('denied'),{code:'EACCES'});await assert.rejects(reader.read(),/denied/);
  problem=null;assert.equal((await reader.read()).world,'Recovered.zip');
});

test('map delivery skips unchanged payloads and returns pins scope metadata without retaining the full document', async () => {
  let revision=1, reads=0;
  const reader=new SnapshotMetadata('fixture',{stat:async()=>({dev:1,ino:revision,size:100,mtimeMs:revision,ctimeMs:revision}),readFile:async()=>{reads++;return JSON.stringify({world:'Factory.zip',seed:revision,created:String(revision),entities:[{large:'payload'}]});}});
  const first=await reader.document();assert.equal(first.snapshot.seed,1);assert.match(first.revision,/^[a-f0-9]{64}$/);assert.equal(reads,1);
  const second=await reader.document(first.revision);assert.equal(second.unchanged,true);assert.equal(second.snapshot,undefined);assert.equal(reads,1);assert.equal(reader.seed,1);assert.equal(reader.value.entities,undefined);
  revision=2;await reader.read();assert.equal(reader.seed,2);
  const third=await reader.document(first.revision);assert.equal(third.snapshot.seed,2);assert.notEqual(third.revision,first.revision);
  assert.equal((await reader.document(third.revision)).unchanged,true);
});
