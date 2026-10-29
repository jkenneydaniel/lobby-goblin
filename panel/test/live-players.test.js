import test from 'node:test';
import assert from 'node:assert/strict';
import {LivePlayers,PLAYER_QUERY,parsePlayers} from '../applications/factorio/live-players.js';

const scope={running:true,world:'Factory.zip',seed:123};
const response=players=>'PANEL_LIVE_PLAYERS:'+JSON.stringify({players,seed:123,tick:100});
const player={name:'Engineer',x:12.5,y:-5,surface:'nauvis',color:[.2,.6,1]};
function fixture(overrides={}){let calls=0,time=10000,persisted;const service=new LivePlayers({scope:async()=>scope,query:async command=>{assert.equal(command,PLAYER_QUERY);calls++;return response([player]);},persist:async config=>{persisted=config;},now:()=>time,...overrides});return {service,calls:()=>calls,persisted:()=>persisted,advance:ms=>{time+=ms;}};}
test('tracking is off by default and enabling requires explicit consent for the current world',async()=>{
  const test=fixture();assert.equal((await test.service.get()).state,'disabled');assert.equal(test.calls(),0);
  await assert.rejects(test.service.configure({enabled:true,world:'Factory.zip',seed:123},'Owner'),/acknowledging/);
  await assert.rejects(test.service.configure({enabled:true,confirm:true,world:'Other.zip',seed:123},'Owner'),/world changed/);
  await test.service.configure({enabled:true,confirm:true,world:'Factory.zip',seed:123},'Owner');assert.equal(test.persisted().approvedBy,'Owner');assert.equal(test.calls(),0,'Configuring does not itself run the Lua query');
});
test('live queries coalesce simultaneous viewers, cache across five-second browser polls, and drop disconnected players',async()=>{
  let connected=true,calls=0;const test=fixture({config:{enabled:true,...scope},query:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return response(connected?[player]:{});}});
  const results=await Promise.all([test.service.get(),test.service.get(),test.service.get()]);assert.equal(calls,1);assert.equal(results[0].state,'live');assert.deepEqual(results[0].players[0].color,[51,153,255]);
  await test.service.get();assert.equal(calls,1);connected=false;test.advance(4500);assert.deepEqual((await test.service.get()).players,[]);assert.equal(calls,2);
});
test('stopped servers, other worlds, and other seeds never receive a script command',async()=>{
  for(const value of [{...scope,running:false},{...scope,world:'Next.zip'},{...scope,seed:456}]){
    const test=fixture({config:{enabled:true,...scope},scope:async()=>value});const result=await test.service.get();assert.equal(result.players.length,0);assert.equal(test.calls(),0);assert.notEqual(result.state,'live');
  }
});
test('only an approved fixed query may repeat the achievements acknowledgement',async()=>{
  let calls=0;const test=fixture({config:{enabled:true,...scope},query:async command=>{assert.equal(command,PLAYER_QUERY);calls++;return calls===1?'Using Lua console commands disables achievements. Repeat the command to proceed.':response([player]);}});
  assert.equal((await test.service.get()).state,'live');assert.equal(calls,2);
  await test.service.configure({enabled:false},'Owner');assert.equal((await test.service.get()).state,'disabled');assert.equal(calls,2);
});
test('malformed coordinates, changed seeds, and failures hide live markers instead of reusing stale data',async()=>{
  assert.throws(()=>parsePlayers(response([{...player,x:null}])),/coordinates/);
  for(const query of [async()=>response([{...player,x:'bad'}]),async()=>response([player]).replace('"seed":123','"seed":456'),async()=>{throw new Error('RCON unavailable');}]){
    const test=fixture({config:{enabled:true,...scope},query});const result=await test.service.get();assert.equal(result.state,'unavailable');assert.deepEqual(result.players,[]);
  }
});
test('disabling tracking during an in-flight warning prevents the repeated script command',async()=>{
  let release,calls=0;const wait=new Promise(resolve=>{release=resolve;});
  const test=fixture({config:{enabled:true,...scope},query:async()=>{calls++;await wait;return 'Achievements disabled; repeat the command.';}});
  const result=test.service.get();await new Promise(resolve=>setTimeout(resolve,0));await test.service.configure({enabled:false},'Owner');release();assert.equal((await result).state,'disabled');assert.equal(calls,1);
});
