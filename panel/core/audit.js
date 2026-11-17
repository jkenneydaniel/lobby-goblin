import crypto from 'node:crypto';
import path from 'node:path';
import {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {validScope} from './permissions.js';
import {validPermissionName} from './permission-catalog.js';
import {assert,HttpError} from '../common.js';
import {AuditRepository,auditDigest as digest} from './storage/state-repositories.js';

function accessChange(value){
 assert(value&&Array.isArray(value.roles)&&value.roles.length===2&&value.roles.every(role=>['admin','viewer','member','removed'].includes(role))&&Array.isArray(value.assignments)&&value.assignments.length<=128,'Invalid access audit summary.');
 return {roles:value.roles,assignments:value.assignments.map(item=>{assert(validScope(item.scope)&&[item.before,item.after].every(list=>Array.isArray(list)&&list.length<=128&&list.every(validPermissionName)),'Invalid access audit summary.');return {scope:item.scope,before:item.before,after:item.after};})};
}
const text=(value,fallback='',length=160)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,length):fallback;
// Fixed fields only: credentials, request bodies, query strings, file contents,
// upstream errors and operation results are never accepted into the audit log.
export class AuditLog {
 constructor(root,{limit=10000,clock=()=>new Date().toISOString(),repository=new AuditRepository(root)}={}) {
  assert(Number.isInteger(limit)&&limit>=2&&limit<=100000,'Invalid audit retention limit.');
  Object.assign(this,{file:path.join(root,'audit.json'),limit,clock,repository});this.queue=Promise.resolve();
 }
 async stateForRead(){return (await this.repository.read()).value;}
 appendOnce(input){
  assert([input.operationId,input.requestId].every(value=>typeof value==='string'&&value.length>0&&value.length<=160),'An idempotent audit outcome needs operation and request identities.');
  return this.append(input,{once:true});
 }
 append(input,{once=false}={}){
  const next=this.queue.then(async()=>{
   // Only this pure metadata append is retried after a revision conflict. No
   // application action or response is replayed, and every attempt revalidates
   // the complete retained chain against the current authoritative revision.
   const base={at:this.clock(),requestId:text(input.requestId),actor:text(input.actor,'system',100),scope:text(input.scope,'panel'),action:text(input.action,'request'),outcome:text(input.outcome,'unknown',32),...(input.status&&{status:input.status}),...(input.target&&{target:text(input.target)}),...(input.operationId&&{operationId:text(input.operationId)}),...(input.accessChange&&{accessChange:accessChange(input.accessChange)})};
   for(let attempt=0;;attempt++){
    const snapshot=await this.repository.read(),current=snapshot.value,last=current.events.at(-1)||current.anchor;
    if(once){const previous=current.events.find(event=>['requestId','operationId','scope','action','outcome','actor'].every(key=>event[key]===base[key]));if(previous)return previous;}
    assert(last.sequence<Number.MAX_SAFE_INTEGER,'Audit sequence limit reached. Preserve it for review.',503);
    const entry={sequence:last.sequence+1,previous:last.hash,...base};
    const events=[...current.events,{...entry,hash:digest(entry)}];let anchor=current.anchor;
    if(events.length>this.limit){const removed=events.splice(0,events.length-this.limit),last=removed.at(-1);anchor={sequence:last.sequence,hash:last.hash};}
    try{await this.repository.save(snapshot,{version:1,anchor,events});return events.at(-1);}
    catch(error){if(!snapshot.store||error.status!==409||attempt>=7)throw error;}
   }
  });this.queue=next.catch(()=>{});return next;
 }
 async list({before,limit=50,search=''}={}){
  assert(Number.isInteger(limit)&&limit>=1&&limit<=100,'Choose an audit page size from 1 to 100.');
  assert(before===undefined||Number.isSafeInteger(before)&&before>0,'Invalid audit cursor.');
  assert(typeof search==='string'&&search.length<=80,'Use at most 80 characters to filter audit history.');
  const query=search.toLowerCase();
  await this.queue;const state=await this.stateForRead(),events=state.events.filter(event=>(before===undefined||event.sequence<before)&&(!query||[event.actor,event.action,event.scope,event.target].some(value=>value?.toLowerCase().includes(query)))).slice(-limit-1).reverse();
  const hasMore=events.length>limit;if(hasMore)events.pop();
  return {events,nextBefore:hasMore?events.at(-1).sequence:null,retainedFrom:state.events[0]?.sequence||null,prunedThrough:state.anchor.sequence,limit:this.limit};
 }
}

