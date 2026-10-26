// Run inside the panel image on a disposable amd64 Docker host, with only the
// Docker socket and this PUBLIC source mounted. Never uses deployment .env/data.
import fs from 'node:fs/promises';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {docker,demultiplex} from '../core/docker.js';import {migrateImage,assertCleanStop} from '../core/image-migration.js';import {acceptanceTarget,validateAcceptanceImage} from './image-acceptance-target.js';import {sanitizeLogs} from '../applications/rust/transport.js';
const execute=promisify(execFile),game=process.argv[2]||'rust',fresh=process.argv.includes('--fresh'),mods=process.argv.includes('--mods');assert.ok(!mods||fresh&&game==='rust','Mod acceptance requires a fresh disposable Rust server');assert.ok(['rust','factorio'].includes(game));assert.ok(!fresh||game==='rust','Fresh install acceptance is specific to Rust');
const id=crypto.randomBytes(12).toString('hex'),instance=id.padEnd(32,'0'),prefix='lobby-goblin-acceptance-'+id,name=prefix+'-game',volume=prefix+'-data',archive=prefix+'-backup',network=prefix+'-net',password=crypto.randomBytes(32).toString('hex'),label='io.lobby-goblin.acceptance='+id;
const panel=process.env.ACCEPTANCE_PANEL_IMAGE,rconName=prefix+'-rcon',controllerName=prefix+'-controller';assert.ok(panel,'Select the disposable panel image, never an installed deployment image');
const {target,expectedId}=acceptanceTarget(game),legacy=game==='rust'?'didstopia/rust-server@sha256:f935f9631e53ad1a235b446496716e1ae65a8d179a3b620abf38e29b9877f88e':'factoriotools/factorio:2.0.77';
const cmd=async args=>{try{return (await execute('docker',args,{timeout:1800000,maxBuffer:8*1024**2})).stdout.trim();}catch{throw Error('Disposable Docker operation failed: '+args[0]);}};
const helper=async(code,{write=false}={})=>cmd(['run','--rm','--platform','linux/amd64','--network','none','--label',label,'--user','0:0','--mount',`type=volume,source=${volume},target=/game${write?'':',readonly'}`,'--mount',`type=volume,source=${archive},target=/evidence`,'--entrypoint','node',panel,'--input-type=module','-e',code]);
// One long-lived connection: Rust limits connection attempts per source IP.
const rcon=async(command)=>game==='rust'?cmd(['exec',rconName,'node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:19199',{method:'POST',body:process.argv[1]});const t=await r.text();if(!r.ok)throw Error(t);console.log(t);",command]):cmd(['exec',name,'rcon',command]);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(){for(let n=0;n<900;n++){const info=JSON.parse(await cmd(['inspect',name]))[0];assert.ok(info.State.Running&&!info.State.OOMKilled,'The disposable game crashed');try{const result=await rcon(game==='rust'?'serverinfo':'/version');if(game==='factorio'){assert.match(result,/2\.0\.77/);return;}if(JSON.parse(result).Players===0){const logs=demultiplex(await docker('GET','/containers/'+name+'/logs?'+new URLSearchParams({stdout:'1',stderr:'1',tail:'500',since:String(Math.floor(Date.parse(info.State.StartedAt)/1000))}),undefined,{raw:true}));if(/Server startup complete/.test(logs))return;}}catch{}await wait(2000);}throw Error('Disposable game did not become ready');}
async function cleanStop(){if(game==='rust')await rcon('server.save');await cmd(['stop','--timeout','-1',name]);const info=JSON.parse(await cmd(['inspect',name]))[0];await assertCleanStop(docker,info,game);}
let journal=null;const report={game,id,fresh,mods,checks:[],publishedImageResolution:false,targetImage:target,targetImageId:expectedId};
try{
 assert.equal((await docker('GET','/info')).OSType,'linux');assert.ok(['x86_64','amd64'].includes((await docker('GET','/info')).Architecture));
 const selectedImage=await docker('GET','/images/'+encodeURIComponent(target)+'/json');validateAcceptanceImage(game,target,expectedId,selectedImage);report.targetImageId=selectedImage.Id;
 for(const v of [volume,archive])await cmd(['volume','create','--label',label,v]);await cmd(['network','create','--label',label,network]);
 if(!fresh)await cmd(['pull','--platform','linux/amd64',legacy]);
 if(game==='rust'){
  const settings='server.hostname "Disposable migration"\nserver.maxplayers 7\nserver.saveinterval 600\n';
  await helper("import fs from 'node:fs/promises';await fs.mkdir('/game/server/lobby-goblin-rust/cfg',{recursive:true});await fs.writeFile('/game/server/lobby-goblin-rust/cfg/server.cfg',"+JSON.stringify(settings)+");",{write:true});
  const env={RUST_SERVER_IDENTITY:'lobby-goblin-rust',RUST_RCON_PASSWORD:password,RUST_RCON_PORT:'28016',RUST_RCON_WEB:'1',RUST_SERVER_NAME:'',RUST_SERVER_DESCRIPTION:'',RUST_SERVER_MAXPLAYERS:'',RUST_SERVER_SAVE_INTERVAL:'',RUST_SERVER_PORT:'28015',RUST_SERVER_QUERYPORT:'28017',RUST_SERVER_LEVEL:'Procedural Map',RUST_SERVER_WORLDSIZE:'1000',RUST_SERVER_SEED:'456',RUST_START_MODE:'2',RUST_UPDATE_CHECKING:'0',RUST_OXIDE_ENABLED:'0',RUST_OXIDE_UPDATE_ON_BOOT:'0',RUST_HEARTBEAT:'0',RUST_SERVER_STARTUP_ARGUMENTS:'-batchmode -nographics +server.secure 1 -logfile -'};
  await cmd(['run','-d','--name',name,'--platform','linux/amd64','--label',label,'--label','io.lobby-goblin.game=rust','--label','io.lobby-goblin.instance='+instance,'--network',network,'--memory','12g','--cpus','4','--restart','unless-stopped','--mount',`type=volume,source=${volume},target=/steamcmd/rust`,...Object.entries(env).flatMap(([k,v])=>['-e',k+'='+v]),fresh?target:legacy]);
  await cmd(['run','-d','--name',rconName,'--platform','linux/amd64','--label',label,'--network',network,'-e','TEST_PASSWORD='+password,'-e','TEST_HOST='+name,'--entrypoint','node',panel,'--input-type=module','-e',"import http from 'node:http';import {createWebRcon} from './applications/rust/transport.js';const client=createWebRcon();http.createServer(async(q,s)=>{let command='';for await(const b of q)command+=b;try{s.end(await client({host:process.env.TEST_HOST,port:28016,password:process.env.TEST_PASSWORD,command,timeout:10000}));}catch{s.writeHead(503);s.end('Disposable RCON request failed');}}).listen(19199,'127.0.0.1');process.on('SIGTERM',()=>{client.close();process.exit(0);});"]);
 }else{
  await cmd(['run','--rm','--platform','linux/amd64','--label',label,'--network','none','--mount',`type=volume,source=${volume},target=/factorio`,'--entrypoint','/bin/bash',legacy,'-ec',"mkdir -p /factorio/{config,saves,mods}; cp /opt/factorio/data/server-settings.example.json /factorio/config/server-settings.json; printf 'disposable-rcon-password' > /factorio/config/rconpw; printf '{\"mods\":[{\"name\":\"base\",\"enabled\":true},{\"name\":\"space-age\",\"enabled\":false},{\"name\":\"quality\",\"enabled\":false},{\"name\":\"elevated-rails\",\"enabled\":false}]}' > /factorio/mods/mod-list.json; /opt/factorio/bin/x64/factorio --create /factorio/saves/Acceptance.zip --mod-directory /factorio/mods; chown -R 845:845 /factorio"]);
  await cmd(['run','-d','--platform','linux/amd64','--name',name,'--label',label,'--network',network,'--memory','2g','--cpus','2','--restart','unless-stopped','--mount',`type=volume,source=${volume},target=/factorio`,'-e','DLC_SPACE_AGE=false','-e','LOAD_LATEST_SAVE=true','-e','GENERATE_NEW_SAVE=false',legacy]);
 }
 await ready();report.checks.push(fresh?'first-party-fresh-install-ready':'legacy-ready');
 if(game==='rust'){await rcon('env.time 13.37');await wait(1000);await rcon('server.save');}
 else{await rcon('/silent-command storage.lg034="before"; rcon.print(storage.lg034)');assert.match(await rcon('/silent-command storage.lg034="before"; rcon.print(storage.lg034)'),/before/);}
 const hashCode=game==='rust'?"['RustDedicated','server/lobby-goblin-rust/cfg/server.cfg']":"['config/server-settings.json','config/rconpw','mods/mod-list.json']";
 const inventory=()=>helper("import fs from 'node:fs/promises';import crypto from 'node:crypto';const result={};for(const p of "+hashCode+")result[p]=crypto.createHash('sha256').update(await fs.readFile('/game/'+p)).digest('hex');console.log(JSON.stringify(result));");
 const modList=()=>helper("import fs from 'node:fs/promises';console.log(await fs.readFile('/game/mods/mod-list.json','utf8'));");
 report.before=JSON.parse(await inventory());if(game==='factorio')report.initialMods=JSON.parse(await modList());
 const original=JSON.parse(await cmd(['inspect',name]))[0];if(fresh)assert.equal(original.Image,report.targetImageId,'Fresh install must run the selected build');
 const owned=async info=>{assert.equal(info.Config.Labels['io.lobby-goblin.acceptance'],id);assert.ok(info.Mounts.some(m=>m.Name===volume&&m.Destination===(game==='rust'?'/steamcmd/rust':'/factorio')));};
 const migrationOptions={docker,name,game,target,owned,journal:null,save:async value=>{journal=structuredClone(value);},
  // Acceptance uses the locally built unpublished image. Production always
  // calls ensureOwnedImage, requiring an actual GHCR digest and contract labels.
  resolveImage:async()=>{const image=await docker('GET','/images/'+encodeURIComponent(target)+'/json');validateAcceptanceImage(game,target,report.targetImageId,image);return {image,reference:target};},
  backupStop:async()=>{await cleanStop();if(game==='factorio'){report.stopped=JSON.parse(await inventory());report.stoppedMods=JSON.parse(await modList());assert.deepEqual(report.stoppedMods,report.initialMods,'The old game must preserve its mod selections during its own shutdown');for(const key of ['config/server-settings.json','config/rconpw'])assert.equal(report.stopped[key],report.before[key]);}if(game==='rust')return helper("import {writeArchive,verifyArchive} from './applications/rust/archive.js';await writeArchive('/evidence/before.tar.gz','/game/server/lobby-goblin-rust',{identity:'lobby-goblin-rust',instance:'"+id.padEnd(32,'0')+"',label:'before-image-migration'});console.log(JSON.stringify(await verifyArchive('/evidence/before.tar.gz')));");return helper("import fs from 'node:fs/promises';import {makeZip,zipEntries} from './core/archive.js';const files=[];for(const d of ['saves','config','mods'])for(const n of await fs.readdir('/game/'+d)){const p=d+'/'+n;if((await fs.stat('/game/'+p)).isFile())files.push({name:p,data:await fs.readFile('/game/'+p)});}const zip=makeZip(files);await fs.writeFile('/evidence/before.zip',zip);console.log(zipEntries(zip).length);");},configured:async()=>{},ready};
 const result=fresh?await(async()=>{await migrationOptions.backupStop();await cmd(['start',name]);await ready();return {phase:'complete'};})():await migrateImage(migrationOptions);
 assert.equal(result.phase,'complete');report.after=JSON.parse(await inventory());assert.deepEqual(report.after,game==='factorio'?report.stopped:report.before);report.checks.push(fresh?'first-party-fresh-start':'image-migration','configuration-and-binaries-unchanged','same-world-ready');
 if(game==='rust'){
  assert.match(await rcon('server.seed'),/456/);assert.match(await rcon('server.worldsize'),/1000/);assert.equal(JSON.parse(await rcon('serverinfo')).MaxPlayers,7);assert.equal(JSON.parse(await rcon('playerlist')).length,0);
  await cmd(['run','--rm','--platform','linux/amd64','--network','container:'+name,'--label',label,'-e','TEST_PASSWORD='+password,'--entrypoint','node',panel,'--input-type=module','-e',"import {createWebRcon} from './applications/rust/transport.js';const client=createWebRcon();try{const o={host:'127.0.0.1',port:28016,password:process.env.TEST_PASSWORD,command:'serverinfo'};for(let n=0;n<20;n++)JSON.parse(await client(o));await Promise.all(Array.from({length:10},()=>client(o)));}finally{client.close();}"]);
  report.checks.push('players','settings','30-burst-requests');await rcon('env.time 18.5');await rcon('server.save');await cleanStop();
  await helper("import fs from 'node:fs/promises';import {extractRust} from './fleet/snapshots.js';await fs.rename('/game/server/lobby-goblin-rust','/game/server/after-migration');await extractRust('/evidence/before.tar.gz','/evidence/restored');await fs.cp('/evidence/restored/identity','/game/server/lobby-goblin-rust',{recursive:true});",{write:true});
  await cmd(['start',name]);await ready();report.recoveredTime=await rcon('env.time');assert.ok(Math.abs(Number(report.recoveredTime.match(/\d+(?:\.\d+)?/)?.[0])-13.37)<.3,report.recoveredTime);report.checks.push('backup-recovery');
 }else{
  assert.match(await rcon('/silent-command rcon.print(storage.lg034)'),/before/);
  assert.match(await rcon('/silent-command storage.lg034="after"; rcon.print(storage.lg034)'),/after/);await cleanStop();
  await helper("import fs from 'node:fs/promises';import {zipEntries} from './core/archive.js';await fs.rename('/game/saves','/game/after-migration-saves');await fs.mkdir('/game/saves');for(const e of zipEntries(await fs.readFile('/evidence/before.zip'))){if(!/^saves\\/[A-Za-z0-9_.-]+\\.zip$/.test(e.name))continue;await fs.writeFile('/game/'+e.name,e.read(),{flag:'wx'});}",{write:true});
  await cmd(['start',name]);await ready();assert.match(await rcon('/silent-command rcon.print(storage.lg034)'),/before/);report.checks.push('backup-recovery');
 }
 if(game==='rust'){
  // Exercise the real shared HTTP controller and Rust module against this game,
  // beyond the lower-level migration engine and RCON acceptance above.
  await helper("import fs from 'node:fs/promises';const marker="+JSON.stringify({game:'rust',instance})+";for(const root of ['/game/server','/evidence/runtime-state','/evidence/runtime-backups']){await fs.mkdir(root,{recursive:true});await fs.writeFile(root+'/.lobby-goblin-rust.json',JSON.stringify(marker));}await fs.writeFile('/evidence/rconpw',"+JSON.stringify(password)+");await fs.writeFile('/evidence/controller-token',"+JSON.stringify(password)+");",{write:true});
  const config={managedVolume:volume,restartPolicy:'unless-stopped',instance,container:name,image:target,hostData:'/unused-disposable-host',identity:'lobby-goblin-rust',data:'/game/server',installRoot:'/game',state:'/evidence/runtime-state',backups:'/evidence/runtime-backups',library:'/evidence/runtime-state/library',backupDir:'/evidence/runtime-backups/archives',rconPort:28016,passwordFile:'/evidence/rconpw'};
  await cmd(['run','-d','--name',controllerName,'--platform','linux/amd64','--label',label,'--network',network,'--memory','512m','--user','0:0','--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock','--mount',`type=volume,source=${volume},target=/game`,'--mount',`type=volume,source=${archive},target=/evidence`,'-e','TEST_CONFIG='+JSON.stringify(config),'--entrypoint','node',panel,'--input-type=module','-e',"import {startController} from './core/controller.js';import {rust} from './applications/rust/index.js';const server=await startController({...rust,configuration:()=>JSON.parse(process.env.TEST_CONFIG)},{env:{CONTROLLER_TOKEN_FILE:'/evidence/controller-token'},hostname:'127.0.0.1',port:8081});process.once('SIGTERM',()=>{server.close(()=>process.exit(0));server.closeIdleConnections();setTimeout(()=>process.exit(1),5000).unref();});"]);
  const api=async(route,body)=>JSON.parse(await cmd(['exec',controllerName,'node','--input-type=module','-e',"import fs from 'node:fs/promises';const token=(await fs.readFile('/evidence/controller-token','utf8')).trim();const response=await fetch('http://127.0.0.1:8081'+process.argv[1],{method:process.argv[2]?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:process.argv[2]||undefined});const data=await response.json();if(!response.ok)throw Error('Disposable controller HTTP failure');console.log(JSON.stringify(data));",route,...(body?[JSON.stringify(body)]:[])]));
  for(let n=0;;n++){try{assert.equal((await api('/status')).ready,true);break;}catch(error){if(n>=30)throw error;await wait(1000);}}
  assert.equal((await api('/players')).players.length,0);assert.ok((await api('/logs')).logs);const settings=await api('/settings');assert.ok(settings.revision);
  const operation=async(action,params={confirm:true})=>{const queued=await api('/jobs',{action,params});for(let n=0;n<900;n++){const status=await api('/jobs'),job=status.jobs.find(j=>j.id===queued.id);if(job&&!['queued','running'].includes(job.state)&&!status.active){assert.equal(job.state,'succeeded',job.message);return job.result;}await wait(1000);}throw Error('Disposable module job timeout');};
  const backup=await operation('backup');assert.match(backup,/^Backup created: .+\.tar\.gz$/);const backups=await api('/backups');assert.ok(backups.backups.length>0);
  await operation('stop');assert.equal((await api('/status')).running,false);const stoppedSettings=await api('/settings');assert.equal(stoppedSettings.editable,true);
  await operation('save-settings',{values:{...stoppedSettings.values,'server.maxplayers':8},revision:stoppedSettings.revision});await operation('start');assert.equal((await api('/status')).maxPlayers,8);await operation('restart');assert.equal((await api('/status')).ready,true);
  report.checks.push('controller-status-players-logs-settings','controller-verified-backup','controller-stop-edit-start-restart');
  if(mods){
   const source='namespace Oxide.Plugins { [Info("LobbyGoblinProbe", "Lobby Goblin", "1.0.0")] public class LobbyGoblinProbe : RustPlugin { [ConsoleCommand("lg.probe")] void Probe(ConsoleSystem.Arg arg) { arg.ReplyWith("LG_MOD_PROBE_OK"); } } }';
   for(const framework of ['carbon','oxide']){
    await operation('stop');const plan=await api('/mods-plan',{framework});await operation('install-framework',{planId:plan.id,confirm:true});
    await operation('plugin',{operation:'install',name:'LobbyGoblinProbe.cs',source,confirm:true});await operation('start');
    assert.match(await rcon(framework==='carbon'?'c.version':'oxide.version'),framework==='carbon'?/carbon/i:/oxide/i);
    for(let n=0;;n++){const reply=await rcon('lg.probe');if(/LG_MOD_PROBE_OK/.test(reply))break;assert.ok(n<90,'Framework must compile and execute the disposable plugin');await wait(2000);}
    await operation('plugin',{operation:'reload',name:'LobbyGoblinProbe.cs',confirm:true});
    const backupResult=await operation('backup');assert.match(backupResult,/Backup created:/);
    await operation('stop');const listing=await api('/backups'),latest=listing.backups[0];assert.ok(latest);
    // Recover the complete modded backup into this test's exclusive volumes.
    const archiveName=latest.relative;assert.match(archiveName,/^[A-Za-z0-9_. -]+\.tar\.gz$/);
    await helper("import fs from 'node:fs/promises';import {extractRust} from './fleet/snapshots.js';import {verifyArchive} from './applications/rust/archive.js';const backup='/evidence/runtime-backups/archives/'+"+JSON.stringify(archiveName)+";if(!(await verifyArchive(backup)).modded)throw Error('Expected modded backup');const restored='/evidence/restored-mods-"+framework+"';await extractRust(backup,restored);await fs.rename('/game/server/lobby-goblin-rust','/game/server/pre-mod-recovery-"+framework+"');await fs.cp(restored+'/identity','/game/server/lobby-goblin-rust',{recursive:true});for(const name of ['carbon','oxide'])if(await fs.stat(restored+'/mods/'+name).catch(()=>null))await fs.cp(restored+'/mods/'+name,'/game/'+name,{recursive:true});await fs.cp(restored+'/mod-state','/evidence/runtime-state/mods',{recursive:true});await fs.cp(restored+'/mod-state/backup-active','/game',{recursive:true});",{write:true});
    await operation('start');for(let n=0;;n++){if(/LG_MOD_PROBE_OK/.test(await rcon('lg.probe')))break;assert.ok(n<90,'Recovered modded server must execute its plugin');await wait(2000);}
    await operation('stop');const vanilla=await api('/mods-plan',{framework:'none'});await operation('install-framework',{planId:vanilla.id,confirm:true});await operation('start');report.checks.push(framework+'-native-loader-plugin-reload-backup-recovery-vanilla');
   }
  }
  await cmd(['stop','--timeout','10',controllerName]);assert.equal(JSON.parse(await cmd(['inspect',controllerName]))[0].State.ExitCode,0,'Disposable HTTP controller must exit cleanly');await cmd(['rm',controllerName]);
 }
 await cleanStop();await cmd(['start',name]);await ready();await cleanStop();report.checks.push('clean-stop-start-restart');
 const final=JSON.parse(await cmd(['inspect',name]))[0];assert.equal(final.Image,report.targetImageId,'Acceptance must exercise the selected build');assert.deepEqual(final.HostConfig.PortBindings,original.HostConfig.PortBindings);assert.equal(final.HostConfig.Memory,original.HostConfig.Memory);assert.equal(final.HostConfig.NanoCpus,original.HostConfig.NanoCpus);report.checks.push('resources-and-ports-preserved');
 if(process.env.ACCEPTANCE_REPORT_DIR){await fs.mkdir(process.env.ACCEPTANCE_REPORT_DIR,{recursive:true});await fs.writeFile(process.env.ACCEPTANCE_REPORT_DIR+'/'+game+'.passed.json',JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
}catch(error){
 if(process.env.ACCEPTANCE_REPORT_DIR){
  const directory=process.env.ACCEPTANCE_REPORT_DIR;await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(directory+'/'+game+'.failure.json',JSON.stringify({...report,error:error.message,migrationPhase:journal?.phase},null,2));
  const logs=await execute('docker',['logs','--tail','250',name],{timeout:30000,maxBuffer:4*1024**2}).then(r=>r.stdout+'\n'+r.stderr).catch(()=> 'Disposable container logs unavailable');
  await fs.writeFile(directory+'/'+game+'.game.log',sanitizeLogs(logs,password));
  const current=await docker('GET','/containers/'+name+'/json').catch(()=>null);if(current)await fs.writeFile(directory+'/'+game+'.state.json',JSON.stringify(current.State,null,2));
 }
 console.error(JSON.stringify({game,id,checks:report.checks,error:error.message,migrationPhase:journal?.phase}));throw Error('Disposable '+game+' acceptance failed; inspect its private report.',{cause:error});
}finally{
 const containers=JSON.parse(await cmd(['ps','-a','--filter','label='+label,'--format','json']).then(value=>'['+value.split('\n').filter(Boolean).join(',')+']'));
 for(const c of containers){const info=JSON.parse(await cmd(['inspect',c.ID]))[0];assert.equal(info.Config.Labels['io.lobby-goblin.acceptance'],id);if(info.State.Running)await cmd(['stop','--timeout',info.Name==='/'+controllerName?'10':'-1',c.ID]);
  if(info.Name==='/'+name&&process.env.ACCEPTANCE_REPORT_DIR){
   const directory=process.env.ACCEPTANCE_REPORT_DIR;await fs.mkdir(directory,{recursive:true});
   const logs=await execute('docker',['logs','--tail','100',c.ID],{timeout:30000,maxBuffer:4*1024**2}).then(r=>r.stdout+'\n'+r.stderr).catch(()=> 'Disposable shutdown logs unavailable');
   await fs.writeFile(directory+'/'+game+'.cleanup.log',sanitizeLogs(logs,password));
   const stopped=await docker('GET','/containers/'+c.ID+'/json');await fs.writeFile(directory+'/'+game+'.cleanup-state.json',JSON.stringify(stopped.State,null,2));
  }
  await cmd(['rm',c.ID]);}
 const nets=JSON.parse(await cmd(['network','inspect',network]).catch(()=>'[]'));if(nets.length&&nets[0].Labels['io.lobby-goblin.acceptance']===id)await cmd(['network','rm',network]);
 for(const v of [volume,archive]){const values=JSON.parse(await cmd(['volume','inspect',v]).catch(()=>'[]'));if(values.length&&values[0].Labels['io.lobby-goblin.acceptance']===id)await cmd(['volume','rm',v]);}
}
