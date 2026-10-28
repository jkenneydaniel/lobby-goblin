import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './image-migration-fixture.js';
import {migrateFleet} from '../fleet/migrations.js';
import {standaloneInstallation,launchStandaloneMigration,runStandaloneMigration} from '../core/standalone-migration.js';
import {startController} from '../core/controller.js';
import {selectedApplication} from '../applications/index.js';
import {ownedImages} from '../core/game-images.js';
import {writeJSON,readJSON} from '../common.js';
import {fixtureContract} from './fixtures.js';
import {noManagedUpdater} from '../core/managed-updater.js';
const id='b'.repeat(32),volume='test-volume';
async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lg-migration-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function managed(t,game,running){
 const f=fixture(game,{running}),root=await temporary(t),original=f.containers.get('game');
 original.Config.Labels['io.lobby-goblin.game']=game;
 const item={id,game,image:original.Config.Image,container:'game',controller:'controller',volume,network:'private',state:'installed'};
 f.containers.set('controller',{Id:'old-controller',Image:'sha256:panel-old',Config:{Env:['RUST_IMAGE='+original.Config.Image],Labels:{owner:'test'},Entrypoint:['node'],Cmd:['server.js']},HostConfig:{},Mounts:[{Type:'volume',Name:volume,Destination:'/instance'}],State:{Running:true},NetworkSettings:{Networks:{private:{Aliases:['controller']}}}});
 const jobs=[];
 const manager={root,state:{servers:[item],jobs:[]},active:null,runtimeImage:'sha256:panel-new',docker:f.options.docker,
  async persist(){await writeJSON(path.join(root,'registry.json'),this.state);},
  async ownedVolume(){},async ownedNetwork(){},
  async ownedContainer(ref){const value=await this.docker('GET','/containers/'+ref+'/json');assert.equal(value.Config.Labels.owner,'test');return value;},
  async request(server,route,body){
   if(body){jobs.unshift({id:String(jobs.length),state:'succeeded',result:body.action==='backup'?'Backup created: safety-before-image-migration.tar.gz':'Stopped'});if(body.action==='stop')f.containers.get('game').State.Running=false;return jobs[0];}
   if(route==='/jobs')return {jobs,active:null};
   assert.equal(route,'/status');return {ready:f.containers.get('game').State.Running};
  }};
 return {...f,root,manager,item,jobs};
}
for(const game of ['factorio','rust'])for(const running of [true,false])test(`host migration coordinates the ${game} child and preserves ${running?'running':'stopped'} state`,async t=>{
 const f=await managed(t,game,running);await migrateFleet(f.manager);
 assert.equal(f.item.migration.state,'complete');assert.equal(f.manager.active,null);assert.equal(f.item.maintenance,undefined);
 assert.equal(f.item.image.split('@')[0],ownedImages[game]);assert.equal(f.containers.get('game').State.Running,running);
 const controller=f.containers.get('controller');assert.equal(controller.Image,f.manager.runtimeImage);assert.equal(controller.State.Running,true);
 assert.ok(controller.Config.Env.includes('IMAGE_MIGRATION_BACKUP=safety-before-image-migration.tar.gz'));
 const journal=await readJSON(path.join(f.root,'migrations',id+'.json'));assert.equal(journal.phase,'complete');assert.equal(journal.backup,'safety-before-image-migration.tar.gz');
 assert.equal(f.jobs.length,2);await migrateFleet(f.manager);assert.equal(f.jobs.length,2);
});
for(const boundary of ['create','start'])test('host migration resumes after child '+boundary+' interruption without another backup or world replacement',async t=>{
 const f=await managed(t,'rust',true);let once=true;
 f.fail((method,url,data)=>{if(once&&method==='POST'&&(boundary==='create'?url.includes('/containers/create')&&data.Env?.some(v=>v.startsWith('IMAGE_MIGRATION_BACKUP=')):url==='/containers/controller/start')){once=false;return true;}});
 await migrateFleet(f.manager);assert.equal(f.item.migration.state,'pending');assert.match(f.item.maintenance,/attention/);assert.equal(f.jobs.length,2);assert.equal(f.item.migration.failure.phase,'replace');assert.equal(f.item.migration.failure.reference,f.manager.state.jobs[0].id);assert.equal(f.item.migration.failure.retained,true);
 f.fail(null);await migrateFleet(f.manager);assert.equal(f.item.migration.state,'complete');assert.equal(f.containers.get('controller').State.Running,true);assert.equal(f.jobs.length,2);
});
function installation(root,game='factorio'){
 const services=game==='rust'?{game:'rust',controller:'controller',panel:'panel'}:{game:'factorio',controller:'panel-controller',panel:'panel'};
 const mounts=game==='rust'?{game:[['/steamcmd/rust','/data']],controller:[['/rust-server','/data/server'],['/rust-state','/control/controller'],['/rust-backups','/backups'],['/run/secrets/controller_token','/control/secrets/controller-token']],panel:[['/auth','/control/auth'],['/run/secrets/controller_token','/control/secrets/controller-token']]}:{game:[['/factorio','/data']],controller:[['/factorio','/data'],['/state','/.panel-data/controller'],['/updates','/.panel-data/updates'],['/backups','/backups'],['/run/secrets/controller_token','/.panel-data/secrets/controller-token']],panel:[['/auth','/.panel-data/auth'],['/run/secrets/controller_token','/.panel-data/secrets/controller-token']]};
 return new Map(Object.entries(services).map(([key,service])=>[key,{Id:key+'-original',Image:'sha256:panel',Config:{Image:key==='game'?'factoriotools/factorio:2.0.77':'panel',Labels:{'com.docker.compose.project':'disposable','com.docker.compose.service':service,'com.docker.compose.project.working_dir':root,'com.docker.compose.project.config_files':root+'/compose.yaml','io.lobby-goblin.game':game,'io.lobby-goblin.instance':id}},Mounts:mounts[key].map(([Destination,source])=>({Type:'bind',Source:root+source,Destination})),State:{Running:true},NetworkSettings:{Networks:{private:{Aliases:[key]}}}}]));
}
test('standalone preflight requires matching Compose identity and exact panel/controller mounts before worker creation',async t=>{
 const root=await temporary(t);
 for(const game of ['factorio','rust']){
  const items=installation(root,game),calls=[];
  const docker=async(method,url,data)=>{calls.push({method,url,data});const name=url.split('/')[2],item=items.get(name);if(method==='GET'){if(!item)throw Object.assign(Error('missing'),{status:404});return item;}if(url.startsWith('/containers/create')){items.set(new URL(url,'http://docker').searchParams.get('name'),{Config:data,State:{Running:true}});return {Id:'worker'};}};
  const names={game:'game',controller:'controller',panel:'panel'};await standaloneInstallation(docker,game,names);
  const original=items.get('panel').Mounts[0].Source;items.get('panel').Mounts[0].Source='/another-installation/auth';
  await assert.rejects(launchStandaloneMigration({docker,game,names}),/storage/);assert.equal(calls.some(c=>c.method==='POST'),false);
  items.get('panel').Mounts[0].Source=original;const name=await launchStandaloneMigration({docker,game,names});await launchStandaloneMigration({docker,game,names});
  assert.match(name,/^lobby-goblin-migration-/);assert.equal(calls.filter(c=>c.url.startsWith('/containers/create')).length,1);
  const spec=calls.find(c=>c.url.startsWith('/containers/create')).data;assert.equal(spec.HostConfig.Mounts[0].Source,root);assert.equal(spec.HostConfig.NetworkMode,'private');
 }
});
test('standalone operation gate clears after worker completion and never blesses a changed container',{timeout:15000},async t=>{
 const root=await temporary(t),state=path.join(root,'state'),updates=path.join(root,'updates'),items=installation(root),token='migration-test-token';await fs.mkdir(state);await fs.mkdir(updates);await fs.writeFile(path.join(root,'token'),token);
 const docker=async(method,url,data)=>{const name=url.split('/')[2],item=items.get(name);if(method==='GET'){if(!item)throw Object.assign(Error('missing'),{status:404});return item;}if(url.startsWith('/containers/create'))items.set(new URL(url,'http://docker').searchParams.get('name'),{Config:data,State:{Running:true}});};
 const updater=noManagedUpdater('fixture');
 const module={managed:selectedApplication('factorio').managed,id:'factorio',name:'fixture',contract:fixtureContract(['increment']),routes:[],web:{...selectedApplication('factorio').web,adminReadRoutes:[]},configuration:()=>({state,backupDir:path.join(root,'backups'),library:path.join(root,'library'),container:'game'}),createUpdater:()=>updater,diagnostics:async()=>({}),async createController(){return {actions:{increment:async()=>{}},async init(){},async start(){},async waitIdle(){},status:async()=>({ready:true}),validateAction(){},async beforeJob(){},async afterJob(){},invalidate(){},recentStatus:()=>null,locations:[],async handle(){},backupFiles:async()=>[],validateBackup:()=>({}),backupVerified:()=>''};}};
 const server=await startController(module,{docker,hostname:'127.0.0.1',port:0,env:{CONTROLLER_TOKEN_FILE:path.join(root,'token'),CONTROLLER_CONTAINER:'controller',PANEL_CONTAINER:'panel',UPDATE_STATE_DIR:updates}});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const call=(body,route='/status')=>fetch('http://127.0.0.1:'+server.address().port+(body?'/jobs':route),{signal:AbortSignal.timeout(3000),method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal((await call({action:'increment'})).status,409);
 for(let n=0;n<30&&!Array.from(items.keys()).some(k=>k.startsWith('lobby-goblin-migration-'));n++)await new Promise(r=>setTimeout(r,100));
 assert.equal(Array.from(items.keys()).filter(k=>k.startsWith('lobby-goblin-migration-')).length,1);
 await writeJSON(path.join(updates,'image-migration.json'),{phase:'complete',target:ownedImages.factorio,imageId:'sha256:new'});
 await new Promise(r=>setTimeout(r,1100));assert.equal((await call({action:'increment'})).status,409,'A false completion must remain blocked');
 items.get('game').Image='sha256:new';items.get('game').Config.Image=ownedImages.factorio;
 await new Promise(r=>setTimeout(r,1100));assert.equal((await (await call()).json()).imageMigration,null);assert.equal((await call({action:'increment'})).status,202);
 // A 202 queues work; wait for persistence and lock release before deleting its
 // temporary state. Otherwise teardown can race the asynchronous job writer.
 let final;for(let n=0;n<100;n++){final=await (await call(null,'/jobs')).json();if(!final.active)break;await new Promise(r=>setTimeout(r,25));}assert.equal(final.active,null);assert.equal(final.jobs[0].state,'succeeded');
});

for(const game of ['factorio','rust'])for(const running of [true,false])test(`standalone ${game} worker updates only its image setting, preserves recovery and ${running?'running':'stopped'} state`,async t=>{
 const root=await temporary(t),f=fixture(game,{running}),layout=installation(root,game),original=f.containers.get('game');
 original.Config.Labels=layout.get('game').Config.Labels;original.Mounts=layout.get('game').Mounts;
 for(const key of ['controller','panel'])f.containers.set(key,{...layout.get(key),Config:{...layout.get(key).Config,Env:['KEEP=this','RUST_IMAGE='+original.Config.Image]},HostConfig:{}});
 const privateDir=game==='rust'?'control/controller':'.panel-data/updates',secretDir=game==='rust'?'control/secrets':'.panel-data/secrets';await fs.mkdir(path.join(root,privateDir),{recursive:true});await fs.mkdir(path.join(root,secretDir),{recursive:true});await fs.writeFile(path.join(root,secretDir,'controller-token'),'private-test-token');
 const before='KEEP=untouched\n'+(game==='rust'?'RUST_IMAGE':'FACTORIO_IMAGE')+'='+original.Config.Image+'\n';await fs.writeFile(path.join(root,'.env'),before,{mode:0o600});
 if(game==='rust')await writeJSON(path.join(root,'installation.json'),{game,instance:id,image:original.Config.Image,keep:'metadata'});
 const jobs=[];const result=await runStandaloneMigration({root,game,names:{game:'game',controller:'controller',panel:'panel'},docker:f.options.docker,fetch:async(url,options)=>{
  assert.equal(options.headers['x-lobby-goblin-migration'],'private-test-token');let value;
  if(options.method==='POST'){const body=JSON.parse(options.body);jobs.unshift({id:String(jobs.length),state:'succeeded',result:body.action==='backup'?'Backup created: preserved.tar.gz':'Stopped'});if(body.action==='stop')f.containers.get('game').State.Running=false;value=jobs[0];}
  else value=url.endsWith('/jobs')?{jobs,active:null}:{ready:f.containers.get('game').State.Running};return {ok:true,json:async()=>value};
 }});
 assert.equal(result.phase,'complete');assert.equal(f.containers.get('game').State.Running,running);assert.equal(f.containers.has('game-pre-lg034'),false);assert.equal(jobs.length,2);
 const after=await fs.readFile(path.join(root,'.env'),'utf8');assert.match(after,/KEEP=untouched/);assert.ok(after.includes((game==='rust'?'RUST_IMAGE':'FACTORIO_IMAGE')+'='+result.target));assert.equal((await readJSON(path.join(root,privateDir,'migration-environment.json'))).environment,before);
 assert.equal((await fs.stat(path.join(root,'.env'))).mode&0o777,0o600);assert.equal((await readJSON(path.join(root,privateDir,'image-migration.json'))).backup,'preserved.tar.gz');
 if(game==='rust'){assert.ok(f.containers.get('controller').Config.Env.includes('RUST_IMAGE='+result.target));assert.ok(f.containers.get('controller').Config.Env.includes('KEEP=this'));assert.equal(f.containers.get('controller').State.Running,true);assert.equal((await readJSON(path.join(root,'installation.json'))).keep,'metadata');}
});
