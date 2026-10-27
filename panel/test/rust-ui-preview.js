// Disposable browser fixture. Real web/controller/auth/archive code, synthetic
// Rust/Docker responses; no host socket, game process or installation access.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startController} from '../core/controller.js';
import {startWeb} from '../core/web.js';
import {rust} from '../applications/rust/index.js';
import {createRust} from '../applications/rust/controller.js';
import {writeJSON} from '../common.js';
import {hashPassword} from '../auth.js';
import {makeZip} from '../core/archive.js';
import {sha256} from '../applications/rust/mod-packages.js';

const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lobby-goblin-rust-ui-')));
process.env.DOCKER_SOCKET=path.join(root,'no-real-engine.sock');
const instance='c'.repeat(32),image='ghcr.io/jkenneydaniel/rust-server:steam-lg.2@sha256:'+'d'.repeat(64);
const env={RUST_INSTANCE_ID:instance,RUST_CONTAINER:'lobby-goblin-rust-'+instance,RUST_IMAGE:image,RUST_HOST_DATA:path.join(root,'host-data'),RUST_DATA:path.join(root,'game/server'),RUST_INSTALL_ROOT:path.join(root,'game'),RUST_STATE_DIR:path.join(root,'state'),RUST_BACKUPS_DIR:path.join(root,'backups'),RUST_RCON_PASSWORD_FILE:path.join(root,'rcon-password'),CONTROLLER_TOKEN_FILE:path.join(root,'token'),AUTH_DIR:path.join(root,'auth'),PANEL_HOSTS:'127.0.0.1,localhost',RELEASE_CHECKS:'false',RUST_GAME_ADDRESS:'play.rust.example:28015'};
const identity=path.join(env.RUST_DATA,'lobby-goblin-rust');await fs.mkdir(path.join(identity,'cfg'),{recursive:true});await fs.mkdir(env.AUTH_DIR);
for(const directory of [env.RUST_DATA,env.RUST_STATE_DIR,env.RUST_BACKUPS_DIR]){await fs.mkdir(directory,{recursive:true});await writeJSON(path.join(directory,'.lobby-goblin-rust.json'),{game:'rust',instance});}
await fs.writeFile(path.join(identity,'cfg/server.cfg'),'server.hostname "North Coast · Rust"\nserver.description "A quieter place to build."\nserver.maxplayers 50\nserver.saveinterval 600\n');
await fs.writeFile(path.join(identity,'proceduralmap.4000.123.1.sav'),'Synthetic Rust world fixture');await fs.writeFile(path.join(identity,'player.blueprints.5.db'),'Synthetic player database');
await fs.writeFile(env.RUST_RCON_PASSWORD_FILE,'fixture_only_password_1234567890123456');await fs.writeFile(env.CONTROLLER_TOKEN_FILE,'fixture-only-token');
await writeJSON(path.join(env.AUTH_DIR,'users.json'),{admin:{...hashPassword('rust-preview-password'),role:'admin'},viewer:{...hashPassword('rust-preview-password'),role:'viewer'},pending:{...hashPassword('rust-preview-password'),role:'member',grants:{}},member:{...hashPassword('rust-preview-password'),role:'member',grants:{standalone:['server.view','mods.manage']}}});
const users=JSON.parse(await fs.readFile(path.join(env.AUTH_DIR,'users.json'),'utf8'));
for(const [username,permission] of Object.entries({framework:'application.rust.framework.manage',plugins:'application.rust.plugins.manage',configuration:'application.rust.plugins.configure'}))users[username]={...hashPassword('rust-preview-password'),role:'member',grants:{standalone:['server.view','mods.manage',permission]}};
users['software-only']={...hashPassword('rust-preview-password'),role:'member',grants:{standalone:['images.change']}};
users.software={...hashPassword('rust-preview-password'),role:'member',grants:{standalone:['server.view','images.change']}};
await writeJSON(path.join(env.AUTH_DIR,'users.json'),users);
if(process.env.UI_RECOVERY_TEST==='1')await writeJSON(path.join(env.RUST_STATE_DIR,'jobs.json'),[{id:'interrupted-browser-operation',action:'restart',actor:'Fixture',state:'running',phase:'executing',started:new Date().toISOString()}]);
let running=true;
const info=()=>({Image:'sha256:'+'e'.repeat(64),State:{Health:{Status:'healthy'},Running:running,Status:running?'running':'exited',ExitCode:0},Config:{Image:image,Labels:{'io.lobby-goblin.game':'rust','io.lobby-goblin.instance':instance}},Mounts:[{Type:'bind',Destination:'/steamcmd/rust',Source:env.RUST_HOST_DATA}],HostConfig:{RestartPolicy:{Name:'unless-stopped'}},NetworkSettings:{Networks:{fixture:{IPAddress:'192.0.2.2'}}}});
const docker=async(method,route)=>{
  if(process.env.UI_RECOVERY_TEST==='1'&&method!=='GET')throw Error('Recovery acceptance cannot mutate a game or host.');
  if(route.startsWith('/images/'))return {Config:{Labels:{'io.lobby-goblin.rust-mods':'1'}}};
  if(!route.startsWith('/containers/'+env.RUST_CONTAINER+'/'))throw Error('Fixture blocked an unexpected host request.');
  if(route.endsWith('/json'))return info();
  if(route.includes('/stats?'))return {cpu_stats:{cpu_usage:{total_usage:50},system_cpu_usage:1000,online_cpus:4},precpu_stats:{cpu_usage:{total_usage:25},system_cpu_usage:500},memory_stats:{usage:4.3*1024**3}};
  if(route.includes('/logs?'))return Buffer.from('[server] Server startup complete\n[server] Harbor crew connected\n[server] Saving complete: 18,492 entities\n[server] No pending operations\n');
  if(method==='POST'&&route.endsWith('/start')){running=true;return null;}
  if(method==='POST'&&route.endsWith('/stop?t=-1')){running=false;return null;}
  throw Error('Fixture blocked an unexpected host operation.');
};
const rcon=async({command})=>{
  if(!running)throw Error('Fixture Rust is stopped.');
  if(command==='serverinfo')return JSON.stringify({Hostname:'North Coast · Rust',Players:3,MaxPlayers:50,Framerate:61,Uptime:12400});
  if(command==='server.save'){await fs.writeFile(path.join(identity,'proceduralmap.4000.123.1.sav'),'Synthetic saved Rust fixture');return 'Saved';}
  if(command==='playerlist')return JSON.stringify(['Harbor crew','Builder <one>','A very long player display name'].map((DisplayName,n)=>({DisplayName,SteamID:'7656119800000000'+n,Ping:28+n*15,ConnectedSeconds:200+n*120})));
  throw Error('Fixture blocked an unexpected Rust command.');
};
const archive=makeZip([{name:'RustDedicated_Data/Managed/Oxide.Rust.dll',data:Buffer.from('fixture loader')},{name:'RustDedicated_Data/Managed/Assembly-CSharp.dll',data:Buffer.from('fixture DLL')}]);
const modFetcher=async url=>url.startsWith('https://api.github.com/')?new Response(JSON.stringify({tag_name:'fixture-v1',assets:[{name:'Oxide.Rust-linux.zip',state:'uploaded',size:archive.length,digest:'sha256:'+sha256(archive),browser_download_url:'https://github.com/OxideMod/Oxide.Rust/releases/download/fixture-v1/Oxide.Rust-linux.zip'}]})):new Response(archive);
const module={...rust,createController:ctx=>createRust(ctx,{rcon,modFetcher,pollInterval:1,readyTimeout:50})};
const controller=await startController(module,{env,docker,port:0,hostname:'127.0.0.1'});
const web=await startWeb(module,{env:{...env,CONTROLLER_URL:'http://127.0.0.1:'+controller.address().port},port:Number(process.env.RUST_UI_PORT||8090),hostname:'127.0.0.1'});
console.log(`Synthetic Rust preview: http://127.0.0.1:${web.address().port}\nSign in: admin or viewer / rust-preview-password`);
let closing=false;
async function close(){if(closing)return;closing=true;for(const server of [web,controller]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await fs.rm(root,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
