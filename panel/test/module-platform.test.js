import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startController} from '../core/controller.js';
import {startWeb} from '../core/web.js';
import {Accounts} from '../core/accounts.js';
import {action,publicContract} from '../core/game-contract.js';
import {validateApplicationModule} from '../core/application-module.js';
import {validateManagedGame} from '../core/managed-game.js';
import {ownedDocker} from '../core/owned-docker.js';
import {permissionCatalogFor,normalizeGrants,requireServerPermission} from '../core/permissions.js';
import {ensureGameImage,imageMatch,validateImagePolicy} from '../core/image-policy.js';
import {selectedApplication} from '../applications/index.js';
import {hashPassword} from '../auth.js';
import {writeJSON} from '../common.js';
import {arena,imagePolicy} from './fixtures/arena-game.js';
import {waitForIdleJob} from './fixtures.js';

test('a third game delegates a new action through real web/controller authorization without core policy edits',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-platform-module-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const module=arena(root),auth=path.join(root,'auth'),token=path.join(root,'token');
  await fs.mkdir(auth);await fs.writeFile(token,'arena-controller-secret');
  await writeJSON(path.join(auth,'users.json'),{
    Assigned:{...hashPassword('assigned-fixture-password'),role:'member',grants:normalizeGrants({standalone:['server.view','game.arena.rotate']},permissionCatalogFor(module))},
    Read:{...hashPassword('readonly-fixture-password'),role:'member',grants:{standalone:['server.view']}},
  });
  const env={CONTROLLER_TOKEN_FILE:token,AUTH_DIR:auth,RELEASE_CHECKS:'false',PANEL_HOSTS:'127.0.0.1'};
  const controller=await startController(module,{env,port:0,hostname:'127.0.0.1',docker:()=>assert.fail('No Docker in this fixture')});
  t.after(()=>new Promise(resolve=>{controller.closeAllConnections();controller.close(resolve);}));
  const web=await startWeb(module,{env:{...env,CONTROLLER_URL:'http://127.0.0.1:'+controller.address().port},port:0,hostname:'127.0.0.1'});
  t.after(()=>new Promise(resolve=>{web.closeAllConnections();web.close(resolve);}));
  const origin='http://127.0.0.1:'+web.address().port;
  async function login(username,password){
    const res=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(res.status,200);return {session:await res.json(),cookie:res.headers.get('set-cookie').split(';')[0]};
  }
  const assigned=await login('Assigned','assigned-fixture-password'),read=await login('Read','readonly-fixture-password');
  assert.deepEqual(assigned.session.allowedActions,['rotate']);assert.deepEqual(read.session.allowedActions,[]);
  const headers=user=>({origin,cookie:user.cookie,'content-type':'application/json','x-csrf-token':user.session.csrf});
  const submit=user=>fetch(origin+'/api/jobs',{method:'POST',headers:headers(user),body:JSON.stringify({action:'rotate'})});
  assert.equal((await submit(read)).status,403);
  const accepted=await submit(assigned);assert.equal(accepted.status,202);const job=await accepted.json();
  const result=await waitForIdleJob(async()=>{const response=await fetch(origin+'/api/jobs',{headers:headers(assigned)});return response.json();},job.id);
  assert.equal(result.state,'succeeded');assert.equal(result.actor,'Assigned');
  const metadata=await(await fetch(origin+'/api/capabilities',{headers:headers(assigned)})).json();
  assert.deepEqual(metadata.screens,module.contract.screens);assert.equal(metadata.policy.permissions['game.arena.rotate'],'Rotate the arena');
  const presentation=await(await fetch(origin+'/application-definition.json')).json();assert.deepEqual(presentation.presentation,module.presentation);
  const entry=await fetch(origin+'/app.js');assert.equal(entry.status,200);assert.match(await entry.text(),/application\/app.js/);assert.equal(Object.hasOwn(module.web.assets,'/screens.js'),false);
  assert.equal((await fetch(origin+'/api/score',{headers:headers(assigned)})).status,200);
  assert.throws(()=>requireServerPermission({role:'member',grants:{standalone:['server.view','mods.manage']}},'standalone','POST','/jobs',{module,action:'rotate'}),error=>error.status===403);
});

