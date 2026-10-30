import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Accounts} from '../core/accounts.js';
import {hashPassword} from '../auth.js';
import {writeJSON} from '../common.js';
import {normalizeGrants,requireAssignment,requireServerPermission,publicAccess} from '../core/permissions.js';

const server='/servers/'+'a'.repeat(32),remote='/hosts/'+'b'.repeat(32)+server;
const member={role:'member',grants:{[server]:['server.view','server.operate']}};
test('assigned permissions are server scoped, action specific and fail closed for executable or unknown operations',()=>{
  requireServerPermission(member,server,'GET','/status');
  requireServerPermission(member,server,'POST','/jobs',{action:'restart'});
  for(const scope of [remote,'standalone','/servers/'+'c'.repeat(32)])assert.throws(()=>requireAssignment(member,scope),error=>error.status===404);
  for(const action of ['restore','settings','install-framework','mod-library-install','not-an-action','constructor'])assert.throws(()=>requireServerPermission(member,server,'POST','/jobs',{action}),error=>error.status===403);
  for(const route of ['/update-install','/jobs/recovery','/mod-library','/diagnostics'])assert.throws(()=>requireServerPermission(member,server,'POST',route),error=>error.status===403);
  assert.deepEqual(publicAccess(member,server).allowedActions.sort(),['announce','restart','save','start','stop']);
  const modsOnly={role:'member',grants:{[server]:['server.view','mods.manage']}},imagesOnly={role:'member',grants:{[server]:['server.view','images.change']}};
  requireServerPermission(modsOnly,server,'POST','/jobs',{action:'mod-library-install'});
  assert.throws(()=>requireServerPermission(modsOnly,server,'POST','/update-install'),error=>error.status===403);
  requireServerPermission(imagesOnly,server,'POST','/update-install');
  assert.throws(()=>requireServerPermission(imagesOnly,server,'POST','/jobs',{action:'mod-library-install'}),error=>error.status===403);
});
test('grant validation rejects wildcard, malformed scopes, unknown permissions and missing viewing access',()=>{
  for(const grants of [[],null,{'*':['server.view']},{'/servers/../servers/x':['server.view']},{[server]:['*']},{[server]:['server.operate']},{[server]:'server.view'}])assert.throws(()=>normalizeGrants(grants));
  assert.deepEqual(normalizeGrants({[remote]:['server.view','server.view'],[server]:[]}),{[remote]:['server.view']});
});
test('legacy and package download authorization use the controller world default',()=>{
 for(const permission of ['backups.download','worlds.download']){
  const user={role:'member',grants:{[server]:['server.view',permission]}};
  for(const kind of [undefined,'','world','unknown']){
   if(permission==='worlds.download')requireServerPermission(user,server,'GET','/download',{kind});
   else assert.throws(()=>requireServerPermission(user,server,'GET','/download',{kind}),error=>error.status===403);
  }
 }
});
test('existing roles remain unscoped and assigned accounts start empty; revisions protect concurrent administrators',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-permissions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await writeJSON(path.join(root,'users.json'),{Owner:{...hashPassword('fixture-owner-password'),role:'admin'},Viewer:{...hashPassword('fixture-viewer-password'),role:'viewer'}});
  const accounts=new Accounts(root),invitation=await accounts.invite('member','Owner');
  await accounts.register({token:invitation.token,username:'Assigned',password:'fixture-member-password'});
  assert.deepEqual((await accounts.users()).Assigned.grants,{});
  requireAssignment({role:'viewer'},remote);requireAssignment({role:'admin'},remote);
  await accounts.update({username:'Assigned',operation:'grants',grants:member.grants,revision:0,confirm:true});
  await assert.rejects(accounts.update({username:'Assigned',operation:'grants',grants:{},revision:0,confirm:true}),error=>error.status===409);
  assert.deepEqual((await accounts.users()).Assigned.grants,normalizeGrants(member.grants));
  await accounts.update({username:'Assigned',operation:'role',role:'viewer',confirm:true});
  assert.equal((await accounts.users()).Assigned.grants,undefined);
  await accounts.update({username:'Assigned',operation:'role',role:'member',confirm:true});
  assert.deepEqual((await accounts.users()).Assigned.grants,{});
  await assert.rejects(accounts.update({username:'Owner',operation:'role',role:'member',confirm:true}),/at least one administrator/);
});

test('compact map bytes require the same server-scoped map permission as legacy snapshots',async()=>{
 const {factorio}=await import('../applications/factorio/index.js');
 const scoped={role:'member',grants:{[server]:['server.view','application.factorio.map.view']}};
 for(const route of ['/map','/map-status','/map-payload']){
  requireServerPermission(scoped,server,'GET',route,{module:factorio});
  assert.throws(()=>requireServerPermission(member,server,'GET',route,{module:factorio}),{status:403});
  assert.throws(()=>requireServerPermission(scoped,remote,'GET',route,{module:factorio}),{status:404});
 }
 assert.throws(()=>requireServerPermission(scoped,server,'POST','/map-payload',{module:factorio}),{status:403});
});
