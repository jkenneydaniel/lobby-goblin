// Isolated, loopback-only UI preview. No Docker access, controller token,
// production accounts, or persistent writes. Preview requests use memory only;
// real server-management actions are rejected. Optional creation/onboarding flows
// simulate success in memory only, for browser acceptance of those workflows.
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import crypto from 'node:crypto';
import {encodeMapPayload,mapPayloadFormat} from '../applications/factorio/public/map-payload.js';
import {mapPayloadFixture} from './map-payload-fixture.js';
import {web as factorioWeb} from '../applications/factorio/web.js';
import {factorio} from '../applications/factorio/index.js';
import {publicContract} from '../core/game-contract.js';
import {sharedAssets} from '../core/web-assets.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scope=process.env.UI_SERVER_SCOPE||'';
if(scope&&!/^(?:\/hosts\/[a-f0-9]{32})?\/servers\/[a-f0-9]{32}$/.test(scope))throw Error('Invalid isolated server scope.');
import {emptySetups,changeSetups} from '../applications/factorio/world-setups.js';
import {diagnosticsReport,controllerDiagnostics} from '../diagnostics.js';
import {defaultRetention,retentionPolicy,retentionSelection} from '../backup-retention.js';
let setups=emptySetups();
const defaults=JSON.parse(await fs.readFile(path.join(project,'world-defaults.json'),'utf8'));
const snapshot={version:1,step:2,world:'Demo-factory.zip',seed:123456789,created:new Date().toISOString(),surface:'nauvis',chunks:[{x:0,y:0,tiles:[1,256],pollution:0}],palette:[{name:'grass-1',color:[80,110,55]}],entities:[],players:[{name:'Engineer',x:8,y:8,surface:'nauvis'}],tags:[],truncated:false};
if(process.env.UI_MAP_ENEMIES_TEST==='1'){
  snapshot.enemyUnits=true;snapshot.chunks=[];snapshot.players=[];
  for(let y=-12;y<=12;y++)for(let x=-20;x<=20;x++)snapshot.chunks.push({x,y,tiles:[1,256],pollution:0});
  const add=(name,type,category,x,y,w=2)=>snapshot.entities.push({name,type,category,x,y,w,h:w,color:[95,126,180]});
  add('biter-spawner','unit-spawner','enemies',-200,-100,7);add('spitter-spawner','unit-spawner','enemies',200,120,7);
  add('small-worm-turret','turret','enemies',-180,-85,2);add('small-worm-turret','turret','enemies',215,105,2);
  for(let i=0;i<6;i++)add('small-biter','unit','enemies',-160+i*8,-70+i*3,1);
  add('iron-ore','resource','resources',-200,-100,12);add('assembling-machine-1','assembling-machine','buildings',0,0,3);
}
if(process.env.UI_MAP_PAYLOAD_TEST==='1')Object.assign(snapshot,mapPayloadFixture());
let retention={policy:{...defaultRetention},revision:0,lastRun:null};const cleanupPlans=new Map();
const backups=[],schedule={enabled:false,hours:6,keep:12,lastRun:null};
const {summarizeBackups}=await import('../core/backup-health.js');
const status={version:'2.0.77',image:'factoriotools/factorio:2.0.77',currentWorld:snapshot.world,seed:String(snapshot.seed),running:true,ready:true,paused:true,players:[],playtime:'Demo snapshot',name:'Lobby Goblin demo',schedule,autoPause:true,connection:'localhost:34197',autosaveMinutes:5,autosaveSlots:10,lastSaveAt:snapshot.created,saveVerified:true,memory:45000000,cpu:0};
const data={session:{username:'Preview',role:process.env.UI_ROLE||'admin',csrf:'isolated-preview',onboarding:{completed:process.env.UI_ONBOARDING_TEST!=='1'}},status,map:{snapshot,pins:[],staleWorld:false},jobs:{jobs:[],active:null},backups:{backups,schedule,retention,health:summarizeBackups(backups,schedule,[],null)},accounts:{users:[{username:'Preview',role:'admin'}],invitations:[]},sessions:{sessions:[{id:'preview-session',created:new Date().toISOString(),expires:Date.now()+3600000,current:true}]}};
data.settings={name:'Isolated preview fixture',description:'Synthetic settings; cannot manage a real server.',max_players:0,autosave_interval:5,autosave_slots:10,auto_pause:true,require_user_verification:false};
data.updates={state:process.env.UI_RELEASE_TEST||'current',available:process.env.UI_RELEASE_TEST==='available',current:'0.1.0-alpha',channel:'preview',checkedAt:snapshot.created,installation:'manual',latest:process.env.UI_RELEASE_TEST==='available'?{tag:'v0.1.1-alpha',url:'https://github.com/jkenneydaniel/lobby-goblin/releases/tag/v0.1.1-alpha'}:null};
data['update-status']={busy:false,jobs:[]};
if(process.env.UI_GAME_RELEASES_TEST==='1'){status.image='ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.2';data['application-releases']={game:'factorio',stable:'2.0.78',experimental:'2.1.23',stale:false,choices:[{version:'2.0.78',imageRevision:1,image:'ghcr.io/jkenneydaniel/factorio-server:2.0.78-fc.1',channel:'stable',notesUrl:'https://wiki.factorio.com/Version_history/2.0.0#2.0.78'},{version:'2.0.77',imageRevision:3,image:'ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.3',channel:'published',notesUrl:'https://wiki.factorio.com/Version_history/2.0.0#2.0.77'}]};}
data.map.automatic={enabled:true,pending:false,running:false,lastError:null};
data['world-options']={defaults,copied:{sourceWorld:snapshot.world,image:'factoriotools/factorio:2.0.77',created:snapshot.created,configuration:defaults},currentWorld:snapshot.world,image:'factoriotools/factorio:2.0.77'};
data.worlds={worlds:[{id:'demo-current',name:snapshot.world,relative:snapshot.world,current:true,kind:'active',modified:snapshot.created,size:1048576}]};
if(process.env.UI_POPULATED==='1'){
  status.players=['Daniel','Alex'];status.paused=false;status.name='Copper Coast';status.currentWorld='Copper Coast.zip';snapshot.world=status.currentWorld;status.playtime='12 hours';status.cpu=8.2;status.memory=1288490188;
  data.jobs.jobs=[['save','Save completed. The world is ready for your next session.'],['backup','Backup archive verified. Keep a copy on another device.'],['settings','Server settings updated. Autosave every 5 minutes.'],['start','Factorio 2.0.77 is ready.']].map(([action,message],i)=>({id:'fixture-'+i,action,message,state:'succeeded',started:new Date(Date.now()-(i+1)*60000).toISOString(),finished:new Date(Date.now()-(i+1)*60000).toISOString()}));
  const backup={relative:'Demo-backup.zip',modified:new Date(Date.now()-720000).toISOString(),size:24500000,validation:{ok:true,checked:snapshot.created}};backups.push(backup);data.backups.health=summarizeBackups(backups,schedule,[],null);
  data.logs={text:'Isolated UI fixture. No connection to a game server.\nFactorio 2.0.77 · Synthetic ready state.\nSaving finished (simulated).'};
  data.worlds.worlds=[{id:'demo-current',name:'Copper Coast',relative:'Copper Coast.zip',current:true,kind:'active',modified:snapshot.created,size:12400000},{id:'demo-archive',name:'Railway Island',relative:'panel-worlds/Railway Island.zip',current:false,kind:'archive',modified:snapshot.created,size:8900000},{id:'demo-autosave',name:'_autosave1',relative:'_autosave1.zip',current:false,kind:'autosave',modified:snapshot.created,size:12400000}];
}
if(process.env.UI_RETENTION_TEST==='1'){
  for(const kind of ['scheduled','manual','safety'])for(let i=0;i<5;i++)backups.push({relative:`2026-09-${String(6-i).padStart(2,'0')}T18-30-00-000Z-${kind==='safety'?'before-world-switch':kind}.zip`,kind,modified:new Date(Date.now()-(40+i)*86400000).toISOString(),size:24500000+i*250000});
  data.backups.health=summarizeBackups(backups,schedule,[],null);
}
if(process.env.UI_READY_TEST==='waiting'){status.ready=false;status.saveVerified=false;}

