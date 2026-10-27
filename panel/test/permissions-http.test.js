import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startFleetWeb} from '../fleet/web.js';
import {Accounts as FactorioAccounts} from '../applications/factorio/accounts.js';
import {storage as factorioStorage} from '../applications/factorio/storage.js';
import {planStorageMigration,applyStorageMigration} from '../core/storage/migrations.js';
import {selectedStorage,closeStorage} from '../core/storage/selection.js';
import {hashPassword} from '../auth.js';
import {writeJSON,json,requestJSON} from '../common.js';

const one='/servers/'+'a'.repeat(32),two='/servers/'+'b'.repeat(32),remote='/hosts/'+'c'.repeat(32)+one;
async function fixture(t,{games={}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-permission-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const auth=path.join(root,'auth'),tokenFile=path.join(root,'token');await fs.mkdir(auth);await fs.writeFile(tokenFile,'fixture-token');
 await writeJSON(path.join(auth,'users.json'),{Owner:{...hashPassword('owner-fixture-password'),role:'admin'},Assigned:{...hashPassword('member-fixture-password'),role:'member',grants:{[one]:['server.view','server.operate'],[remote]:['server.view','backups.read']},accessRevision:0},Viewer:{...hashPassword('viewer-fixture-password'),role:'viewer'}});
 const calls=[];
 const backend=http.createServer((req,res)=>{void(async()=>{
  calls.push({route:req.url,method:req.method,user:req.headers['x-panel-user'],updateKind:req.headers['x-panel-update-kind']});
  assert.equal(req.headers.authorization,'Bearer fixture-token');
  if(req.url==='/update-status')return json(res,200,{busy:false});
  if([one,two,remote].includes(req.url))return json(res,200,{id:req.url.split('/').at(-1),game:games[req.url]||'factorio',state:'installed',name:'Fixture server',address:'fixture:35000',controllerToken:'never-public',rconPassword:'never-public'});
  if(req.url.endsWith('/controller/status'))return json(res,200,{ready:true,running:true,version:'2.0.77',players:[]});
  if(req.method==='POST'&&req.url.endsWith('/controller/jobs')){const body=await requestJSON(req);calls.at(-1).body=body;return json(res,202,{id:'fixture-job',state:'succeeded',...body});}
  return json(res,200,{});
 })().catch(error=>json(res,500,{error:error.message}));});await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{backend.closeAllConnections();backend.close(resolve);}));
 const web=await startFleetWeb({env:{AUTH_DIR:auth,CONTROLLER_TOKEN_FILE:tokenFile,CONTROLLER_URL:'http://127.0.0.1:'+backend.address().port,PANEL_HOSTS:'127.0.0.1',RELEASE_CHECKS:'false'},port:0,hostname:'127.0.0.1'});t.after(()=>new Promise(resolve=>{web.closeAllConnections();web.close(resolve);}));
 const origin='http://127.0.0.1:'+web.address().port;
 async function login(username,password){const response=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],session:await response.json()};}
 const request=(auth,route,body)=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{origin,cookie:auth.cookie,'content-type':'application/json','x-csrf-token':auth.session.csrf,'x-panel-user':'SpoofedOwner'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 return {auth,login,request,calls};
}
test('real fleet and scoped web enforce server assignments before proxying, separate hosts, and do not trust actor headers',async t=>{
 const f=await fixture(t),member=await f.login('Assigned','member-fixture-password');
 const listed=await (await f.request(member,'/api/assigned-servers')).json();
 assert.deepEqual(listed.servers.map(item=>item.manageUrl),[one+'/',remote+'/']);assert.ok(!JSON.stringify(listed).includes('never-public'));
 const session=await(await f.request(member,one+'/api/session')).json();assert.deepEqual(session.allowedActions.sort(),['announce','restart','save','start','stop']);
 assert.equal((await f.request(member,one+'/api/jobs',{action:'save',actor:'Owner'})).status,202);
 assert.equal(f.calls.at(-1).body.actor,'Assigned');assert.equal(f.calls.at(-1).user,'Assigned');
 const before=f.calls.length;
 for(const route of [two+'/api/status',two+'/',remote+'/api/jobs'])assert.equal((await f.request(member,route,route.endsWith('/jobs')?{action:'save'}:undefined)).status,route.includes(two)?404:403);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 assert.ok(f.calls.slice(before).every(call=>call.route===remote));
 for(const route of ['/api/accounts','/api/hosts','/api/jobs','/api/host-settings','/api/snapshots'])assert.equal((await f.request(member,route)).status,route==='/api/jobs'?404:403);
 for(const action of ['restore','settings','install-framework','unknown'])assert.equal((await f.request(member,one+'/api/jobs',{action})).status,403);
 assert.equal((await f.request(member,one+'/api/download?kind=backup&name=private.zip')).status,403);
 const viewer=await f.login('Viewer','viewer-fixture-password');for(const user of [member,viewer]){assert.equal((await f.request(user,one+'/api/jobs?workflows=1')).status,403);assert.equal((await f.request(user,'/api/hosts/'+'c'.repeat(32)+'/jobs?workflows=1')).status,403);} assert.equal((await f.request(viewer,two+'/api/status')).status,200);assert.equal((await f.request(viewer,one+'/api/jobs',{action:'save'})).status,403);
});
test('permission changes revoke existing sessions and refresh available tools after reauthentication',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password'),member=await f.login('Assigned','member-fixture-password');
 assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'grants',grants:{[remote]:['server.view']},revision:0,confirm:true})).status,200);
 assert.equal((await f.request(member,one+'/api/status')).status,401);
 const renewed=await f.login('Assigned','member-fixture-password');
 assert.equal((await f.request(renewed,one+'/api/status')).status,404);
 assert.equal((await f.request(renewed,remote+'/api/status')).status,200);
});