test('module v2 rejects incomplete, cross-module, undefined and reserved policy declarations',()=>{
  const module=arena('/unused');validateApplicationModule(module);
  const changed=change=>({...module,contract:{...module.contract,...change}});
  for(const value of [
    changed({policy:undefined}),
    changed({actions:{...module.contract.actions,rotate:{label:'Rotate',confirmation:false,retry:'manual'}}}),
    changed({policy:{...module.contract.policy,permissions:{'game.other.rotate':'Wrong owner'}}}),
    changed({policy:{...module.contract.policy,routes:{'/jobs/recovery':{POST:'server.operate'}}}}),
    changed({policy:{...module.contract.policy,routes:{}}}),
    changed({actions:{...module.contract.actions,backup:action('Backup',false,'manual','server.view')}}),
    changed({screens:[{id:'arena',label:'Arena',permission:'game.arena.missing'}]}),
    changed({screens:[{id:'arena',label:'Arena',actions:['undeclared']}]}),
  ]) assert.throws(()=>validateApplicationModule(value));
  assert.throws(()=>normalizeGrants({standalone:['server.view','game.arena.rotate']}));
  assert.equal(publicContract(module).version,2);
});

test('game image resolution uses declared reference, label, architecture and immutable digest contracts',async()=>{
  validateImagePolicy(imagePolicy);
  const id='sha256:'+'a'.repeat(64),digest='sha256:'+'b'.repeat(64);
  const image={Id:id,Architecture:'amd64',Os:'linux',RepoDigests:['registry.example/arena@'+digest],Config:{Labels:{game:'arena',revision:'1'}}};
  const resolve=value=>ensureGameImage(async()=>value,imagePolicy,imagePolicy.defaultImage);
  assert.equal((await resolve(image)).reference,imagePolicy.defaultImage+'@'+digest);
  for(const value of [{...image,Architecture:'arm64'},{...image,Config:{Labels:{game:'arena',revision:'2'}}},{...image,RepoDigests:['unrelated/arena@'+digest]}])await assert.rejects(resolve(value));
  for(const value of ['registry.example/arena:1-r1@bad','registry.example/arena:1-r1@'+digest+'@other','other/arena:1-r1','registry.example/arena:1-r1\n'])assert.equal(imageMatch(imagePolicy,value),null);
  await assert.rejects(ensureGameImage(async()=>image,imagePolicy,imagePolicy.defaultImage+'@sha256:'+'c'.repeat(64)),/digest changed/);
});
test('removed module permissions can be preserved or revoked without granting them to another scope',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-retired-grants-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const remote='/servers/'+'a'.repeat(32),previous={standalone:['server.view','game.retired.rotate']};
  await writeJSON(path.join(root,'users.json'),{Owner:{role:'admin'},Assigned:{role:'member',grants:previous}});
  const accounts=new Accounts(root);
  await accounts.update({username:'Assigned',operation:'grants',grants:{...previous,[remote]:['server.view']},revision:0,confirm:true});
  assert.deepEqual((await accounts.users()).Assigned.grants.standalone,['game.retired.rotate','server.view']);
  await assert.rejects(accounts.update({username:'Assigned',operation:'grants',grants:{...previous,[remote]:['server.view','game.retired.rotate']},revision:1,confirm:true}),/Unknown/);
  await assert.rejects(accounts.update({username:'Assigned',operation:'grants',grants:{standalone:['server.view','game.retired.new']},revision:1,confirm:true}),/Unknown/);
  await accounts.update({username:'Assigned',operation:'grants',grants:{[remote]:['server.view']},revision:1,confirm:true});
  assert.equal((await accounts.users()).Assigned.grants.standalone,undefined);
});