// Mutating responses are held until their audit outcome is persisted. A durable
// "started" entry remains if the process dies or completion cannot be recorded.
class BufferedResponse extends Writable {
 constructor(){super();this.chunks=[];this.size=0;this.statusCode=200;this.headers=new Map();this.headersSent=false;}
 setHeader(key,value){this.headers.set(key.toLowerCase(),value);return this;}
 getHeader(key){return this.headers.get(key.toLowerCase());}
 writeHead(status,headers){this.statusCode=status;this.headersSent=true;for(const [key,value] of Object.entries(headers||{}))this.setHeader(key,value);return this;}
 _write(chunk,_encoding,callback){this.size+=chunk.length;if(this.size>4*1024**2)return callback(Error('Audit response exceeded its size limit.'));this.chunks.push(Buffer.from(chunk));callback();}
}
export async function auditedResponse(audit,req,res,event,work){
 const requestId=crypto.randomUUID();req.auditContext={...event,requestId};
 const describe=()=>({...req.auditContext,actor:req.auditActor||event.actor,...(req.auditTarget&&{target:req.auditTarget}),...(req.auditAction&&{action:req.auditAction}),...(req.auditAccessChange&&{accessChange:req.auditAccessChange})});
 try{await audit.append({...describe(),outcome:'started'});}catch{throw new HttpError(503,'Audit history could not be saved. No action was submitted.');}
 const buffered=new BufferedResponse();let error;
 const disconnect=()=>buffered.destroy(new HttpError(499,'The client disconnected before the response completed.'));
 res.once('close',disconnect);
 // Attach before work: a proxy may finish or fail synchronously.
 const done=finished(buffered);done.catch(()=>{});
 try{await work(buffered);await done;}catch(failure){error=failure;buffered.destroy();}finally{res.off('close',disconnect);}
 const status=error?(error.status||502):buffered.statusCode;
 let operationId;
 try{const value=JSON.parse(Buffer.concat(buffered.chunks));if(typeof value.id==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value.id))operationId=value.id;}catch{}
 try{await audit.append({...describe(),status,operationId,outcome:status>=400?(status===403||status===401?'denied':'failed'):status===202?'accepted':'succeeded'});}
 catch{throw new HttpError(503,'The action may have completed, but its audit outcome could not be saved. Review audit history and current status before trying again.');}
 if(error)throw error;
 if(res.destroyed)return;
 for(const [key,value] of buffered.headers)res.setHeader(key,value);
 res.writeHead(status);res.end(Buffer.concat(buffered.chunks));
}
export function auditRequest(pathname,scope='standalone'){
 const match=pathname.match(/^((?:\/hosts\/[a-f0-9]{32})?\/servers\/[a-f0-9]{32})(\/api\/.*)$/);
 const route=match?match[2]:pathname;
 const actions={'/api/login':'account.sign-in','/api/register':'account.register','/api/registration':'invitation.inspect','/api/logout':'account.sign-out','/api/password':'account.password','/api/accounts':'account.access','/api/invitations':'invitation.change','/api/sessions':'session.revoke','/api/onboarding':'setup.complete'};
 const serverRoutes=['jobs','jobs/recovery','schedule','backup-retention','upload','pins','world-preview','world-setups','update-plan','update-install','mod-library','mod-library-plan','mod-library-account','mods-plan'];
 const hostRoutes=['servers','host-settings','host-pairing','host-setup','host-setup-plan','hosts'];
 const endpoint=route.startsWith('/api/')?route.slice(5):'';
 const action=actions[route]||(serverRoutes.includes(endpoint)?'server.'+endpoint.replaceAll('/','.'):hostRoutes.includes(endpoint)?'host.'+endpoint:/^hosts\/[a-f0-9]{32}\/(?:servers|host-settings|disconnect|agent-update|agent-update-plan)$/.test(endpoint)?'host.'+endpoint.split('/').at(-1):/^servers\/[a-f0-9]{32}\/(?:snapshot|remove)$/.test(endpoint)?'server.'+endpoint.split('/').at(-1):'management.request');
 return {scope:match?.[1]||scope,action};
}