for(const sqlite of [false,true])test(`fleet account deletion cleans package data with ${sqlite?'transactional':'legacy JSON'} storage`,async t=>{
 const f=await fixture(t),accounts=new FactorioAccounts(f.auth);
 t.after(()=>closeStorage(f.auth));
 const configuration=JSON.parse(await fs.readFile(new URL('../world-defaults.json',import.meta.url),'utf8'));
 for(const scope of [undefined,'a'.repeat(32)])await accounts.worldSetups('Assigned',{operation:'save-preset',revision:0,name:'Private fixture setup',configuration,image:'fixture:2.0.77'},scope);
 const user=(await accounts.users()).Assigned,ids=[user.worldSetupId,...Object.values(user.serverWorldSetupIds)];
 if(sqlite)await applyStorageMigration(await planStorageMigration(f.auth,'accounts',{groups:factorioStorage.groups}),{confirm:true,offline:true,groups:factorioStorage.groups});
 const owner=await f.login('Owner','owner-fixture-password');
 if(sqlite){
  const sql=new DatabaseSync((await selectedStorage(f.auth)).file);
  try{
   sql.exec("CREATE TRIGGER prevent_package_delete BEFORE UPDATE ON documents WHEN new.namespace='factorio-world-setups' AND new.deleted=1 BEGIN SELECT RAISE(ABORT,'Injected package deletion failure'); END");
   assert.ok((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'delete',confirm:true})).status>=400);
   assert.ok((await accounts.users()).Assigned,'A failed related delete must retain the account');
   for(const id of ids)assert.equal((await selectedStorage(f.auth)).read('factorio-world-setups',id).exists,true);
   sql.exec('DROP TRIGGER prevent_package_delete');
  }finally{sql.close();}
 }
 assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'delete',confirm:true})).status,200);
 assert.equal((await accounts.users()).Assigned,undefined);
 for(const id of ids){
  if(sqlite)assert.equal((await selectedStorage(f.auth)).read('factorio-world-setups',id).exists,false);
  else await assert.rejects(fs.access(path.join(f.auth,'world-setups',id+'.json')),{code:'ENOENT'});
 }
 assert.equal((await f.request(owner,'/api/accounts',{username:'Viewer',operation:'delete',confirm:true})).status,200,'Accounts without saved setups also delete successfully');
});

test('backup download grants cannot reach Factorio world downloads through omitted or unknown kinds',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password');
 for(const [revision,permission] of ['backups.download','worlds.download'].entries()){
  assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'grants',grants:{[one]:['server.view',permission],[remote]:['server.view',permission]},revision,confirm:true})).status,200);
  const member=await f.login('Assigned','member-fixture-password');
  for(const scope of [one,remote])for(const kind of ['', '?kind=world', '?kind=unknown']){
   const before=f.calls.filter(call=>call.route.includes('/controller/download')).length;
   assert.equal((await f.request(member,scope+'/api/download'+kind+(kind?'&':'?')+'id=fixture-world')).status,permission==='worlds.download'?200:403);
   assert.equal(f.calls.filter(call=>call.route.includes('/controller/download')).length,before+(permission==='worlds.download'?1:0));
  }
  assert.equal((await f.request(member,one+'/api/download?kind=backup&name=fixture.zip')).status,permission==='backups.download'?200:403);
 }
 // Existing administrators keep the historical download URL behavior.
 assert.equal((await f.request(owner,one+'/api/download?id=fixture-world')).status,200);
});

