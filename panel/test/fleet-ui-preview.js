import {publishSnapshot} from '../fleet/snapshots.js';
import {makeZip} from '../core/archive.js';
// Disposable loopback-only UI acceptance fixture. No Docker socket, production
// accounts, SSH connections or game data. All host/game actions are synthetic.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FleetManager} from '../fleet/manager.js';
import {startFleetWeb} from '../fleet/web.js';
import {catalog} from '../fleet/catalog.js';
import {hashPassword} from '../auth.js';
import {writeJSON,json,requestJSON,assert} from '../common.js';
import {setupInput} from '../fleet/host-setup.js';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lobby-host-ui-'))),auth=path.join(root,'auth'),tokenFile=path.join(root,'token'),token='f'.repeat(64),fleet='a'.repeat(32);
await fs.mkdir(auth);await fs.writeFile(tokenFile,token);await writeJSON(path.join(auth,'users.json'),{Preview:{...hashPassword('isolated-panel-preview-password'),role:'admin'},Viewer:{...hashPassword('isolated-panel-preview-password'),role:'viewer'},Assigned:{...hashPassword('isolated-panel-preview-password'),role:'member',grants:{['/servers/'+'b'.repeat(32)]:['server.view','server.operate']},accessRevision:0}});
const manager=new FleetManager({root:path.join(root,'state'),library:path.join(root,'library'),fleet,stateVolume:`lobby-goblin-fleet-${fleet}-state`,libraryVolume:`lobby-goblin-fleet-${fleet}-library`,hostContainer:'fixture',image:'fixture',memoryBudgetGiB:24,docker:async(method,route)=>{assert(method==='GET'&&route==='/info','This preview cannot use Docker.');return {MemTotal:32*1024**3,OSType:'linux',Architecture:'amd64',ServerVersion:'29.1.3',NCPU:8};}});await manager.init();
manager.state.servers=[{id:'b'.repeat(32),game:'factorio',name:'Friday factory',state:'installed',memoryGiB:3,cpu:2,gamePort:35000},{id:'c'.repeat(32),game:'rust',name:'Island crew',state:'installed',memoryGiB:12,cpu:4,gamePort:35003}];await manager.persist();
const previewSnapshot='f'.repeat(32),previewBackup=path.join(root,'preview-backup.zip');
await fs.writeFile(previewBackup,makeZip([{name:'saves/world.zip',data:makeZip([{name:'world/level.dat',data:Buffer.from('Disposable browser fixture')}])},{name:'panel-manifest.json',data:Buffer.from(JSON.stringify({activeSave:'world.zip'}))}]));
const snapshotRecord={id:previewSnapshot,sourceId:'b'.repeat(32),sourceName:'Friday factory',title:'Friday factory before removal',game:'factorio',image:catalog.factorio.image};
const snapshotResult=await publishSnapshot({library:manager.library,backup:previewBackup,record:snapshotRecord});
const snapshotManifest=JSON.parse(await fs.readFile(path.join(manager.library,previewSnapshot,'manifest.json')));
manager.state.snapshots=[{...snapshotRecord,...snapshotResult,created:snapshotManifest.created}];
manager.state.servers.push({id:'9'.repeat(32),game:'factorio',name:'Retired factory',state:'removed',volume:'disposable-retained-volume',removedAt:new Date().toISOString()});await manager.persist();
manager.assertHost=async()=>{};
const remoteId='d'.repeat(32),previewVersion='0.3.5-alpha';let remote=null,setupPlan=null;const setupJobs=[];
const backend=http.createServer((req,res)=>{void(async()=>{
 assert(req.headers.authorization==='Bearer '+token,'Unauthorized',401);
 if(req.method==='GET'&&req.url==='/status')return json(res,200,{ready:true,version:'0.3.10-alpha',isolation:'broker-v1'});
 if(req.url.startsWith('/application-releases?')){const query=new URL(req.url,'http://fixture').searchParams,game=query.has('serverId')?manager.server(query.get('serverId')).game:query.get('game');return json(res,200,game==='factorio'?{game,software:process.env.UI_FACTORIO_DELIVERY_TEST==='runtime'?{mode:'runtime',provider:'factorio-headless',updateKind:'software'}:{mode:'image',updateKind:'image'},source:'Synthetic release fixture',stable:'2.0.78',experimental:'2.1.23',stale:false,checkedAt:new Date().toISOString(),choices:[{kind:process.env.UI_FACTORIO_DELIVERY_TEST==='runtime'?'software':'image',version:'2.0.78',imageRevision:1,...(process.env.UI_FACTORIO_DELIVERY_TEST==='runtime'?{}:{image:'ghcr.io/jkenneydaniel/factorio-server:2.0.78-fc.1'}),channel:'stable',notesUrl:'https://wiki.factorio.com/Version_history/2.0.0#2.0.78'}]}:{game,software:{mode:'runtime',provider:'rust-steamcmd',updateKind:'software'},source:'Synthetic Steam news fixture',message:'SteamCMD build discovery is required before enabling Rust upgrades.',news:[{title:'Rust update details',text:'Disposable release notes.',published:new Date().toISOString(),url:'https://store.steampowered.com/news/app/252490'}]});}
 if(req.url==='/host-settings'){if(req.method==='GET')return json(res,200,await manager.hostSettings());return json(res,200,await manager.updateHostSettings(await requestJSON(req),'preview'));}
 if(req.url==='/hosts'){
  if(req.method==='POST'){await requestJSON(req);remote={id:remoteId,name:'Weekend game host',origin:'https://host.example.test:24443',connection:'persistent',local:false,connected:true,version:'0.3.4-alpha',panelVersion:previewVersion,aligned:false,agentOnly:true};return json(res,201,remote);}
  return json(res,200,{hosts:[{id:fleet,name:'This host',local:true,connected:true},...(remote?[remote]:[])]});
 }
 if(req.url==='/host-pairing')return json(res,200,req.method==='GET'?{expires:null,panels:[]}:{code:'p'.repeat(43),expires:Date.now()+600000});
 if(req.url==='/host-setup-plan'){
  const input=await requestJSON(req);setupPlan=setupInput(input,previewVersion);return json(res,200,{...setupPlan,id:'e'.repeat(32),fingerprint:'SHA256:'+'a'.repeat(43),expires:Date.now()+900000,directory:'/opt/lobby-goblin-host-preview'});
 }
 if(req.url==='/host-setup'){
  if(req.method==='POST'){await requestJSON(req);remote={id:remoteId,name:setupPlan.name,origin:setupPlan.options.origin,connection:'persistent',local:false,connected:true,version:previewVersion,panelVersion:previewVersion,aligned:true,agentOnly:true};setupJobs.unshift({id:'setup',name:remote.name,host:setupPlan.host,state:'succeeded',message:'Host connected. You can create a server on it now.'});return json(res,202,setupJobs[0]);}
  return json(res,200,{jobs:setupJobs,active:null});
 }
 let route=new URL(req.url,'http://fixture').pathname;
 if(route.startsWith('/hosts/'+remoteId+'/')){
  assert(remote,'Remote fixture is disconnected.',404);route=route.slice(('/hosts/'+remoteId).length);
  if(route==='/disconnect'){await requestJSON(req);remote=null;return json(res,200,{disconnected:true,revoked:true,message:'Synthetic host disconnected; no real servers were contacted.'});}
  if(route==='/agent-update-plan')return json(res,200,{id:'f'.repeat(32),current:remote.version,version:previewVersion});
  if(route==='/agent-update'){await requestJSON(req);remote.version=previewVersion;remote.aligned=true;return json(res,202,{state:'running'});}
 }
 if(route==='/creation-preflight'){const body=await requestJSON(req);return json(res,200,{ready:true,checks:[{label:'Fixture host',status:'pass',message:'Disposable preview only.'}],application:body.game});}
 if(route==='/catalog')return json(res,200,{games:Object.values(catalog)});
 if(route==='/servers'){
  if(req.method==='POST'){const input=await requestJSON(req);return json(res,202,{id:'synthetic-create',state:'succeeded',hostId:input.hostId});}
  return json(res,200,{servers:req.url.startsWith('/hosts/')?[{id:'e'.repeat(32),game:'factorio',name:'Remote Friday factory',state:'installed',memoryGiB:2,cpu:1,gamePort:35000,address:'host.example.test:35000',manageUrl:'/unused'}]:manager.list()});
 }
 if(route==='/removed-servers')return json(res,200,{servers:manager.removedServers()});
 const snapshotRoute=route.match(/^\/snapshots\/([a-f0-9]{32})(\/remove)?$/);
 if(snapshotRoute){if(req.method==='GET')return json(res,200,await manager.snapshotDetails(snapshotRoute[1]));return json(res,202,await manager.submit('removeSnapshot',{...await requestJSON(req),snapshotId:snapshotRoute[1]},'Preview'));}
 if(route==='/snapshots')return json(res,200,{snapshots:manager.state.snapshots});
 if(route==='/jobs'||route==='/jobs?workflows=1')return json(res,200,manager.operations.status());
 if(route==='/update-status')return json(res,200,{busy:false});
 if(/^\/servers\/[a-f0-9]{32}\/controller\/jobs$/.test(route))return json(res,200,{jobs:[],active:null});
 if(/^\/servers\/[a-f0-9]{32}\/controller\/backups$/.test(route))return json(res,200,{backups:[],health:{verifiedCount:0,latestAt:null,alerts:[]}});
 const match=route.match(/^\/servers\/([a-f0-9]{32})(\/controller\/status)?$/);
 if(match){const item=match[1]==='e'.repeat(32)?{id:match[1],game:'factorio',state:'installed'}:manager.server(match[1]);return json(res,200,match[2]?{version:'2.0.77',currentWorld:'disposable-preview-world',connection:'host.example.test:35000',ready:item.game==='factorio',running:item.game==='factorio',state:item.game==='factorio'?'running':'exited',players:[],memory:0}:manager.publicServer(item));}
 json(res,404,{error:'Unavailable in isolated preview.'});
 })().catch(error=>json(res,error.status||500,{error:error.message}));});
await new Promise(r=>backend.listen(0,'127.0.0.1',r));
const web=await startFleetWeb({env:{AUTH_DIR:auth,CONTROLLER_TOKEN_FILE:tokenFile,CONTROLLER_URL:'http://127.0.0.1:'+backend.address().port,PANEL_HOSTS:'127.0.0.1,localhost',RELEASE_CHECKS:'false'},port:Number(process.env.UI_PREVIEW_PORT||8098),hostname:'127.0.0.1'});
let shutting=false;async function cleanup(){if(shutting)return;shutting=true;web.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>backend.close(r))]);await fs.rm(root,{recursive:true,force:true});}
process.on('SIGINT',()=>void cleanup().then(()=>process.exit()));process.on('SIGTERM',()=>void cleanup().then(()=>process.exit()));
console.log('Disposable host-settings UI fixture ready on loopback. Host setup, pairing, updates and creation are synthetic.');
