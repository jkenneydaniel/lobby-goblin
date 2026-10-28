import {agentOperationJournal} from './operation-sources.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert,readJSON,json,requestJSON} from '../common.js';
import {compareVersions,version as parseVersion} from '../updates.js';
import {assertAgentContainer} from './agent-update-worker.js';
import {panelImage,panelRepository,validatePanelImage} from '../core/panel-image.js';

export const agentVersion=async()=>JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
export class AgentUpdater{
 constructor(manager,{enabled=false,now=Date.now}={}){this.manager=manager;this.enabled=enabled&&!manager.broker;this.now=now;this.file=path.join(manager.root,'agent-update.json');this.journal=agentOperationJournal(this.file);this.plans=new Map();this.busy=false;}
 async status(){
  let state=await readJSON(this.file,null);
  if(state?.state==='running'&&!this.busy){
   let worker,known=false;try{worker=await this.manager.docker('GET','/containers/lobby-goblin-agent-update-'+state.id+'/json');known=true;}catch(error){if(error.status===404)known=true;}
   if(known&&!worker?.State?.Running){state=await readJSON(this.file,null);if(state?.state==='running'){state.state='attention';state.message='Agent update was interrupted. Recover the previous management containers before changing this host.';await this.journal.write(state);}}
  }
  if(state&&['complete','failed','attention'].includes(state.state))await this.manager.audit?.appendOnce({action:'operation.agent-update',actor:state.recoveryActor||state.actor,requestId:state.id,operationId:state.id,scope:'host:'+this.manager.fleet,outcome:state.state==='complete'?'succeeded':state.state==='attention'?'interrupted':'failed'});
  return {version:await agentVersion(),supported:this.enabled&&(!this.coordinated||['running','attention'].includes(state?.state)),update:state?{id:state.id,state:state.state,message:state.message,target:state.target,rolledBack:state.rolledBack||false}:null};
 }
 async plan(input){
  assert(!this.coordinated,'Use the coordinated management update controls under Updates.',409);
  assert(this.enabled,this.manager.broker?'This isolated host requires a reviewed operator update of its broker and management services. No game restart is required.':'Update this host’s full panel through its own installation. Agent-only hosts support updates here.',409);
  assert(!this.manager.active&&!this.manager.settingsUpdating&&!this.busy,'Wait for the host operation to finish.',409);
  const current=await this.status();assert(!current.update||['complete','failed'].includes(current.update.state),'An agent update needs attention. Recover it before starting another.',409);
  assert(typeof input?.version==='string'&&/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(input.version)&&parseVersion(input.version),'Choose a published panel version.');
  assert(compareVersions(input.version,current.version)>0,'The agent is already current or newer. Update the panel first if it is behind.',409);
  const controller=await this.manager.docker('GET','/containers/'+this.manager.hostContainer+'/json');assert(controller.Config?.Labels?.['io.lobby-goblin.fleet']===this.manager.fleet&&controller.Config.Labels['io.lobby-goblin.role']==='host-controller','Host controller ownership changed.',409);
  const web=await this.manager.docker('GET','/containers/lobby-goblin-agent-'+this.manager.fleet+'/json');assert(web.Config?.Labels?.['io.lobby-goblin.fleet']===this.manager.fleet&&web.Config.Labels['io.lobby-goblin.role']==='host-agent-web','Host agent ownership changed.',409);
  const plan={id:crypto.randomBytes(16).toString('hex'),current:current.version,version:input.version,target:panelImage(input.version),expires:this.now()+15*60000,containers:[{id:controller.Id,name:this.manager.hostContainer,role:'host-controller'},{id:web.Id,name:'lobby-goblin-agent-'+this.manager.fleet,role:'host-agent-web'}]};
  for(const [id,entry] of this.plans)if(entry.expires<this.now())this.plans.delete(id);assert(this.plans.size<20,'Too many pending agent reviews.',409);this.plans.set(plan.id,plan);return {...plan,containers:undefined,message:'Only the host controller and agent will restart. Game containers, storage and worlds stay in place.'};
 }
 async apply(input,actor='system'){
  assert(!this.busy&&!this.manager.active&&!this.manager.settingsUpdating&&(!this.manager.agentUpdating||input?.recover===true),'Wait for the host operation to finish.',409);this.busy=true;
  try{
   assert(this.enabled&&input?.confirm===true,'Confirm the agent update.');assert(!this.coordinated||input.recover===true,'Use the coordinated management update controls under Updates.',409);const previous=await readJSON(this.file,null);
   let state;
   if(input.recover===true){
    assert(previous&&['running','attention'].includes(previous.state),'There is no interrupted agent update to recover.',409);
    let worker;try{worker=await this.manager.docker('GET','/containers/lobby-goblin-agent-update-'+previous.id+'/json');}catch(error){if(error.status!==404)throw error;}
    assert(!worker?.State?.Running,'The agent update helper is still running. Wait for it to finish.',409);
    if(worker){assert(worker.Config?.Labels?.['io.lobby-goblin.fleet']===this.manager.fleet&&worker.Config.Labels['io.lobby-goblin.role']==='agent-updater','The update helper changed. Inspect recovery manually.',409);await this.manager.docker('DELETE','/containers/'+worker.Id);}
    state={...previous,recoveryActor:actor,recover:true,state:'running',message:'Recovering previous agent containers…'};
   }
   else{
    const plan=this.plans.get(input.planId);assert(plan&&plan.expires>this.now(),'This agent update review expired. Review it again.',409);assert(!previous||['complete','failed'].includes(previous.state),'An agent update needs recovery.',409);
    for(const item of plan.containers){const current=await this.manager.docker('GET','/containers/'+item.name+'/json');assert(current.Id===item.id,'The agent changed since review. Review the update again.',409);}
    state={...plan,actor,started:new Date(this.now()).toISOString(),fleet:this.manager.fleet,stateVolume:this.manager.stateVolume,state:'running',message:'Preparing the matching runtime image…',entries:[]};this.plans.delete(plan.id);
   }
   await this.journal.write(state);this.manager.agentUpdating=true;
   void(async()=>{try{
    let helperImage;
    if(state.recover){
     // Recovery restores saved originals; it must work when the target image
     // or registry is unavailable. Run the helper from this owned controller.
     const current=await this.manager.docker('GET','/containers/'+this.manager.hostContainer+'/json');assertAgentContainer(current,state,{role:'host-controller'});
     assert(/^sha256:[a-f0-9]{64}$/.test(current.Image),'The current agent runtime is unavailable for recovery.',409);helperImage=current.Image;
    }else{
     const tag=state.target;await this.manager.docker('POST','/images/create?'+new URLSearchParams({fromImage:tag}),undefined,{raw:true,timeout:900000});
     const image=await this.manager.docker('GET','/images/'+encodeURIComponent(tag)+'/json'),verified=validatePanelImage(image,state.version);assert(image.Architecture==='amd64','Game-host agents require an amd64 runtime.',409);state.target=panelRepository+'@'+verified.split('@')[1];state.imageId=image.Id;await this.journal.write(state);helperImage=image.Id;
    }
    const worker='lobby-goblin-agent-update-'+state.id;
    // The helper owns no game mounts and remains alive while its parent restarts.
    await this.manager.docker('POST','/containers/create?'+new URLSearchParams({name:worker}),{Image:helperImage,User:'0:0',Entrypoint:['node','/app/fleet/agent-update-worker.js'],Env:['FLEET_ID='+this.manager.fleet],Labels:{'io.lobby-goblin.fleet':this.manager.fleet,'io.lobby-goblin.role':'agent-updater'},HostConfig:{AutoRemove:true,RestartPolicy:{Name:'no'},NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Memory:256*1024**2,Mounts:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock'},{Type:'volume',Source:this.manager.stateVolume,Target:'/fleet'}]}});
    await this.manager.docker('POST','/containers/'+worker+'/start');
   }catch(error){
    // A lost start response can leave a live helper. Never unlock host changes
    // until its absence is known; it may already be replacing management services.
    let worker,absent=false;try{worker=await this.manager.docker('GET','/containers/lobby-goblin-agent-update-'+state.id+'/json');}catch(probe){absent=probe.status===404;}
    if(worker?.State?.Running)return;
    state=await readJSON(this.file,state);if(['complete','failed'].includes(state.state))return;
    state.state=absent&&!state.entries?.length?'failed':'attention';state.message=state.state==='attention'?'Agent update needs recovery. Management containers and storage were retained. Check Docker, then recover the agent.':'Agent update could not start. Check its image and Docker state before retrying.';await this.journal.write(state);this.manager.agentUpdating=state.state==='attention';
   }
   finally{this.busy=false;}
   })().catch(()=>{this.busy=false;this.manager.agentUpdating=true;});
   return {id:state.id,state:'running',message:'Agent update started. The host will reconnect after its management services restart.'};
  }catch(error){this.busy=false;throw error;}
 }
 async handle(req,res,url){
  if(url.pathname==='/agent-status'){assert(req.method==='GET','Not found.',404);json(res,200,await this.status());return true;}
  if(url.pathname==='/agent-update-plan'){assert(req.method==='POST','Not found.',404);json(res,200,await this.plan(await requestJSON(req)));return true;}
  if(url.pathname==='/agent-update'){assert(req.method==='POST','Not found.',404);json(res,202,await this.apply(await requestJSON(req),req.headers['x-panel-user']||'administrator'));return true;}return false;
 }
}
