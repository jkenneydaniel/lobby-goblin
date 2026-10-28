import {collectableHostWorker} from '../fleet/worker-lifecycle.js';
import {assert,readJSON,writeJSON,redact} from '../common.js';
import {daemonPath} from '../update-source.js';
import {demultiplex} from './docker.js';
import path from 'node:path';

// Recheck immutable IDs. No force or volume flags: Docker refuses a concurrent start.
export async function removeStoppedContainer(docker,info,authorize){
 const current=await docker('GET','/containers/'+encodeURIComponent(info.Id)+'/json').catch(error=>{if(error.status!==404)throw error;return null;});
 if(!current)return false;
 assert(current.Id===info.Id,'Cleanup container identity changed.',409);
 if(current.State?.Running||current.State?.Restarting||current.State?.Paused||!['created','exited','dead'].includes(current.State?.Status))return false;
 if(!await authorize(current))return false;
 try{await docker('DELETE','/containers/'+encodeURIComponent(current.Id));return true;}catch(error){if([404,409].includes(error.status))return false;throw error;}
}
export async function cleanupUpdateWorkers({docker,root,jobs,now=Date.now}){
 let removed=0;
 for(const job of jobs){
  if(!['succeeded','failed','interrupted'].includes(job.state)||!job.finished||!job.root||!job.project)continue;
  if(!Number.isFinite(Date.parse(job.finished))||job.state!=='succeeded'&&now()-Date.parse(job.finished)<24*3600000)continue;
  for(const slug of ['lobby-goblin','factory-control']){
   const worker=await docker('GET','/containers/'+slug+'-update-'+job.id+'/json').catch(error=>{if(error.status!==404)throw error;return null;});
   if(!worker?.Id)continue;
   const authorize=info=>{
    const labels=info.Config?.Labels||{},env=info.Config?.Env||[];
    return labels[slug+'.update']===job.id&&labels['com.'+slug+'.project']===job.project&&env.includes('UPDATE_JOB='+job.id)&&env.includes('UPDATE_ROOT='+job.root)&&info.Mounts?.some(m=>m.Type==='bind'&&m.Destination===job.root&&daemonPath(m.Source)===job.root);
   };
   if(!authorize(worker)||worker.State?.Running)continue;
   if(job.state!=='succeeded'){
    const logs=await docker('GET','/containers/'+worker.Id+'/logs?stdout=1&stderr=1&tail=100',undefined,{raw:true});
    const current=await readJSON(path.join(root,job.id+'.json'),null);
    if(!current||current.state!==job.state)continue;
    current.workerLog=redact(demultiplex(logs)).slice(-16384);await writeJSON(path.join(root,job.id+'.json'),current);
   }
   if(await removeStoppedContainer(docker,worker,authorize))removed++;
  }
 }
 return removed;
}
export async function cleanupFleetContainers(manager){
 if(manager.active||manager.cleaningContainers)return {removed:0};
 manager.cleaningContainers=true;let removed=0;
 try{
  await manager.assertHost();
  const filters=encodeURIComponent(JSON.stringify({label:['io.lobby-goblin.fleet='+manager.fleet,'io.lobby-goblin.worker=true']}));
  for(const worker of await manager.docker('GET','/containers/json?all=1&filters='+filters)){
   if(manager.active)break;
   let receipt;
   if(await removeStoppedContainer(manager.docker,worker,info=>!manager.active&&!!(receipt=collectableHostWorker(manager,info)))){receipt.phase='removed';await manager.persist();removed++;}
  }
  for(const item of manager.state.servers){
   if(manager.active)break;
   const journal=await readJSON(path.join(manager.root,'migrations',item.id+'.json'),null);
   if(journal?.phase!=='complete'||!journal.backup||!journal.originalId||item.image!==journal.target||item.state==='removed')continue;
   const current=await manager.ownedContainer(item.container,item.id);
   if(current.Image!==journal.imageId||current.Config.Image!==journal.target||current.Id===journal.originalId)continue;
   const original=await manager.docker('GET','/containers/'+journal.originalId+'/json').catch(error=>{if(error.status!==404)throw error;return null;});
   if(!original)continue;
   if(await removeStoppedContainer(manager.docker,original,info=>!manager.active&&info.Name==='/'+journal.retain&&info.HostConfig?.RestartPolicy?.Name==='no'&&info.Config?.Labels?.['io.lobby-goblin.fleet']===manager.fleet&&info.Config.Labels['io.lobby-goblin.instance']===item.id&&info.Mounts?.some(m=>m.Type==='volume'&&m.Name===item.volume&&m.Destination===(item.game==='rust'?'/steamcmd/rust':'/factorio'))))removed++;
  }
  return {removed};
 }finally{manager.cleaningContainers=false;}
}