test('reviewed game helpers use their own executable, naming and read paths within fixed broker limits',async()=>{
  const fleet='a'.repeat(32),id='b'.repeat(32),volume='lobby-goblin-'+fleet+'-'+id;
  const owner={Id:'owner-id',Name:'/arena-game',Image:'sha256:'+'c'.repeat(64),Config:{Image:imagePolicy.defaultImage,Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.instance':id}},
    Mounts:[{Type:'volume',Name:volume,Destination:'/arena'}],HostConfig:{NetworkMode:volume,Mounts:[{Type:'volume',Source:volume,Target:'/arena',VolumeOptions:{Subpath:'data'}}]}};
  const calls=[];
  const engine=async(method,route,data)=>{
    calls.push({method,route,data});
    if(route==='/containers/arena-game/json')return owner;
    if(route.startsWith('/volumes/'))return {Driver:'local',Options:{},Labels:owner.Config.Labels};
    if(route.startsWith('/containers/json'))return [];
    if(route.endsWith('/exec'))return {Id:'exec-id'};
    return {};
  };
  const helpers={container:'arena-game',dataTarget:'/arena',enforceBoundary:true,
    previewWorker:{target:'/arena',root:'state/.work',entrypoint:['/arena/bin/preview'],entrypoints:[['/arena/bin/offline','--fixed']],namePrefixes:['arena-preview-']},
    archiveReadPaths:['/arena/defaults/settings.json'],execCommands:[{executable:'arena-command',arguments:1,maxArgumentBytes:64}]};
  const request=ownedDocker(engine,{FLEET_ID:fleet,FLEET_INSTANCE:id,FLEET_VOLUME:volume},helpers);
  const config={Image:owner.Image,Entrypoint:['/arena/bin/preview'],Cmd:['--render'],Labels:{},HostConfig:{Memory:256*1024**2,NetworkMode:'none',Mounts:[{Type:'volume',Source:volume,Target:'/arena',VolumeOptions:{Subpath:'state/.work/sample'}}]}};
  await request('POST','/containers/create?name=arena-preview-'+'d'.repeat(36),config);
  await request('POST','/containers/create?name=arena-preview-'+'d'.repeat(36),{...config,Entrypoint:['/arena/bin/offline','--fixed']});
  await request('GET','/containers/arena-game/archive?path='+encodeURIComponent('/arena/defaults/settings.json'));
  await request('POST','/containers/arena-game/exec',{Cmd:['arena-command','status'],AttachStdout:true});
  const writes=()=>calls.filter(call=>call.method!=='GET').length,before=writes();
  await assert.rejects(request('POST','/containers/create?name=factorio-panel-preview-'+'d'.repeat(36),config),/identity/);
  await assert.rejects(request('POST','/containers/create?name=arena-preview-'+'d'.repeat(36),{...config,Entrypoint:['/bin/sh']}),/command/);
  await assert.rejects(request('POST','/containers/create?name=arena-preview-'+'d'.repeat(36),{...config,Entrypoint:['/arena/bin/offline','--different']}),/command/);
  await assert.rejects(request('POST','/containers/arena-game/exec',{Cmd:['rcon','status']}),/declared/);
  await assert.rejects(request('GET','/containers/arena-game/archive?path=/etc/passwd'),/settings example/);
  assert.equal(writes(),before);
  const base=selectedApplication('factorio');
  for(const patch of [{execCommands:[{executable:'bad/helper',arguments:1,maxArgumentBytes:64}]},{previewWorker:{...base.managed.previewWorker,namePrefixes:['../escape-']}},{previewWorker:{...base.managed.previewWorker,entrypoints:[[]]}},{previewWorker:{...base.managed.previewWorker,entrypoints:[['/bin/../escape']]}},{archiveReadPaths:['/arena/../etc/passwd']}])
    assert.throws(()=>validateManagedGame({...base,managed:{...base.managed,...patch}}));
});

// The disposable runtime adapter must use the same host interface as real games.
test('the managed Arena fixture uses the shared host lifecycle interface',async()=>{
  const calls=[],module=arena('/unused-arena-fixture');
  const controller=await module.createController({env:{ARENA_LIVE_RUNTIME:'true'},host:{control:async action=>calls.push(action)}});
  await controller.actions.start();await controller.actions.restart();await controller.actions.stop();
  assert.deepEqual(calls,['start','stop','start','stop']);
});
