import {publicTransportMessage} from '../core/operation-errors.js';
import {ApplicationReleases} from '../core/application-releases.js';
import {managementMaintenance,assertManagementIdle} from '../core/management-maintenance.js';
import {OperationFeed,jobOperationSource,operationProgressSnapshot} from '../core/operation-feed.js';
import {setupOperationSource,agentOperationSource} from './operation-sources.js';
import {managementUpdateSource} from './management-outcome.js';
import {dockerTransport} from '../core/broker-client.js';
import {ManagementPanel} from '../core/management-panel.js';
import fs from 'node:fs/promises';import http from 'node:http';
import crypto from 'node:crypto';
import {ensureAgentIdentity} from './agent-identity.js';
import {auditedResponse} from '../core/audit.js';
import {FleetManager} from './manager.js';
import {cleanupFleetContainers} from '../core/container-cleanup.js';
import {migrateFleet} from './migrations.js';
import {RemoteHosts,remoteRoute} from './hosts.js';
import {HostSetup} from './host-setup.js';
import {AgentUpdater,agentVersion} from './agent-update.js';
import {proxyResponse} from '../core/proxy.js';
import {controllerAccess} from '../core/routes.js';
import {catalog,noManagedUpdater} from './catalog.js';import {docker as dockerAPI} from '../core/docker.js';import {selectedApplication} from '../applications/index.js';
import {assert,equalSecret,json,requestJSON,readBody,redact} from '../common.js';import {initializePanel} from '../init.js';
export async function startFleetController({env=process.env,docker=dockerAPI,port=Number(env.PORT||8091),hostname='0.0.0.0',hostFetch=fetch,setupDependencies}={}){
 const transport=dockerTransport(env,docker);docker=transport.docker;
 const root=env.FLEET_ROOT||'/fleet',library=env.FLEET_LIBRARY||'/library',webRoot=env.FLEET_WEB_ROOT||'/web-state';
 if(env.FLEET_AGENT_ONLY==='true'){
  await fs.mkdir(webRoot+'/secrets',{recursive:true});try{await fs.writeFile(webRoot+'/secrets/controller-token',crypto.randomBytes(48).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 }else await initializePanel(webRoot,env.FLEET_PANEL_URL||'http://localhost:8082');const token=(await fs.readFile(webRoot+'/secrets/controller-token','utf8')).trim();
 const maintenance=await managementMaintenance(root,env);
 let legacyUpdates=null;
 const managementDocker=docker;docker=async(method,...args)=>{assert(!maintenance.held||maintenance.preparing||method==='GET','Management startup is held. Docker changes require explicit operator activation.',409);if(legacyUpdates&&method!=='GET'&&!maintenance.preparing)assert(!legacyUpdates.blocksChanges(await legacyUpdates.current()),'A coordinated management update owns this host.',409);return managementDocker(method,...args);};
 const manager=new FleetManager({docker,broker:transport.grant?transport:null,brokerVolume:env.FLEET_BROKER_VOLUME,root,library,fleet:env.FLEET_ID,stateVolume:env.FLEET_STATE_VOLUME,libraryVolume:env.FLEET_LIBRARY_VOLUME,image:env.FLEET_IMAGE,hostContainer:env.FLEET_HOST_CONTAINER,address:env.FLEET_GAME_ADDRESS||'localhost',bind:env.FLEET_GAME_BIND||'0.0.0.0',memoryBudgetGiB:Number(env.FLEET_MEMORY_GIB||16),portBase:Number(env.FLEET_GAME_PORT_BASE||35000)});await manager.init();
 await manager.assertHost();
 legacyUpdates=transport.managementUpdate?null:new ManagementPanel({root,fleet:manager.fleet,docker:managementDocker,runtimeImage:manager.runtimeImage,profile:'legacy'});
 if(legacyUpdates)await legacyUpdates.init();
 const coordinatedHold=legacyUpdates&&legacyUpdates.blocksChanges(await legacyUpdates.current());
 if(!maintenance.held&&!coordinatedHold)await manager.reconnect();
 if(maintenance.held)await manager.audit.list();
 let managementChanges=Promise.resolve();
 const coordinatedUpdate=transport.managementUpdate||((input)=>{const next=managementChanges.then(()=>legacyUpdates.handle(input));managementChanges=next.catch(()=>{});return next;});
 const identity=env.FLEET_AGENT_TRANSPORT==='persistent'?await ensureAgentIdentity(webRoot):null;
 const hosts=new RemoteHosts(manager,{fetcher:hostFetch,identity:identity?.fingerprint});await hosts.init({connect:!maintenance.held&&!coordinatedHold});
 const setup=new HostSetup(hosts,setupDependencies);await setup.init();const agent=new AgentUpdater(manager,{enabled:env.FLEET_AGENT_ONLY==='true'}),version=await agentVersion();
 agent.coordinated=true;
 const applicationReleases=new ApplicationReleases();
 const operationFeed=new OperationFeed({scope:'host:'+manager.fleet,sources:[jobOperationSource(manager.operations),setupOperationSource(setup),agentOperationSource(agent),managementUpdateSource(root)]});
 async function handle(req,res){
  if(req.url==='/health')return json(res,200,{ok:true});assert(equalSecret(req.headers.authorization,'Bearer '+token),'Unauthorized.',401);const url=new URL(req.url,'http://host-manager');
  if(await maintenance.handle(req,res,url,{token,prepare:async()=>{assertManagementIdle(await operationFeed.snapshot());await manager.reconnect();hosts.startConnections();},inspect:()=>operationFeed.snapshot()}))return;
  maintenance.assertAvailable();
  if(req.method==='POST'&&!req.auditContext){
   let actor=req.headers['x-panel-user']||'controller';
   if(url.pathname.startsWith('/remote/v1/')&&url.pathname!=='/remote/v1/pair'){const peer=hosts.authenticate(req.headers['x-host-token']);actor='remote:'+peer.centralId+':'+String(actor).replace(/[^A-Za-z0-9_. -]/g,'').slice(0,80);}
   if(url.pathname==='/remote/v1/pair')actor='pairing-request';
   const route=url.pathname.replace(/^\/remote\/v1/,'');
   const known=['/host-settings','/hosts','/host-pairing','/host-setup','/host-setup-plan','/agent-update','/agent-update-plan','/pair','/disconnect','/servers','/jobs/recovery'];
   return auditedResponse(manager.audit,req,res,{actor,scope:'host:'+manager.fleet,action:known.includes(route)?'host.'+route.slice(1).replaceAll('/','.'):route.match(/^\/servers\/[a-f0-9]{32}\/(?:snapshot|remove)$/)?'host.'+route.split('/').at(-1):'server.request'},buffered=>handle(req,buffered));
  }
  if(url.pathname.startsWith('/remote/v1/')){
   if(url.pathname==='/remote/v1/pair'){assert(req.method==='POST','Not found.',404);return json(res,200,await hosts.accept(await requestJSON(req)));}
   const peer=hosts.authenticate(req.headers['x-host-token']);
   if(url.pathname==='/remote/v1/authorize'){assert(req.method==='GET','Not found.',404);return json(res,200,{authorized:true});}
   if(url.pathname==='/remote/v1/disconnect'){assert(req.method==='POST','Not found.',404);return json(res,200,await hosts.revoke(peer));}
   url.pathname=url.pathname.slice('/remote/v1'.length);assert(remoteRoute(req.method,url.pathname),'Remote route not found.',404);
   req.headers['x-panel-user']='remote:'+peer.centralId+':'+String(req.headers['x-panel-user']||'administrator').replace(/[^A-Za-z0-9_. -]/g,'').slice(0,80);
  }
  if(legacyUpdates&&req.method!=='GET'&&url.pathname!=='/management-update')assert(!legacyUpdates.blocksChanges(await legacyUpdates.current()),'A coordinated management update owns this host. Wait for completion or recovery.',409);
  if(!req.url.startsWith('/remote/v1/')&&(await setup.handle(req,res,url)||await hosts.handle(req,res,url)))return;
  if(req.method==='GET'&&url.pathname==='/operations')return json(res,200,await operationFeed.snapshot());
  if(url.pathname==='/management-update'){
   assert(['GET','POST'].includes(req.method),'Not found.',404);
   const input=req.method==='GET'?{action:'status'}:await requestJSON(req);
   if(req.method==='POST'){assert(!manager.active&&!manager.settingsUpdating,'Wait for the host operation to finish.',409);if(['plan','apply'].includes(input.action))assertManagementIdle(await operationFeed.snapshot());}
   return json(res,req.method==='GET'?200:202,await coordinatedUpdate(input));
  }
  if(req.method==='POST'&&url.pathname==='/operations/recovery')return json(res,200,await operationFeed.recover(await requestJSON(req),req.headers['x-panel-user']||'administrator'));
  const agentState=await agent.status();manager.agentUpdating=!!agentState.update&&['running','attention'].includes(agentState.update.state);
  if(await agent.handle(req,res,url))return;
  assert(req.method==='GET'||!manager.agentUpdating,'Wait for the agent update or recovery before changing this host.',409);
  if(url.pathname==='/host-settings'){if(req.method==='GET')return json(res,200,await manager.hostSettings());assert(req.method==='POST','Not found.',404);return json(res,200,await manager.updateHostSettings(await requestJSON(req),req.headers['x-panel-user']||'administrator'));}
  if(req.method==='GET'&&url.pathname==='/application-releases'){const item=url.searchParams.has('serverId')?manager.server(url.searchParams.get('serverId')):null;assert(!item||item.state!=='removed','This server was removed.',410);const game=item?.game||url.searchParams.get('game');return json(res,200,await applicationReleases.read(game,item?.software||manager.module(game).managed.software));}
  if(req.method==='POST'&&url.pathname==='/creation-preflight')return json(res,200,await manager.preflight(await requestJSON(req)));
  if(req.method==='GET'&&url.pathname==='/catalog')return json(res,200,{games:Object.values(catalog),memoryBudgetGiB:manager.memoryBudgetGiB});
  if(req.method==='GET'&&url.pathname==='/status')return json(res,200,{game:'fleet',ready:true,hostId:manager.fleet,protocol:1,version,agentOnly:env.FLEET_AGENT_ONLY==='true',agentUpdate:agentState.update,agentUpdateSupported:agentState.supported,managementUpdateSupported:true,isolation:manager.broker?'broker-v1':'legacy-socket',servers:manager.list().length,activeJob:manager.active});
  if(req.method==='GET'&&url.pathname==='/audit')return json(res,200,await manager.audit.list({before:url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined,search:url.searchParams.get('search')||''}));
  if(req.method==='GET'&&url.pathname==='/jobs')return json(res,200,url.searchParams.get('workflows')==='1'?await operationProgressSnapshot(manager.operations,operationFeed):manager.operations.status());
  if(req.method==='POST'&&url.pathname==='/jobs/recovery')return json(res,200,await manager.operations.recover(await requestJSON(req),req.headers['x-panel-user']||'administrator'));
  if(req.method==='GET'&&url.pathname==='/removed-servers')return json(res,200,{servers:manager.removedServers()});
  const retainedRoute=url.pathname.match(/^\/removed-servers\/([a-f0-9]{32})\/(inspect|recover|remove)$/);
  if(retainedRoute){assert(req.method==='POST','Not found.',404);return json(res,202,await manager.submit({inspect:'inspectStorage',recover:'recoverStorage',remove:'deleteStorage'}[retainedRoute[2]],{...await requestJSON(req),serverId:retainedRoute[1]},req.headers['x-panel-user']||'administrator'));}
  const snapshotRoute=url.pathname.match(/^\/snapshots\/([a-f0-9]{32})(\/remove)?$/);
  if(snapshotRoute){if(req.method==='GET'&&!snapshotRoute[2])return json(res,200,await manager.snapshotDetails(snapshotRoute[1]));if(req.method==='POST'&&snapshotRoute[2])return json(res,202,await manager.submit('removeSnapshot',{...await requestJSON(req),snapshotId:snapshotRoute[1]},req.headers['x-panel-user']||'administrator'));assert(false,'Not found.',404);}
  if(req.method==='GET'&&url.pathname==='/snapshots')return json(res,200,{snapshots:manager.state.snapshots});
  if(url.pathname==='/servers'){
   if(req.method==='GET')return json(res,200,{servers:manager.list()});assert(req.method==='POST','Not found.',404);const input=await requestJSON(req);assert(input.hostId===undefined||input.hostId===manager.fleet,'The selected host does not match this destination.',409);return json(res,202,await manager.submit('create',input,req.headers['x-panel-user']||'administrator'));
  }
  if(req.method==='GET'&&url.pathname==='/update-status')return json(res,200,await noManagedUpdater(version).refresh());
  const match=url.pathname.match(/^\/servers\/([a-f0-9]{32})(?:\/(.*))?$/);assert(match,'Not found.',404);const item=manager.server(match[1]),tail=match[2]||'';
  if(!tail&&req.method==='GET')return json(res,200,manager.publicServer(item));
  if(req.method==='POST'&&['snapshot','remove'].includes(tail)){const body=await requestJSON(req);return json(res,202,await manager.submit(tail==='snapshot'?'publish':'remove',{...body,serverId:item.id},req.headers['x-panel-user']||'administrator'));}
  assert(tail.startsWith('controller/')&&item.state!=='removed','This server is unavailable. Its stored data has been preserved.',409);const route='/'+tail.slice(11),module=selectedApplication(item.game);
  assert(controllerAccess(module,req.method,route),'Not found.',404);
  assert(['GET','POST'].includes(req.method),'Not found.',404);assert(req.method==='GET'||!item.maintenance&&manager.active?.action!=='image-migration','A host operation is using this server. Wait for it to finish.',409);
  await manager.ownedContainer(item.controller,item.id);let body;if(req.method==='POST'){body=await readBody(req,route==='/upload'?128*1024**2:1024**2);if(route==='/jobs'&&req.headers['x-panel-user']){let value;try{value=JSON.parse(body);}catch{assert(false,'Invalid action.');}body=Buffer.from(JSON.stringify({...value,actor:req.headers['x-panel-user']}));}}
  return proxyResponse(req,res,`http://${item.controller}:8081${route}${url.search}`,{headers:{authorization:'Bearer '+item.controllerToken,'content-type':req.headers['content-type']||'application/json','x-panel-user':req.headers['x-panel-user']||'administrator','x-panel-update-kind':req.headers['x-panel-update-kind']==='game'?'game':'any'},body,download:route==='/download',timeout:['/mod-library','/mod-library-plan'].includes(route)?150000:30000});
 }
 const server=http.createServer((req,res)=>handle(req,res).catch(error=>{if(!res.headersSent)json(res,error.status||502,{error:publicTransportMessage(error)??(error.status?redact(error.message):'The host manager could not complete the request.')});else res.destroy();}));server.requestTimeout=300000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,resolve);});
 const sweep=()=>{if(!maintenance.held)void cleanupFleetContainers(manager).catch(error=>console.error('Container cleanup deferred:',redact(error.message)));};
 const cleanupTimer=setInterval(sweep,60000).unref();server.once('close',()=>{clearInterval(cleanupTimer);hosts.close();});
 if(!maintenance.held&&!coordinatedHold&&!manager.broker&&env.FLEET_AGENT_ONLY!=='true'&&env.FLEET_SKIP_MIGRATIONS!=='true')void migrateFleet(manager).catch(()=>console.error('Image migration needs attention; stored data was preserved.')).finally(sweep);return {server,manager,hosts,setup,agent};
}
