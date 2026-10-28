import {assertManagementStartAllowed,managementInstallationRuntime} from './core/management-installation.js';
import {portableStartupRuntime} from './core/management-startup.js';
// Installation operates on a fresh, separately named host manager. It never
// imports existing accounts, containers or game storage.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {sourceFile} from './source-layout.js';
import {httpsAddress,httpsOrigin,httpsGateway} from './https.js';

export const INSTALLER_FORMAT=1;
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const insist=(ok,message)=>{if(!ok)throw Error(message);};
const hostname=value=>typeof value==='string'&&value.length<=253&&value.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const exists=async file=>{try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

export function optionsFor(input={},version){
  const mode=input.mode??'local',address=input.address??'localhost',domain=mode==='hosted'?httpsAddress(input.domain):input.domain??'',port=Number(input.port??8082),memory=Number(input.memory??4);
  insist(['local','hosted'].includes(mode),'Choose local or hosted installation.');
  insist(hostname(address),'Use a game hostname or IPv4 address without a scheme, path or port. For IPv6 HTTPS, set a separate --address for games.');
  insist(Number.isInteger(port)&&port>=1024&&port<=65535,'Choose a panel port between 1024 and 65535.');
  insist(Number.isInteger(memory)&&memory>=2&&memory<=128,'Choose a memory budget between 2 and 128 GiB.');
  if(mode!=='hosted')insist(!domain,'An HTTPS address is only used with --mode hosted.');
  const image=input.image||'ghcr.io/jkenneydaniel/lobby-goblin:'+version;
  insist(/^ghcr\.io\/jkenneydaniel\/lobby-goblin(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})$/.test(image),'Use a versioned Lobby Goblin runtime image from its official registry.');
  return {mode,address,domain,port,memory,image,origin:mode==='hosted'?httpsOrigin(domain):'http://localhost:'+port};
}

export function installationFiles(options,template,id=crypto.randomBytes(16).toString('hex')){
  insist(/^[a-f0-9]{32}$/.test(id),'Invalid installation identity.');
  const o=options,project='lobby-goblin-fleet-'+id;
  const env=[['FLEET_ID',id],['FLEET_IMAGE',o.image],['FLEET_ADDRESS',o.address],['FLEET_PANEL_PORT',o.port],['FLEET_PANEL_BIND','127.0.0.1'],['FLEET_GAME_BIND','0.0.0.0'],['FLEET_GAME_PORT_BASE',35000],['FLEET_MEMORY_GIB',o.memory]].map(([key,value])=>key+'='+value).join('\n')+'\n';
  const overrides={services:{'fleet-controller':{environment:{FLEET_PANEL_URL:o.origin}},'fleet-web':{environment:{PANEL_HOSTS:[o.domain?new URL(o.origin).hostname:'','localhost','127.0.0.1'].filter(Boolean).join(','),PANEL_ORIGIN:o.origin}}}};
  if(o.mode==='hosted'){
    const {command,configs,definition}=httpsGateway(o.domain,'fleet-web:8080');
    overrides.services.gateway={image:'caddy:2.11.7-alpine',restart:'unless-stopped',command,configs,ports:['80:80/tcp','443:443/tcp'],volumes:['gateway-data:/data','gateway-config:/config'],networks:['management'],depends_on:{'fleet-web':{condition:'service_healthy'}},logging:{driver:'json-file',options:{'max-size':'5m','max-file':'2'}}};
    overrides.configs=definition;
    overrides.volumes={'gateway-data':{name:project+'-https-data',labels:{'io.lobby-goblin.fleet':id}},'gateway-config':{name:project+'-https-config',labels:{'io.lobby-goblin.fleet':id}}};
  }
  const files={'.env.install':env,'fleet.compose.yaml':template,'install.compose.json':JSON.stringify(overrides,null,2)+'\n'};
  const manifest={format:INSTALLER_FORMAT,id,project,options:o,files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,digest(text)]))};
  return {...files,'installation.json':JSON.stringify(manifest,null,2)+'\n'};
}