const fixtureImage=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#506e37"/><path d="M0 100Q250 350 512 100V220Q200 450 0 220Z" fill="#467889"/><text x="30" y="475" fill="white" font-size="20">Synthetic preview fixture</text></svg>');
let draftPreview=null,previewRequests=0;
let playerSample=0;
function previewPlayers(){playerSample++;return process.env.UI_LIVE_PLAYERS_TEST==='1'?{enabled:true,state:'live',world:snapshot.world,seed:snapshot.seed,updatedAt:new Date().toISOString(),players:[{name:'Preview engineer',x:playerSample*3,y:0,surface:snapshot.surface,color:[90,200,220]}]}:{enabled:false,state:'disabled',players:[]};}
if(process.env.UI_AUTO_REFRESH_TEST==='1')setTimeout(()=>{snapshot.created=new Date().toISOString();console.log('Preview-only snapshot advanced in memory.');},20000).unref();
let payloadCache=null;
const server=http.createServer(async(req,res)=>{
  if(scope){if(!req.url.startsWith(scope+'/')){res.writeHead(404);return res.end('Open the scoped disposable server URL.');}req.url=req.url.slice(scope.length);}
  if(req.method==='POST'&&req.url==='/api/backup-retention'&&process.env.UI_RETENTION_TEST==='1'){
    try{
      let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),policy=retentionPolicy(body.policy);let result;
      if(body.operation==='preview'){
        const cutoff=new Date(Date.now()-policy.days*86400000).toISOString();
        const items=backups.map(item=>({...item,kind:item.kind||'unknown'})).sort((a,b)=>b.modified.localeCompare(a.modified));
        result={id:'synthetic-'+Date.now(),policy,cutoff,expires:new Date(Date.now()+600000).toISOString(),...retentionSelection(items,{policy,cutoff})};cleanupPlans.set(result.id,result);
      }else if(body.operation==='save'){
        if(body.revision!==retention.revision)throw new Error('Settings changed. Reload before saving.');
        if(policy.enabled&&(!body.confirm||JSON.stringify(cleanupPlans.get(body.planId)?.policy)!==JSON.stringify(policy)))throw new Error('Confirm automatic cleanup first.');
        retention={...retention,policy,revision:retention.revision+1};data.backups.retention=retention;cleanupPlans.clear();result=retention;
      }else throw new Error('Unsupported fixture operation.');
      res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(result));
    }catch(error){res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:error.message}));}
  }
  if(req.method==='POST'&&req.url==='/api/jobs'&&process.env.UI_RETENTION_TEST==='1'){
    let text='';for await(const chunk of req)text+=chunk;const {action,params}=JSON.parse(text),plan=cleanupPlans.get(params?.planId);
    if(action!=='cleanup-backups'||!params?.confirm||!plan){res.writeHead(403,{'content-type':'application/json'});return res.end('{"error":"Only reviewed, simulated backup cleanup is enabled."}');}
    cleanupPlans.delete(plan.id);const job={id:'fixture-cleanup-'+Date.now(),action,state:'running',message:'Simulating cleanup of synthetic archives.',started:new Date().toISOString()};data.jobs.jobs.unshift(job);data.jobs.active=job;
    setTimeout(()=>{for(const candidate of plan.candidates){const index=backups.findIndex(item=>item.relative===candidate.relative);if(index!==-1)backups.splice(index,1);}job.state='succeeded';job.message=`Deleted ${plan.candidates.length} old backups (memory-only simulation).`;job.finished=new Date().toISOString();data.jobs.active=null;data.backups.health=summarizeBackups(backups,schedule,[],null);},300).unref();
    res.writeHead(202,{'content-type':'application/json'});return res.end(JSON.stringify(job));
  }
  if(req.url==='/api/world-setups'){try{if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;setups=changeSetups(setups,JSON.parse(body));}res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(setups));}catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});return res.end(JSON.stringify({error:error.message}));}}
  if(req.method==='GET'&&req.url==='/api/diagnostics'){const report=process.env.UI_DIAGNOSTICS_TEST==='offline'?null:await controllerDiagnostics({version:'0.2.1-alpha',container:'fixture',docker:async(method,route)=>route==='/info'?{Architecture:'aarch64'}:{State:{Running:true}},locations:[{id:'saves',title:'World storage',path:'synthetic'}],access:async()=>{},statfs:async()=>({bavail:400000,bsize:4096}),recentStatus:status});res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(diagnosticsReport('0.2.1-alpha',report)));}

  if(req.method==='GET'&&req.url==='/api/session'&&process.env.UI_SESSION_DELAY_MS)await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Number(process.env.UI_SESSION_DELAY_MS)||0)));
  if(req.method==='GET'&&req.url==='/api/session'&&process.env.UI_AUTH_TEST==='login'){res.writeHead(401,{'content-type':'application/json'});return res.end('{"error":"Sign in to this isolated fixture."}');}
  if(req.method==='POST'&&req.url==='/api/registration'&&process.env.UI_AUTH_TEST==='login'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"owner":true,"role":"admin"}');}
  if(req.method==='POST'&&req.url==='/api/world-preview'){let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);draftPreview={id:'fixture-'+(++previewRequests),seed:value.seed,state:'rendering'};setTimeout(()=>{if(draftPreview?.id==='fixture-'+previewRequests)draftPreview.state='ready';},150).unref();console.log(JSON.stringify({previewRequests,seed:value.seed,water:value.configuration.map_gen_settings.autoplace_controls.water.size}));res.writeHead(202,{'content-type':'application/json'});return res.end(JSON.stringify(draftPreview));}
  if(req.method==='POST'&&req.url==='/api/update-plan'&&process.env.UI_UPDATE_REVIEW_TEST==='1'){let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:'synthetic-review-only',kind:value.kind,current:value.kind==='game'?'2.0.77':'0.1.0-alpha',target:value.target,targetImage:value.source==='factory'?'ghcr.io/jkenneydaniel/factorio-server:'+value.target+'-fc.'+value.imageRevision:'factoriotools/factorio:'+value.target,operation:value.target==='2.0.77'?'image-change':'upgrade',impact:'SIMULATED REVIEW ONLY. No installation can run from this fixture.',backup:'A real installation would save and verify a backup.',notes:'Cancel this review to return.'}));}
  if(req.method==='POST'&&req.url==='/api/jobs'&&process.env.UI_CREATE_TEST==='1'){
    let body='';for await(const chunk of req)body+=chunk;const {action,params}=JSON.parse(body);
    if(action==='create'){
      const job={id:'fixture-create-'+Date.now(),action,state:'running',message:'Simulating world generation. No game files are created.',started:new Date().toISOString()};data.jobs.jobs.unshift(job);
      setTimeout(()=>{job.state='succeeded';job.finished=new Date().toISOString();job.message='Created '+params.name+' (isolated UI simulation). Current server world is unchanged.';data.worlds.worlds.push({id:job.id,name:params.name,relative:'panel-worlds/'+params.name+'.zip',kind:'archive',current:false,modified:job.finished,size:1234567});},300).unref();
      res.writeHead(202,{'content-type':'application/json'});return res.end(JSON.stringify(job));
    }
    res.writeHead(403,{'content-type':'application/json'});return res.end('{"error":"Only simulated library creation is enabled in this UI fixture."}');
  }
  if(req.method==='POST'&&req.url==='/api/onboarding'&&process.env.UI_ONBOARDING_TEST==='1'){data.session.onboarding={completed:true};res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(data.session.onboarding));}
  if(req.method!=='GET'){res.writeHead(403,{'content-type':'application/json'});return res.end('{"error":"This isolated preview cannot change the real server or accounts."}');}
  const route=req.url.split('?')[0];if(route==='/api/world-preview-image'){res.writeHead(200,{'content-type':'image/svg+xml'});return res.end(fixtureImage);}
  if(route==='/api/world-preview'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(draftPreview||{state:'idle'}));}
  if(route==='/api/players'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({available:status.ready,players:status.players.map(name=>({name})),message:status.ready?'':'Factorio is not ready.'}));}
  if(route==='/api/map'&&new URL(req.url,'http://fixture').searchParams.get('format')==='compact-v1'){
    const text=JSON.stringify(snapshot),revision=process.env.UI_AUTO_REFRESH_TEST==='1'?crypto.createHash('sha256').update(text).digest('hex'):'a'.repeat(64);
    if(payloadCache?.text!==text)payloadCache={text,revision,bytes:gzipSync(JSON.stringify(encodeMapPayload(snapshot)))};
    const known=new URL(req.url,'http://fixture').searchParams.get('revision');
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({...data.map,snapshot:undefined,revision,...(known===revision?{unchanged:true}:{payload:{format:mapPayloadFormat,revision}})}));
  }
  if(route==='/api/map-payload'){res.writeHead(payloadCache?200:404,{'content-type':'application/vnd.lobby-goblin.map+gzip'});return res.end(payloadCache?.bytes);}
  if(route.startsWith('/api/')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(route==='/api/live-players'?previewPlayers():route==='/api/map-status'?{created:snapshot.created,automatic:data.map.automatic,active:null}:data[route.slice(5)]||{}));}
  if(route==='/application-definition.json'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(publicContract(factorio)));}
  const files={...sharedAssets,...factorioWeb.assets};const file=files[route];if(!file){res.writeHead(404);return res.end();}let content=await fs.readFile(new URL(file[0],Object.hasOwn(factorioWeb.assets,route)?factorioWeb.publicRoot:new URL('../public/',import.meta.url)));if(scope&&file[1].startsWith('text/html'))content=content.toString().replace(/(href|src)="\/(?!\/)/g,(_,key)=>key+'="'+scope+'/');res.writeHead(200,{'content-type':file[1]});res.end(content);
}).listen(Number(process.env.UI_PREVIEW_PORT||8089),'127.0.0.1',()=>console.log('Isolated UI fixture listening (no server-management access).'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close();});