test('audit records trusted actors, accepted operations and denied writes without request secrets',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password'),member=await f.login('Assigned','member-fixture-password');
 await f.request(member,one+'/api/jobs',{action:'save',actor:'SpoofedOwner',params:{password:'never-log-this-secret'}});
 await f.request(member,one+'/api/jobs',{action:'install-framework',params:{token:'never-log-this-secret'}});
 const response=await f.request(owner,'/api/audit');assert.equal(response.status,200);const history=await response.json();
 assert.ok(history.events.some(event=>event.actor==='Assigned'&&event.outcome==='accepted'&&event.operationId==='fixture-job'));
 assert.ok(history.events.some(event=>event.actor==='Assigned'&&event.outcome==='denied'));
 assert.ok(!JSON.stringify(history).includes('SpoofedOwner'));assert.ok(!JSON.stringify(history).includes('never-log-this-secret'));
 assert.equal((await f.request(member,'/api/audit')).status,403);
});
test('audit reservation failure prevents submission; an uncertain outcome keeps a durable started record',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password');
 const write=fs.writeFile;let writes=0,failAt=1;
 t.mock.method(fs,'writeFile',async(file,...args)=>{if(String(file).startsWith(path.join(f.auth,'audit.json.'))&&++writes===failAt)throw Error('Simulated full disk');return write(file,...args);});
 const before=f.calls.filter(call=>call.method==='POST').length;
 assert.equal((await f.request(owner,one+'/api/jobs',{action:'save'})).status,503);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,before);
 writes=0;failAt=2;
 const uncertain=await f.request(owner,one+'/api/jobs',{action:'save'});assert.equal(uncertain.status,503);assert.match((await uncertain.json()).error,/may have completed/);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,before+1);
 const history=await(await f.request(owner,'/api/audit')).json();assert.equal(history.events[0].outcome,'started');
});

test('executable mods and game-image changes require separate explicit grants, never host or panel administration',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password');
 const grants={[one]:['server.view','mods.manage','images.change']};
 assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'grants',grants,revision:0,confirm:true})).status,200);
 const member=await f.login('Assigned','member-fixture-password');
 for(const route of ['/mod-library','/update-status'])assert.equal((await f.request(member,one+'/api'+route)).status,200);
 assert.equal((await f.request(member,one+'/api/mod-library-plan',{operation:'install'})).status,200);
 assert.equal((await f.request(member,one+'/api/jobs',{action:'mod-library-install',params:{confirm:true}})).status,202);
 assert.equal((await f.request(member,one+'/api/update-plan',{kind:'game',target:'2.0.78'})).status,200);assert.equal(f.calls.at(-1).updateKind,'game');
 assert.equal((await f.request(member,one+'/api/update-install',{planId:'fixture-id',kind:'panel',confirm:true})).status,200);assert.equal(f.calls.at(-1).updateKind,'game','The controller must validate the stored plan, not the client kind');
 const before=f.calls.length;
 for(const route of ['/mod-library-account','/update-plan'])assert.equal((await f.request(member,one+'/api'+route,{kind:'panel',token:'private'})).status,403);
 for(const route of ['/updates','/diagnostics','/audit'])assert.equal((await f.request(member,one+'/api'+route)).status,403);
 assert.ok(f.calls.slice(before).every(call=>call.route===one));
 assert.equal((await f.request(member,one+'/api/jobs',{action:'start'})).status,403);
 assert.equal((await f.request(member,two+'/api/mod-library')).status,404);
 assert.equal((await f.request(owner,one+'/api/update-status')).status,200);assert.equal(f.calls.at(-1).updateKind,'any');
});

test('package map permissions reach real scoped HTTP checks without granting world management',async t=>{
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password');
 const policy=await(await f.request(owner,'/api/access-policy')).json();
 for(const permission of ['application.factorio.map.view','application.factorio.map.generate','application.factorio.map.pins','application.factorio.map.tracking','application.rust.framework.manage','application.rust.plugins.manage','application.rust.plugins.configure'])assert.equal(typeof policy.permissions[permission],'string');
 const features=[
  {permission:'application.factorio.map.view',reads:['/map','/map-status','/live-players','/preview?id=fixture'],actions:[]},
  {permission:'application.factorio.map.generate',reads:[],actions:['refresh-map']},
  {permission:'application.factorio.map.pins',reads:[],actions:[],write:'/pins'},
  {permission:'application.factorio.map.tracking',reads:[],actions:['live-tracking']},
 ];
 let revision=0;
 for(const feature of features){
  assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'grants',grants:{[one]:['server.view',feature.permission]},revision:revision++,confirm:true})).status,200);
  const user=await f.login('Assigned','member-fixture-password');
  const session=await(await f.request(user,one+'/api/session')).json();assert.deepEqual(session.allowedActions,feature.actions);
  for(const target of features){
   const allowed=target===feature;
   for(const route of target.reads)assert.equal((await f.request(user,one+'/api'+route)).status,allowed?200:403);
   for(const action of target.actions)assert.equal((await f.request(user,one+'/api/jobs',{action})).status,allowed?202:403);
   if(target.write)assert.equal((await f.request(user,one+'/api'+target.write,{label:'fixture pin'})).status,allowed?200:403);
  }
  for(const action of ['create','switch','mod-library-install'])assert.equal((await f.request(user,one+'/api/jobs',{action,params:{confirm:true}})).status,403);
  assert.equal((await f.request(user,remote+'/api/map')).status,404);
 }
 const viewer=await f.login('Viewer','viewer-fixture-password');
 assert.equal((await f.request(viewer,one+'/api/map')).status,200);
 assert.equal((await f.request(viewer,one+'/api/jobs',{action:'refresh-map'})).status,403);
});