export async function readInstallation(directory){
  const stat=await exists(directory);if(!stat)return null;
  insist(stat.isDirectory()&&!stat.isSymbolicLink(),'Installation directory must be a real directory.');
  for(const name of ['installation.json','.env.install','fleet.compose.yaml','install.compose.json']){
    const item=await exists(path.join(directory,name));
    insist(item?.isFile()&&!item.isSymbolicLink(),'Choose a fresh directory, or an intact installation created by this installer.');
  }
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'installation.json'),'utf8'));
  insist(manifest.format===INSTALLER_FORMAT&&/^[a-f0-9]{32}$/.test(manifest.id)&&manifest.project==='lobby-goblin-fleet-'+manifest.id,'Unrecognized installation record.');
  insist(JSON.stringify(optionsFor(manifest.options,'unused'))===JSON.stringify(manifest.options),'Invalid stored installation options.');
  const names=['.env.install','fleet.compose.yaml','install.compose.json'];
  insist(Object.keys(manifest.files||{}).sort().join()===names.sort().join(),'Invalid installation file record.');
  for(const name of names)insist(digest(await fs.readFile(path.join(directory,name),'utf8'))===manifest.files[name],'Installation files were edited. Review them manually; the installer will not overwrite or start them.');
  return manifest;
}

export async function prepareInstallation(directory,options,{template}={}){
  const existing=await readInstallation(directory);
  if(existing){insist(JSON.stringify(existing.options)===JSON.stringify(options),'This installation already has different settings. Keep them, or choose a fresh directory.');return existing;}
  template??=await fs.readFile(await sourceFile(sourceRoot,'fleet.compose.yaml'),'utf8');
  const files=installationFiles(options,template);
  // Exclusive directory creation is also the installation lock. No existing
  // directory or user data is removed, including after an interrupted write.
  await fs.mkdir(directory,{mode:0o700});
  for(const [name,text] of Object.entries(files))await fs.writeFile(path.join(directory,name),text,{mode:0o600,flag:'wx'});
  if(process.getuid?.()===0&&/^\d{1,9}$/.test(process.env.GOBLIN_INSTALL_UID||'')&&/^\d{1,9}$/.test(process.env.GOBLIN_INSTALL_GID||'')){
    const uid=Number(process.env.GOBLIN_INSTALL_UID),gid=Number(process.env.GOBLIN_INSTALL_GID);
    for(const name of Object.keys(files))await fs.chown(path.join(directory,name),uid,gid);
    await fs.chown(directory,uid,gid);
  }
  return readInstallation(directory);
}

export function run(command,args,{cwd,inherit=false,env=process.env}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:inherit?'inherit':['ignore','pipe','pipe'],shell:false});let stdout='',stderr='';
    child.stdout?.on('data',chunk=>stdout+=chunk);child.stderr?.on('data',chunk=>stderr+=chunk);
    child.once('error',error=>reject(Error(command+' is unavailable: '+error.message)));
    child.once('exit',code=>code===0?resolve(stdout.trim()):reject(Error(command+' failed. '+(stderr.trim()||'Check the installation output.'))));
  });
}

export async function checkHost({execute=run,env=process.env}={}){
  const endpoint=env.DOCKER_CONTEXT?await execute('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}','--',env.DOCKER_CONTEXT]):env.DOCKER_HOST||await execute('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']);
  insist(endpoint.startsWith('unix://')||process.platform==='win32'&&endpoint.startsWith('npipe://'),'Run the installer on the target machine using its local Docker engine. Remote Docker contexts are not supported.');
  const info=JSON.parse(await execute('docker',['info','--format','{{json .}}']));
  insist(info.OSType==='linux','Use Docker with Linux containers.');
  insist(['amd64','x86_64'].includes(info.Architecture),'The host manager currently requires an x86-64 Docker host. ARM users can use the existing standalone Factorio setup.');
  insist(parseInt(info.ServerVersion,10)>=26,'Docker Engine 26 or newer is required. Existing Docker is never upgraded automatically.');
  insist(!(info.SecurityOptions||[]).some(value=>value.includes('rootless')),'This host-manager layout requires rootful Docker.');
  const compose=await execute('docker',['compose','version','--short']);
  const match=compose.match(/^v?(\d+)\.(\d+)/);insist(match&&(Number(match[1])>2||Number(match[1])===2&&Number(match[2])>=24),'Docker Compose 2.24 or newer is required.');
  return {memoryGiB:Math.floor(Number(info.MemTotal)/1024**3),version:info.ServerVersion,compose};
}

