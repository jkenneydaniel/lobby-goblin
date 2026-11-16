import {writeUpdateRecord,updateOperationSource} from './update-operations.js';
import {legacySlug,releasePrefixes,canonicalRepository} from '../../branding.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert,readJSON,writeJSON} from '../../common.js';
import {ReleaseChecks} from '../../updates.js';
import {daemonPath} from '../../update-source.js';
import {gameUpdate} from './public/game-images.js';
import {cleanupUpdateWorkers} from '../../core/container-cleanup.js';

const busyStates=new Set(['preparing','running','recovering']);
export class UpdateManager{
  constructor({root='/updates',docker,backup,canInstall=()=>true,waitIdle=async()=>{},current,repository=process.env.RELEASE_REPOSITORY||'jkenneydaniel/lobby-goblin',channel=process.env.RELEASE_CHANNEL||'preview',names={game:process.env.FACTORIO_CONTAINER||'factorio-server',controller:process.env.CONTROLLER_CONTAINER||'factorio-panel-controller',panel:process.env.PANEL_CONTAINER||'factorio-panel'},fetcher=fetch,now=Date.now,record=async()=>{}}={}){
    repository=canonicalRepository(repository);
    Object.assign(this,{root,docker,backup,canInstall,waitIdle,current,repository,channel,names,fetcher,now,record});
    this.releases=new ReleaseChecks({current,repository,channel,fetcher,enabled:process.env.RELEASE_CHECKS!=='false'});this.jobs=[];this.reserved=false;
  }
  operationSource(){return updateOperationSource(this);}
  get busy(){return this.reserved||this.jobs.some(j=>busyStates.has(j.state));}
  get pendingReview(){return this.jobs.find(job=>job.recovery?.interrupted&&!job.recovery.acknowledged);}
  get pendingRestore(){return this.jobs.find(j=>j.recovery?.requiresWorldRestore);}
  async restored(name){for(const job of this.jobs)if(job.recovery?.requiresWorldRestore&&job.backup===name){job.recovery.requiresWorldRestore=false;job.recovery.action='Pre-update backup explicitly restored by an administrator.';await writeUpdateRecord(path.join(this.root,job.id+'.json'),job);}}
  async init(){await fs.mkdir(this.root,{recursive:true});await this.refresh({recover:true});}
  async refresh(options){
    try {
      const status=await this.refreshJobs(options);
      this.refreshError=null;
      return status;
    } catch (error) {
      this.refreshError=error;
      throw error;
    }
  }
  async refreshJobs({recover=true}={}){
    const names=(await fs.readdir(this.root)).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n));
    this.jobs=(await Promise.all(names.map(n=>readJSON(path.join(this.root,n),null)))).filter(Boolean).sort((a,b)=>b.started.localeCompare(a.started)).filter((job,index)=>index<30||busyStates.has(job.state)||job.recovery?.requiresWorldRestore||job.recovery?.interrupted&&!job.recovery.acknowledged);
    if(recover&&!this.reserved)for(const job of this.jobs)if(busyStates.has(job.state)){
      let worker=null;
      for(const slug of ['lobby-goblin',legacySlug]){worker=await this.docker('GET',`/containers/${slug}-update-${job.id}/json`).catch(e=>{if(e.status===404)return null;throw e;});if(worker)break;}
      if(!worker?.State?.Running){const latest=await readJSON(path.join(this.root,job.id+'.json'),job);if(!busyStates.has(latest.state))continue;job.state='failed';job.recovery={...job.recovery,interrupted:true};job.message='Update worker was interrupted. Review recovery details before retrying.';job.finished=new Date(this.now()).toISOString();await writeUpdateRecord(path.join(this.root,job.id+'.json'),job);}
    }
    if(!this.reserved&&!this.cleaning&&this.now()-(this.lastCleanup||0)>=60000){
      this.cleaning=true;this.lastCleanup=this.now();
      try{await cleanupUpdateWorkers({docker:this.docker,root:this.root,jobs:(await Promise.all(names.map(n=>readJSON(path.join(this.root,n),null)))).filter(Boolean),now:this.now});}
      catch(error){console.error('Update container cleanup deferred:',error.message);}
      finally{this.cleaning=false;}
    }
    for(const job of this.jobs)if(['succeeded','failed'].includes(job.state))await this.record({action:'operation.'+(job.kind==='game'?'game-image-update':'panel-update'),actor:job.actor,requestId:job.id,operationId:job.id,outcome:job.recovery?.interrupted?'interrupted':job.state});
    return this.status();
  }
  status(){return {busy:this.busy,jobs:this.jobs.map(({id,kind,target,state,message,started,finished,backup,recovery,targetImage,resolvedImage})=>({id,kind,target,state,message,started,finished,backup,recovery,targetImage,resolvedImage}))};}
  async review({id,operation,confirm},actor){
    assert(!this.reserved,'Another update or recovery is in progress.',409);this.reserved=true;
    try{
      await this.refresh({recover:false});
      const job=this.jobs.find(job=>job.id===id);
      assert(job&&!busyStates.has(job.state)&&(job.recovery?.requiresWorldRestore||job.recovery?.interrupted&&!job.recovery.acknowledged),'This update no longer needs review.',409);
      for(const slug of ['lobby-goblin',legacySlug]){let worker;try{worker=await this.docker('GET',`/containers/${slug}-update-${id}/json`);}catch(error){if(error.status!==404)throw error;}assert(!worker?.State?.Running,'Wait for the update worker to stop before reviewing.',409);}
      const next=structuredClone(job);
      if(operation==='inspect')Object.assign(next.recovery,{checkedAt:new Date(this.now()).toISOString(),checkedBy:actor});
      else{assert(operation==='acknowledge'&&confirm===true&&job.recovery.checkedAt&&!job.recovery.requiresWorldRestore,'Inspect the update and complete any required world restore before acknowledging.',409);Object.assign(next.recovery,{acknowledged:true,reviewedAt:new Date(this.now()).toISOString(),reviewedBy:actor});}
      await this.record({action:'recovery.update.'+operation,actor,requestId:id,operationId:id,outcome:operation==='inspect'?'review-required':'reviewed'});
      await writeUpdateRecord(path.join(this.root,id+'.json'),next);Object.assign(job,next);return job;
    }finally{this.reserved=false;}
  }
  async installation(){
    const items={};for(const [key,name] of Object.entries(this.names))items[key]=await this.docker('GET',`/containers/${encodeURIComponent(name)}/json`);
    const labels=items.game.Config.Labels||{},project=labels['com.docker.compose.project'];
    assert(items.panel.Image===items.controller.Image,'Panel and controller must use the same installed release image.');
    assert(project&&/^[a-z0-9][a-z0-9_-]*$/.test(project),'In-panel updates require this application’s Compose installation.');
    const mount=items.game.Mounts.find(m=>m.Destination==='/factorio');
    assert(mount?.Type==='bind','Updates require a bind-mounted installation.');
    const root=daemonPath(mount.Source).replace(/\/data$/,'');
    assert(root!==daemonPath(mount.Source),'Expected the installation data/ directory.');
    for(const [key,service] of [['game','factorio'],['controller','panel-controller'],['panel','panel']]){
      const value=items[key].Config.Labels||{};
      assert(value['com.docker.compose.project']===project&&value['com.docker.compose.service']===service,'Container identity does not match this stack.');
      // A worker must mount exactly the host directory that Compose owns.
      assert(daemonPath(value['com.docker.compose.project.working_dir'])===root,'The Compose working directory does not match the data mount. Use the standard local installation layout.');
      const configs=String(value['com.docker.compose.project.config_files']||'').split(',').map(daemonPath);
      assert(configs.length===1&&configs[0]===root+'/compose.yaml','Updates currently require the standard compose.yaml without additional override files.');
    }
    return {root,project,images:Object.fromEntries(Object.entries(items).map(([k,v])=>[k,v.Image])),gameImage:items.game.Config.Image,items};
  }
  async plan(input){
    await this.refresh();assert(!this.busy&&this.canInstall(),'Wait for the current operation before reviewing an update.',409);
    assert(!this.pendingRestore,'Restore the pre-update game backup before reviewing another update.',409);
    assert(!this.pendingReview,'Inspect and acknowledge the interrupted update before reviewing another.',409);
    assert(['panel','game'].includes(input.kind),'Choose panel or Factorio.');
    const install=await this.installation();let target,assets,game;
    if(input.kind==='panel'){
      await this.releases.check({force:true});const release=this.releases.releases.find(r=>r.tag_name===this.releases.result.latest?.tag);
      assert(this.releases.result.available&&release,'No newer eligible panel release is available.');
      target=release.tag_name.replace(/^v/,'');
      assert(!input.target||input.target===target,'Release changed. Review the available release again.');
      const prefix=releasePrefixes(target).find(prefix=>['.source',''].some(bundle=>['.zip','.sha256','.update.json'].every(suffix=>release.assets?.some(a=>a.name===prefix+bundle+suffix&&a.state==='uploaded'))));
      assert(prefix,'This release does not include an in-panel update package.');
      // Old panels still use the legacy ZIP. New installers prefer the complete
      // source bundle, whose paths the old worker does not understand.
      const complete=['.zip','.sha256','.update.json'].every(suffix=>release.assets?.some(a=>a.name===prefix+'.source'+suffix&&a.state==='uploaded'));
      assets={};for(const suffix of ['.zip','.sha256','.update.json']){
        const asset=release.assets?.find(a=>a.name===prefix+(complete?'.source':'')+suffix&&a.state==='uploaded');
        assert(asset,'This release does not include an in-panel update package.');
        assets[suffix]=`https://github.com/${this.repository}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
      }
    }else{
      game=gameUpdate(install.gameImage,input);target=game.target;
    }
    const plan={id:crypto.randomUUID(),created:this.now(),kind:input.kind,target,assets,...game,root:install.root,project:install.project,images:install.images,gameImage:install.gameImage,names:this.names};
    await writeJSON(path.join(this.root,'plan-'+plan.id+'.json'),plan);
    return {id:plan.id,kind:plan.kind,current:plan.kind==='panel'?this.current:install.gameImage,target,targetImage:game?.targetImage,operation:game?.operation,expires:new Date(plan.created+15*60000).toISOString(),impact:plan.kind==='panel'?'The panel and controller reconnect during installation. The game container is not restarted.':'Players disconnect while Factorio is replaced. Clients and mods must support the selected version. A failed replacement leaves the game stopped for explicit backup recovery.',backup:'A verified pre-update world/config/mod backup and an installation recovery copy will be kept.',notes:plan.kind==='game'?(game.operation==='image-change'?'The Factorio version stays the same. Saves, mods, settings, ports and startup options are preserved. ':'Clients must match the chosen game version. ')+ 'Mod upgrades and DLC changes are not included. The target image must be published and pass compatibility checks.':'Modified installation files block installation. Releases requiring unsupported state migrations are refused.'};
  }
  async install(input,actor,{gameOnly=false}={}){
    assert(input.confirm===true&&/^[0-9a-f-]{36}$/.test(input.planId),'Review and confirm the update first.');
    assert(!this.reserved,'Another update is starting.',409);this.reserved=true;
    let job,workerSubmitted=false;
    try{
      // Resolve the saved plan before any refresh, backup or worker effect. A
      // delegated caller cannot relabel an administrator's panel-update plan.
      const plan=await readJSON(path.join(this.root,'plan-'+input.planId+'.json'),null);
      assert(plan&&this.now()-plan.created<15*60000,'Update review expired. Review the update again.');
      assert(!gameOnly||plan.kind==='game','This account can change game images only.',403);
      await this.refresh();assert(!this.jobs.some(j=>busyStates.has(j.state))&&this.canInstall(),'Another operation is in progress.',409);
      assert(!this.pendingRestore,'Restore the pre-update game backup before installing another update.',409);
      assert(!this.pendingReview,'Inspect and acknowledge the interrupted update before installing another.',409);
      const current=await this.installation();assert(JSON.stringify(current.images)===JSON.stringify(plan.images)&&current.gameImage===plan.gameImage&&current.root===plan.root&&current.project===plan.project,'Installed containers changed. Review the update again.',409);
      job={...plan,id:crypto.randomUUID(),actor,started:new Date(this.now()).toISOString(),state:'preparing',message:'Saving and verifying a pre-update backup…'};
      this.jobs.unshift(job);await writeUpdateRecord(path.join(this.root,job.id+'.json'),job);
      await this.waitIdle();job.backup=await this.backup('before-'+plan.kind+'-update');
      job.state='running';job.message='Starting the independent update worker…';await writeUpdateRecord(path.join(this.root,job.id+'.json'),job);
      const source=plan.root+'/.panel-data/updates';
      workerSubmitted=true;
      await this.docker('POST','/containers/create?'+new URLSearchParams({name:'lobby-goblin-update-'+job.id}),{
        Image:current.images.controller,User:'0:0',Entrypoint:['node','/app/update-worker.js'],Cmd:[],Env:['UPDATE_JOB='+job.id,'UPDATE_ROOT='+plan.root,'UPDATE_STATE=/updates'],Labels:{'lobby-goblin.update':job.id,'com.lobby-goblin.project':plan.project},
        HostConfig:{AutoRemove:true,ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:['CHOWN','DAC_OVERRIDE','FOWNER'],SecurityOpt:['no-new-privileges:true'],Memory:1536*1024*1024,Tmpfs:{'/tmp':'rw,nosuid,size=512m'},Mounts:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock'},{Type:'bind',Source:plan.root,Target:plan.root},{Type:'bind',Source:source,Target:'/updates'}],LogConfig:{Type:'json-file',Config:{'max-size':'2m','max-file':'2'}}}
      });
      await this.docker('POST',`/containers/lobby-goblin-update-${job.id}/start`);
      await fs.unlink(path.join(this.root,'plan-'+input.planId+'.json'));
      return this.status().jobs.find(j=>j.id===job.id);
    }catch(error){
      if(job&&workerSubmitted){
        // Docker may have accepted a create/start whose response was lost. The
        // worker owns this record now; never overwrite its progress or outcome.
        const latest=await readJSON(path.join(this.root,job.id+'.json'),null).catch(()=>null);
        if(latest)this.jobs=this.jobs.map(value=>value.id===job.id?latest:value);
        await fs.unlink(path.join(this.root,'plan-'+input.planId+'.json')).catch(()=>{});
        return this.status().jobs.find(value=>value.id===job.id);
      }
      if(job){job.state='failed';job.message=error.message;job.finished=new Date(this.now()).toISOString();await writeUpdateRecord(path.join(this.root,job.id+'.json'),job);}throw error;
    }
    finally{this.reserved=false;}
  }
}