test('Rust HTTP requires both executable and package grants for framework, plugin and configuration tools',async t=>{
 const f=await fixture(t,{games:{[two]:'rust'}}),owner=await f.login('Owner','owner-fixture-password');
 const features=[
  {permission:'application.rust.framework.manage',actions:['install-framework','recover-framework'],routes:[['POST','/mods-plan']]},
  {permission:'application.rust.plugins.manage',actions:['plugin','mod-library-install','mod-library-recover'],routes:[['GET','/mod-library'],['POST','/mod-library-plan']]},
  {permission:'application.rust.plugins.configure',actions:['plugin-config'],routes:[['GET','/plugin-config']]},
 ];
 let revision=0;
 for(const feature of features)for(const grants of [[feature.permission],['mods.manage'],['mods.manage',feature.permission]]){
  assert.equal((await f.request(owner,'/api/accounts',{username:'Assigned',operation:'grants',grants:{[two]:['server.view',...grants]},revision:revision++,confirm:true})).status,200);
  const user=await f.login('Assigned','member-fixture-password'),session=await(await f.request(user,two+'/api/session')).json();
  assert.deepEqual(session.allowedActions.sort(),grants.length===2?[...feature.actions].sort():[]);
  for(const target of features){
   const allowed=target===feature&&grants.length===2;
   for(const action of target.actions){
    const before=f.calls.filter(call=>call.method==='POST').length;
    assert.equal((await f.request(user,two+'/api/jobs',{action,params:{confirm:true}})).status,allowed?202:403);
    assert.equal(f.calls.filter(call=>call.method==='POST').length,before+(allowed?1:0));
   }
   for(const [method,route] of target.routes)assert.equal((await f.request(user,two+'/api'+route,method==='POST'?{framework:'oxide'}:undefined)).status,allowed?200:403);
  }
  assert.equal((await f.request(user,two+'/api/jobs',{action:'start'})).status,403);
  assert.equal((await f.request(user,one+'/api/map')).status,404);
 }
});


test('only the root administrator can save release preferences and scoped servers stay disabled',async t=>{
 const realFetch=globalThis.fetch;let checks=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).startsWith('https://api.github.com/')){checks++;return new Response(JSON.stringify([]));}
  return realFetch(url,options);
 });
 const f=await fixture(t),owner=await f.login('Owner','owner-fixture-password'),member=await f.login('Assigned','member-fixture-password'),viewer=await f.login('Viewer','viewer-fixture-password');
 const settings=await(await f.request(owner,'/api/updates/settings')).json();
 assert.equal(settings.editable,true);assert.equal(settings.enabled,false);assert.equal(checks,0);
 for(const user of [member,viewer])for(const body of [undefined,{enabled:true,channel:'preview',revision:0}])assert.equal((await f.request(user,'/api/updates/settings',body)).status,403);
 assert.equal((await f.request(owner,'/api/updates/settings',{enabled:true,channel:'stable',revision:0})).status,200);
 assert.equal((await f.request(owner,'/api/updates/check',{})).status,200);assert.equal(checks,1);
 assert.equal((await f.request(owner,'/api/updates/settings',{enabled:false,channel:'preview',revision:0})).status,409);
 const scoped=await(await f.request(owner,one+'/api/updates/settings')).json();assert.equal(scoped.editable,false);assert.equal(scoped.enabled,false);
 assert.equal((await f.request(owner,one+'/api/updates/settings',{enabled:true,channel:'stable',revision:0})).status,403);
 assert.equal((await(await f.request(owner,one+'/api/updates/check',{})).json()).state,'disabled');assert.equal(checks,1);
 await f.request(owner,'/api/updates/settings',{enabled:false,channel:'preview',revision:1});
 assert.equal((await(await f.request(owner,'/api/updates/check',{})).json()).state,'disabled');assert.equal(checks,1);
 const wrong={...owner,session:{...owner.session,csrf:'invalid'}};
 assert.equal((await f.request(wrong,'/api/updates/settings',{enabled:true,channel:'preview',revision:2})).status,403);
});
