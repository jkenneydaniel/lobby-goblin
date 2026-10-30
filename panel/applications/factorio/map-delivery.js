import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {assert} from '../../common.js';
import {encodeMapPayload,mapPayloadFormat,mapPayloadLimit} from './public/map-payload.js';
const compress=promisify(gzip);

// One bounded compressed snapshot per controller. No parsed entity graph is
// retained and no persistent state format changes. Work is lazy and coalesced:
// unviewed snapshots cost nothing and later viewers reuse the same bytes.
export class MapDelivery {
 constructor(metadata,{encode=encodeMapPayload,zip=compress}={}){Object.assign(this,{metadata,encode,zip});this.cached=null;this.pending=null;}
 async document(known){
  const value=await this.metadata.read(),revision=this.metadata.revision;
  if(!value){this.cached=null;return {snapshot:null,revision:null};}
  if(!revision)return this.metadata.document(known);
  if(this.cached?.revision!==revision)this.cached=null;
  return {revision,mapScope:{...value,seed:this.metadata.seed},...(known===revision?{unchanged:true}:{payload:{format:mapPayloadFormat,revision}})};
 }
 async bytes(revision){
  await this.metadata.read();
  assert(revision===this.metadata.revision,'The map changed during delivery. Retry the latest snapshot.',409);
  if(this.cached?.revision===revision)return this.cached.bytes;
  if(this.pending?.revision===revision)return this.pending.promise;
  const pending={revision};
  pending.promise=this.build(revision).finally(()=>{if(this.pending===pending)this.pending=null;});
  this.pending=pending;return pending.promise;
 }
 async build(revision){
  const document=await this.metadata.document();
  assert(document.snapshot&&document.revision===revision,'The map changed during delivery. Retry the latest snapshot.',409);
  const text=JSON.stringify(this.encode(document.snapshot));
  assert(Buffer.byteLength(text)<=mapPayloadLimit,'The compact map exceeds its delivery budget.',413);
  const bytes=await this.zip(text,{level:6});
  assert(bytes.length<=mapPayloadLimit,'The compact map exceeds its delivery budget.',413);
  await this.metadata.read();
  assert(this.metadata.revision===revision,'The map changed during delivery. Retry the latest snapshot.',409);
  this.cached={revision,bytes};return bytes;
 }
}
