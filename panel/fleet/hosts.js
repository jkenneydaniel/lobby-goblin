import path from 'node:path';
import crypto from 'node:crypto';
import {assert,equalSecret,json,requestJSON,readBody} from '../common.js';
import {RemoteHostsRepository} from '../core/storage/state-repositories.js';
import {validId} from './catalog.js';
import {registeredApplications} from '../applications/index.js';
import {controllerAccess} from '../core/routes.js';
import {proxyResponse} from '../core/proxy.js';
import {agentVersion} from './agent-update.js';
import {AgentConnection} from './agent-connection.js';
import {pairingCode} from './agent-identity.js';

const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const secret=()=>crypto.randomBytes(32).toString('base64url');
const id=()=>crypto.randomBytes(16).toString('hex');
const name=value=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=80&&!/[\x00-\x1f\x7f]/.test(value);
export function hostOrigin(value){
 let url;try{url=new URL(value);}catch{assert(false,'Enter the host agent’s address, including its dedicated port.');}
 assert(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'Use an HTTPS origin without a path, password, query or fragment.');
 return url.origin;
}

// A paired panel can manage only this host's registered games. Federation,
// account administration, enrollment and arbitrary controller URLs stay local.
export function remoteRoute(method,route){
 if(!['GET','POST'].includes(method))return false;
 if(route==='/management-update')return true;
 if(/^\/snapshots\/[a-f0-9]{32}$/.test(route))return method==='GET';
 if(/^\/snapshots\/[a-f0-9]{32}\/remove$/.test(route))return method==='POST';
 if(/^\/removed-servers\/[a-f0-9]{32}\/(inspect|recover|remove)$/.test(route))return method==='POST';
 if(route==='/creation-preflight')return method==='POST';
 if(['/removed-servers','/application-releases'].includes(route))return method==='GET';
 if(route==='/operations')return method==='GET';
 if(route==='/operations/recovery')return method==='POST';
 if(route==='/jobs/recovery')return method==='POST';
 if(['/agent-status','/agent-update-plan','/agent-update'].includes(route))return method===(route==='/agent-status'?'GET':'POST');
 if(['/status','/catalog','/servers','/snapshots','/jobs','/host-settings'].includes(route))return method==='GET'||['/servers','/host-settings'].includes(route);
 const match=route.match(/^\/servers\/[a-f0-9]{32}(?:\/(.*))?$/);if(!match)return false;
 if(!match[1])return method==='GET';
 if(['snapshot','remove'].includes(match[1]))return method==='POST';
 if(!match[1].startsWith('controller/'))return false;
 const action='/'+match[1].slice(11);
 return registeredApplications().some(module=>controllerAccess(module,method,action));
}

