import {workflowJournal} from '../../core/workflow-journal.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert,readJSON,writeJSON} from '../../common.js';
import {createModStore} from '../../core/mod-store.js';
import {frameworks,frameworkRelease,frameworkFiles,boundedDownload,sha256,safePath} from './mod-packages.js';

const pluginName=value=>{assert(typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}\.cs$/.test(value),'Use the original plugin filename, such as GatherManager.cs.');return value;};
export function validateModAction(action,params){
 assert(params&&typeof params==='object','Invalid mod request.');
 if(action==='install-framework')assert(params.confirm===true&&/^[a-f0-9-]{36}$/.test(params.planId||''),'Review and confirm a framework installation first.');
 if(action==='recover-framework')assert(params.confirm===true,'Confirm restoring the interrupted framework transaction.');
 if(action==='plugin'){
  pluginName(params.name);assert(['install','enable','disable','remove','reload'].includes(params.operation),'Choose a plugin operation.');
  if(params.operation==='install')assert(typeof params.source==='string'&&Buffer.byteLength(params.source)>0&&Buffer.byteLength(params.source)<=512*1024&&!params.source.includes('\0'),'Upload a C# plugin source file of at most 512 KiB.');
  assert(params.confirm===true,'Confirm the plugin change.');
 }
 if(action==='plugin-config'){
  assert(typeof params.name==='string'&&/^[A-Za-z][A-Za-z0-9_. -]{0,99}\.json$/.test(params.name)&&!params.name.includes('..'),'Choose a plugin JSON configuration.');
  assert(typeof params.source==='string'&&Buffer.byteLength(params.source)<=512*1024,'Configuration exceeds 512 KiB.');
  JSON.parse(params.source);assert(/^[a-f0-9]{64}$/.test(params.revision||''),'Reload this configuration before saving.');
 }
}

