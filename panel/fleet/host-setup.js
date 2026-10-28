import {HostSetupRepository} from '../core/storage/state-repositories.js';
import {recordSetupJobs} from './operation-sources.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assert,sleep,json,requestJSON} from '../common.js';
import {agentOptionsFor} from '../agent-options.js';
import {probeSSH,runSSH} from './ssh.js';
import {dockerBootstrap} from './bootstrap-docker.js';

const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const payloadFiles=['install.js','agent-options.js','host-install.js','https.js','common.js','source-layout.js','package.json','fleet/host-compose.js','fleet/broker-compose.js','core/management-installation.js','core/management-startup.js','core/management-volume.js','core/instance.js','core/storage/files.js','core/storage/coordination.js'];
export function setupInput(input,version){
 assert(input&&typeof input.host==='string'&&(net.isIP(input.host)||/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(input.host)),'Enter an SSH hostname or IP address.');
 const port=Number(input.port||22);assert(Number.isInteger(port)&&port>0&&port<=65535,'Choose an SSH port from 1 to 65535.');
 assert(typeof input.username==='string'&&/^[a-z_][a-z0-9_-]{0,31}$/i.test(input.username),'Enter the SSH username.');
 assert(typeof input.name==='string'&&input.name.trim().length>0&&input.name.trim().length<=80&&!/[\x00-\x1f\x7f]/.test(input.name),'Enter a host name of 1–80 characters.');
 assert(typeof input.installDocker==='boolean'&&typeof input.useSudo==='boolean','Choose Docker installation and sudo preferences.');
 let options;
 try{options=agentOptionsFor({domain:input.domain||input.host,agentPort:input.agentPort,address:input.address||((input.domain||input.host).includes(':')?input.host:(input.domain||input.host)),memory:input.memory||16},version);}
 catch(error){assert(false,error.message);}
 return {host:input.host,port,username:input.username,name:input.name.trim(),useSudo:input.useSudo,installDocker:input.installDocker,options};
}
export async function setupScript(plan,{read=fs.readFile}={}){
 const directory='/opt/lobby-goblin-host-'+plan.id,lines=['set -eu','umask 077',"[ \"$(uname -s)\" = Linux ] && [ \"$(uname -m)\" = x86_64 ] || { echo 'Use an x86-64 Linux game host.' >&2; exit 1; }",'[ "$(id -u)" -eq 0 ] || { echo "Use root or passwordless sudo for automatic setup." >&2; exit 1; }','mkdir -m 700 '+quote(directory),'cd '+quote(directory)];
 for(const file of payloadFiles){const data=await read(path.join(sourceRoot,file)),target='panel/'+file;lines.push('mkdir -p '+quote(path.posix.dirname(target)),"printf '%s' "+quote(Buffer.from(data).toString('base64'))+' | base64 -d > '+quote(target));}
 if(plan.installDocker)lines.push(dockerBootstrap);
 else lines.push('command -v docker >/dev/null 2>&1 || { echo "Install Docker first, or enable its installation in the setup plan." >&2; exit 1; }');
 lines.push('docker run --rm --user 0:0 --mount '+quote('type=bind,source='+directory+',target='+directory)+' --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock --workdir '+quote(directory)+' --entrypoint node '+quote(plan.options.image)+' '+quote(directory+'/panel/host-install.js')+' --start --host '+quote(plan.options.domain)+' --agent-port '+quote(plan.options.port)+' --address '+quote(plan.options.address)+' --memory '+quote(plan.options.memory)+' --image '+quote(plan.options.image)+' --directory '+quote(directory+'/agent'));
 return lines.join('\n')+'\n';
}
export class HostSetup{
 constructor(hosts,{probe=probeSSH,execute=runSSH,now=Date.now,record=event=>hosts.manager.audit?.appendOnce({...event,scope:'host:'+hosts.manager.fleet})}={}){this.hosts=hosts;this.probe=probe;this.execute=execute;this.now=now;this.record=record;this.plans=new Map();this.active=null;this.storageError=false;this.planning=false;this.writes=Promise.resolve();this.file=path.join(hosts.manager.root,'host-setup-jobs.json');}
 async init(){this.repository=new HostSetupRepository(this.hosts.manager.root);this.storageSnapshot=await this.repository.read();this.jobs=this.storageSnapshot.value;for(const job of this.jobs)if(job.state==='running'){job.state='interrupted';job.message='Panel restarted during setup. Inspect the target host before retrying; its partial installation was preserved.';}await this.persist();}
 persist(replacement=null){
  const next=this.writes.then(async()=>{
   const records=structuredClone(this.jobs),index=replacement?records.findIndex(job=>job.id===replacement.id):-1;
   if(replacement){assert(index>=0,'Setup record is no longer retained.',409);records[index]=structuredClone(replacement);}
   recordSetupJobs(records);for(const job of records)if(['succeeded','failed','interrupted'].includes(job.state))await this.record({action:'operation.install-host',actor:job.actor,requestId:job.id,operationId:job.id,outcome:job.state});await this.repository.save(this.storageSnapshot,records);
   for(const saved of records){const current=this.jobs.find(job=>job.id===saved.id);if(current){if(replacement&&saved.id===replacement.id)Object.assign(current,saved);else current.operationRecord=saved.operationRecord;}}
   this.storageError=false;
  });this.writes=next.catch(()=>{});return next;
 }
 async plan(input,actor){
  assert(!this.active&&!this.planning&&!this.storageError,'Another host setup or storage recovery is in progress.',409);this.planning=true;
  try{
   const version=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version,config=setupInput(input,version);
   const fingerprint=await this.probe({host:config.host,port:config.port,username:config.username});
   assert(/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint),'Could not verify the SSH host key.',502);
   for(const [id,plan] of this.plans)if(plan.expires<this.now())this.plans.delete(id);assert(this.plans.size<20,'Too many setup reviews. Wait for older reviews to expire.',409);
   const plan={...config,id:crypto.randomBytes(16).toString('hex'),fingerprint,expires:this.now()+15*60000,actor};this.plans.set(plan.id,plan);return {...plan,directory:'/opt/lobby-goblin-host-'+plan.id};
  }finally{this.planning=false;}
 }
 async install(input,actor){
  assert(!this.active&&!this.storageError,'Another host setup or storage recovery is in progress.',409);const plan=this.plans.get(input?.planId);
  assert(plan&&plan.expires>this.now()&&plan.actor===actor,'This setup review expired or belongs to another administrator. Review the host again.',409);
  assert(input.confirm===true,'Review and confirm the SSH fingerprint and installation plan.');
  assert(input.auth&&typeof input.auth==='object'&&!Array.isArray(input.auth)&&Object.keys(input.auth).every(key=>['password','privateKey','passphrase'].includes(key)),'Enter an SSH password or private key.');
  assert(typeof input.auth.password==='string'&&input.auth.password.length>0&&input.auth.password.length<=1024||typeof input.auth.privateKey==='string'&&input.auth.privateKey.length>0&&input.auth.privateKey.length<=65536,'Enter an SSH password or private key.');
  const job={id:plan.id,name:plan.name,host:plan.host,directory:'/opt/lobby-goblin-host-'+plan.id,actor,state:'running',phase:'connecting',message:'Connecting over SSH…',started:new Date(this.now()).toISOString()};this.active=job;this.jobs.unshift(job);this.jobs=this.jobs.filter((job,index)=>index<30||['interrupted','failed'].includes(job.state)&&!job.recoveryReview?.acknowledged);
  try{await this.persist();}catch(error){this.jobs.shift();this.active=null;throw error;}this.plans.delete(plan.id);
  // Authentication exists only in this closure, never in plans, logs or jobs.
  let auth=input.auth;
  this.completion=(async()=>{
   let outcome;
   try{
    job.phase='installing';job.message='Installing the game-host agent…';await this.persist();
    const output=await this.execute({host:plan.host,port:plan.port,username:plan.username,fingerprint:plan.fingerprint,useSudo:plan.useSudo,...auth},await setupScript(plan));auth=null;
    const code=[...output.matchAll(/Pairing code: ((?:lg1\.[a-f0-9]{64}\.)?[A-Za-z0-9_-]{43})(?=\s|$)/g)].at(-1)?.[1];assert(code,'The agent did not return a pairing code. Inspect its installation before retrying.',502);
    job.phase='pairing';job.message='Agent installed. Opening the encrypted agent connection…';await this.persist();let paired,lastError;
    for(let attempt=0;attempt<12;attempt++){
     try{paired=await this.hosts.add({name:plan.name,origin:plan.options.origin,code,confirm:true});break;}catch(error){lastError=error;if(error.status!==502)throw error;if(attempt<11)await sleep(5000);}
    }
    if(!paired)throw lastError;outcome={hostId:paired.id,state:'succeeded',message:'Host connected. You can create a server on it now.'};
   }catch(error){outcome={state:'failed',message:error.status?error.message:'Host setup could not finish. Inspect its retained installation before retrying.'};}
   finally{
    auth=null;job.phase='recording-outcome';job.message='Saving the host setup outcome…';const completed={...structuredClone(job),...outcome,finished:new Date(this.now()).toISOString()};
    try{await this.persist(completed);}
    catch{this.storageError=true;Object.assign(job,{state:'interrupted',phase:'persisting-outcome',finished:completed.finished,message:'The host setup outcome could not be saved. Inspect the retained installation and repair storage before submitting another setup.'});}
    finally{this.active=null;}
   }
  })();return job;
 }
 async handle(req,res,url){
  if(url.pathname==='/host-setup-plan'){assert(req.method==='POST','Not found.',404);json(res,200,await this.plan(await requestJSON(req),req.headers['x-panel-user']||'administrator'));return true;}
  if(url.pathname==='/host-setup'){if(req.method==='GET')json(res,200,{active:this.active,jobs:this.jobs});else{assert(req.method==='POST','Not found.',404);json(res,202,await this.install(await requestJSON(req),req.headers['x-panel-user']||'administrator'));}return true;}return false;
 }
}
