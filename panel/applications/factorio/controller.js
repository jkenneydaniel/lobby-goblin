import {RuntimeUpdates,restoreRuntimeBackup} from './runtime-update.js';
import {releaseKey} from './runtime.js';
import {runtimeHelper, runtimeIdentity, installedRuntime, runtimeSoftware, runtimeServer, softwareIdentity} from './runtime.js';
import {createFactorioModLibrary} from './mod-library.js';
import {modLibraryRoutes,validateLibraryAction} from '../../core/mod-library.js';
import {helperWorkspace,readScopedFile,readScopedJSON,removeHelperWorkspace,removeHelperWorker} from '../../core/helper-workspace.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {rcon as query,gameContainerRoute as containerRoute} from './transport.js';
import {listFiles} from '../../core/files.js';
import {StatusMetadata} from './status-metadata.js';
import {assert,HttpError,sleep,stamp,readJSON,writeJSON,json,readBody,requestJSON,safeName,existingFile,inside,redact} from '../../common.js';
import {zipEntries} from '../../core/archive.js';
import {validateWorld} from './world-archive.js';
import {validateBackup} from './backup.js';
import {exportMap} from './map-export.js';
import {completedSave,saveVersion,SaveMapQueue,mapRefreshSettings} from './save-map.js';
import {SnapshotMetadata} from './snapshot-metadata.js';
import {MapDelivery} from './map-delivery.js';
import {LivePlayers} from './live-players.js';
import {validateConfiguration} from './world-settings.js';
import {WorldPreviews,renderWorldPreview,cleanPreviewWorkers} from './world-preview.js';
import {engineMapSettings,mergeSettings} from './engine-settings.js';
import {fields as serverSettingFields,validateServerSettings} from './settings.js';

