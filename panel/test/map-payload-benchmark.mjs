// Synthetic payload work only. No game engine, Docker or existing worlds.
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {encodeMapPayload,decodeMapPayload,readMapPayload} from '../applications/factorio/public/map-payload.js';
import {mapPayloadFixture} from './map-payload-fixture.js';

const snapshot=mapPayloadFixture(),plain=JSON.stringify(snapshot),compact=JSON.stringify(encodeMapPayload(snapshot)),gzip=gzipSync(compact,{level:6}),legacyGzip=gzipSync(plain,{level:6});
assert.deepEqual(decodeMapPayload(JSON.parse(compact)),snapshot);assert.deepEqual(await readMapPayload(gzip),snapshot);
const samples={legacyParse:[],compactParseAndExpand:[],gzipDecodeAndExpand:[],firstEncodingAndCompression:[]};
for(let i=0;i<9;i++){
 const work={legacyParse:()=>JSON.parse(plain),compactParseAndExpand:()=>decodeMapPayload(JSON.parse(compact)),gzipDecodeAndExpand:()=>readMapPayload(gzip),firstEncodingAndCompression:()=>gzipSync(JSON.stringify(encodeMapPayload(snapshot)),{level:6})};
 const keys=Object.keys(work);if(i%2)keys.reverse();
 for(const key of keys){const start=performance.now();await work[key]();if(i>1)samples[key].push(performance.now()-start);}
}
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
console.log(JSON.stringify({syntheticOnly:true,objects:snapshot.entities.length,chunks:snapshot.chunks.length,node:process.version,medianOf:7,bytes:{legacyJSON:Buffer.byteLength(plain),compactJSON:Buffer.byteLength(compact),compactGzip:gzip.length,legacyGzip:legacyGzip.length},medianMs:Object.fromEntries(Object.entries(samples).map(([key,values])=>[key,Number(median(values).toFixed(2))]))},null,2));
