import test from 'node:test';
import assert from 'node:assert/strict';
import {ReleaseChecks,compareVersions,selectRelease,version} from '../updates.js';
const release=(tag,extra={})=>({tag_name:tag,published_at:'2026-10-15T12:00:00Z',prerelease:tag.includes('-'),draft:false,...extra});
test('release versions compare numerically and use semantic prerelease ordering',()=>{
  assert.equal(compareVersions('v0.10.0','0.9.9'),1);
  assert.equal(compareVersions('0.1.0-alpha.10','0.1.0-alpha.2'),1);
  assert.equal(compareVersions('0.1.0','0.1.0-rc.1'),1);
  assert.equal(compareVersions('0.1.0-alpha','0.1.0-alpha.1'),-1);
  assert.equal(compareVersions('0.1.0+build.1','v0.1.0'),0);
  assert.equal(version('v01.2.3'),null);assert.equal(version('main'),null);assert.equal(version('1.0.0-alpha.01'),null);
});
test('preview includes alphas; stable excludes prereleases; drafts and malformed tags never notify',()=>{
  const list=[release('0.1.0'),release('v0.2.0-alpha'),release('v9.0.0',{draft:true}),release('v8.0.0',{published_at:null}),release('not-semver'),release('1.0.0-beta',{prerelease:false})];
  assert.equal(selectRelease(list,'preview').tag_name,'1.0.0-beta');
  assert.equal(selectRelease(list,'stable').tag_name,'0.1.0');
  assert.equal(selectRelease([release('v0.2.0-alpha')],'stable'),null);
});
test('checks coalesce, cache, use conditional requests and never downgrade newer installations',async()=>{
  let now=1000,calls=0;const requests=[];
  const checks=new ReleaseChecks({current:'0.1.0-alpha',now:()=>now,interval:100,fetcher:async(url,options)=>{
    calls++;requests.push({url,options});await new Promise(resolve=>setImmediate(resolve));
    return calls===1?new Response(JSON.stringify([release('v0.1.1-alpha')]),{headers:{etag:'"release-list"'}}):new Response(null,{status:304});
  }});
  const [a,b]=await Promise.all([checks.check(),checks.check()]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.state,'available');assert.equal(a.installation,'manual');
  assert.equal(a.latest.url,'https://github.com/jkenneydaniel/lobby-goblin/releases/tag/v0.1.1-alpha');
  await checks.check();assert.equal(calls,1);now+=101;await checks.check();assert.equal(calls,2);assert.equal(requests[1].options.headers['if-none-match'],'"release-list"');
  assert.ok(requests.every(r=>r.url.startsWith('https://api.github.com/repos/')));
  checks.current='0.2.0';now+=101;assert.equal((await checks.check()).available,false);
});
test('offline, rate limits and unavailable repositories stay explicit; disabled checks make no request',async()=>{
  for(const status of [403,404,429]){
    const checks=new ReleaseChecks({current:'0.1.0-alpha',fetcher:async()=>new Response('',{status})});
    const result=await checks.check();assert.equal(result.state,'unavailable');assert.equal(result.available,false);assert.ok(result.error);
  }
  const offline=new ReleaseChecks({current:'0.1.0-alpha',fetcher:async()=>{throw new Error('offline');}});
  assert.match((await offline.check()).error,/Cannot reach GitHub/);
  const disabled=new ReleaseChecks({current:'0.1.0-alpha',enabled:false,fetcher:()=>assert.fail('Must not fetch')});assert.equal((await disabled.check()).state,'disabled');
});

test('manual checks bypass the automatic cache with a one-minute limit and coalesce requests',async()=>{
  let now=1000,calls=0;
  const checks=new ReleaseChecks({current:'0.2.1-alpha',now:()=>now,fetcher:async()=>{
    calls++;await new Promise(resolve=>setImmediate(resolve));
    return new Response(JSON.stringify([release(calls===1?'v0.2.1-alpha':'v0.2.2-alpha')]));
  }});
  assert.equal((await checks.check()).available,false);
  now+=60001;
  assert.equal((await checks.check()).available,false);assert.equal(calls,1);
  const results=await Promise.all([checks.check({force:true}),checks.check({force:true})]);
  assert.equal(calls,2);assert.ok(results.every(result=>result.available&&result.latest.tag==='v0.2.2-alpha'));
  await checks.check({force:true});assert.equal(calls,2);
  const disabled=new ReleaseChecks({current:'0.2.1-alpha',enabled:false,fetcher:()=>assert.fail('Disabled checks must stay disabled')});
  assert.equal((await disabled.check({force:true})).state,'disabled');
});

test('changing release preferences invalidates in-flight checks and starts a fresh channel check', async () => {
  let resolveFirst, calls=0;
  const checks=new ReleaseChecks({current:'0.1.0',fetcher:async()=>{
    if(++calls===1)await new Promise(resolve=>{resolveFirst=resolve;});
    return new Response(JSON.stringify([release('v0.2.0-alpha'),release('v0.1.1')]));
  }});
  const first=checks.check();
  checks.configure({enabled:false,channel:'stable'});
  resolveFirst();await first;
  assert.equal(checks.result.state,'disabled');assert.equal(checks.result.latest,undefined);assert.equal(checks.result.checkedAt,null);
  checks.configure({enabled:true,channel:'stable'});
  assert.equal((await checks.check()).latest.tag,'v0.1.1');assert.equal(calls,2);
  checks.configure({enabled:true,channel:'preview'});
  assert.equal((await checks.check()).latest.tag,'v0.2.0-alpha');assert.equal(calls,3);
});