export function createModManager({root,state,assertStopped,command,fetcher=fetch,getActive=()=>null,mutableStores=null}){
 const storage=path.join(state,'mods'),installedFile=path.join(storage,'installed.json'),transactionFile=path.join(storage,'transaction.json');
 const journal=workflowJournal({file:transactionFile,history:path.join(storage,'recovery'),source:'frameworks',label:'Framework transactions',action:'framework-change',getActive});
 const marker=root&&path.join(root,'.lobby-goblin-mods.json');
 async function available(){assert(root,'Update the Rust controller storage mount before managing mods.',409);assert(await fs.realpath(root)===path.resolve(root),'Rust installation must be a real directory.',409);await fs.mkdir(storage,{recursive:true,mode:0o700});assert(await fs.realpath(storage)===storage,'Mod recovery storage cannot be a link.');}
 async function file(name,{create=false,base=root}={}){
  safePath(name);assert(await fs.realpath(base)===path.resolve(base),'Mod storage root cannot be a link.');
  let location=base;const parts=name.split('/');
  for(const part of parts.slice(0,-1)){
   location=path.join(location,part);let stat=await fs.lstat(location).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
   if(!stat&&create){await fs.mkdir(location,{mode:0o755});stat=await fs.lstat(location);}
   if(!stat)return null;
   assert(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(location)===location,'Mod directories cannot contain links.');
  }
  location=path.join(location,parts.at(-1));const stat=await fs.lstat(location).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  assert(!stat||stat.isFile()&&!stat.isSymbolicLink(),'Mod files cannot be links or special files.');return {location,stat};
 }
 const mutable=name=>{const slash=name.lastIndexOf('/');return slash>0&&mutableStores?.get(name.slice(0,slash));};
 function store(scope){assert(frameworks[scope],'Choose an installed framework.',409);return mutableStores?.get(frameworks[scope].plugins)||createModStore(path.join(root,frameworks[scope].plugins),{accept:name=>/\.cs(?:\.disabled)?$/.test(name)});}
 async function bytes(name,options){const dataStore=(!options?.base||options.base===root)&&mutable(name);if(dataStore)return (await dataStore.read(name.slice(name.lastIndexOf('/')+1)))?.data??null;const found=await file(name,options);if(!found?.stat)return null;assert(found.stat.size<=(options?.limit??128*1024**2),'Mod file exceeds its size limit.');return fs.readFile(found.location);}
 async function write(name,data,{mode=0o644,base=root}={}){
  const dataStore=base===root&&mutable(name);if(dataStore)return dataStore.write(name.slice(name.lastIndexOf('/')+1),data,mode);
  const target=await file(name,{create:true,base});
  if(data===null){if(target.stat)await fs.unlink(target.location);return;}
  const temporary=target.location+'.lg-'+crypto.randomUUID();
  try{await fs.writeFile(temporary,data,{flag:'wx',mode});await fs.rename(temporary,target.location);}finally{await fs.rm(temporary,{force:true});}
 }
 async function installed(){const value=await readJSON(installedFile,{format:1,framework:'none',files:[]});assert(value.format===1&&['none','carbon','oxide'].includes(value.framework)&&Array.isArray(value.files),'Invalid installed framework record.',409);for(const entry of value.files){safePath(entry.name);assert(/^[a-f0-9]{64}$/.test(entry.sha256)&& (entry.original===null||/^[a-f0-9-]{36}$/.test(entry.original)&&/^[a-f0-9]{64}$/.test(entry.originalSha256)),'Invalid framework file record.',409);}return value;}
 async function assertReady(){
  if(!root)return;
  await available();const transaction=await readJSON(transactionFile,null),active=await readJSON(marker,null);
  assert(!transaction||transaction.phase==='complete'||transaction.phase==='recovered','An interrupted framework change needs recovery from Mods before Rust can start.',409);
  assert(!active||active.status==='complete','Framework files are incomplete. Recover the change from Mods before starting.',409);
 }
 async function status(){
  if(!root)return {available:false,framework:'none',plugins:[],configs:[],message:'Update the Rust controller storage mount to enable mod management.'};
  await available();const record=await installed(),transaction=await readJSON(transactionFile,null),definition=frameworks[record.framework];let plugins=[],configs=[];
  async function listing(directory,pattern,disabled=false){
   const dataStore=mutableStores?.get(directory);if(dataStore)return [...await dataStore.list()].filter(([name])=>pattern.test(name)).map(([name,file])=>({name:disabled?name.replace(/\.disabled$/,''):name,disabled,size:file.data.length}));
   const parent=await file(directory+'/unused');if(!parent)return [];
   const values=[];for(const name of await fs.readdir(path.dirname(parent.location)).catch(error=>{if(error.code!=='ENOENT')throw error;return [];}))if(pattern.test(name)){const result=await file(directory+'/'+name);if(result?.stat)values.push({name:disabled?name.replace(/\.disabled$/,''):name,disabled,size:result.stat.size});}return values;
  }
  if(definition){plugins=[...await listing(definition.plugins,/^[A-Za-z][A-Za-z0-9_]{0,79}\.cs$/),...await listing(definition.plugins,/^[A-Za-z][A-Za-z0-9_]{0,79}\.cs\.disabled$/,true)];configs=await listing(definition.configs,/^[A-Za-z][A-Za-z0-9_. -]{0,99}\.json$/);}
  return {available:true,framework:record.framework,version:record.version||null,sha256:record.sha256||null,plugins,configs,recoveryRequired:!!transaction&&!['complete','recovered'].includes(transaction.phase),recoveryId:transaction?.id,message:'Stop Rust before changing frameworks, plugin files or configuration. Plugin reload is available while Rust is ready. Framework recovery copies and plugin history are retained.'};
 }
 async function plan(framework){
  await available();await assertReady();assert(['none','carbon','oxide'].includes(framework),'Choose Vanilla, Carbon or Oxide / uMod.');
  const release=framework==='none'?{framework,version:'vanilla'}:await frameworkRelease(framework,fetcher),current=await installed();
  const value={...release,id:crypto.randomUUID(),created:Date.now(),current:sha256(Buffer.from(JSON.stringify(current)))};
  await writeJSON(path.join(storage,'plan-'+value.id+'.json'),value);
  return {...value,name:frameworks[framework]?.name||'Vanilla',message:'Rust must be stopped. Framework files are backed up before replacement; worlds, plugin data and configurations are preserved. Start Rust yourself after installation.'};
 }
 async function restoreTransaction(transaction){
  assert(transaction?.format===1&&/^[a-f0-9-]{36}$/.test(transaction.id)&&Array.isArray(transaction.files),'Invalid framework recovery record.');
  const recovery=path.join(storage,'recovery',transaction.id);assert(await fs.realpath(recovery)===recovery,'Invalid recovery directory.');
  for(const entry of transaction.files){await assertStopped();const original=entry.before===null?null:await bytes(entry.name,{base:recovery});assert(original===null?entry.before===null:sha256(original)===entry.before,'Framework recovery copy failed verification.');await write(entry.name,original,{mode:entry.mode});}
  await writeJSON(installedFile,transaction.previous);await writeJSON(marker,{format:1,status:'complete',framework:transaction.previous.framework});
  transaction.phase='recovered';await journal.write(transaction);
 }
 async function recover(){assert(!mutableStores,'Managed framework recovery requires the paired software and data workflow.',409);await available();await assertStopped();const transaction=await readJSON(transactionFile,null);assert(transaction&&!['complete','recovered'].includes(transaction.phase),'No interrupted framework change needs recovery.',409);await restoreTransaction(transaction);return 'Previous framework files restored. Rust remains stopped; worlds and plugin data were preserved.';}
 async function install(planId,parent){
  assert(!mutableStores,'Managed framework changes require the paired software and data workflow.',409);
  await available();await assertStopped();await assertReady();
  const reviewed=await readJSON(path.join(storage,'plan-'+planId+'.json'),null),previous=await installed();
  assert(reviewed&&Date.now()-reviewed.created<15*60000&&reviewed.current===sha256(Buffer.from(JSON.stringify(previous))),'Framework review expired or the installation changed. Review again.',409);
  let files=[];
  if(reviewed.framework!=='none'){
   const definition=frameworks[reviewed.framework];assert(definition&&reviewed.asset===definition.asset&&new URL(reviewed.url).pathname.startsWith('/'+definition.repository+'/releases/download/'),'Unexpected framework release.');
   const archive=await boundedDownload(reviewed.url,64*1024**2,fetcher);assert(archive.length===reviewed.size&&sha256(archive)===reviewed.sha256,'The framework archive changed after review. Nothing was installed.',409);files=frameworkFiles(reviewed.framework,archive);
   await write('packages/'+reviewed.sha256+(reviewed.framework==='carbon'?'.tar.gz':'.zip'),archive,{base:storage,mode:0o600});
  }
  await assertStopped();
  if(previous.framework==='none')for(const name of ['libdoorstop.so','RustDedicated_Data/Managed/Oxide.Rust.dll'])assert(!await bytes(name),'An unmanaged framework already exists. Import or remove it manually before using managed installation.',409);
  const desired=new Map(),originals=new Map();
  for(const entry of previous.files){
   const current=await bytes(entry.name);assert(current&&sha256(current)===entry.sha256,'A managed framework file changed outside the panel. Preserve those changes before switching frameworks: '+entry.name,409);
   const original=entry.original===null?null:await bytes(entry.name,{base:path.join(storage,'originals',entry.original)});assert(original===null?entry.original===null:sha256(original)===entry.originalSha256,'Vanilla recovery copy failed verification.');
   desired.set(entry.name,original);originals.set(entry.name,entry);
  }
  const id=crypto.randomUUID(),recovery=path.join(storage,'recovery',id),baseline=path.join(storage,'originals',id);
  await fs.mkdir(recovery,{recursive:true,mode:0o700});await fs.mkdir(baseline,{recursive:true,mode:0o700});
  for(const entry of files){
   if(!originals.has(entry.name)){
    const original=await bytes(entry.name);if(original!==null)await write(entry.name,original,{base:baseline});
    originals.set(entry.name,{name:entry.name,original:original===null?null:id,originalSha256:original===null?null:sha256(original)});
   }
   desired.set(entry.name,entry.data);
  }
  const records=[];
  for(const [name] of desired){const before=await bytes(name),found=await file(name);if(before!==null)await write(name,before,{base:recovery,mode:found.stat.mode&0o777});records.push({name,before:before===null?null:sha256(before),mode:found?.stat?.mode&0o777||0o644});}
  const transaction={format:1,id,phase:'applying',actor:parent?.actor,started:new Date().toISOString(),previous,files:records};await journal.write(transaction,parent);await writeJSON(marker,{format:1,status:'pending',framework:reviewed.framework});
  try{
   for(const [name,data] of desired){await assertStopped();await write(name,data,{mode:files.find(file=>file.name===name)?.mode||records.find(file=>file.name===name).mode});}
   const next={format:1,framework:reviewed.framework,version:reviewed.version,sha256:reviewed.sha256,installed:new Date().toISOString(),files:files.map(entry=>({...originals.get(entry.name),sha256:sha256(entry.data)}))};
   await writeJSON(installedFile,next);await writeJSON(marker,{format:1,status:'complete',framework:reviewed.framework});transaction.phase='complete';await journal.write(transaction);
  }catch(error){
   try{await assertStopped();await restoreTransaction(transaction);}catch{throw Error('Framework installation was interrupted. Keep Rust stopped and use Recover framework from Mods.');}throw error;
  }
  // Removing an expired review is cleanup; it cannot undo a committed framework.
  await fs.unlink(path.join(storage,'plan-'+planId+'.json')).catch(()=>{});
  return (frameworks[reviewed.framework]?.name||'Vanilla')+' installed. Rust remains stopped. Worlds, settings and plugin data were preserved.';
 }
 async function plugin(params){
  await available();await assertReady();const record=await installed(),definition=frameworks[record.framework];assert(definition,'Install Carbon or Oxide / uMod first.',409);
  const name=pluginName(params.name),location=definition.plugins+'/'+name;
  if(params.operation==='reload'){assert(await bytes(location),'Plugin is not enabled.',409);const result=await command((record.framework==='carbon'?'c.reload ':'oxide.reload ')+name.slice(0,-3));return 'Reload requested: '+String(result).slice(0,2000);}
  await assertStopped();
  const enabled=await bytes(location),disabled=await bytes(location+'.disabled');assert(!(enabled&&disabled),'Both enabled and disabled copies exist; resolve the duplicate first.',409);
  const existing=enabled??disabled;
  if(existing){const history=path.join(storage,'plugin-history',crypto.randomUUID());await fs.mkdir(history,{recursive:true,mode:0o700});await write(name,existing,{base:history});}
  if(params.operation==='install'){await write(location,Buffer.from(params.source));if(disabled)await write(location+'.disabled',null);}
  if(params.operation==='disable'){assert(enabled,'Plugin is not enabled.',409);await write(location+'.disabled',enabled);await write(location,null);}
  if(params.operation==='enable'){assert(disabled,'Plugin is not disabled.',409);await write(location,disabled);await write(location+'.disabled',null);}
  if(params.operation==='remove'){assert(existing,'Plugin is not installed.',404);await write(enabled?location:location+'.disabled',null);}
  return 'Plugin '+params.operation+' complete. Configuration and plugin data were preserved. Changes apply at the next start.';
 }
 async function configuration(name,change){
  await available();const record=await installed(),definition=frameworks[record.framework];assert(definition,'Install a framework first.',409);
  assert(/^[A-Za-z][A-Za-z0-9_. -]{0,99}\.json$/.test(name)&&!name.includes('..'),'Invalid plugin configuration name.');
  const location=definition.configs+'/'+name,content=await bytes(location,{limit:512*1024});assert(content&&content.length<=512*1024,'Plugin configuration is missing or exceeds 512 KiB.',404);
  if(!change)return {name,source:content.toString('utf8'),revision:sha256(content)};
  validateModAction('plugin-config',{name,...change});await assertStopped();await assertReady();assert(sha256(content)===change.revision,'Configuration changed. Reload before saving.',409);
  const history=path.join(storage,'plugin-history',crypto.randomUUID());await fs.mkdir(history,{recursive:true,mode:0o700});await write(name,content,{base:history});await write(location,Buffer.from(change.source));return 'Plugin configuration saved. Changes apply at the next start.';
 }
 async function backupRoots(){
  if(!root)return [];
  await available();await assertStopped();await assertReady();const record=await installed(),extras=[];
  for(const framework of mutableStores?[]:['carbon','oxide'])if(await fs.lstat(path.join(root,framework)).catch(error=>{if(error.code!=='ENOENT')throw error;return null;}))extras.push({prefix:'mods/'+framework,root:path.join(root,framework)});
  if(await fs.lstat(installedFile).catch(error=>{if(error.code!=='ENOENT')throw error;return null;})){
   // Include the exact active loader/DLL bytes and selection marker alongside
   // original files and downloaded packages, so recovery needs no network.
   const active=path.join(storage,'backup-active');await fs.rm(active,{recursive:true,force:true});await fs.mkdir(active,{mode:0o700});
   for(const entry of record.files){const data=await bytes(entry.name);assert(data&&sha256(data)===entry.sha256,'Managed framework files changed; reconcile them before backing up.');await write(entry.name,data,{base:active});}
   await write('.lobby-goblin-mods.json',Buffer.from(JSON.stringify({format:1,status:'complete',framework:record.framework})),{base:active});extras.push({prefix:'mod-state',root:storage});
  }
  return extras;
 }
 return {status,plan,install,recover,plugin,configuration,store,assertReady,backupRoots,operationSource:journal.operationSource,inspectOperation:journal.inspect};
}
