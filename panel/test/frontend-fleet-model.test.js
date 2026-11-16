import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetModel} from '../public/fleet/model.js';
import {createEventScope} from '../public/shared/events.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('fleet model keeps remote scopes, bounded status concurrency and source-host failure state',async()=>{
  const session={username:'Owner',role:'admin'},seen=[],events=[];let offline=false,active=0,maximum=0;
  const hosts=[{id:'local',name:'Local',local:true,connected:true},{id:'remote',name:'Remote',local:false,connected:true}];
  const model=createFleetModel({getSession:()=>session,onChange:value=>events.push(value),
    request:async route=>{seen.push(route);if(route==='/hosts')return {hosts:structuredClone(hosts)};
      if(offline&&route.startsWith('/hosts/remote'))throw Error('Disconnected');
      if(route.endsWith('/servers'))return {servers:Array.from({length:5},(_,index)=>({id:String(index),name:'Server '+index,state:'installed'}))};
      if(route.endsWith('/snapshots'))return {snapshots:[{id:'snapshot'}]};
      if(route.endsWith('/jobs'))return {jobs:[{id:'job',message:'Done'}],active:null};throw Error(route);},
    fetchStatus:async url=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));active--;return {ready:true,url};},
  });
  const snapshot=await model.refresh();
  assert.equal(snapshot.servers.length,10);assert.equal(snapshot.live.size,10);assert.equal(maximum,4);
  assert.equal(snapshot.servers[5].manageUrl,'/hosts/remote/servers/0/');assert.equal(model.route('remote','/jobs'),'/hosts/remote/jobs');
  assert.ok(seen.includes('/hosts/remote/snapshots'));assert.equal(events.length,2);
  offline=true;await model.refresh();assert.equal(model.snapshot.hosts[1].connected,false);assert.equal(model.snapshot.servers.filter(item=>item.unavailable).length,5);assert.equal(model.snapshot.snapshots[1].unavailable,true);
});
test('fleet model coalesces reads and a session reset cannot publish old data into a new account',async()=>{
  const old=deferred(),events=[];let session={username:'Old',role:'member'},reads=0,oldSignal;
  const model=createFleetModel({getSession:()=>session,onChange:value=>events.push(value),request:(_route,options)=>{reads++;oldSignal=options.signal;return old.promise;}});
  const first=model.refresh(),second=model.refresh();assert.equal(first,second);assert.equal(reads,1);
  session={username:'New',role:'member'};model.reset();assert.equal(oldSignal.aborted,true);
  old.resolve({servers:[{id:'private-old-server'}]});await first;assert.deepEqual(model.snapshot.servers,[]);assert.deepEqual(events,[]);
});
test('assigned-server loading does not request host administration, snapshots or other server status',async()=>{
  const seen=[];
  const principal={role:'member'};const scoped=createFleetModel({getSession:()=>principal,request:async route=>{seen.push(route);return {servers:[{id:'assigned'}]};}});
  await scoped.refresh();assert.deepEqual(seen,['/assigned-servers']);assert.equal(scoped.snapshot.assigned,true);assert.equal(scoped.snapshot.servers[0].id,'assigned');
});
test('fleet catalogue updates survive an in-flight statistics refresh',async()=>{
  const stats=deferred(),principal={role:'admin'};
  const model=createFleetModel({getSession:()=>principal,request:async route=>route==='/hosts'?{hosts:[{id:'one',local:true,connected:true}]}:route==='/servers'?{servers:[{id:'server',state:'installed'}]}:route==='/snapshots'?{snapshots:[]}:{jobs:[],active:null},fetchStatus:()=>stats.promise});
  const pending=model.refresh();await new Promise(resolve=>setImmediate(resolve));model.setGames([{id:'arena'}]);stats.resolve({ready:true});await pending;
  assert.deepEqual(model.snapshot.games,[{id:'arena'}]);
});
test('replaceable event scopes preserve immediate event prevention and remove all callbacks on disposal',async()=>{
  const target=new EventTarget(),errors=[];let calls=0;
  const events=createEventScope(error=>errors.push(error.message));
  events.set(target,'submit',()=>{calls+=100;});events.set(target,'submit',event=>{event.preventDefault();calls++;});
  const event=new Event('submit',{cancelable:true});target.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(calls,1);
  events.clear();target.dispatchEvent(new Event('submit'));assert.equal(calls,1);
  events.set(target,'submit',async()=>{throw Error('Failed handler');});target.dispatchEvent(new Event('submit'));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(errors,['Failed handler']);events.clear();
});
test('disposed or replaced event scopes suppress errors from their previous asynchronous handlers',async()=>{
  const target=new EventTarget(),errors=[];let rejectOld;
  const events=createEventScope(error=>errors.push(error.message));
  events.set(target,'submit',()=>new Promise((_resolve,reject)=>{rejectOld=reject;}));
  target.dispatchEvent(new Event('submit'));events.clear();rejectOld(Error('Old screen failed'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(errors,[]);
  events.set(target,'submit',()=>new Promise((_resolve,reject)=>{rejectOld=reject;}));
  target.dispatchEvent(new Event('submit'));events.set(target,'submit',()=>{});rejectOld(Error('Replaced handler failed'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(errors,[]);events.clear();
});

test('fleet native management progress stays host-scoped and never requests administrator history as a viewer',async()=>{
 const native={id:'agent-updates:worker',source:'agent-updates',sourceId:'worker',action:'agent-update',state:'running',message:'Replacing management'};
 const setup={id:'host-setup:ssh',source:'host-setup',sourceId:'ssh',action:'install-host',state:'failed',message:'Review the remote installation',recovery:{required:true}};
 const calls=[];let user={username:'Owner',role:'admin'};
 const model=createFleetModel({includeWorkflows:true,getSession:()=>user,request:async route=>{
  calls.push(route);if(route==='/hosts')return {hosts:[{id:'local',name:'Local',local:true,connected:true},{id:'remote',name:'Remote',local:false,connected:true}]};
  if(route.endsWith('/servers'))return {servers:[]};if(route.endsWith('/snapshots'))return {snapshots:[]};
  return {jobs:[],active:null,...(route.endsWith('/jobs?workflows=1')?{workflow:{operations:route.startsWith('/hosts/')?[native]:[setup],sources:[{id:'agent-updates',available:true}]}}:{})};
 }});
 await model.refresh();assert.equal(model.snapshot.active.id,native.id);assert.equal(model.snapshot.jobs.find(job=>job.id===native.id).hostId,'remote');assert.equal(model.busy('remote'),true);
 assert.equal(model.busy('local'),false);assert.equal(model.snapshot.jobs.find(job=>job.id===setup.id).recovery.required,true);assert.ok(calls.includes('/hosts/remote/jobs?workflows=1'));
 user={username:'Viewer',role:'viewer'};model.reset();calls.length=0;await model.refresh();assert.ok(calls.includes('/hosts/remote/jobs'));assert.ok(!calls.some(route=>route.includes('workflows')));assert.equal(model.snapshot.jobs.length,0);
});
