import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostCapacity,hostCapacityView} from '../public/fleet/host-capacity.js';
const local={id:'a'.repeat(32),local:true,connected:true},remote={id:'b'.repeat(32),local:false,connected:true};
const data=(budget=24)=>({memoryBudgetGiB:budget,allocatedMemoryGiB:17,availableMemoryGiB:budget-17,dockerMemoryGiB:32});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('capacity uses exact host routes and backend allocations, coalesces list repaints and deliberately refreshes',async()=>{
 const reads=[];const model=createHostCapacity({request:async(route,options)=>{reads.push([route,options.method]);return data(route.startsWith('/hosts/')?32:24);},now:()=>123456});
 model.sync([local,remote]);await tick();assert.deepEqual(reads,[['/host-settings','GET'],['/hosts/'+remote.id+'/host-settings','GET']]);assert.equal(model.get(local).data.allocatedMemoryGiB,17);assert.equal(model.get(remote).data.availableMemoryGiB,15);assert.equal(model.get(local).checkedAt,123456);
 model.sync([local,remote]);await tick();assert.equal(reads.length,2);model.refresh();model.refresh();await tick();assert.equal(reads.length,4);model.dispose();
});
test('capacity bounds concurrent reads to four and does not start queued reads after disposal',async()=>{
 const waiting=[],signals=[];const model=createHostCapacity({request:(_route,{signal})=>{signals.push(signal);return new Promise(resolve=>waiting.push(resolve));}});const hosts=Array.from({length:9},(_,i)=>({...remote,id:String(i).padStart(32,'0')}));
 model.sync(hosts);await tick();assert.equal(waiting.length,4);waiting.shift()(data());await tick();assert.equal(waiting.length,4);assert.equal(signals.length,5);model.dispose();assert.ok(signals.every(signal=>signal.aborted));for(const resolve of waiting)resolve(data());await tick();assert.equal(signals.length,5);
});
test('offline/removal/reconnection and disposal discard old responses without exposing stale headroom',async()=>{
 const waiting=[],signals=[];const model=createHostCapacity({request:(_route,{signal})=>{signals.push(signal);return new Promise(resolve=>waiting.push(resolve));}});
 model.sync([remote]);await tick();model.sync([{...remote,connected:false}]);assert.equal(model.get(remote),undefined);assert.equal(signals[0].aborted,true);model.sync([remote]);await tick();waiting[1](data(32));await tick();waiting[0](data(24));await tick();assert.equal(model.get(remote).data.memoryBudgetGiB,32);model.sync([]);assert.equal(model.get(remote),undefined);model.dispose();
 let calls=0;const closed=createHostCapacity({request:async()=>{calls++;return data();}});closed.sync([local]);closed.dispose();await tick();assert.equal(calls,0);
});
test('partial failures and unsupported data stay explicit while Docker-unknown capacity retains valid budget data',async()=>{
 let bad=true;const model=createHostCapacity({request:async(route)=>route.startsWith('/hosts/')?(bad?{memoryBudgetGiB:'32'}:{...data(32),dockerMemoryGiB:null}):data()});model.sync([local,remote]);await tick();assert.equal(model.get(local).state,'ready');assert.equal(model.get(remote).state,'unavailable');assert.match(hostCapacityView(remote,model.get(remote)),/Capacity unavailable/);assert.ok(!hostCapacityView({...local,connected:false},model.get(local)).includes('Available to allocate'));bad=false;model.refresh();await tick();assert.match(hostCapacityView(remote,model.get(remote)),/Not reported/);assert.match(hostCapacityView(remote,model.get(remote)),/not live RAM usage/);model.dispose();
});