export class RemoteHosts{
 constructor(manager,{fetcher=fetch,now=Date.now,identity}={}){this.identity=identity;this.connections=new Map();this.manager=manager;this.fetcher=fetcher;this.now=now;this.file=path.join(manager.root,'remote-hosts.json');this.queue=Promise.resolve();this.pairing=false;}
 async init({connect=true}={}){
  this.repository=new RemoteHostsRepository(this.manager.root);this.storageSnapshot=await this.repository.read();this.state=this.storageSnapshot.value;
  assert(this.state.version===1&&Array.isArray(this.state.outgoing)&&Array.isArray(this.state.incoming)&&Array.isArray(this.state.pending),'Unsupported remote host registry.',409);
  for(const item of this.state.outgoing){assert(validId(item.id)&&validId(item.pairId)&&name(item.name)&&/^[A-Za-z0-9_-]{43}$/.test(item.token),'Invalid remote host registry.',409);hostOrigin(item.origin);assert(item.fingerprint===undefined||/^[a-f0-9]{64}$/.test(item.fingerprint),'Invalid paired agent identity.',409);}
  if(connect)this.startConnections();
 }
 startConnections(){for(const item of this.state.outgoing)if(item.fingerprint)this.connection(item.origin,item.fingerprint).start();}
 connection(origin,fingerprint){
  fingerprint??=this.state.outgoing.find(h=>h.origin===origin)?.fingerprint;if(!fingerprint)return null;
  let connection=this.connections.get(origin);if(connection&&connection.fingerprint!==fingerprint){connection.close();this.connections.delete(origin);connection=null;}
  if(!connection){connection=new AgentConnection(origin,fingerprint);this.connections.set(origin,connection);}return connection;
 }
 fetchFor(origin,fingerprint){const connection=this.connection(origin,fingerprint);return connection?connection.fetch.bind(connection):this.fetcher;}
 close(){for(const connection of this.connections.values())connection.close();this.connections.clear();}
 async change(fn){
  const next=this.queue.then(async()=>{const draft=structuredClone(this.state),result=await fn(draft);await this.repository.save(this.storageSnapshot,draft);this.state=draft;return result;});this.queue=next.catch(()=>{});return next;
 }
 local(){return {id:this.manager.fleet,name:'This host',local:true,connected:true};}
 host(hostId){assert(validId(hostId),'Invalid host.');const item=this.state.outgoing.find(h=>h.id===hostId);assert(item,'Remote host not found. It may have been disconnected.',404);return item;}
 async enrollment(input){
  assert(input&&typeof input==='object'&&!Array.isArray(input),'Choose a pairing operation.');
  return this.change(state=>{
   if(input.operation==='create'){
    const code=secret(),expires=this.now()+10*60000;state.enrollment={hash:hash(code),expires};return {code:this.identity?'lg1.'+this.identity+'.'+code:code,expires};
   }
   if(input.operation==='cancel'){delete state.enrollment;return {cancelled:true};}
   assert(input.operation==='revoke'&&validId(input.id),'Choose a paired panel to revoke.');
   state.incoming=state.incoming.filter(peer=>peer.id!==input.id);return {revoked:true};
  });
 }
 pairingStatus(){return {expires:this.state.enrollment?.expires>this.now()?this.state.enrollment.expires:null,panels:this.state.incoming.map(({id,centralId,name,created})=>({id,centralId,name,created}))};}
 async accept(input){
  assert(input&&validId(input.centralId)&&input.centralId!==this.manager.fleet&&validId(input.pairId)&&name(input.name)&&/^[A-Za-z0-9_-]{43}$/.test(input.token),'Invalid pairing request.');
  return this.change(state=>{
   const existing=state.incoming.find(peer=>peer.id===input.pairId);
   // Retry after a lost response without issuing a second credential.
   if(existing){assert(existing.centralId===input.centralId&&equalSecret(existing.hash,hash(input.token)),'Pairing is no longer available.',403);return {protocol:1,id:this.manager.fleet,pairId:existing.id};}
   assert(state.enrollment?.expires>this.now()&&typeof input.code==='string'&&equalSecret(hash(pairingCode(input.code).secret),state.enrollment.hash),'Pairing code is invalid or expired. Create a new code on the remote host.',403);
   assert(state.incoming.length<20,'This host already has 20 paired panels.',409);
   assert(!state.incoming.some(peer=>peer.centralId===input.centralId),'This panel is already paired. Revoke its previous access before pairing again.',409);
   state.incoming.push({id:input.pairId,centralId:input.centralId,name:input.name.trim(),hash:hash(input.token),created:new Date(this.now()).toISOString()});delete state.enrollment;
   return {protocol:1,id:this.manager.fleet,pairId:input.pairId};
  });
 }
 authenticate(token){const peer=this.state.incoming.find(item=>equalSecret(item.hash,hash(token)));assert(peer,'This panel is not paired or its access was revoked.',401);return peer;}
 async revoke(peer){await this.change(state=>{state.incoming=state.incoming.filter(item=>item.id!==peer.id);});return {disconnected:true};}
 async request(origin,route,{token,body,timeout=10000,fingerprint}={}){
  try{
   const response=await this.fetchFor(origin,fingerprint)(origin+'/remote/v1'+route,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeout)});
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert(size<=2*1024**2,'The remote host returned too much data.',502);chunks.push(chunk);}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{assert(false,'The remote address is not a compatible Lobby Goblin host.',502);}
   assert(response.ok,response.status===401?'Remote access was revoked. Pair this host again.':route==='/pair'&&[400,403,409].includes(response.status)?'Pairing was refused. Check the code, expiry and existing paired panels on the remote host.':'The remote host could not complete the request.',response.status>=400&&response.status<500?response.status:502);return value;
  }catch(error){if(error.status)throw error;assert(false,'The remote host is unreachable. Check its agent address, dedicated port and network connection.',502);}
 }
 async add(input){
  assert(!this.pairing,'Another host pairing is in progress.',409);this.pairing=true;
  try{
   assert(input?.confirm===true&&name(input.name)&&typeof input.code==='string','Confirm the host name, HTTPS address and current pairing code.');
   const origin=hostOrigin(input.origin),{code,fingerprint}=pairingCode(input.code);assert(this.state.outgoing.length<20,'This panel already has 20 remote hosts.',409);
   assert(!this.state.outgoing.some(h=>h.origin===origin),'This address is already paired.',409);
   const pending=await this.change(state=>{
    state.pending=state.pending.filter(p=>p.expires>this.now());let entry=state.pending.find(p=>p.origin===origin&&p.codeHash===hash(code));
    if(!entry){assert(state.pending.length<20,'Too many unfinished pairings. Retry after ten minutes.',409);entry={origin,codeHash:hash(code),pairId:id(),token:secret(),expires:this.now()+10*60000};state.pending.push(entry);}return entry;
   });
   const result=await this.request(origin,'/pair',{fingerprint,body:{code,pairId:pending.pairId,token:pending.token,centralId:this.manager.fleet,name:input.panelName&&name(input.panelName)?input.panelName.trim():'Lobby Goblin panel'}});
   assert(result.protocol===1&&validId(result.id)&&result.id!==this.manager.fleet&&result.pairId===pending.pairId,'This is not a compatible remote host, or it is this host.',409);
   await this.change(state=>{assert(!state.outgoing.some(h=>h.id===result.id),'This host is already paired under another address.',409);state.outgoing.push({id:result.id,name:input.name.trim(),origin,...(fingerprint?{fingerprint}:{}),token:pending.token,pairId:pending.pairId,created:new Date(this.now()).toISOString()});state.pending=state.pending.filter(p=>p.pairId!==pending.pairId);});
   return {id:result.id,name:input.name.trim(),origin,connected:true,local:false};
  }finally{this.pairing=false;for(const [origin,connection] of this.connections)if(!this.state.outgoing.some(h=>h.origin===origin)){connection.close();this.connections.delete(origin);}}
 }
 async list(){
  const hosts=[this.local()];
  // Bounded parallel probes. A failed host never hides the local host or others.
  for(let n=0;n<this.state.outgoing.length;n+=4)hosts.push(...await Promise.all(this.state.outgoing.slice(n,n+4).map(async item=>{
   const {id,name,origin,created}=item;try{const status=await this.request(origin,'/status',{token:item.token,timeout:3000});assert(status.hostId===id&&status.protocol===1,'Remote host identity changed.',409);const panelVersion=await agentVersion();return {id,name,origin,created,local:false,connected:true,connection:item.fingerprint?'persistent':'https',version:status.version,panelVersion,aligned:status.version===panelVersion,agentOnly:status.agentOnly,agentUpdate:status.agentUpdate,agentUpdateSupported:status.agentUpdateSupported,managementUpdateSupported:status.managementUpdateSupported,isolation:status.isolation};}
   catch(error){return {id,name,origin,created,local:false,connected:false,error:error.message};}
  })));return {hosts};
 }
 async disconnect(hostId,input){
  const host=this.host(hostId);assert(input?.confirm===true&&input.name===host.name,'Type the host name to disconnect it.');
  let revoked=false;try{await this.request(host.origin,'/disconnect',{token:host.token,body:{}});revoked=true;}catch{}
  await this.change(state=>{state.outgoing=state.outgoing.filter(h=>h.id!==hostId);});this.connections.get(host.origin)?.close();this.connections.delete(host.origin);
  return {disconnected:true,revoked,message:revoked?'Host disconnected. Its servers and worlds were left unchanged.':'Host removed from this panel. Revoke this panel under Hosts on the remote installation when it is reachable. Its servers and worlds were left unchanged.'};
 }
 async handle(req,res,url){
  if(url.pathname==='/hosts'){if(req.method==='GET')json(res,200,await this.list());else{assert(req.method==='POST','Not found.',404);json(res,201,await this.add(await requestJSON(req)));}return true;}
  if(url.pathname==='/host-pairing'){if(req.method==='GET')json(res,200,this.pairingStatus());else{assert(req.method==='POST','Not found.',404);json(res,200,await this.enrollment(await requestJSON(req)));}return true;}
  const match=url.pathname.match(/^\/hosts\/([a-f0-9]{32})(\/.*)$/);if(!match)return false;
  const host=this.host(match[1]),route=match[2];
  if(route==='/disconnect'){assert(req.method==='POST','Not found.',404);json(res,200,await this.disconnect(host.id,await requestJSON(req)));return true;}
  assert(remoteRoute(req.method,route),'Remote route not found.',404);
  let body=req.method==='POST'?await readBody(req,route.endsWith('/upload')?128*1024**2:1024**2):undefined;
  if(route==='/agent-update-plan')body=Buffer.from(JSON.stringify({version:await agentVersion()}));
  if(req.method==='POST'&&!['/agent-update','/agent-update-plan','/management-update'].includes(route)){
   const status=await this.request(host.origin,'/status',{token:host.token,timeout:5000});assert(status.hostId===host.id&&status.version===await agentVersion(),'Update the agent to match this panel before changing its servers.',409);
  }
  await proxyResponse(req,res,host.origin+'/remote/v1'+route+url.search,{fetcher:this.fetchFor(host.origin),headers:{origin:host.origin,authorization:'Bearer '+host.token,'content-type':req.headers['content-type']||'application/json','x-panel-user':req.headers['x-panel-user']||'administrator','x-panel-update-kind':req.headers['x-panel-update-kind']==='game'?'game':'any'},body,download:route.endsWith('/download'),timeout:route.endsWith('/mod-library')||route.endsWith('/mod-library-plan')?150000:30000});return true;
 }
}