export function composeArgs(directory,manifest){return ['compose','--project-name',manifest.project,'--env-file',path.join(directory,'.env.install'),'-f',path.join(directory,'fleet.compose.yaml'),'-f',path.join(directory,'install.compose.json')];}
export function installationEnvironment(env=process.env){return Object.fromEntries(Object.entries(env).filter(([key])=>!/^(FLEET_|COMPOSE_|PANEL_)/.test(key)));}

export async function startInstallation(directory,manifest,dependencies={}){
  let lock;
  try{lock=await fs.open(path.join(directory,'.start.lock'),'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Another installation is starting, or an interrupted start needs review. Inspect .start.lock before retrying.',{cause:error});throw error;}
  try{return await startPreparedInstallation(directory,manifest,dependencies);}finally{await lock.close();await fs.unlink(path.join(directory,'.start.lock'));}
}
async function startPreparedInstallation(directory,manifest,{execute=run,host,log=console.log}={}){
  insist(JSON.stringify(await readInstallation(directory))===JSON.stringify(manifest),'The installation record changed. Review it before starting.');
  await assertManagementStartAllowed(directory);
  const runtime=await portableStartupRuntime(directory,manifest,{execute})||await managementInstallationRuntime(directory,manifest);
  host??=await checkHost({execute});
  if(runtime.engine)insist((await execute('docker',['info','--format','{{.ID}}'])).trim()===runtime.engine,'This management update belongs to another Docker engine. No containers were started.');
  insist(Number.isFinite(host.memoryGiB)&&host.memoryGiB>=manifest.options.memory+2,'The budget needs at least 2 GiB of additional Docker memory. Reduce --memory or increase Docker memory; leave more room for existing workloads.');
  const args=[...composeArgs(directory,manifest),...runtime.arguments],docker=(tail,extra)=>execute('docker',[...args,...tail],{cwd:directory,env:installationEnvironment(),...extra});
  const containers=await docker(['ps','--all','--quiet']);
  if(containers){log('This installation already has containers. They were not recreated or restarted. Open '+manifest.options.origin+' or inspect its existing installation manually.');return {started:false};}
  await docker(['config','--quiet']);
  await docker(['pull'],{inherit:true});
  // An older published image cannot silently bypass the HTTPS/origin changes.
  await execute('docker',['run','--rm','--entrypoint','node',runtime.image,'--input-type=module','-e',"const m=await import('./install.js');if(m.INSTALLER_FORMAT!==1)process.exit(1)"+((await fs.readFile(path.join(directory,'fleet.compose.yaml'),'utf8')).includes('MODE: docker-broker')?";const b=await import('./core/docker-broker.js');if(b.BROKER_PROTOCOL!==1)process.exit(1)":'')],{inherit:true});
  insist(JSON.stringify(await readInstallation(directory))===JSON.stringify(manifest),'The installation record changed. Review it before starting.');
  log('Starting only the new host manager. No game server is created.');
  await docker(['up','-d','--no-build','--wait','--wait-timeout','180'],{inherit:true});
  log('Manager containers are ready. Open '+manifest.options.origin+'.'+(manifest.options.mode==='hosted'?' Confirm HTTPS reachability from your browser; the gateway obtains and renews its Let’s Encrypt certificate automatically.':''));
  log(await docker(['exec','-T','fleet-controller','cat','/web-state/registration-link.txt']));
  return {started:true};
}

export function parseArguments(args){
  const result={};
  for(let n=0;n<args.length;n++){
    const key=args[n];
    if(['--check','--prepare','--start','--registration-link','--help'].includes(key)){insist(!result[key.slice(2)],'Do not repeat '+key+'.');result[key.slice(2)]=true;}
    else if(['--directory','--mode','--address','--domain','--port','--memory','--image'].includes(key)){insist(args[n+1]&&!args[n+1].startsWith('--')&&!Object.hasOwn(result,key.slice(2)),key+' needs one value.');result[key.slice(2)]=args[++n];}
    else throw Error('Unknown option '+key+'. Use --help.');
  }
  insist(['check','prepare','start','registration-link'].filter(key=>result[key]).length<=1,'Choose only one of --check, --prepare, --start or --registration-link.');
  return result;
}

