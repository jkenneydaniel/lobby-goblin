import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApi,
  playerCount,
  serverState,
  sameImageReference,
} from '../public/client.js';

test('shared client keeps scoped URLs, current CSRF, JSON and raw uploads', async () => {
  const calls = [];
  let session = {csrf: 'first'};
  const api = createApi({
    base: '/hosts/host/servers/server/api',
    getSession: () => session,
    fetcher: async (...args) => {
      calls.push(args);
      return {ok: true, json: async () => ({ok: true})};
    },
  });
  await api('/status');
  assert.equal(calls[0][0], '/hosts/host/servers/server/api/status');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers['x-csrf-token'], undefined);
  session = {csrf: 'renewed'};
  await api('jobs', {method: 'POST', body: {action: 'backup'}});
  assert.equal(calls[1][1].headers['x-csrf-token'], 'renewed');
  const operation=JSON.parse(calls[1][1].body);
  assert.equal(operation.action,'backup');assert.match(operation.requestId,/^[A-Za-z0-9_-]{16,96}$/);
  const archive = new Uint8Array([1, 2, 3]);
  await api('/upload?name=world.zip', {
    method: 'POST',
    body: archive,
    raw: true,
  });
  assert.equal(calls[2][1].body, archive);
  assert.equal(calls[2][1].headers['content-type'], undefined);
});

test('uncertain operation responses retain their request ID while accepted and rejected requests clear it',async()=>{
  const calls=[];let outcome='network';
  const api=createApi({getSession:()=>({username:'Owner'}),fetcher:async(_url,options)=>{
    calls.push(JSON.parse(options.body));if(outcome==='network')throw Error('Disconnected');
    return {ok:outcome==='accepted',status:outcome==='accepted'?202:409,json:async()=>({id:'job',error:'Conflict'})};
  }});
  const send=()=>api('/jobs',{method:'POST',body:{action:'backup'}});
  await assert.rejects(send(),/Disconnected/);outcome='accepted';await send();
  assert.equal(calls[0].requestId,calls[1].requestId);await send();assert.notEqual(calls[1].requestId,calls[2].requestId);
  outcome='rejected';await assert.rejects(send(),/Conflict/);await assert.rejects(send(),/Conflict/);
  assert.notEqual(calls[3].requestId,calls[4].requestId);
});

test('expired sessions use one unauthorized path while rejected login stays on its form', async () => {
  let expired = 0;
  const api = createApi({
    onUnauthorized: () => expired++,
    fetcher: async () => ({
      ok: false,
      status: 401,
      json: async () => ({error: 'Please sign in.'}),
    }),
  });
  for (const route of ['/login', '/registration', '/register'])
    await assert.rejects(api(route, {method: 'POST', body: {}}), {status: 401});
  assert.equal(expired, 0);
  await assert.rejects(api('/status'), {status: 401});
  assert.equal(expired, 1);
});
test('a late unauthorized response cannot sign out a newer session',async()=>{
  let session={username:'First',csrf:'first'},reply,expired=0;
  const response=new Promise(resolve=>{reply=resolve;});
  const api=createApi({getSession:()=>session,onUnauthorized:()=>expired++,fetcher:()=>response});
  const pending=api('/status');session={username:'Second',csrf:'second'};
  reply({ok:false,status:401,json:async()=>({error:'Expired old session'})});
  await assert.rejects(pending,{status:401});assert.equal(expired,0);assert.equal(session.username,'Second');
});

test('shared status and image matching preserve unknown states and reject different pinned digests', () => {
  assert.equal(playerCount(['a', 'b']), 2);
  assert.equal(playerCount(3), 3);
  assert.equal(playerCount(null), null);
  assert.equal(serverState(null).label, 'Unavailable');
  assert.equal(serverState({ready: true, paused: true}).label, 'Paused');
  assert.equal(serverState({running: true}).label, 'Starting');
  assert.equal(serverState({imageMigration: {}}).label, 'Needs attention');
  assert.equal(sameImageReference('game:v1@sha256:a', 'game:v1'), true);
  assert.equal(
    sameImageReference('game:v1@sha256:a', 'game:v1@sha256:b'),
    false,
  );
  assert.equal(sameImageReference('game:v1', 'game:v2'), false);
});

test('binary delivery keeps scoped credentials and uses the same expired-session path',async()=>{
 let expired=0,unauthorized=false;const payload=new Uint8Array([31,139,0,255]),session={username:'Reader'};
 const api=createApi({base:'/servers/synthetic/api',getSession:()=>session,onUnauthorized:()=>expired++,fetcher:async(url,options)=>{
  assert.equal(url,'/servers/synthetic/api/map-payload?revision=fixture');assert.equal(options.credentials,'same-origin');
  return unauthorized?Response.json({error:'Expired'},{status:401}):new Response(payload,{headers:{'content-type':'application/vnd.lobby-goblin.map+gzip'}});
 }});
 assert.deepEqual(await api('/map-payload?revision=fixture',{binary:true}),payload);
 unauthorized=true;await assert.rejects(api('/map-payload?revision=fixture',{binary:true}),{status:401});assert.equal(expired,1);
});
test('binary responses cancel on exceeding the byte budget',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}));
 const api=createApi({fetcher:async()=>response});await assert.rejects(api('/map-payload',{binary:true}),/incomplete response/);assert.equal(cancelled,true);
});
