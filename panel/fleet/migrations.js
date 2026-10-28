import path from 'node:path';
import {retainOperationDiagnostic} from '../core/operation-diagnostics.js';
import {imageMigrationAttempt} from '../core/migration-history.js';
import {assert,readJSON,writeJSON,sleep} from '../common.js';
import {migrationImage,ownedImage,ownedImages} from '../core/game-images.js';
import {migrateImage,replacementSpec} from '../core/image-migration.js';
import {selectedApplication} from '../applications/index.js';
export async function controllerJob(manager,item,action){
 const queued=await manager.request(item,'/jobs',{action,params:{confirm:true},actor:'automatic image migration'});
 for(let n=0;n<1800;n++){
  const value=await manager.request(item,'/jobs'),job=value.jobs.find(j=>j.id===queued.id);
  if(job&&!['running','queued'].includes(job.state)&&!value.active){assert(job.state==='succeeded','The pre-migration '+action+' failed. Existing data was preserved.',409);return job;}
  await sleep(1000);
 }
 throw Error('The pre-migration operation has not completed. Check the server before retrying.');
}
export async function migrateFleet(manager){
 const definition=item=>manager.module?.(item.game)||selectedApplication(item.game);
 const candidates=manager.state.servers.filter(item=>item.state!=='removed'&&definition(item).managed.legacyMigration&&(!ownedImage(item.game,item.image)||migrationImage(item.game,item.image)||item.migration?.state==='pending'));
 if(!candidates.length)return;
 assert(!manager.active,'Another host operation is running.',409);
 const job={...imageMigrationAttempt(),action:'image-migration',actor:'system',state:'running',started:new Date().toISOString(),message:'Migrating existing game images…'};
 const previousJobs=manager.state.jobs;manager.active=job;manager.state.jobs=[job,...previousJobs];
 try{await manager.persist();}catch(error){manager.state.jobs=previousJobs;manager.active=null;throw error;}
 try{for(const item of candidates){
  item.maintenance='Migrating game image';item.migration={state:'pending'};await manager.persist();
  try{
   const file=path.join(manager.root,'migrations',item.id+'.json');await manager.ownedVolume(item.volume,item.id);await manager.ownedNetwork(item.network,item.id);
   const owned=async info=>{const value=await manager.ownedContainer(info.Id,item.id);assert(value.Config.Labels['io.lobby-goblin.game']===item.game&&info.Mounts?.some(m=>m.Type==='volume'&&m.Name===item.volume&&m.Destination===definition(item).managed.dataTarget&&info.HostConfig?.Mounts?.some(v=>v.Source===item.volume&&v.Target===m.Destination&&v.VolumeOptions?.Subpath==='data')),'Game storage does not match its registry.',409);};
   await migrateImage({docker:manager.docker,name:item.container,game:item.game,target:ownedImages[item.game],journal:await readJSON(file,null),save:state=>writeJSON(file,state),owned,
    backupStop:async()=>{const backup=await controllerJob(manager,item,'backup');assert(/^Backup created: [A-Za-z0-9_.-]+\.(zip|tar\.gz)$/.test(backup.result),'Migration backup was not verified.',409);await controllerJob(manager,item,'stop');const child=await manager.ownedContainer(item.controller,item.id);if(child.State.Running)await manager.docker('POST','/containers/'+item.controller+'/stop?t=30');return backup.result.slice('Backup created: '.length);},
    configured:async state=>{
     let controller;try{controller=await manager.ownedContainer(item.controller,item.id);}catch(error){if(error.status!==404||!state.controllerOriginal)throw error;}
     if(!state.controllerOriginal){state.controllerOriginal=controller;await writeJSON(file,state);}
     const template=state.controllerOriginal;assert(template.Mounts?.some(m=>m.Type==='volume'&&m.Name===item.volume&&m.Destination==='/instance'),'Controller storage changed.',409);
     if(!controller||controller.Image!==manager.runtimeImage||!controller.Config.Env.includes('RUST_IMAGE='+state.target)){
      if(controller?.State.Running)await manager.docker('POST','/containers/'+item.controller+'/stop?t=30');
      if(controller)await manager.docker('DELETE','/containers/'+item.controller);
      await manager.docker('POST','/containers/create?'+new URLSearchParams({name:item.controller}),replacementSpec(template,manager.runtimeImage,{env:{RUST_IMAGE:state.target,IMAGE_MIGRATION_BACKUP:state.backup}}));
     }
     const current=await manager.ownedContainer(item.controller,item.id);if(!current.State.Running)await manager.docker('POST','/containers/'+item.controller+'/start');
     item.image=state.target;await manager.persist();
    },
    ready:async()=>{for(let n=0;n<900;n++){try{if((await manager.request(item,'/status')).ready)return;}catch{}await sleep(2000);}throw Error('The migrated game did not report readiness. Its backup and original stopped container were retained.');}
   });item.migration={state:'complete'};item.state='installed';
  }catch(error){let phase='preflight';try{const journal=await readJSON(path.join(manager.root,'migrations',item.id+'.json'),null);if(['backup','replace','verify','complete'].includes(journal?.phase))phase=journal.phase;}catch{}
   const failure=await retainOperationDiagnostic(manager.root,error,{id:job.id,source:'image-migration-'+item.id,phase,fallback:'image-migration-failed'});item.migration={state:'pending',message:failure.message+' '+failure.action,failure};item.state='attention';job.state='failed';job.failure=failure;}
  finally{if(item.migration.state==='complete')delete item.maintenance;else item.maintenance='Image migration needs attention';await manager.persist();}
 }}finally{if(job.state==='running')job.state='succeeded';job.message=job.state==='succeeded'?'Game image migrations completed.':job.failure?job.failure.message+' '+job.failure.action:'An image migration needs attention. Stored data was preserved.';job.finished=new Date().toISOString();manager.active=null;await manager.persist();}
}