export async function main(args=process.argv.slice(2),{execute=run,log=console.log}={}){
  const input=parseArguments(args);
  if(input.help){log('Lobby Goblin installation\n  Install.sh / Install.ps1              Guided setup\n  --check                              Read-only Docker checks\n  --prepare                            Write a fresh installation; do not start\n  --start                              Explicitly install a fresh manager\n  --directory PATH                     Dedicated installation directory\n  --mode local|hosted                   Local access or hosted HTTPS\n  --address HOST                       Game hostname or IPv4 address\n  --domain HOST                        HTTPS public IP or DNS hostname\n  --port 8082 --memory 4                Panel port and host game budget (GiB)\n  --registration-link                   Explicitly replace the admin invitation\n  --image REGISTRY:VERSION              Matching published runtime version\n\nHosted HTTPS automatically obtains and renews Let’s Encrypt certificates.\nTCP 80/443 must reach this machine. DNS is needed only for hostnames.\nRun this on the target machine. Existing installations and worlds are never adopted.');return;}
  if(input.check){insist(Object.keys(input).every(key=>['check','directory'].includes(key)),'--check cannot change installation settings.');const host=await checkHost({execute});if(input.directory)await readInstallation(path.resolve(input.directory));log(`Docker ${host.version}, Compose ${host.compose}, ${host.memoryGiB} GiB. No files changed or containers started.`);return;}
  const directory=path.resolve(input.directory||'lobby-goblin-installation'),existing=await readInstallation(directory);
  const version=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8')).version;
  let options;
  const guided=!input.prepare&&!input.start&&!input['registration-link'];let start=!!input.start;
  if(existing){
    options=optionsFor({...existing.options,...Object.fromEntries(Object.entries(input).filter(([key])=>['mode','address','domain','port','memory','image'].includes(key)))},version);
  }else if(guided){
    insist(process.stdin.isTTY,'Use --prepare or --start for non-interactive installation.');
    const rl=createInterface({input:process.stdin,output:process.stdout});
    try{
      log('Welcome to Lobby Goblin. Set up a new host, then create your administrator account in the browser.');
      const mode=await rl.question('1) This computer (private access)\n2) A hosted server (HTTPS public IP or hostname)\nChoose [1]: ');
      insist(['','1','2'].includes(mode),'Choose 1 or 2.');
      input.mode=mode==='2'?'hosted':'local';
      if(input.mode==='hosted'){
        input.domain=await rl.question('Panel public IP or DNS hostname: ');
        log('Let’s Encrypt certificates renew automatically. TCP 80/443 must reach this machine. For a hostname, point its DNS here first.');
      }
      input.address=(await rl.question('Game hostname or IPv4 address [localhost]: '))||'localhost';
      input.memory=(await rl.question('Game memory budget in GiB, leaving 2+ GiB for management [4]: '))||'4';
      options=optionsFor(input,version);
      log(`\nInstallation: ${directory}\nPanel: ${options.origin}\nGame address: ${options.address}\nBudget: ${options.memory} GiB\nExisting installations will stay separate.`);
      const choice=await rl.question('Prepare and start this new manager now? [y/N]: ');start=/^y(es)?$/i.test(choice);
    }finally{rl.close();}
  }else options=optionsFor(input,version);
  if(input['registration-link']){
    insist(existing,'No installation exists here. Prepare and start one first.');
    insist(JSON.stringify(existing.options)===JSON.stringify(options),'Invitation recovery cannot change installation settings.');
    await checkHost({execute});
    const base=composeArgs(directory,existing);
    log(await execute('docker',[...base,'exec','-T','fleet-controller','env','PANEL_INIT_DIR=/web-state','PANEL_URL='+existing.options.origin,'node','init.js','--registration-link'],{cwd:directory,env:installationEnvironment()}));return;
  }
  const host=start?await checkHost({execute}):null;
  if(host)insist(host.memoryGiB>=options.memory+2,'Docker needs the selected budget plus at least 2 GiB of management headroom.');
  const manifest=await prepareInstallation(directory,options);
  log('Installation prepared at '+directory+'. Settings and identity are preserved on reruns.');
  if(start)await startInstallation(directory,manifest,{execute,host,log});
  else log('Nothing started. Rerun the installer with --start --directory '+directory+' when ready.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Install: '+error.message);process.exitCode=1;});
