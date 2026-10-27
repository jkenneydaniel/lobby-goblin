import {createRustSoftware} from './software.js';
import {atomicRecord,readRecord} from '../../providers/steamcmd/files.js';
import {createRustFrameworkChanges,pairedFrameworkMissing} from './framework-changes.js';
import {createRustModStores} from './mod-stores.js';
import {createRustModLibrary} from './mod-library.js';
import {modLibraryRoutes,validateLibraryAction} from '../../core/mod-library.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assert,json,sleep,requestJSON} from '../../common.js';
import {ownedImage} from '../../core/game-images.js';
import {demultiplex} from '../../core/docker.js';
import {createWebRcon,sanitizeLogs} from './transport.js';
import {fields,readSettings,saveSettings,validateSettings} from './settings.js';
import {inventory,writeArchive,verifyArchive} from './archive.js';
import {createModManager,validateModAction} from './mods.js';

export async function createRust(ctx,{rcon=createWebRcon(),readyTimeout=600000,pollInterval=2000,modFetcher=fetch,frameworkFault=async()=>{}}={}){
  const {config,host,docker,env}=ctx,identityRoot=path.join(config.data,config.identity),settingsFile=path.join(identityRoot,'cfg/server.cfg');
  const software=createRustSoftware(ctx);
  let recent=null,password;
  async function owned(){
    const info=await host.info(),labels=info.Config?.Labels||{};
    assert(labels['io.lobby-goblin.game']==='rust'&&labels['io.lobby-goblin.instance']===config.instance,'Container does not belong to this Rust installation. No changes were made.',409);
    assert(info.Mounts?.some(mount=>mount.Destination==='/steamcmd/rust'&&(config.managedVolume?mount.Type==='volume'&&mount.Name===config.managedVolume:mount.Type==='bind'&&path.resolve(mount.Source)===config.hostData)),'Rust container data mount does not match this installation.',409);
    assert(info.Config?.Image===config.image,'Rust container image does not match this installation.',409);
    assert(info.HostConfig?.RestartPolicy?.Name===(config.managedVolume?config.restartPolicy:'unless-stopped'),'Rust requires the unless-stopped restart policy.',409);
    const world=await fs.lstat(config.data).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(world){const root=await fs.realpath(config.data);assert(world.isDirectory()&&root===path.resolve(config.data),'Rust data cannot be a symbolic link.');const marker=JSON.parse(await fs.readFile(path.join(config.data,'.lobby-goblin-rust.json'),'utf8'));assert(marker.game==='rust'&&marker.instance===config.instance,'Rust data does not belong to this installation.',409);}
    else assert(software&&(!['uninstalled','complete'].includes((await software.status()).phase)||await pairedFrameworkMissing(config,'world')),'Rust world storage is missing; inspect installation recovery.',409);
    const stat=await fs.lstat(identityRoot).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat)assert(stat.isDirectory()&&await fs.realpath(identityRoot)===identityRoot,'Rust identity cannot be a symbolic link.');
    const cfg=path.join(identityRoot,'cfg'),cfgStat=await fs.lstat(cfg).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(cfgStat)assert(cfgStat.isDirectory()&&await fs.realpath(cfg)===cfg,'Rust configuration cannot be a symbolic link.');
    if(config.installRoot){
      if(software){
        assert(config.installRoot===path.join(path.dirname(config.data),'engine')&&await fs.realpath(path.dirname(config.data))===path.dirname(config.data),'Managed Rust execution storage is outside its owned mount.',409);
        const engine=await fs.lstat(config.installRoot).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(engine)assert(engine.isDirectory()&&!engine.isSymbolicLink()&&await fs.realpath(config.installRoot)===config.installRoot,'Managed Rust execution storage cannot be linked.',409);
        else assert(!['uninstalled','complete'].includes((await software.status()).phase)||await pairedFrameworkMissing(config,'engine'),'Rust execution storage needs recovery.',409);
      }else assert(await fs.realpath(config.installRoot)===path.resolve(config.installRoot)&&path.join(config.installRoot,'server')===config.data,'Rust mod storage must be the root of this game installation.',409);
      assert(info.Mounts?.some(m=>m.Destination==='/steamcmd/rust'&&(config.managedVolume?m.Name===config.managedVolume:path.resolve(m.Source)===config.hostData)),'Rust mod storage is outside its owned game mount.',409);
    }
    return info;
  }
  async function command(value){
    const info=await owned();assert(info.State?.Running,'Rust is stopped.',409);
    const networks=Object.values(info.NetworkSettings?.Networks||{}).map(network=>network.IPAddress).filter(Boolean);
    assert(networks.length===1&&/^\d{1,3}(\.\d{1,3}){3}$/.test(networks[0]),'Rust must use its single isolated Docker network.',409);
    return rcon({host:networks[0],port:config.rconPort,password,command:value});
  }
  async function serverInfo(){const value=JSON.parse(await command('serverinfo'));assert(value&&typeof value==='object'&&!Array.isArray(value)&&Number.isFinite(value.Players),'Rust returned invalid server status.',502);return value;}
  function started(info,live){
    // WebRCON is available before SaveRestore and environment initialization.
    // Owned images publish a process-scoped health proof after startup completes.
    // Legacy bootstrap is migration-only; its runtime measurements stay zero
    // until the server has finished initializing.
    return ownedImage('rust',info.Config.Image)?info.State.Health?.Status==='healthy':live?.Framerate>0&&live?.Memory>0;
  }
  async function ready(){
    const initial=await owned(),restarts=initial.RestartCount||0,deadline=Date.now()+readyTimeout;
    do{
      try{const live=await serverInfo();if(started(await owned(),live))return;}catch{}
      const current=await owned();
      assert(current.State?.Running&&!current.State?.Restarting&&!current.State?.OOMKilled&&(current.RestartCount||0)===restarts,'Rust exited or restarted before becoming ready. Check its logs and host resources before retrying.');
      await sleep(pollInterval);
    }while(Date.now()<deadline);
    throw Error('Rust did not become ready in time. It may still be loading; check status and logs before retrying.');
  }
  const mods=createModManager({root:config.installRoot,state:config.state,mutableStores:createRustModStores(config),getActive:()=>ctx.active,fetcher:modFetcher,assertStopped:async()=>{assert(!(await owned()).State?.Running,'Stop Rust before changing mod files.',409);},command:async value=>{assert(started(await owned(),await serverInfo()),'Wait for Rust to finish startup.',409);return command(value);}});
  async function rememberProtocol(){
    if(!software)return;
    const output=String(await command('version')),protocols=[...new Set([...output.matchAll(/^Protocol:\s*(\d+\.\d+\.\d+)\s*$/gm)].map(match=>match[1]))];
    if(protocols.length===1)await atomicRecord(path.join(config.state,'software/rust/protocol.json'),{format:1,buildId:(await software.maintenance.execution()).receipt.selection.softwareVersion,protocol:protocols[0]});
  }
  const frameworkChanges=createRustFrameworkChanges(ctx,{software,mods,fetcher:modFetcher,fault:frameworkFault,protocol:async()=>{
    const record=await readRecord(path.join(config.state,'software/rust/protocol.json'),{optional:true,max:4096}),buildId=(await software.maintenance.execution()).receipt.selection.softwareVersion;
    assert(record?.format===1&&record.buildId===buildId&&/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(record.protocol||''),'Start and cleanly stop this Rust build once to retain its exact protocol before installing Carbon.',409);return record.protocol;
  },validate:async(framework,id)=>{
    if(framework==='none')return;
    const name='LobbyGoblinValidation_'+id.replaceAll('-',''),file=name+'.cs',store=mods.store(framework),token=id.replaceAll('-','');
    assert(!await store.read(file),'Validation plugin already exists. Use paired recovery.',409);
    await store.write(file,Buffer.from('using Oxide.Core; namespace Oxide.Plugins { [Info("'+name+'", "Lobby Goblin", "1.0.0")] public class '+name+' : RustPlugin { [ConsoleCommand("lg.validation.'+token+'")] void Probe(ConsoleSystem.Arg arg) { arg.ReplyWith("LG_VALIDATED:'+token+'"); } } }'));
    const deadline=Date.now()+Math.min(readyTimeout,300000);let compiled=false;
    do{const output=await command('lg.validation.'+token);if(String(output).includes('LG_VALIDATED:'+token)){compiled=true;break;}await sleep(pollInterval);}while(Date.now()<deadline);
    assert(compiled,'The framework did not compile and load its validation plugin. Recover the previous software and world before retrying.',409);
    await store.write(file,null);await command((framework==='carbon'?'c.':'oxide.')+'unload '+name);
  }});
  const modLibrary=createRustModLibrary(ctx,{mods,changes:frameworkChanges,owned,start,stop,command,ready:async()=>{const current=await owned();assert(current.State?.Running&&started(current,await serverInfo()),'Wait for Rust to be ready before applying plugins while running.',409);},fetcher:modFetcher});
  async function softwareReadyForSettings(){if(!software)return true;const value=await software.status();return value.phase==='complete'&&!value.recoveryRequired&&!(await frameworkChanges.inspect()).pending;}
  async function start(_params,job=ctx.active){if(frameworkChanges)return frameworkChanges.start(()=>startGame(job));return startGame(job);}
  async function startGame(job){await owned();if(software)await software.ensure(job);const info=await owned();await modLibrary.assertReady();await mods.assertReady();if(!info.State?.Running)await host.control('start');await ready();await rememberProtocol();return 'Rust is ready.';}
  async function stop(){
    const info=await owned();if(!info.State?.Running)return 'Rust is already stopped.';
    // Fail closed if a running server cannot save. Docker's unlimited graceful
    // stop signals the image shutdown handler; never escalate to SIGKILL.
    assert(started(info,await serverInfo()),'Wait for Rust to finish startup before saving or stopping.',409);
    await rememberProtocol();await command('server.save');await owned();await host.control('stop');
    const stopped=await owned();assert(!stopped.State?.Running&&!stopped.State?.Restarting&&stopped.State?.ExitCode===0&&!stopped.State?.OOMKilled,'Rust did not stop cleanly. Check status and logs before retrying.');
    return 'Rust saved and stopped.';
  }
  async function backup(target,label){
    const info=await owned(),resume=!!info.State?.Running;
    // Preflight before interrupting players; inventory again after shutdown.
    await inventory(identityRoot,{requireSave:!resume});
    let stopped=false,originalError;
    try{
      if(resume){await stop();stopped=true;}else assert(info.State?.ExitCode===0&&!info.State?.Restarting&&!info.State?.OOMKilled,'Rust last stopped uncleanly. Start and cleanly stop it before backing up.');
      assert(!(await owned()).State?.Running,'Rust restarted during backup.');
      await writeArchive(target,identityRoot,{identity:config.identity,instance:config.instance,label,extras:await mods.backupRoots(),...(software?{software:await software.receipt()}:{})});
      assert(!(await owned()).State?.Running,'Rust restarted during backup; snapshot discarded.');
      await verifyArchive(target);
    }catch(error){originalError=error;}
    if(stopped){try{await start();}catch(error){throw Error((originalError?'Backup failed. ':'Snapshot copying finished, but the backup was not published. ')+'Rust could not be resumed; check status and start it manually.',{cause:error});}}
    if(originalError)throw originalError;
  }
  async function status(){
    const info=await owned();let live=null,error=null;
    if(info.State?.Running)try{live=await serverInfo();}catch{error='Rust is starting or WebRCON is unavailable.';}
    const initialized=!!live&&started(info,live);if(live&&!initialized)error='Rust is still initializing its world.';
    const metrics=await host.metrics(!!info.State?.Running);
    recent={game:'rust',name:live?.Hostname||'Rust server',running:!!info.State?.Running,ready:initialized,state:info.State?.Status||'unknown',
      players:live?.Players??null,maxPlayers:live?.MaxPlayers??null,fps:live?.Framerate??null,uptime:live?.Uptime??null,
      connection:env.RUST_GAME_ADDRESS||'localhost:28015',identity:config.identity,...metrics,error,activeJob:ctx.active,...(software?{software:await software.status()}:{})};return recent;
  }
  return {
    operationSources:[...(software?[software.operationSource,frameworkChanges.operationSource]:[]),modLibrary.operationSource,mods.operationSource],
    actions:{...modLibrary.actions,'software-recover':async(params,job)=>{assert(software,'This installation uses the legacy Rust installer.',409);await software.recover(params,job);return 'Initial Rust software recovered. Start Rust when ready.';},'software-cancel':async params=>{assert(software,'This installation uses the legacy Rust installer.',409);return software.cancel(params);},start,stop,restart:async()=>{await stop();await start();return 'Rust restarted and is ready.';},
      'install-framework':async (params,job)=>{const image=await docker('GET','/images/'+encodeURIComponent((await owned()).Image)+'/json');assert(image.Config?.Labels?.['io.lobby-goblin.rust-mods']==='1','Framework management requires the mod-capable Rust image (steam-lg.2 or newer). Upgrade that game image before installation.',409);if(frameworkChanges){assert(image.Config?.Labels?.['io.lobby-goblin.mod-data']==='1','Managed frameworks require the reviewed mod-data image. Existing installations are not changed automatically.',409);return frameworkChanges.prepare(params.planId,job);}return mods.install(params.planId,job);},'recover-framework':params=>frameworkChanges?frameworkChanges.recover(params):mods.recover(),plugin:params=>mods.plugin(params),'plugin-config':params=>mods.configuration(params.name,params),
      'save-settings':async params=>{await owned();assert(await softwareReadyForSettings(),'Finish or recover initial software setup before editing Rust settings.',409);assert(!(await owned()).State?.Running,'Stop Rust before saving settings.',409);await saveSettings(settingsFile,params.values,params.revision);return 'Settings saved. They take effect when Rust starts.';}},
    status,recentStatus:()=>recent,locations:[{id:'rust-identity',title:'Rust identity',path:identityRoot}],
    backupExtension:'.tar.gz',writeBackup:backup,verifyBackupFile:verifyArchive,
    backupVerified:result=>`Rust archive verified: ${result.files} files, including a world save. Archive integrity checked; game-load recovery is a separate test.`,
    validateAction(body){
      validateLibraryAction(body.action,body.params);
      if(['software-recover','software-cancel'].includes(body.action))assert(software&&body.params?.confirm===true,'Inspect and confirm this managed Rust software change.',409);
      if(body.action==='recover-framework'&&frameworkChanges)assert(/^[a-f0-9]{64}$/.test(body.params?.review||''),'Inspect the paired framework recovery first.',409);
      if(body.action==='software-recover')assert(/^[a-f0-9]{64}$/.test(body.params.review||''),'Inspect the installation before recovery.',409);
      if(['install-framework','recover-framework','plugin','plugin-config'].includes(body.action))validateModAction(body.action,body.params);
      if(['stop','restart','backup'].includes(body.action))assert(body.params?.confirm===true,'Confirm the Rust server interruption first.');
      if(body.action==='save-settings'){validateSettings(body.params?.values);assert(typeof body.params?.revision==='string','Reload settings first.');}
    },
    validateSchedule(value){if(value.enabled)assert(value.confirmDowntime===true,'Confirm that scheduled backups briefly stop Rust.');},
    async handle(req,res,url){
      if(req.method==='GET'&&url.pathname==='/software'){await owned();assert(software,'This installation uses the legacy Rust installer.',409);return json(res,200,await software.inspect());}
      if(req.method==='GET'&&url.pathname==='/framework-change'){await owned();assert(frameworkChanges,'This installation uses legacy framework recovery.',409);return json(res,200,await frameworkChanges.inspect());}
      if(modLibraryRoutes.includes(url.pathname)){if(req.method==='POST'&&frameworkChanges)await frameworkChanges.guard('mod-library-plan');return modLibrary.handle(req,res,url);}
      if(url.pathname==='/mods-plan'){assert(req.method==='POST','Not found.',404);await owned();assert(!ctx.active,'Wait for the current operation.',409);if(frameworkChanges)await frameworkChanges.guard('mods-plan');return json(res,200,await (frameworkChanges||mods).plan((await requestJSON(req)).framework));}
      if(req.method==='GET'&&url.pathname==='/mods'){
        const info=await owned(),image=config.installRoot?await docker('GET','/images/'+encodeURIComponent(info.Image)+'/json'):null,capable=image?.Config?.Labels?.['io.lobby-goblin.rust-mods']==='1'&&(!software||image.Config.Labels['io.lobby-goblin.mod-data']==='1'),change=frameworkChanges?await frameworkChanges.inspect():null,value=await mods.status();
        return json(res,200,{...value,imageCapable:capable,editable:!info.State?.Running&&!ctx.active&&!change?.pending,pairedRecovery:!!frameworkChanges,pairedPending:!!change?.pending,recoveryRequired:value.recoveryRequired||!!change?.pending,message:change?.pending?'A paired framework change is pending. Start Rust to validate prepared files, or recover the previous software and world.':capable?value.message:'Framework installation requires a compatible mod-capable Rust image and controller storage. Existing game containers are not restarted automatically.'});
      }
      if(req.method==='GET'&&url.pathname==='/plugin-config'){await owned();return json(res,200,await mods.configuration(url.searchParams.get('name')));}
      assert(req.method==='GET','Not found.',404);
      if(url.pathname==='/players'){
        const info=await owned();if(!info.State?.Running)return json(res,200,{players:[],available:false,message:'Rust is stopped.'});
        const values=JSON.parse(await command('playerlist'));assert(Array.isArray(values)&&values.length<=1000,'Invalid Rust player list.',502);
        return json(res,200,{available:true,players:values.map(value=>({id:String(value.SteamID||''),name:String(value.DisplayName||''),ping:Number.isFinite(Number(value.Ping))?Number(value.Ping):null,connectedSeconds:Number(value.ConnectedSeconds)||0}))});
      }
      if(url.pathname==='/logs'){
        await owned();const logs=await docker('GET',`/containers/${encodeURIComponent(config.container)}/logs?stdout=true&stderr=true&tail=300`,undefined,{raw:true});
        return json(res,200,{logs:sanitizeLogs(demultiplex(logs),password)});
      }
      if(url.pathname==='/settings'){
        const info=await owned(),value=await readSettings(settingsFile),setupReady=await softwareReadyForSettings();
        return json(res,200,{fields,values:value.values,configured:value.configured,revision:value.revision,editable:setupReady&&!info.State?.Running&&!ctx.active,message:setupReady?'Stop Rust before saving. Changes apply at the next start. Unlisted settings are preserved.':'Finish or recover initial software setup before editing Rust settings.'});
      }
      assert(false,'Not found.',404);
    },
    async init(){password=(await fs.readFile(config.passwordFile,'utf8')).trim();assert(/^[A-Za-z0-9_-]{32,128}$/.test(password),'Rust requires a 32–128 character generated WebRCON secret.');},
    async start(){},async beforeJob(job){await owned();if(frameworkChanges)await frameworkChanges.guard(job?.action);if(!['stop','mod-library-recover','software-recover','software-cancel'].includes(job?.action))await modLibrary.assertReady();},async afterJob(){},async waitIdle(){},invalidate(){recent=null;},
  };
}