export async function createFactorio(ctx,{modFetcher=fetch}={}){
const {data,state,backups,container,library,backupDir}=ctx.config;
const {host,docker}=ctx;const info=host.info,control=host.control;
const rcon=(command,name=container)=>query(command,name,docker);
const gameContainerRoute=name=>containerRoute(name,ctx.env.FACTORIO_PLATFORM||'linux/amd64');
const backup=(...args)=>ctx.backups.create(...args);
const stageMessage=(...args)=>ctx.stageMessage(...args);
const runJob=(...args)=>ctx.runJob(...args);
const saves=path.join(data,'saves'),settingsFile=path.join(data,'config/server-settings.json');
const modLibrary=createFactorioModLibrary(ctx,{fetcher:modFetcher,start:async()=>{await modLibrary.assertReady();await control('start');await ready();},stop:async()=>{await control('stop');const server=await info();assert(!server.State.Running&&server.State.ExitCode===0&&!server.State.OOMKilled,'Factorio did not stop cleanly. Check its logs.',409);}});
const worldDefaults=await readJSON(new URL('../../world-defaults.json',import.meta.url));
const autoMapFile=path.join(state,'map-refresh.json');
const snapshotMetadata=new SnapshotMetadata(path.join(state,'map.json'));
const mapDelivery=new MapDelivery(snapshotMetadata);
const autoMap=new SaveMapQueue(await readJSON(autoMapFile,{enabled:true,intervalMinutes:15}),{debounceMs:Number(ctx.env.MAP_SAVE_DEBOUNCE_MS||2000),manualCooldownMs:Number(ctx.env.MAP_MANUAL_REFRESH_COOLDOWN_MS??120000)});
let autoMapWrites=Promise.resolve(),autoMapSaved=null,autoMapPolling=false;
function persistAutoMap(settings){
  autoMapWrites=autoMapWrites.catch(()=>{}).then(async()=>{const value=JSON.stringify({...autoMap.toJSON(),...settings});if(settings||value!==autoMapSaved){await writeJSON(autoMapFile,JSON.parse(value));if(settings)autoMap.configure(settings);autoMapSaved=value;}});return autoMapWrites;
}
const logFile=path.join(data,'factorio-current.log');
const worldPreviews=new WorldPreviews({canRun:()=>!ctx.imageMigrationPending&&!ctx.active&&!ctx.updater.busy,render:async input=>{assert(!await runtimeUpdates.pending(),'Recover the software update before generating previews.',409);const server=await info();assert(await runtimeIdentity(data,server)===input.image,'Factorio changed. Refresh this preview.');return renderWorldPreview(input,{data,state,env:ctx.env,server,docker,gameContainerRoute});}});
const livePlayersFile=path.join(state,'live-players.json');
const livePlayers=new LivePlayers({config:await readJSON(livePlayersFile,{enabled:false}),query:rcon,persist:config=>writeJSON(livePlayersFile,config),scope:async()=>{
  if(ctx.imageMigrationPending||ctx.updater.busy)return {running:false};
  const server=await info();
  if(!server.State.Running||ctx.active&&['switch','restore','settings','restart','stop','start'].includes(ctx.active.action))return {running:false};
  const world=await activeSave(),value=await rcon('/seed'),seed=Number(value.match(/\d+/)?.[0]);assert(Number.isFinite(seed),'Factorio seed is unavailable.');return {running:true,world,seed};
}});
async function logText(){try{return await fs.readFile(logFile,'utf8');}catch{return '';}}
async function activeSave(){
  const log=await logText();const matches=[...log.matchAll(/Loading map \/factorio\/saves\/([^\r\n]+?\.zip):/g)];
  if(matches.length)return path.basename(matches.at(-1)[1]);
  const list=await listFiles(saves,0);return list.filter(x=>x.relative.endsWith('.zip')).sort((a,b)=>b.modified.localeCompare(a.modified))[0]?.relative||null;
}
function fileId(kind,relative){return Buffer.from(`${kind}:${relative}`).toString('base64url');}
async function resolveWorld(id){
  let value;try{value=Buffer.from(String(id),'base64url').toString('utf8');}catch{throw new HttpError(400,'Invalid world.');}
  const colon=value.indexOf(':'),kind=value.slice(0,colon),relative=value.slice(colon+1);
  assert(['active','archive'].includes(kind)&&relative.endsWith('.zip'),'Invalid world.');
  if(kind==='archive')assert(!relative.startsWith('panel-backups/'),'Use backup restore for full backup archives.');
  return {file:await existingFile(kind==='active'?saves:backups,relative),name:path.basename(relative),kind};
}
async function worlds(){
  const current=await activeSave();const result=[];
  for(const file of await listFiles(saves,0))if(file.relative.endsWith('.zip'))result.push({...file,id:fileId('active',file.relative),name:path.basename(file.relative,'.zip'),kind:file.relative.startsWith('_autosave')?'autosave':'active',current:file.relative===current});
  for(const file of await listFiles(backups,4))if(file.relative.endsWith('.zip')&&!file.relative.startsWith('panel-backups/')&&!file.relative.includes('/.'))result.push({...file,id:fileId('archive',file.relative),name:path.basename(file.relative,'.zip'),kind:'archive',current:false});
  for(const world of result)world.hasPreview=world.kind==='archive'&&!!await fs.stat(path.join(backups,world.relative.replace(/\.zip$/,'.png'))).then(s=>s.isFile()).catch(()=>false);
  return result.sort((a,b)=>Number(b.current)-Number(a.current)||b.modified.localeCompare(a.modified));
}
async function saveNow(){
  const before=(await fs.stat(logFile).catch(()=>({size:0}))).size;
  const output=await rcon('/server-save');assert(!/cannot|error/i.test(output),output||'Save request failed.',409);
  for(let i=0;i<120;i++){
    const log=await logText();
    if(/Saving finished|Saving progress: 100/.test(log.slice(before)))return 'World saved successfully.';
    await sleep(500);
  }throw new HttpError(504,'Save was requested but completion could not be confirmed.');
}
async function ready(name=container,timeout){
  const deadline=Date.now()+Number(timeout||ctx.env.FACTORIO_READY_TIMEOUT_MS||(name===container&&runtimeServer(await info())?ctx.env.FACTORIO_INSTALL_TIMEOUT_MS||1200000:60000));
  while(Date.now()<deadline){
    try{const value=await rcon('/version',name);if(/2\.\d+\.\d+/.test(value))return value;}catch{}
    if(name===container){const server=await info();assert(!runtimeServer(server)||server.State.Running,'Factorio stopped during software startup. Check its logs; existing data and the recorded release were retained.',409);}
    await sleep(Math.min(1000,Math.max(0,deadline-Date.now())));
  }throw new HttpError(504,'Factorio did not become ready before the startup deadline.');
}
async function switchWorld(params,job){
  assert(params.confirm===true,'Confirm the world change first.');
  const selected=await resolveWorld(params.id),buffer=await fs.readFile(selected.file);validateWorld(buffer);
  const oldCurrent=await activeSave();const wasRunning=(await info()).State.Running;
  const archive=path.join(library,`before-switch-${stamp()}`);let moved=false;
  await stageMessage(job,'Saving and backing up the current world…');
  if(livePlayers.config.enabled)await livePlayers.configure({enabled:false},'World switch');
  if(wasRunning)await control('stop');
  try{
    const backupName=await backup('before-world-switch',{save:false});
    await fs.mkdir(archive,{recursive:true});
    for(const entry of await fs.readdir(saves,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.zip'))await fs.rename(path.join(saves,entry.name),path.join(archive,entry.name));
    moved=true;
    const name=selected.name.startsWith('_autosave')?`Restored-${stamp()}.zip`:selected.name;
    await fs.writeFile(path.join(saves,name),buffer,{flag:'wx'});
    await stageMessage(job,'Starting the selected world…');await control('start');await ready();
    return `Now running ${path.basename(name,'.zip')}. Previous world backed up as ${backupName}.`;
  }catch(error){
    if(moved){
      await control('stop').catch(()=>{});
      const failed=path.join(library,`failed-switch-${stamp()}`);await fs.mkdir(failed,{recursive:true});
      for(const entry of await fs.readdir(saves,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.zip'))await fs.rename(path.join(saves,entry.name),path.join(failed,entry.name));
      for(const entry of await fs.readdir(archive))await fs.copyFile(path.join(archive,entry),path.join(saves,entry));
      if(oldCurrent)await fs.utimes(path.join(saves,oldCurrent),new Date(),new Date()).catch(()=>{});
    }
    if(wasRunning)await control('start').catch(()=>{});
    throw Object.assign(new HttpError(409,'World switch failed. The previous saves were restored.'),{cause:error});
  }
}
async function restoreBackup(params,job){
  assert(params.confirm===true,'Confirm the backup restore first.');
  const file=await existingFile(backupDir,params.name),entries=zipEntries(await fs.readFile(file));
  validateBackup(await fs.readFile(file));
  assert(entries.some(e=>e.name.startsWith('saves/')&&e.name.endsWith('.zip')),'Backup has no world saves.');
  for(const entry of entries)assert(entry.name==='panel-manifest.json'||/^(saves|config|mods)\//.test(entry.name),'Unexpected file in backup.');
  // Validate and inflate everything before touching the live server.
  const extracted=entries.filter(e=>!e.name.endsWith('/')).map(e=>({name:e.name,data:e.read()}));
  const manifestEntry=extracted.find(e=>e.name==='panel-manifest.json');
  const manifest=manifestEntry?JSON.parse(manifestEntry.data):{};
  const currentSoftware=await installedRuntime(data,await info());assert(!currentSoftware&&!manifest.software||currentSoftware&&manifest.software&&releaseKey(currentSoftware)===releaseKey(manifest.software),'Restore requires the backup’s matching Factorio release. Use software recovery for the recorded pre-update backup.',409);
  const wasRunning=(await info()).State.Running,archive=path.join(backups,`panel-before-restore-${stamp()}`);const moved=[];
  await stageMessage(job,'Saving the current state before restoring…');if(livePlayers.config.enabled)await livePlayers.configure({enabled:false},'Backup restore');if(wasRunning)await control('stop');
  try{
    await backup('before-backup-restore',{save:false});await fs.mkdir(archive,{recursive:true});
    for(const subdir of ['saves','config','mods']){await fs.rename(path.join(data,subdir),path.join(archive,subdir));moved.push(subdir);await fs.mkdir(path.join(data,subdir));}
    for(const entry of extracted)if(entry.name!=='panel-manifest.json'){
      const target=inside(data,entry.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,entry.data);
    }
    if(manifest.activeSave)await fs.utimes(inside(saves,manifest.activeSave),new Date(),new Date());
    await control('start');await ready();return 'Backup restored. The previous state is preserved in the backup library.';
  }catch(error){
    if(moved.length){await control('stop').catch(()=>{});const failed=path.join(backups,`panel-failed-restore-${stamp()}`);await fs.mkdir(failed,{recursive:true});
      for(const subdir of moved){if(await fs.stat(path.join(data,subdir)).catch(()=>null))await fs.rename(path.join(data,subdir),path.join(failed,subdir));await fs.rename(path.join(archive,subdir),path.join(data,subdir));}}
    if(wasRunning)await control('start').catch(()=>{});throw Object.assign(new HttpError(409,'Restore failed; previous data was recovered.'),{cause:error});
  }
}
const EXPORT_LUA='/silent-command local original = helpers.parse_map_exchange_string(game.get_map_exchange_string()); local difficulty = original.map_settings.difficulty_settings; original.map_settings.difficulty_settings = nil; local function plain(template,live) local out = {}; for key,value in pairs(template) do if type(value) == "table" then out[key] = plain(value,live[key]) else out[key] = live[key] end end; return out end; local settings = plain(original.map_settings,game.map_settings); settings.difficulty_settings = plain(difficulty,game.difficulty_settings); helpers.write_file("export-settings.json",helpers.table_to_json({map_gen_settings=game.surfaces["nauvis"].map_gen_settings,map_settings=settings})); rcon.print("Settings exported.")';
async function createWorld(params,job,{optionsOnly=false}={}){
  const configuration=params.configuration===undefined?null:validateConfiguration(params.configuration);
  const extract=optionsOnly||!configuration;
  const name=safeName(params.name||`NewWorld-${new Date().toISOString().slice(0,10)}`),destination=path.join(library,`${name}.zip`);
  if(!optionsOnly)assert(!await fs.stat(destination).catch(()=>null),'A world with this name already exists.');
  let seed=params.seed===''||params.seed==null?crypto.randomInt(1,0x100000000):Number(params.seed);
  assert(Number.isInteger(seed)&&seed>0&&seed<=0xffffffff,'Seed must be an integer between 1 and 4294967295.');
  const settings=await readScopedJSON(data,'config/server-settings.json',{});const server=await info();
  if(extract){assert(server.State.Running,'Start Factorio first so its current world settings can be copied.',409);
    await stageMessage(job,'Saving a copy of the current world…');await saveNow();}
  const source=await activeSave(),workspace=await helperWorkspace({data,state,env:ctx.env,server,docker},job.id);
  const helper=`factorio-panel-job-${job.id}`;let helperExists=false;
  try{
    await workspace.copyInputs();
    const runtime = await runtimeHelper(workspace,{data,server});
    if(extract)await workspace.write('saves/source.zip',(await readScopedFile(data,'saves/'+source)).bytes);
    await workspace.write('config/server-settings.json',JSON.stringify({...settings,name:'Isolated map settings export',visibility:{public:false,lan:false},auto_pause:true}));
    let exported=configuration;
    if(extract){
    await stageMessage(job,'Extracting settings from an isolated copy…');
    await docker('POST',gameContainerRoute(helper),{Image:server.Image||server.Config.Image,Env:[...runtime.env,'DLC_SPACE_AGE=false','UPDATE_MODS_ON_START=false','LOAD_LATEST_SAVE=false','SAVE_NAME=source'],Labels:{'factorio-panel.job':job.id},HostConfig:{NetworkMode:'none',Mounts:runtime.mounts,Memory:1073741824}});helperExists=true;
    await docker('POST',`/containers/${helper}/start`);await ready(helper);
    await rcon(EXPORT_LUA,helper);await rcon(EXPORT_LUA,helper);
    exported=validateConfiguration(await workspace.json('script-output/export-settings.json'),{limits:false});
    await docker('POST',`/containers/${helper}/stop?t=30`);await docker('DELETE',`/containers/${helper}`);helperExists=false;
    }
    if(optionsOnly){await writeJSON(path.join(state,'world-options.json'),{sourceWorld:source,image:server.Config.Image,created:new Date().toISOString(),configuration:exported});return 'Current world settings are ready to customize.';}
    exported=validateConfiguration(exported);
    // Factorio requires every member of gameplay subtrees such as pollution.
    // Fill omitted advanced tuning from this exact installed game image.
    exported.map_settings=mergeSettings(await engineMapSettings(container,await runtimeIdentity(data,server),{docker,data,server}),exported.map_settings);
    if(params.seed==null||params.seed==='')while(seed===exported.map_gen_settings.seed)seed=crypto.randomInt(1,0x100000000);
    exported.map_gen_settings.seed=seed;
    await workspace.write('config/new-map-gen-settings.json',JSON.stringify(exported.map_gen_settings));await workspace.write('config/new-map-settings.json',JSON.stringify(exported.map_settings));
    await stageMessage(job,`Generating a new world with seed ${seed}…`);
    await docker('POST',gameContainerRoute(helper),{Image:server.Image||server.Config.Image,Entrypoint:['/opt/factorio/bin/x64/factorio'],Cmd:['--create','/factorio/saves/generated.zip','--map-gen-settings','/factorio/config/new-map-gen-settings.json','--map-settings','/factorio/config/new-map-settings.json','--mod-directory','/factorio/mods'],Labels:{'factorio-panel.job':job.id},HostConfig:{NetworkMode:'none',Mounts:runtime.mounts,Memory:1073741824}});helperExists=true;
    await docker('POST',`/containers/${helper}/start`);
    const result=await docker('POST',`/containers/${helper}/wait?condition=not-running`,undefined,{timeout:180000});
    assert(result.StatusCode===0,'Factorio could not generate the world.');
    const generated=await workspace.read('saves/generated.zip');validateWorld(generated);await fs.writeFile(destination,generated,{flag:'wx'});
    await writeJSON(path.join(library,`${name}.settings.json`),{...exported,seed,source,created:new Date().toISOString()});
    await docker('DELETE',`/containers/${helper}`);helperExists=false;
    // A preview is generated separately, without opening or scripting the fresh save.
    if(params.preview!==false){
      await stageMessage(job,'Creating the map preview…');
      await docker('POST',gameContainerRoute(helper),{Image:server.Image||server.Config.Image,Entrypoint:['/opt/factorio/bin/x64/factorio'],Cmd:['--generate-map-preview','/factorio/preview.png','--map-preview-size','1024','--map-gen-settings','/factorio/config/new-map-gen-settings.json','--mod-directory','/factorio/mods'],Labels:{'factorio-panel.job':job.id},HostConfig:{NetworkMode:'none',Mounts:runtime.mounts,Memory:1073741824}});helperExists=true;
      await docker('POST',`/containers/${helper}/start`);await docker('POST',`/containers/${helper}/wait?condition=not-running`,undefined,{timeout:180000});
      const preview=await workspace.read('preview.png',8*1024*1024).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(preview)await fs.writeFile(path.join(library,`${name}.png`),preview);
    }
    if(params.activate){assert(params.confirm===true,'Confirm switching to the new world.');await switchWorld({id:fileId('archive',`panel-worlds/${name}.zip`),confirm:true},job);}
    return `Created ${name} with seed ${seed}, using ${configuration?'your chosen':'copied'} settings.${params.activate?' The new world is now running.':' The current world is still running.'}`;
  }finally{
    if(helperExists)await removeHelperWorker(docker,helper);
    await workspace.remove();
  }
}
async function settingsUpdate(params){
  assert(params.confirm===true,'Confirm applying settings and restarting.');
  validateServerSettings(params);
  const current=await readJSON(settingsFile,{}),next={...current};
  for(const {key} of serverSettingFields)if(!['game_password','clear_password'].includes(key)&&Object.hasOwn(params,key))next[key]=params[key];
  if(params.game_password)next.game_password=params.game_password;
  if(params.clear_password)next.game_password='';
  next.visibility={public:false,lan:true};
  const running=(await info()).State.Running;if(running)await control('stop');
  try{await backup('before-settings-change',{save:false});await writeJSON(settingsFile,next);if(running){await control('start');await ready();}}
  catch(error){await writeJSON(settingsFile,current);if(running)await control('start').catch(()=>{});throw error;}
  return 'Server settings saved.';
}
const runtimeUpdates=new RuntimeUpdates({data,state,info,control,backup,restore:(name,previous)=>restoreRuntimeBackup({data,backups,backupDir,name,previous}),stage:stageMessage,ready:async expected=>{const value=await ready(container,Number(ctx.env.FACTORIO_INSTALL_TIMEOUT_MS||1200000));assert(value.trim()===expected,'Factorio reported a different software version.',409);}});
const actions={
  'software-update':(params,job)=>runtimeUpdates.update(params,job),
  'software-recover':(params,job)=>runtimeUpdates.recover(params,job),
  ...modLibrary.actions,
  save:()=>saveNow(),
  start:async()=>{await modLibrary.assertReady();await control('start');await ready();return 'Factorio is running.';},
  stop:async params=>{assert(params.confirm===true,'Confirm stopping the server.');await control('stop');return 'Factorio stopped and saved.';},
  restart:async params=>{await modLibrary.assertReady();assert(params.confirm===true,'Confirm restarting the server.');await control('restart');await ready();return 'Factorio restarted and loaded its latest save.';},
  'live-tracking':async(params,job)=>{
    await livePlayers.validate(params);
    if(params.enabled){await stageMessage(job,'Backing up the world before enabling live tracking…');await backup('before-live-player-tracking');}
    await livePlayers.configure(params,job.actor);
    if(params.enabled){const sample=await livePlayers.get();assert(sample.state==='live','Live tracking is configured but positions are unavailable. The map will retry.');}
    return params.enabled?'Live player tracking enabled for this world. Lua console use disables achievements.':'Live player tracking disabled. This does not restore achievements already disabled.';
  },
  'refresh-map':async(params,job)=>{
    if(!params.automatic){autoMap.claimManual();await persistAutoMap();}
    const server=await info(),world=await activeSave(),automatic=params.automatic;
    assert(!automatic||automatic.world===world,'The active world changed before map export.');
    return exportMap({data,state,env:ctx.env,server,world,source:automatic?.source||world,save:!automatic,expectedVersion:automatic?.version,saveNow,ready,running:server.State.Running,job,stageMessage},{docker,rcon,gameContainerRoute});
  },
  switch:switchWorld,restore:restoreBackup,create:createWorld,'world-options':(params,job)=>createWorld({},job,{optionsOnly:true}),settings:settingsUpdate,
  player:async params=>{
    const commands={kick:'/kick',ban:'/ban',unban:'/unban',promote:'/promote',demote:'/demote',whitelist:'/whitelist add',unwhitelist:'/whitelist remove'};
    assert(commands[params.operation],'Unsupported player action.');assert(typeof params.name==='string'&&/^[\p{L}\p{N}_ .-]{1,64}$/u.test(params.name),'Invalid player name.');
    return await rcon(`${commands[params.operation]} ${params.name}`)||'Player list updated.';
  },
  announce:async params=>{assert(typeof params.message==='string'&&params.message.length>0&&params.message.length<=250&&!/[\r\n\x00]/.test(params.message),'Enter a message up to 250 characters.');return await rcon(`/shout ${params.message}`)||'Announcement sent.';},
  console:async params=>{assert(['/players','/time','/seed','/version','/evolution','/admins','/bans','/whitelist get','/help'].includes(params.command),'Choose one of the supported administrative commands.');return await rcon(params.command);},
};
let statusCache=null,statusAt=0;
const statusMetadata=new StatusMetadata();
async function status(){
  if(statusCache&&Date.now()-statusAt<3000)return statusCache;
  const server=await info(),settings=await readJSON(settingsFile,{}),running=server.State.Running,currentWorld=await activeSave();
  let players=[],playtime='',seed='',version='',rconReady=false;
  if(running)try{
    const output=await rcon('/players online');players=output.split('\n').filter(line=>/^\s+\S/.test(line)).map(line=>line.trim().replace(/ \(online\)$/,''));
    playtime=await rcon('/time');({seed,version}=await statusMetadata.get(server,currentWorld,rcon));rconReady=true;
  }catch{statusMetadata.clear();}
  if(!running)statusMetadata.clear();
  const {cpu,memory}=await host.metrics(running);
  const log=await logText(),saveEvents=[...log.matchAll(/([\d.]+) (?:Info AppManagerStates[^\n]*Saving finished|Info MainLoop[^\n]*Saving progress: 100)/g)];
  const latestEvent=saveEvents.at(-1),started=new Date(server.State.StartedAt).getTime();
  const lastSave=latestEvent?new Date(started+Number(latestEvent[1])*1000).toISOString():null;
  const saveFiles=await listFiles(saves,0),latestFile=saveFiles.filter(x=>x.relative.endsWith('.zip')).sort((a,b)=>b.modified.localeCompare(a.modified))[0];
  const lastSaveAt=lastSave||latestFile?.modified||null;
  const installed=await installedRuntime(data,server).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),softwareRecovery=await runtimeUpdates.pending();
  statusCache={state:server.State.Status,running,ready:rconReady,paused:running&&rconReady&&players.length===0&&settings.auto_pause,players,playtime,seed,version:version||installed?.softwareVersion||(runtimeServer(server)?'Installing…':server.Config.Image.split(':').at(-1)),softwareRecovery:softwareRecovery?{required:true,backup:softwareRecovery.backup}:null,software:runtimeServer(server)?runtimeSoftware:{version:1,mode:'image'},image:server.Config.Image,currentWorld,lastSaveAt,saveVerified:!!lastSave,cpu,memory,autosaveMinutes:settings.autosave_interval,autosaveSlots:settings.autosave_slots,autoPause:settings.auto_pause,connection:ctx.env.GAME_ADDRESS||'localhost:34197',name:settings.name,activeJob:ctx.active,schedule:ctx.schedule};statusAt=Date.now();return statusCache;
}
async function handle(req,res,url){
  if(req.method==='GET'&&url.pathname==='/players'){const value=await status();return json(res,200,{available:value.ready,players:value.players.map(name=>({name})),message:value.ready?'':'Factorio is not ready. Start it before managing players.'});}
  if(modLibraryRoutes.includes(url.pathname))return modLibrary.handle(req,res,url);
  if(['/world-preview','/world-preview-image'].includes(url.pathname)){
    const owner=req.headers['x-panel-user'];assert(typeof owner==='string'&&(/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(owner)||/^remote:[a-f0-9]{32}:[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(owner)),'Preview needs an administrator session.',403);
    if(req.method==='GET'&&url.pathname==='/world-preview')return json(res,200,worldPreviews.status(owner));
    if(req.method==='GET'&&url.pathname==='/world-preview-image'){const png=worldPreviews.image(owner,url.searchParams.get('id'));res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','content-length':png.length});return res.end(png);}
    assert(req.method==='POST'&&url.pathname==='/world-preview','Not found.',404);
    const body=await requestJSON(req),configuration=validateConfiguration(body.configuration),seed=Number(body.seed);
    assert(Number.isInteger(seed)&&seed>=1&&seed<=0xffffffff,'Choose a seed between 1 and 4294967295.');
    const server=await info();return json(res,202,worldPreviews.request(owner,{configuration,seed,image:await runtimeIdentity(data,server)}));
  }
  if(req.method==='GET'&&url.pathname==='/world-options'){const copied=await readJSON(path.join(state,'world-options.json'),null);return json(res,200,{defaults:worldDefaults,copied,currentWorld:await activeSave(),image:(await info()).Config.Image});}
  if(req.method==='GET'&&url.pathname==='/worlds')return json(res,200,{worlds:await worlds()});
  if(req.method==='GET'&&url.pathname==='/map'){
    const known=url.searchParams.get('revision');assert(!known||/^[a-f0-9]{64}$/.test(known),'Invalid map revision.');
    const document=await (url.searchParams.get('format')==='compact-v1'?mapDelivery.document(known):snapshotMetadata.document(known)),snapshot=document.snapshot||document.mapScope||snapshotMetadata.value,seed=snapshot?.seed??snapshotMetadata.seed;
    if(!snapshot)return json(res,200,{snapshot:null,revision:null,pins:[],automatic:autoMap.status(),manual:autoMap.manualStatus()});
    const current=await activeSave();return json(res,200,{...document,automatic:autoMap.status(),manual:autoMap.manualStatus(),staleWorld:snapshot.world!==current,pins:(await readJSON(path.join(state,'map-pins.json'),[])).filter(pin=>pin.world===snapshot.world&&pin.seed===seed)});
  }
  if(req.method==='GET'&&url.pathname==='/map-payload'){
    const revision=url.searchParams.get('revision');assert(/^[a-f0-9]{64}$/.test(revision||''),'Invalid map revision.');
    const bytes=await mapDelivery.bytes(revision);
    // This is an explicit gzip file, not HTTP content-encoding: every proxy
    // transports identical bytes, including Node fetch and the HTTP/2 agent.
    res.writeHead(200,{'content-type':'application/vnd.lobby-goblin.map+gzip','cache-control':'no-store','content-length':bytes.length});return res.end(bytes);
  }
  if(req.method==='GET'&&url.pathname==='/map-status'){
    const snapshot=await snapshotMetadata.read();return json(res,200,{created:snapshot?.created||null,revision:snapshotMetadata.revision,automatic:autoMap.status(),manual:autoMap.manualStatus(),active:ctx.active?.action==='refresh-map'?{message:ctx.active.message}:null});
  }
  if(req.method==='POST'&&url.pathname==='/map-settings'){
    const settings=mapRefreshSettings(await requestJSON(req));await persistAutoMap(settings);return json(res,200,autoMap.status());
  }
  if(req.method==='GET'&&url.pathname==='/live-players')return json(res,200,await livePlayers.get());
  if(req.method==='POST'&&url.pathname==='/pins'){
    const body=await requestJSON(req),snapshot=await readJSON(path.join(state,'map.json'),null);assert(snapshot,'Generate a map first.');
    let pins=await readJSON(path.join(state,'map-pins.json'),[]);
    if(body.remove){assert(typeof body.remove==='string','Invalid pin.');pins=pins.filter(pin=>pin.id!==body.remove);}
    else{
      assert(typeof body.label==='string'&&body.label.trim().length>0&&body.label.length<=80&&Number.isFinite(body.x)&&Number.isFinite(body.y),'Enter a label and valid coordinates.');
      assert(snapshot.chunks.some(chunk=>Math.floor(body.x/32)===chunk.x&&Math.floor(body.y/32)===chunk.y),'Pins must be inside the exported explored area.');
      assert(pins.length<200,'Remove an old pin before adding another.');pins.push({id:crypto.randomUUID(),world:snapshot.world,seed:snapshot.seed,label:body.label.trim(),x:body.x,y:body.y});
    }
    await writeJSON(path.join(state,'map-pins.json'),pins);return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/settings'){
    const value=await readJSON(settingsFile,{});return json(res,200,{name:value.name,description:value.description,max_players:value.max_players,autosave_interval:value.autosave_interval,autosave_slots:value.autosave_slots,auto_pause:value.auto_pause,require_user_verification:value.require_user_verification,passwordSet:!!value.game_password});
  }
  if(req.method==='GET'&&url.pathname==='/logs')return json(res,200,{text:redact((await logText()).split('\n').slice(-250).join('\n'))});
  if(req.method==='GET'&&url.pathname==='/download'){
    let file,name;
    {const world=await resolveWorld(url.searchParams.get('id'));file=world.file;name=world.name;}
    const buffer=await fs.readFile(file);res.writeHead(200,{'content-type':'application/zip','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'content-length':buffer.length});return res.end(buffer);
  }
  if(req.method==='GET'&&url.pathname==='/preview'){
    const world=await resolveWorld(url.searchParams.get('id'));assert(world.kind==='archive','No preview available.',404);
    const relative=path.relative(backups,world.file).replace(/\.zip$/i,'.png');const buffer=await fs.readFile(await existingFile(backups,relative));res.writeHead(200,{'content-type':'image/png'});return res.end(buffer);
  }
  if(req.method==='POST'&&url.pathname==='/upload'){
    assert(!ctx.active,'Wait for the current operation before uploading.',409);const name=safeName(url.searchParams.get('name'));
    const target=path.join(library,`${name}.zip`),buffer=await readBody(req,128*1024*1024);validateWorld(buffer);await fs.writeFile(target,buffer,{flag:'wx'}).catch(error=>{if(error.code==='EEXIST')throw new HttpError(409,'A world with this name already exists.');throw error;});
    return json(res,201,{message:'World uploaded to the library. The current world was not changed.'});
  }
  throw new HttpError(404,'Not found.');
}
async function pollSavedMap(){
  if(autoMapPolling)return;autoMapPolling=true;
  try{
    if(!autoMap.enabled||await runtimeUpdates.pending())return;
    const event=completedSave(await logText()),snapshot=await snapshotMetadata.read();
    if(event.completed&&!event.saving){
      const item=event.completed,file=await existingFile(saves,item.source).catch(()=>null);
      if(file){const stat=await fs.stat(file);autoMap.observe({...item,version:saveVersion(item.world,item.source,stat)},snapshot);}
    }
    if(!ctx.imageMigrationPending&&!ctx.active&&!ctx.updater.busy&&!event.saving&&autoMap.pending){
      const item=autoMap.pending,file=await existingFile(saves,item.source).catch(()=>null);
      if(!file||item.world!==await activeSave()||saveVersion(item.world,item.source,await fs.stat(file))!==item.version)autoMap.pending=null;
      const task=autoMap.claim(false);
      if(task){try{await persistAutoMap();await runJob('refresh-map',{automatic:task},'automatic map refresh');}catch(error){autoMap.finish(task,false,redact(error.message));}}
    }
    await persistAutoMap();
  }catch(error){console.error('Save-triggered map refresh:',redact(error.message));}
  finally{autoMapPolling=false;}
}
return {actions,status,handle,validateBackup,maintenancePending:()=>runtimeUpdates.pending().then(Boolean,()=>true),protectedBackups:async()=>[(await runtimeUpdates.journal())?.backup].filter(Boolean),softwarePolicy:async()=>runtimeServer(await info())?runtimeSoftware:{version:1,mode:'image'},operationSources:[modLibrary.operationSource],
backupVerified:result=>`Backup integrity verified: ${result.worlds} world saves and ${result.files} files. This checks archive contents, not a game-load restore.`,
async validateAction(body){
    await runtimeUpdates.guard(body.action);
    if(body.action==='software-update')assert(body.params?.confirm===true&&/^2\.\d{1,3}\.\d{1,4}$/.test(body.params.version),'Choose and confirm a Factorio release.');
    validateLibraryAction(body.action,body.params);
    if(body.action==='settings')validateServerSettings(body.params);
    if(body.action==='create'&&body.params?.configuration!==undefined)validateConfiguration(body.params.configuration);
    if(body.action==='refresh-map')assert(!body.params||Object.keys(body.params).length===0,'Manual map refresh does not accept source overrides.');
    if(body.action==='live-tracking'&&body.params?.enabled)assert(body.params.confirm===true,'Acknowledge that live tracking disables achievements.');
    if(['switch','restore','stop','restart','settings'].includes(body.action)||body.action==='create'&&body.params?.activate)assert(body.params?.confirm===true,'This action requires confirmation.');
},async backupFiles(label,{save=true}={}){
  if(save&&(await info()).State.Running)await saveNow();
  const files=[];
  for(const subdir of ['saves','config','mods'])for(const item of await listFiles(path.join(data,subdir),4)){
    if(item.relative.endsWith('.tmp.zip'))continue;
    files.push({name:`${subdir}/${item.relative}`,data:await fs.readFile(await existingFile(data,`${subdir}/${item.relative}`))});
  }
  files.push({name:'panel-manifest.json',data:Buffer.from(JSON.stringify({version:1,created:new Date().toISOString(),activeSave:await activeSave(),software:softwareIdentity(await installedRuntime(data,await info())),label}))});
  return files;
},
async init(){await cleanPreviewWorkers(state,{data,env:ctx.env,server:await info(),docker});
// A controller restart can interrupt an export before its finally block runs.
// Stop only the isolated worker belonging to that recorded job before retrying.
for(const job of ctx.jobs)if(['refresh-map','create','world-options'].includes(job.action)&&job.state==='interrupted'&&/^[0-9a-f-]{36}$/.test(job.id)){
  await removeHelperWorkspace(state,job.id);
}
},
async start(){ctx.every(()=>void worldPreviews.tick(),500);ctx.every(pollSavedMap,Number(ctx.env.MAP_SAVE_POLL_MS||5000));await pollSavedMap();},
async beforeJob(job){await runtimeUpdates.guard(job.action);if(!['stop','mod-library-recover'].includes(job?.action))await modLibrary.assertReady();if(worldPreviews.running)await stageMessage(job,'Waiting for the current map preview to finish…');await worldPreviews.waitIdle();},
async afterJob(job,params){if(job.action==='refresh-map'&&params.automatic){autoMap.finish(params.automatic,job.state==='succeeded',job.state==='failed'?job.message:null);await persistAutoMap().catch(error=>console.error('Map queue persistence failed:',redact(error.message)));}},
waitIdle:()=>worldPreviews.waitIdle(),
invalidate(){statusCache=null;statusAt=0;statusMetadata.clear();},
recentStatus:()=>Date.now()-statusAt<10000?statusCache:null,
locations:[{id:'saves',title:'World storage',path:saves}],
};
}
