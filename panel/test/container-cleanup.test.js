import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {removeStoppedContainer,cleanupUpdateWorkers,cleanupFleetContainers} from '../core/container-cleanup.js';
import {writeJSON,readJSON} from '../common.js';
const missing=()=>{throw Object.assign(Error('Missing'),{status:404});};
const stopped={Status:'exited',Running:false,Restarting:false,Paused:false,ExitCode:0};
test('cleanup rechecks immutable IDs, refuses active and foreign containers, and never forces or deletes volumes',async()=>{
 const info={Id:'owned-id',State:stopped},calls=[];let current=structuredClone(info);
 const docker=async(method,route)=>{calls.push([method,route]);if(method==='GET')return structuredClone(current);};
 for(const state of [{...stopped,Running:true},{...stopped,Restarting:true},{...stopped,Status:'running'},{...stopped,Paused:true}]){current.State=state;assert.equal(await removeStoppedContainer(docker,info,()=>true),false);}
 current.State=stopped;assert.equal(await removeStoppedContainer(docker,info,()=>false),false);assert.equal(await removeStoppedContainer(docker,info,()=>true),true);assert.deepEqual(calls.filter(([method])=>method==='DELETE'),[['DELETE','/containers/owned-id']]);
 current.Id='replacement';await assert.rejects(removeStoppedContainer(docker,info,()=>true),/identity changed/);
 assert.equal(await removeStoppedContainer(async(method)=>{if(method==='GET')return info;throw Object.assign(Error('started concurrently'),{status:409});},info,()=>true),false);
});
test('historical update workers require matching labels, job, root and bind; failures retain diagnostics and running workers survive',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lg-cleanup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const job={id:'a'.repeat(36),root:'/owned-installation',project:'own-project',state:'succeeded',finished:new Date(0).toISOString()},removed=[];
 const info={Id:'worker-id',Config:{Labels:{'lobby-goblin.update':job.id,'com.lobby-goblin.project':job.project},Env:['UPDATE_JOB='+job.id,'UPDATE_ROOT='+job.root]},Mounts:[{Type:'bind',Source:job.root,Destination:job.root}],State:stopped};
 const docker=async(method,route)=>{if(route.includes('factory-control'))return missing();if(route.includes('/logs?'))return Buffer.from('bounded failure details');if(method==='GET')return structuredClone(info);removed.push(route);};
 for(const mutate of [()=>{info.Config.Labels['com.lobby-goblin.project']='other';},()=>{info.Mounts[0].Source='/other';},()=>{info.State={...stopped,Running:true};}]){const original=structuredClone(info);mutate();assert.equal(await cleanupUpdateWorkers({docker,root,jobs:[job]}),0);Object.assign(info,original);}
 assert.equal(await cleanupUpdateWorkers({docker,root,jobs:[job]}),1);
 job.state='failed';job.finished=new Date(Date.now()-1000).toISOString();await writeJSON(path.join(root,job.id+'.json'),job);assert.equal(await cleanupUpdateWorkers({docker,root,jobs:[job]}),0);
 job.finished=new Date(0).toISOString();await writeJSON(path.join(root,job.id+'.json'),job);assert.equal(await cleanupUpdateWorkers({docker,root,jobs:[job]}),1);assert.match((await readJSON(path.join(root,job.id+'.json'))).workerLog,/bounded failure/);assert.ok(removed.every(route=>!route.includes('?')));
});
test('fleet sweeping retains unrecorded helpers and interrupted migrations while collecting completed migration originals',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lg-fleet-cleanup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const fleet='a'.repeat(32),id='b'.repeat(32),other='c'.repeat(32),item={id,container:'current',volume:'owned-volume',image:'pinned-image',game:'rust',state:'installed'},removed=[];
 const labels={'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.instance':id},containers=new Map([
 ['helper',{Id:'helper',Config:{Labels:{...labels,'io.lobby-goblin.worker':'true'}},State:stopped}],
 ['neighbor',{Id:'neighbor',Config:{Labels:{...labels,'io.lobby-goblin.fleet':other,'io.lobby-goblin.worker':'true'}},State:stopped}],
 ['active-helper',{Id:'active-helper',Config:{Labels:{...labels,'io.lobby-goblin.worker':'true'}},State:{...stopped,Running:true}}],
 ['old',{Id:'old',Name:'/current-pre-lg034',Config:{Labels:labels},HostConfig:{RestartPolicy:{Name:'no'}},Mounts:[{Type:'volume',Name:item.volume,Destination:'/steamcmd/rust'}],State:stopped}],
 ]);
 const manager={root,fleet,state:{servers:[item]},active:null,assertHost:async()=>{},ownedContainer:async()=>({Id:'new',Image:'immutable-image',Config:{Image:item.image}}),docker:async(method,route)=>{if(route.startsWith('/containers/json?'))return [...containers.values()];const key=route.split('/')[2];if(method==='GET')return structuredClone(containers.get(key)||missing());removed.push(key);containers.delete(key);}};
 const journal={phase:'verify',backup:'verified.tar.gz',originalId:'old',retain:'current-pre-lg034',target:item.image,imageId:'immutable-image'};await writeJSON(path.join(root,'migrations',id+'.json'),journal);
 assert.equal((await cleanupFleetContainers(manager)).removed,0);assert.ok(containers.has('helper'));assert.ok(containers.has('old'));assert.ok(containers.has('neighbor'));assert.ok(containers.has('active-helper'));
 journal.phase='complete';await writeJSON(path.join(root,'migrations',id+'.json'),journal);assert.equal((await cleanupFleetContainers(manager)).removed,1);assert.deepEqual(removed,['old']);manager.active={};assert.equal((await cleanupFleetContainers(manager)).removed,0);
});
