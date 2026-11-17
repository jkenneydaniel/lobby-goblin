import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AuditLog} from '../core/audit.js';
import {writeJSON} from '../common.js';
import {AuditRepository} from '../core/storage/state-repositories.js';

test('audit history serializes concurrent writes, survives restart, paginates and makes retention visible',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-audit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const log=new AuditLog(root,{limit:5});
 await Promise.all(Array.from({length:12},(_,i)=>log.append({actor:'User',scope:'standalone',action:'operation.save',outcome:'accepted',requestId:String(i),body:{password:'must-not-appear'},error:'secret'})));
 const reloaded=new AuditLog(root,{limit:5}),page=await reloaded.list({limit:3});
 assert.deepEqual(page.events.map(event=>event.sequence),[12,11,10]);assert.equal(page.prunedThrough,7);
 const last=await reloaded.list({before:page.nextBefore,limit:2});
 assert.deepEqual(last.events.map(event=>event.sequence),[9,8]);assert.equal(last.nextBefore,null);
 assert.ok(!(await fs.readFile(log.file,'utf8')).includes('must-not-appear'));assert.ok(!(await fs.readFile(log.file,'utf8')).includes('secret'));
 assert.equal((await fs.stat(log.file)).mode&0o777,0o600);
 await assert.rejects(log.list({limit:1000}));
});
test('audit integrity errors do not silently reset history and failed persistence does not advance it',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-audit-integrity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let fail=false;const repository=new AuditRepository(root),save=repository.save.bind(repository);repository.save=async(...args)=>{if(fail)throw Error('Full disk');return save(...args);};const log=new AuditLog(root,{repository});
 await log.append({actor:'Owner',action:'account.access',outcome:'started'});fail=true;
 await assert.rejects(log.append({actor:'Owner',action:'account.access',outcome:'succeeded'}));assert.equal((await log.list()).events.length,1);
 fail=false;await log.append({actor:'Owner',action:'account.access',outcome:'succeeded'});
 const state=JSON.parse(await fs.readFile(log.file,'utf8'));state.events[0].actor='Altered';await writeJSON(log.file,state);
 const reloaded=new AuditLog(root);await assert.rejects(reloaded.list(),/integrity/);await assert.rejects(reloaded.append({action:'test'}),/integrity/);
});

test('access deltas retain both disjoint assignment sets at the account limit and exclude extra fields',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-audit-access-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const log=new AuditLog(root),assignments=Array.from({length:128},(_,index)=>({scope:'/servers/'+index.toString(16).padStart(32,'0'),before:index<64?['server.view']:[],after:index>=64?['server.view','mods.manage']:[],token:'private'}));
 await log.append({actor:'Owner',action:'account.access',outcome:'succeeded',accessChange:{roles:['member','member'],assignments,password:'private'}});
 const event=(await new AuditLog(root).list()).events[0];assert.equal(event.accessChange.assignments.length,128);assert.ok(!JSON.stringify(event).includes('private'));
});
