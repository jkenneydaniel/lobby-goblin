import {hostWorkerLifecycle} from './worker-lifecycle.js';
import {retainOperationDiagnostic} from '../core/operation-diagnostics.js';
import {RetainedStorage} from './retained-manager.js';
import {creationSeedRange} from '../core/managed-game.js';
import {storageWorkerCapabilities,storageWorkerError} from './storage-worker.js';
import {regularFile,parseStorageJSON} from '../core/storage/files.js';
import {creationPreflight} from '../core/creation-preflight.js';
import {publicSoftwareDelivery} from '../core/software-delivery.js';
import {brokerSocket,brokerToken} from '../core/broker-client.js';
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {assert,readJSON,writeJSON,sleep} from '../common.js';import {validId,labels,resources,validateCreation} from './catalog.js';
import {registeredApplications} from '../applications/index.js';
import {gameCatalog,validateManagedGame} from '../core/managed-game.js';
import {selectedRuntime} from '../core/runtime-option.js';
import {verifySnapshot} from './snapshots.js';
import {AuditLog} from '../core/audit.js';
import {Operations} from '../core/operations.js';
import {repairMigrationHistory} from '../core/migration-history.js';
import {RegistryRepository} from '../core/storage/state-repositories.js';
const giB=1024**3;
export class FleetManager{
 constructor({docker,broker=null,brokerVolume,root='/fleet',library='/library',fleet,stateVolume,libraryVolume,image,hostContainer,address='localhost',bind='0.0.0.0',memoryBudgetGiB=16,portBase=35000,gameModules=registeredApplications()}){
  assert(validId(fleet),'FLEET_ID must be a fresh 32-character lowercase hex ID.');assert(stateVolume===`lobby-goblin-fleet-${fleet}-state`&&libraryVolume===`lobby-goblin-fleet-${fleet}-library`,'Unexpected host-manager storage names.');
  assert(typeof image==='string'&&image.length>0,'The host manager image is required.');assert(/^[a-zA-Z0-9.-]+$/.test(address)&&['0.0.0.0','127.0.0.1'].includes(bind),'Invalid LAN address or bind setting.');assert(Number.isInteger(Number(memoryBudgetGiB))&&memoryBudgetGiB>=2&&memoryBudgetGiB<=128,'Memory budget must be 2–128 GiB.');assert(Number.isInteger(Number(portBase))&&portBase>=1024&&portBase<=64000,'Port base must be 1024–64000.');
  this.modules=new Map(gameModules.map(module=>{validateManagedGame(module);return [module.id,module];}));
  assert(this.modules.size===gameModules.length,'Duplicate game module.');
  this.catalog=Object.fromEntries(gameModules.map(module=>[module.id,gameCatalog(module)]));
  if(broker)assert(brokerVolume===`lobby-goblin-fleet-${fleet}-broker-transport`,'Invalid broker transport volume.');
  Object.assign(this,{docker,broker,brokerVolume,root,library,fleet,stateVolume,libraryVolume,image,hostContainer,address,bind,memoryBudgetGiB:Number(memoryBudgetGiB),portBase:Number(portBase)});this.retained=new RetainedStorage(this);this.active=null;this.settingsUpdating=false;this.queue=Promise.resolve();
 }
 module(id){const module=this.modules.get(id);assert(module,'Unsupported game module.');return module;}
 async init(){
  await fs.mkdir(this.root,{recursive:true});await fs.mkdir(this.library,{recursive:true});
  for(const dir of [this.root,this.library]){assert(await fs.realpath(dir)===path.resolve(dir),'Host-manager storage cannot be a link.');const file=path.join(dir,'.fleet-owner.json'),owner=await readJSON(file,null);assert(!owner||owner.fleet===this.fleet,'Host-manager storage belongs to another installation.',409);if(!owner)await writeJSON(file,{fleet:this.fleet});}
  await repairMigrationHistory(this.root);
  this.repository=new RegistryRepository(this.root);this.storageSnapshot=await this.repository.read();this.state=this.storageSnapshot.value;
  if(this.state.settings){assert(Number.isInteger(this.state.settings.memoryBudgetGiB)&&this.state.settings.memoryBudgetGiB>=2&&this.state.settings.memoryBudgetGiB<=128&&Number.isSafeInteger(this.state.settings.revision)&&this.state.settings.revision>=0,'Invalid persisted host settings.',409);this.memoryBudgetGiB=this.state.settings.memoryBudgetGiB;}
  assert(!this.broker||this.state.servers.every(item=>item.state==='removed'||item.isolationVersion===1),'Existing controllers require a reviewed broker upgrade; no resources were adopted.',409);
  for(const item of this.state.servers)delete item.maintenance;
  this.audit=new AuditLog(this.root);
  this.operations=new Operations({failure:(error,job)=>retainOperationDiagnostic(this.root,error,{id:job.id,source:'host-operations',phase:job.phase||'unknown'}),record:event=>this.audit.append({...event,scope:'host:'+this.fleet}),getJobs:()=>this.state.jobs,setJobs:value=>{this.state.jobs=value;},getActive:()=>this.active,setActive:value=>{this.active=value;},
   persist:()=>this.persist(),id:()=>crypto.randomBytes(16).toString('hex'),inspect:job=>this.inspectOperation(job)});
  await this.operations.init();
 }
 persist(state=this.state){const data=structuredClone(state);const next=this.queue.then(()=>this.repository.save(this.storageSnapshot,data));this.queue=next.catch(()=>{});return next;}
 server(id){assert(validId(id),'Invalid server.');const item=this.state.servers.find(s=>s.id===id);assert(item,'Server not found.',404);return item;}
 snapshot(id){assert(validId(id),'Invalid snapshot.');const item=this.state.snapshots.find(s=>s.id===id);assert(item,'Snapshot not found.',404);return item;}
 publicServer(item){const {controllerToken,rconPassword,software,...publicFields}=item;return {...publicFields,...(software?{software:publicSoftwareDelivery(software)}:{}),address:`${this.address}:${item.gamePort}`,manageUrl:`/servers/${item.id}/`};}
 list(){return this.state.servers.filter(s=>s.state!=='removed').map(s=>this.publicServer(s));}
 removedServers(){return this.state.servers.filter(s=>s.state==='removed').map(({id,name,game,volume,created,removedAt,removalSnapshotId,storageDeletedAt,storageStatus,storageReview})=>({id,name,game,volume,created,removedAt,removalSnapshotId,storageDeletedAt,storageStatus,...(storageReview?{storageReview:((({identity:_identity,...review})=>review)(storageReview))}:{})}));}
 allocations(){return this.state.servers.filter(s=>s.state!=='removed').map(s=>({id:s.id,name:s.name,game:s.game,state:s.state,gameGiB:s.memoryGiB,controllerGiB:1,totalGiB:s.memoryGiB+1}));}
 async hostSettings(){
  const allocations=this.allocations(),allocatedMemoryGiB=allocations.reduce((sum,s)=>sum+s.totalGiB,0);let dockerMemoryGiB=null;
  try{const info=await this.docker('GET','/info');if(Number.isFinite(info.MemTotal)&&info.MemTotal>0)dockerMemoryGiB=info.MemTotal/giB;}catch{}
  return {memoryBudgetGiB:this.memoryBudgetGiB,revision:this.state.settings?.revision??0,allocatedMemoryGiB,availableMemoryGiB:Math.max(0,this.memoryBudgetGiB-allocatedMemoryGiB),dockerMemoryGiB,minMemoryBudgetGiB:Math.max(2,allocatedMemoryGiB),maxMemoryBudgetGiB:dockerMemoryGiB===null?null:Math.min(128,Math.max(0,Math.floor(dockerMemoryGiB)-2)),hostHeadroomGiB:2,allocations,updatedAt:this.state.settings?.updatedAt??null};
 }
 async updateHostSettings(input,actor='administrator'){
  assert(!this.operations?.blocked,'Review interrupted host operations before changing the budget.',409);
  assert(!this.active&&!this.settingsUpdating,'Wait for the current host operation to finish before changing the budget.',409);
  this.settingsUpdating=true;
  try{
   assert(input&&typeof input==='object'&&!Array.isArray(input),'Invalid host settings.');
   assert(Number.isSafeInteger(input.revision)&&input.revision===(this.state.settings?.revision??0),'Host settings changed in another session. Reload the current budget before saving.',409);
   const budget=input.memoryBudgetGiB;assert(Number.isInteger(budget)&&budget>=2&&budget<=128,'Choose a whole-number memory budget from 2 to 128 GiB.');
   const current=await this.hostSettings();assert(current.dockerMemoryGiB!==null,'Docker memory capacity is unavailable. Retry when Docker is ready.',503);
   assert(budget>=current.minMemoryBudgetGiB,`Existing servers and their controllers already have ${current.allocatedMemoryGiB} GiB allocated. The budget cannot be lower than that.`,409);
   assert(budget<=current.maxMemoryBudgetGiB,`Choose at most ${current.maxMemoryBudgetGiB} GiB to leave at least 2 GiB of Docker memory for management and other work.`,409);
   const settings={memoryBudgetGiB:budget,revision:current.revision+1,updatedAt:new Date().toISOString(),updatedBy:actor};
   await this.persist({...this.state,settings});this.state.settings=settings;this.memoryBudgetGiB=budget;
   return {...current,...settings,availableMemoryGiB:budget-current.allocatedMemoryGiB};
  }finally{this.settingsUpdating=false;}
 }
 async assertHost(){const info=await this.docker('GET',`/containers/${encodeURIComponent(this.hostContainer)}/json`);assert(info.Config?.Labels?.['io.lobby-goblin.fleet']===this.fleet&&info.Config.Labels['io.lobby-goblin.role']==='host-controller','The manager does not own its configured host container.',409);this.runtimeImage=info.Image;}
 async ownedContainer(name,id){const info=await this.docker('GET',`/containers/${encodeURIComponent(name)}/json`);assert(info.Config?.Labels?.['io.lobby-goblin.fleet']===this.fleet&&info.Config.Labels['io.lobby-goblin.instance']===id,'Container belongs to another installation.',409);return info;}
 async ownedVolume(name,id){const info=await this.docker('GET',`/volumes/${encodeURIComponent(name)}`);assert(info.Labels?.['io.lobby-goblin.fleet']===this.fleet&&info.Labels['io.lobby-goblin.instance']===id,'Volume belongs to another installation.',409);return info;}
 async ownedNetwork(name,id){const info=await this.docker('GET',`/networks/${encodeURIComponent(name)}`);assert(info.Labels?.['io.lobby-goblin.fleet']===this.fleet&&info.Labels['io.lobby-goblin.instance']===id,'Network belongs to another installation.',409);return info;}
 async reconnect(){
  await this.assertHost();const host=await this.docker('GET',`/containers/${encodeURIComponent(this.hostContainer)}/json`);
  for(const item of this.state.servers.filter(s=>s.state!=='removed')){let network;try{network=await this.ownedNetwork(item.network,item.id);}catch(error){if(error.status===404)continue;throw error;}
   if(!Object.hasOwn(network.Containers||{},host.Id))await this.docker('POST',`/networks/${item.network}/connect`,{Container:this.hostContainer,EndpointConfig:{Aliases:[]}});
  }
 }
 async submit(action,input,actor='administrator'){
  assert(input&&typeof input==='object'&&!Array.isArray(input),'Invalid host operation.');
  const {requestId,...originalInput}=input;input=originalInput;
  const previous=this.operations.existing({action,actor,input:originalInput,requestId});if(previous)return this.operations.accepted(previous);
  assert(!this.active&&!this.settingsUpdating&&!this.agentUpdating,'Wait for the current host operation to finish.',409);
  if(action==='create')input=validateCreation(input,[...this.modules.values()]);
  else if(action==='publish'){const s=this.server(input.serverId);assert(!s.migration||s.migration.state==='complete','Complete the game image migration before publishing snapshots.',409);assert(s.state!=='removed'&&input.confirm===true,'Confirm the save and possible server interruption.');assert(typeof input.title==='string'&&input.title.trim().length>=1&&input.title.length<=80&&!/[\x00-\x1f]/.test(input.title),'Use a snapshot title of 1–80 characters.');input={serverId:s.id,title:input.title.trim(),confirm:true};}
  else if(action==='removeSnapshot'){const snapshot=this.snapshot(input.snapshotId);assert(input.confirm===true&&input.title===snapshot.title,'Confirm the snapshot title before deleting it.');input={snapshotId:snapshot.id};}
  else if(action==='remove'){const s=this.server(input.serverId);assert(s.state!=='removed'&&input.confirm===true&&input.name===s.name,'Type the server name to remove its containers.');assert(input.publishSnapshot===undefined||typeof input.publishSnapshot==='boolean','Choose whether to publish a snapshot.');input={serverId:s.id,confirm:true,publishSnapshot:input.publishSnapshot===true};}
  else if(['inspectStorage','deleteStorage','recoverStorage'].includes(action)){const item=this.retained.source(input.serverId);if(action!=='inspectStorage')this.retained.review(item,input);if(action==='recoverStorage')assert(typeof input.newName==='string','Choose a name for the recovered server.');}
  else assert(false,'Unsupported host operation.');
  const {job,duplicate}=await this.operations.reserve({action,actor,input:originalInput,requestId});
  if(!duplicate)void this.operations.execute(job,{before:async()=>{await this.assertHost();if(input.serverId)await this.stage(job,'Checking selected server…','checking',{serverId:input.serverId});},
   run:()=>this[action](input,job),after:async()=>{if(input.serverId)delete this.server(input.serverId).maintenance;}});
  return job;
 }
 async stage(job,message,phase='working',target){await this.operations.checkpoint(job,phase,message,target);}
 async inspectOperation(job){
  if(['inspectStorage','deleteStorage','recoverStorage'].includes(job.action)&&(!job.target?.sourceId)){const item=this.state.servers.find(s=>s.id===job.target?.serverId);if(job.action==='deleteStorage'&&item){try{await this.ownedVolume(item.volume,item.id);}catch(error){if(error.status!==404)throw error;item.storageDeletedAt=new Date().toISOString();item.storageStatus={state:'deleted',checkedAt:item.storageDeletedAt};delete item.storageReview;return {outcome:'succeeded',message:'The reviewed volume is absent. Shared snapshots were kept.',result:{serverId:item.id}};}}return {message:'Storage operation was interrupted. Original storage was not replayed or adopted. Inspect Storage and any partial replacement before retrying.'};}
  if(job.action==='removeSnapshot'){const id=job.target?.snapshotId||job.result?.snapshotId;if(validId(id)){const exists=await fs.lstat(path.join(this.library,id)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!exists){this.state.snapshots=this.state.snapshots.filter(snapshot=>snapshot.id!==id);return {outcome:'succeeded',message:'Snapshot files are absent and its library entry was removed.',result:{snapshotId:id}};}}return {message:'Snapshot deletion needs review. Existing servers and source backups were preserved.'};}
  const item=this.state.servers.find(server=>server.id===(job.target?.serverId||job.result?.serverId));
  if(['create','recoverStorage'].includes(job.action)&&item&&item.state!=='removed'){
   if(item.state==='installed'){
    await this.ownedContainer(item.container,item.id);await this.ownedContainer(item.controller,item.id);await this.ownedVolume(item.volume,item.id);await this.ownedNetwork(item.network,item.id);
    return {outcome:'succeeded',message:'The server registry and owned resources confirm creation completed.',result:{serverId:item.id}};
   }
   item.state='attention';
   return {message:'This server was only partly prepared. Its allocated storage is retained. Inspect this server and its logs; removal keeps its data volume. Creating a replacement is a separate reviewed operation.'};
  }
  if(job.action==='publish'){
   const snapshot=this.state.snapshots.find(value=>value.id===(job.target?.snapshotId||job.result?.snapshotId));
   if(snapshot){await verifySnapshot(this.library,snapshot.id,snapshot.manifestSha256);return {outcome:'succeeded',message:'The published snapshot is registered and its archive integrity is verified.',result:{snapshotId:snapshot.id}};}
   return {message:'No completed registered snapshot could be verified. Check the source backup and library before publishing again. No backup or archive was changed.'};
  }
  if(job.action==='remove'&&item){
   const missing=async read=>{try{await read();return false;}catch(error){if(error.status===404)return true;throw error;}};
   const removed=await Promise.all([missing(()=>this.ownedContainer(item.container,item.id)),missing(()=>this.ownedContainer(item.controller,item.id)),missing(()=>this.ownedNetwork(item.network,item.id))]);
   if(removed.every(Boolean)){await this.ownedVolume(item.volume,item.id);item.state='removed';return {outcome:'succeeded',message:'The selected containers and network are absent; its owned data volume is retained.',result:{serverId:item.id,retainedVolume:item.volume}};}
   return {message:'Some selected resources remain. Inspect the server before confirming removal again. This check did not stop or remove anything.'};
  }
  return {message:'Completion cannot be proven from the recorded metadata. Review the host, server status, logs and backups before acknowledging. No operation was replayed.'};
 }
 async ensureImage(image,game=Object.values(this.catalog).find(value=>value.image===image)?.id){return this.module(game).managed.ensureImage(this.docker,image);}
 async allocatePorts(game){
  const definitions=this.module(game).managed.ports;
  // Inspect published metadata only; existing containers are never adopted.
  const containers=await this.docker('GET','/containers/json?all=1');
  const used=new Set(containers.flatMap(container=>(container.Ports||[]).filter(port=>port.PublicPort).map(port=>port.Type+':'+port.PublicPort)));
  for(const server of this.state.servers.filter(server=>server.state!=='removed'))for(const port of this.module(server.game).managed.ports)if(server[port.key])used.add(port.protocol+':'+server[port.key]);
  const span=Math.max(3,...definitions.map(port=>port.offset+1));
  for(let base=this.portBase;base+span<65000;base+=span)if(definitions.every(port=>!used.has(port.protocol+':'+(base+port.offset))))return Object.fromEntries(definitions.map(port=>[port.key,base+port.offset]));
  assert(false,'No free managed game ports remain.',409);
 }
 async helper(item,config,{write=false}={}){
  await this.ownedVolume(item.volume,item.id);const requestId=crypto.randomBytes(16).toString('hex'),directory=path.join(this.root,'requests',requestId);await fs.mkdir(directory,{recursive:true});await writeJSON(path.join(directory,'request.json'),{...config,fleet:this.fleet,id:item.id,game:item.game});
  const name=`lobby-goblin-worker-${requestId}`,lifecycle=await hostWorkerLifecycle(this,name,item.id);let createdId=null,retainRequest=false,creationAttempted=false;
  try{creationAttempted=true;const reservation=await this.docker('POST','/containers/create?'+new URLSearchParams({name}),{Image:this.runtimeImage||this.image,User:'0:0',Entrypoint:['node','/app/fleet/worker.js'],Labels:{...labels(this.fleet,item.id,item.game),'io.lobby-goblin.worker':'true'},HostConfig:{NetworkMode:'none',CapDrop:['ALL'],CapAdd:[...storageWorkerCapabilities],SecurityOpt:['no-new-privileges:true'],Memory:512*1024**2,NanoCpus:1000000000,Mounts:[{Type:'volume',Source:this.stateVolume,Target:'/setup',VolumeOptions:{Subpath:'requests/'+requestId}},{Type:'volume',Source:item.volume,Target:'/instance',ReadOnly:!write},{Type:'volume',Source:this.libraryVolume,Target:'/library',ReadOnly:config.action!=='snapshot'}]}});await lifecycle.created(reservation.Id);createdId=reservation.Id;await this.docker('POST',`/containers/${name}/start`);const result=await this.docker('POST',`/containers/${name}/wait?condition=not-running`,undefined,{timeout:1200000});if(result.StatusCode!==0){
    const worker=await this.ownedContainer(name,item.id);let failure=null;
    try{const bytes=await regularFile(path.join(directory,'failure.json'),{optional:true,max:65536});if(bytes)failure=parseStorageJSON(bytes);}catch{}
    await lifecycle.collected(result.StatusCode);
    throw storageWorkerError(failure,{oomKilled:worker.State?.OOMKilled,exitCode:result.StatusCode});
   }const output=await readJSON(path.join(directory,'result.json'),null);await lifecycle.collected(result.StatusCode);return output;
  }catch(error){const diagnostic=await retainOperationDiagnostic(this.root,error,{id:this.active.id,source:'host-operations',phase:this.active.phase||'executing'});retainRequest=!diagnostic.retained;throw error;}
  finally{await lifecycle.teardown(async()=>{if(createdId){const worker=await this.ownedContainer(createdId,item.id);if(worker.State?.Running)await this.docker('POST',`/containers/${createdId}/stop?t=15`);await this.docker('DELETE',`/containers/${createdId}`);await lifecycle.removed();}else if(creationAttempted){retainRequest=true;await lifecycle.review();}});if(!retainRequest)await fs.rm(directory,{recursive:true,force:true});}
 }
 preflight(input){return creationPreflight(this,input);}
 async inspectStorage(input,job){return this.retained.inspect(input,job);}
 async deleteStorage(input,job){return this.retained.remove(input,job);}
 async recoverStorage(input,job){return this.retained.recover(input,job);}
 async create(input,job,recovery=null){
  const info=await this.docker('GET','/info');assert(info.OSType==='linux'&&['x86_64','amd64'].includes(info.Architecture),'This first host-manager version requires Linux containers on an amd64 host.');assert(Number(String(info.ServerVersion).split('.')[0])>=26,'Docker Engine 26 or newer is required for isolated volume subdirectories.');
  const reserved=this.allocations().reduce((n,s)=>n+s.totalGiB,0);assert(reserved+input.memoryGiB+1<=this.memoryBudgetGiB,`This server needs ${input.memoryGiB+1} GiB including its controller, but only ${Math.max(0,this.memoryBudgetGiB-reserved)} GiB remains in the ${this.memoryBudgetGiB} GiB host budget. Open Host settings to review allocations.`,409);assert((reserved+input.memoryGiB+3)*giB<=info.MemTotal,'Keep at least 2 GiB outside the managed server memory budget.',409);
  const module=this.module(input.game),managed=module.managed,defaults=this.catalog[input.game];let snapshot=null;
  if(input.snapshotId){snapshot=this.snapshot(input.snapshotId);const manifest=await verifySnapshot(this.library,snapshot.id,snapshot.manifestSha256);assert(snapshot.game===input.game,'This snapshot belongs to a different application.',409);input=managed.creationFromSnapshot(input,manifest);}
  const runtime=selectedRuntime(managed,input);assert(!runtime?.controllerPrepared||this.broker,'Managed software preparation requires an updated brokered host.',409);
  const game={...defaults,...(runtime?{image:runtime.imagePolicy.defaultImage}:{}),...(recovery?{image:recovery.source.image}:{})};
  if(snapshot)assert(managed.snapshots.compatible(snapshot.image,game.image),'This snapshot requires a different game image.',409);
  const seedRange=creationSeedRange(managed.catalog.creation);
  const id=crypto.randomBytes(16).toString('hex'),ports=await this.allocatePorts(input.game),item={...input,id,...resources(this.fleet,id,input.game),...ports,seed:input.seed??crypto.randomInt(seedRange.min,seedRange.max+1),image:game.image,software:structuredClone(runtime?runtime.software:managed.software||{version:1,mode:'image'}),...(this.broker?{isolationVersion:1}:{}),...(recovery?{recoveredFrom:recovery.source.id}:{}),created:new Date().toISOString(),state:'creating',controllerToken:crypto.randomBytes(48).toString('hex'),rconPassword:crypto.randomBytes(48).toString('base64url')};this.state.servers.push(item);await this.stage(job,'Server storage and ports reserved.','allocated',{serverId:id,...(recovery?{sourceId:recovery.source.id}:{})});
  try{
   await this.stage(job,'Downloading the reviewed game image…');const resolved=await this.ensureImage(game.image,input.game);item.image=resolved.reference;await this.persist();
   if(this.broker)await this.broker.grant({id,game:item.game});
   await this.docker('POST','/volumes/create',{Name:item.volume,Labels:labels(this.fleet,id,input.game)});await this.ownedVolume(item.volume,id);
   await this.stage(job,snapshot?'Verifying and cloning the snapshot…':'Preparing isolated server storage…');await this.helper(item,{...input,action:'provision',name:item.name,image:item.image,seed:item.seed,maxPlayers:item.maxPlayers,controllerToken:item.controllerToken,rconPassword:item.rconPassword,snapshotId:snapshot?.id,snapshotHash:snapshot?.manifestSha256,...(recovery?{retainedRecovery:{sourceId:recovery.source.id,nonce:recovery.nonce}}:{})},{write:true});
   if(recovery){assert(await this.retained.available(recovery.source)===recovery.review.identity,'Source ownership changed. Inspect retained storage again.',409);await this.stage(job,'Copying retained data and verifying every copied file…');await this.retained.helper(recovery.source,{action:'copy',id,nonce:recovery.nonce,fingerprint:recovery.review.fingerprint,name:item.name,maxPlayers:item.maxPlayers,rconPassword:item.rconPassword},item);}
   await this.docker('POST','/networks/create',{Name:item.network,CheckDuplicate:true,Driver:'bridge',Labels:labels(this.fleet,id,input.game)});await this.ownedNetwork(item.network,id);
   const commonLabels=labels(this.fleet,id,input.game),target=managed.dataTarget;
   const environment=managed.gameEnvironment(item);
   const bindings=Object.fromEntries(managed.ports.map(port=>[port.containerPort+'/'+port.protocol,[{HostIp:this.bind,HostPort:String(item[port.key])}]]));
   await this.docker('POST','/containers/create?'+new URLSearchParams({name:item.container,platform:'linux/amd64'}),{Image:item.image,Env:Object.entries(environment).map(([k,v])=>k+'='+v),Labels:commonLabels,ExposedPorts:Object.fromEntries(Object.keys(bindings).map(k=>[k,{}])),HostConfig:{RestartPolicy:{Name:item.autoStart?'unless-stopped':'no'},Memory:item.memoryGiB*giB,NanoCpus:item.cpu*1e9,Mounts:[{Type:'volume',Source:item.volume,Target:target,VolumeOptions:{Subpath:'data',NoCopy:true}}],NetworkMode:item.network,PortBindings:bindings,LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'3'}}},NetworkingConfig:{EndpointsConfig:{[item.network]:{Aliases:[item.container]}}}});
   const env={MODE:'controller',GAME_MODULE:item.game,PORT:'8081',FLEET_ID:this.fleet,FLEET_INSTANCE:id,FLEET_VOLUME:item.volume,FLEET_RESTART_POLICY:item.autoStart?'unless-stopped':'no',CONTROLLER_TOKEN_FILE:'/instance/control/controller-token',STATE_DIR:'/instance/state',UPDATE_STATE_DIR:'/instance/updates',RELEASE_CHECKS:'false',...managed.controllerEnvironment(item,{address:this.address})};
   if(this.broker)Object.assign(env,{DOCKER_BROKER_SOCKET:brokerSocket,DOCKER_BROKER_TOKEN_FILE:brokerToken});
   await this.docker('POST','/containers/create?'+new URLSearchParams({name:item.controller}),{Image:this.runtimeImage||this.image,User:'0:0',Env:Object.entries(env).map(([k,v])=>k+'='+v),Labels:{...commonLabels,'io.lobby-goblin.role':'instance-controller'},HostConfig:{RestartPolicy:{Name:'unless-stopped'},Memory:1024**3,NanoCpus:1e9,CapDrop:['ALL'],CapAdd:['DAC_OVERRIDE'],SecurityOpt:['no-new-privileges:true'],Mounts:[{Type:'volume',Source:item.volume,Target:'/instance'},...(this.broker?[{Type:'volume',Source:this.brokerVolume,Target:'/broker/socket',ReadOnly:true,VolumeOptions:{Subpath:'socket',NoCopy:true}},{Type:'volume',Source:this.brokerVolume,Target:'/broker/credential',ReadOnly:true,VolumeOptions:{Subpath:'instances/'+id,NoCopy:true}}]:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock'}])],NetworkMode:item.network,LogConfig:{Type:'json-file',Config:{'max-size':'5m','max-file':'2'}}},NetworkingConfig:{EndpointsConfig:{[item.network]:{Aliases:[item.controller]}}}});
   await this.docker('POST',`/networks/${item.network}/connect`,{Container:this.hostContainer,EndpointConfig:{Aliases:[]}});
   if(recovery){await this.docker('POST',`/containers/${item.controller}/start`);for(let n=0;n<60;n++){try{await this.request(item,'/status');break;}catch(error){if(n===59)throw error;await sleep(1000);}}item.state='installed';await this.persist();return {serverId:id,sourceId:recovery.source.id,message:'Retained storage copied into an independent server. The new game is stopped; open it to review and start. Original storage was kept.'};}
   await this.stage(job,'Starting the new server. Open it for installation progress…');if(!runtime?.controllerPrepared)await this.docker('POST',`/containers/${item.container}/start`);await this.docker('POST',`/containers/${item.controller}/start`);item.state='starting';await this.persist();
   for(let n=0;n<60;n++){try{const child=await this.request(item,'/jobs',{action:'start',params:{},actor:job.actor,requestId:job.id+'-start'});item.state='installed';await this.stage(job,'The controller accepted server startup.','handoff',{childJobId:child.id});return {serverId:id,message:'Server created. Open it for installation progress and game controls.'};}catch(error){if(n===59)throw error;await sleep(1000);}}
  }catch(error){item.state='attention';await this.persist();throw error;}
 }
 async request(item,route,body){
  await this.ownedContainer(item.controller,item.id);const response=await fetch(`http://${item.controller}:8081`+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+item.controllerToken,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const result=await response.json();assert(response.ok,result.error||'The instance controller is unavailable.',response.status);return result;
 }
 async publish(input,job){
  const item=this.server(input.serverId);item.maintenance='Publishing a snapshot';await this.stage(job,this.catalog[item.game].snapshotHelp,'source-backup',{serverId:item.id});const queued=await this.request(item,'/jobs',{action:'backup',params:{confirm:true},actor:job.actor,requestId:job.id+'-backup'});await this.stage(job,'Waiting for the source backup…','source-backup',{childJobId:queued.id});let completed;
  for(let n=0;n<1200;n++){const value=await this.request(item,'/jobs');completed=value.jobs.find(j=>j.id===queued.id);if(completed&&!['running','queued'].includes(completed.state)&&!value.active)break;await sleep(1000);}assert(completed?.state==='succeeded','The source backup did not complete. No snapshot was published.',409);
  const name=String(completed.result||'').match(/(?:Backup created: )?([A-Za-z0-9_.-]+\.(?:zip|tar\.gz))$/)?.[1];assert(name,'The source controller did not return a backup name.',409);
  const snapshotId=crypto.randomBytes(16).toString('hex');await this.stage(job,'Copying the completed backup into the shared library…','publishing',{snapshotId,backup:name});const result=await this.helper(item,{action:'snapshot',backup:name,snapshotId,name:item.name,title:input.title,image:item.image,seed:item.seed,worldSize:item.worldSize});assert(result?.id===snapshotId,'Snapshot publication did not finish.');
  const manifest=await verifySnapshot(this.library,snapshotId,result.manifestSha256);const entry={id:snapshotId,title:input.title,game:item.game,image:item.image,sourceId:item.id,sourceName:item.name,created:manifest.created,...(manifest.software?{software:manifest.software}:{}),includesPlayerData:manifest.includesPlayerData,...result};this.state.snapshots.push(entry);await this.persist();return {snapshotId,message:'Snapshot published. New servers receive independent copies and fresh credentials.'};
 }
 async snapshotDetails(id){const entry=this.snapshot(id);const manifest=await verifySnapshot(this.library,id,entry.manifestSha256);return {...entry,verifiedAt:new Date().toISOString(),manifest};}
 async removeSnapshot(input,job){
  const entry=this.snapshot(input.snapshotId),root=path.join(this.library,entry.id);await this.stage(job,'Deleting the selected snapshot…','deleting-snapshot',{snapshotId:entry.id});
  const stat=await fs.lstat(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat){assert(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(root)===root,'Snapshot storage cannot be a link.',409);await fs.rm(root,{recursive:true});}
  this.state.snapshots=this.state.snapshots.filter(snapshot=>snapshot.id!==entry.id);await this.persist();return {snapshotId:entry.id,message:'Snapshot deleted. Existing servers, source backups and retained server storage were preserved.'};
 }
 async remove(input,job){
  const item=this.server(input.serverId);
  item.maintenance='Removing the server';await this.stage(job,'Saving and stopping the selected server…');
  try{const info=await this.ownedContainer(item.container,item.id);if(info.State.Running){const queued=await this.request(item,'/jobs',{action:'stop',params:{confirm:true},actor:job.actor});for(let n=0;n<180;n++){const jobs=await this.request(item,'/jobs');const result=jobs.jobs.find(j=>j.id===queued.id);if(result&&!['running','queued'].includes(result.state)&&!jobs.active){assert(result.state==='succeeded',result.message,409);break;}await sleep(1000);}const stopped=await this.ownedContainer(item.container,item.id);assert(!stopped.State.Running&&stopped.State.ExitCode===0&&!stopped.State.OOMKilled,'The server did not stop cleanly. No resources were removed.',409);}}
  catch(error){if(error.status!==404)throw error;}
  if(input.publishSnapshot){const result=await this.publish({serverId:item.id,title:item.name.slice(0,60)+' before removal'},job);item.removalSnapshotId=result.snapshotId;await this.persist();}
  for(const name of [item.controller,item.container]){let info;try{info=await this.ownedContainer(name,item.id);}catch(error){if(error.status===404)continue;throw error;}if(info.State.Running)await this.docker('POST',`/containers/${name}/stop?t=30`);await this.docker('DELETE',`/containers/${name}`);}
  const filter=encodeURIComponent(JSON.stringify({label:[`io.lobby-goblin.fleet=${this.fleet}`,`io.lobby-goblin.instance=${item.id}`,'io.lobby-goblin.worker=true']}));
  for(const worker of await this.docker('GET','/containers/json?all=1&filters='+filter)){const info=await this.ownedContainer(worker.Id,item.id);assert(info.Config?.Labels?.['io.lobby-goblin.worker']==='true','Resource is not an owned worker.',409);if(info.State.Running)await this.docker('POST',`/containers/${worker.Id}/stop?t=15`);await this.docker('DELETE',`/containers/${worker.Id}`);}
  let network;try{network=await this.ownedNetwork(item.network,item.id);}catch(error){if(error.status!==404)throw error;}
  if(network){const host=await this.docker('GET',`/containers/${this.hostContainer}/json`);const endpoints=Object.keys(network.Containers||{});assert(endpoints.every(id=>id===host.Id),'Another container still uses this server network.',409);if(endpoints.includes(host.Id))await this.docker('POST',`/networks/${item.network}/disconnect`,{Container:this.hostContainer});await this.docker('DELETE',`/networks/${item.network}`);}
  if(this.broker)await this.broker.revoke(item.id);
  item.state='removed';item.removedAt=new Date().toISOString();await this.persist();return {serverId:item.id,retainedVolume:item.volume,...(item.removalSnapshotId?{snapshotId:item.removalSnapshotId}:{}),message:'Server containers removed. Its data volume is available in Storage for inspection, recovery or deletion. Shared snapshots were kept.'};
 }
}
