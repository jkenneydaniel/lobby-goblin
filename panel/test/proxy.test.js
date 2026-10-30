import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {proxyResponse} from '../core/proxy.js';

async function fixture(t,handle,{download=true,timeout=120}={}){
  const upstream=http.createServer(handle);
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const errors=[],proxy=http.createServer((req,res)=>{
    proxyResponse(req,res,'http://127.0.0.1:'+upstream.address().port,{download,timeout}).catch(error=>{
      errors.push(error);if(res.headersSent)res.destroy();else{res.writeHead(502);res.end('Unavailable');}
    });
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const server of [proxy,upstream])await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
  return {url:'http://127.0.0.1:'+proxy.address().port,errors};
}

test('download deadlines reset on progress while API requests retain their total deadline',{timeout:5000},async t=>{
  for(const download of [true,false]){
    const f=await fixture(t,(req,res)=>{
      res.writeHead(200,{'content-type':'application/gzip','content-disposition':'attachment; filename="fixture.tar.gz"'});
      res.write('first');let count=0;
      const timer=setInterval(()=>{res.write('next');if(++count===8){clearInterval(timer);res.end('last');}},40);
      res.once('close',()=>clearInterval(timer));
    },{download});
    const response=await fetch(f.url);assert.equal(response.status,200);
    if(download){assert.equal(await response.text(),'first'+'next'.repeat(8)+'last');assert.equal(f.errors.length,0);}
    else await assert.rejects(response.text(),'An API response must still be time bounded');
  }
});

test('stalled download headers fail and stalled bodies are visibly incomplete',{timeout:5000},async t=>{
  const headers=await fixture(t,()=>{});assert.equal((await fetch(headers.url)).status,502);
  const body=await fixture(t,(req,res)=>{res.writeHead(200);res.write('partial archive');});
  const response=await fetch(body.url);assert.equal(response.status,200);await assert.rejects(response.text());
});

test('client cancellation closes the upstream download instead of leaving it running',{timeout:5000},async t=>{
  let closed;const finished=new Promise(resolve=>{closed=resolve;});
  const f=await fixture(t,(req,res)=>{res.writeHead(200);res.write('first chunk');res.once('close',closed);},{timeout:3000});
  const response=await fetch(f.url),reader=response.body.getReader();assert.equal((await reader.read()).done,false);
  await reader.cancel();await finished;
});

test('upstream errors cannot turn a partial archive into a successful response',{timeout:5000},async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(200);res.write('partial');setTimeout(()=>res.destroy(),30);});
  const response=await fetch(f.url);await assert.rejects(response.text());
});

test('explicit gzip map files survive HTTP proxying byte-for-byte without implicit decompression',async t=>{
 const {gzipSync}=await import('node:zlib'),bytes=gzipSync(JSON.stringify({synthetic:'map'.repeat(1000)}));
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/vnd.lobby-goblin.map+gzip'});res.end(bytes);},{download:false,timeout:3000});
 const response=await fetch(f.url);assert.equal(response.headers.get('content-type'),'application/vnd.lobby-goblin.map+gzip');assert.equal(response.headers.get('content-encoding'),null);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});
