import {assertManagementStartAllowed,managementInstallationRuntime} from './core/management-installation.js';
import {portableStartupRuntime} from './core/management-startup.js';
// Prepare a game-host agent on the target machine. Starting is explicit and
// limited to a fresh project; existing installations are never adopted.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {optionsFor,checkHost,run,installationEnvironment} from './install.js';
import {agentOptionsFor} from './agent-options.js';
import {hostAgentCompose} from './fleet/host-compose.js';
import {assert} from './common.js';

export const HOST_INSTALLER_FORMAT=1;
export const AGENT_TRANSPORT_VERSION=1;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const files=['host.compose.json'];
export function hostInstallationFiles(options,id=crypto.randomBytes(16).toString('hex')){
 assert(options.mode==='hosted','A game-host agent requires an encrypted HTTPS agent address.');
 assert(/^[a-f0-9]{32}$/.test(id),'Invalid host identity.');
 const result={'host.compose.json':JSON.stringify(hostAgentCompose(options,id),null,2)+'\n'};
 const manifest={format:HOST_INSTALLER_FORMAT,kind:'host-agent',id,project:'lobby-goblin-fleet-'+id,options,files:Object.fromEntries(Object.entries(result).map(([name,text])=>[name,digest(text)]))};
 return {...result,'host-installation.json':JSON.stringify(manifest,null,2)+'\n'};
}
export async function readHostInstallation(directory){
 const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return null;
 assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Choose a real, dedicated host-agent directory.');
 for(const file of [...files,'host-installation.json']){const item=await fs.lstat(path.join(directory,file)).catch(()=>null);assert(item?.isFile()&&!item.isSymbolicLink(),'Choose a fresh directory or an intact host-agent installation.');}
 const record=JSON.parse(await fs.readFile(path.join(directory,'host-installation.json'),'utf8'));
 assert(record.format===1&&record.kind==='host-agent'&&/^[a-f0-9]{32}$/.test(record.id)&&record.project==='lobby-goblin-fleet-'+record.id,'Unrecognized host-agent installation.');
 assert(record.options.mode==='hosted'&&JSON.stringify((record.options.transport==='persistent'?agentOptionsFor:optionsFor)(record.options,'unused'))===JSON.stringify(record.options),'Invalid stored host options.');
 assert(Object.keys(record.files||{}).sort().join()===files.slice().sort().join(),'Invalid host-agent file record.');
 for(const file of files)assert(digest(await fs.readFile(path.join(directory,file)))===record.files[file],'Host-agent files changed. Review them manually; this installer will not overwrite or start them.');return record;
}
export async function prepareHostInstallation(directory,options){
 const existing=await readHostInstallation(directory);if(existing){assert(JSON.stringify(existing.options)===JSON.stringify(options),'Choose a fresh directory to use different host settings.');return existing;}
 const entries=hostInstallationFiles(options);await fs.mkdir(directory,{mode:0o700});
 for(const [name,value] of Object.entries(entries))await fs.writeFile(path.join(directory,name),value,{flag:'wx',mode:0o600});return readHostInstallation(directory);
}
export const hostComposeArgs=(directory,record)=>['compose','--project-name',record.project,'-f',path.join(directory,'host.compose.json')];
export async function startHostInstallation(directory,record,{execute=run,log=console.log}={}){
 const lock=await fs.open(path.join(directory,'.start.lock'),'wx',0o600).catch(()=>{throw Error('Another host-agent start may be in progress. Inspect .start.lock before retrying.');});
 try{
  assert(JSON.stringify(await readHostInstallation(directory))===JSON.stringify(record),'Host-agent installation changed. Review it first.');
  await assertManagementStartAllowed(directory);
  const runtime=await portableStartupRuntime(directory,record,{execute})||await managementInstallationRuntime(directory,record);
  const host=await checkHost({execute});if(runtime.engine)assert((await execute('docker',['info','--format','{{.ID}}'])).trim()===runtime.engine,'This management update belongs to another Docker engine. No containers were started.');assert(host.memoryGiB>=record.options.memory+2,'Docker needs the selected game budget plus at least 2 GiB of management headroom.');
  const args=[...hostComposeArgs(directory,record),...runtime.arguments],docker=tail=>execute('docker',[...args,...tail],{cwd:directory,env:installationEnvironment()});
  if(await docker(['ps','--all','--quiet'])){log('This host-agent installation already has containers. They were left unchanged. Use --pairing-code to issue a new code.');return {started:false};}
  await docker(['config','--quiet']);await docker(['pull']);
  await execute('docker',['run','--rm','--entrypoint','node',runtime.image,'--input-type=module','-e',`const m=await import('./host-install.js');if(m.HOST_INSTALLER_FORMAT!==1${record.options.transport==='persistent'?'||m.AGENT_TRANSPORT_VERSION!==1':''})process.exit(1);await import('./fleet/agent-web.js')`+(JSON.parse(await fs.readFile(path.join(directory,'host.compose.json'),'utf8')).services['docker-broker']?";const b=await import('./core/docker-broker.js');if(b.BROKER_PROTOCOL!==1)process.exit(1)":'')],{env:installationEnvironment()});
  assert(JSON.stringify(await readHostInstallation(directory))===JSON.stringify(record),'Host-agent installation changed. Review it first.');
  await docker(['up','-d','--no-build','--wait','--wait-timeout','180']);
  log('Game-host agent started. No game servers were created. Confirm agent-port reachability from your main panel.');
  log(await docker(['exec','-T','fleet-controller','node','host-agent-control.js','pair']));return {started:true};
 }finally{await lock.close();await fs.unlink(path.join(directory,'.start.lock'));}
}
export async function main(args=process.argv.slice(2),{execute=run,log=console.log}={}){
 const input={};for(let n=0;n<args.length;n++){
  const key=args[n];assert(!Object.hasOwn(input,key),'Do not repeat '+key+'.');
  if(['--prepare','--start','--check','--pairing-code','--help'].includes(key))input[key]=true;
  else{assert(['--directory','--host','--agent-port','--domain','--address','--memory','--image'].includes(key)&&args[n+1]&&!args[n+1].startsWith('--'),'Unknown option or missing value: '+key);input[key]=args[++n];}
 }
 if(input['--help'])return log('Game-host agent (no separate panel or accounts)\n  node panel/host-install.js --prepare --host IP_OR_HOSTNAME --agent-port 24443 --address GAME_IP_OR_HOSTNAME --memory 16 --directory PATH\n  Public, private and VPN addresses are supported. --domain is an alias for --host.\n  Pairing verifies the encrypted agent connection. Only the dedicated TCP port must reach this host; ports 80/443 are not used.\n  --address is the game hostname or IPv4 address (required separately for IPv6 agents).\n  --prepare writes files only; --start explicitly starts a fresh agent.\n  --check checks Docker only. --pairing-code issues a new ten-minute code.\n  Run on the game-host machine with Node 22+ and local Docker.');
 assert(['--prepare','--start','--check','--pairing-code'].filter(key=>input[key]).length===1,'Choose --prepare, --start, --check, or --pairing-code.');
 if(input['--check']){assert(Object.keys(input).length===1,'--check cannot change settings.');const host=await checkHost({execute});return log('Docker ready: '+host.memoryGiB+' GiB. No files or containers changed.');}
 const directory=path.resolve(input['--directory']||'lobby-goblin-host'),existing=await readHostInstallation(directory);
 if(input['--pairing-code']){
  assert(existing,'Prepare and start this host agent first.');assert(Object.keys(input).every(key=>['--directory','--pairing-code'].includes(key)),'Pairing cannot change host settings.');
  return log(await execute('docker',[...hostComposeArgs(directory,existing),'exec','-T','fleet-controller','node','host-agent-control.js','pair'],{cwd:directory,env:installationEnvironment()}));
 }
 const version=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8')).version;
 const overrides=Object.fromEntries(Object.entries(input).filter(([key])=>['--host','--agent-port','--domain','--address','--memory','--image'].includes(key)).map(([key,value])=>[key.slice(2),value]));
 assert(!(overrides.host&&overrides.domain),'Use --host or --domain, not both.');
 const normalize=existing&&!existing.options.transport?optionsFor:agentOptionsFor;
 assert(normalize===agentOptionsFor||(!overrides.host&&!overrides['agent-port']),'Choose a fresh directory for a dedicated-port agent; existing HTTPS installations are preserved.');
 const options=normalize({...existing?.options,...overrides,agentHost:overrides.host||overrides.domain||existing?.options.domain,agentPort:overrides['agent-port'],mode:'hosted',address:overrides.address||existing?.options.address||overrides.host||overrides.domain},version);
 const record=await prepareHostInstallation(directory,options);log('Host-agent files prepared at '+directory+'.');
 if(input['--start'])return startHostInstallation(directory,record,{execute,log});log('Nothing started. Review the files, then use --start with the same directory.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Host agent: '+error.message);process.exitCode=1;});
