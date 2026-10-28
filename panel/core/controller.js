import {publicTransportMessage} from './operation-errors.js';
import {retainOperationDiagnostic} from './operation-diagnostics.js';
import {ApplicationReleases} from './application-releases.js';
import {managementMaintenance,assertManagementIdle} from './management-maintenance.js';
import {dockerTransport} from './broker-client.js';
import {migrationImage,ownedImage} from './game-images.js';
import {launchStandaloneMigration} from './standalone-migration.js';
import fs from 'node:fs/promises';
import {ownedDocker} from './owned-docker.js';
import {noManagedUpdater} from './managed-updater.js';
import path from 'node:path';
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {docker as dockerAPI} from './docker.js';
import {createHost} from './host.js';
import {createBackups} from './backups.js';
import {BackupRetention} from '../backup-retention.js';
import {assert,HttpError,sleep,readJSON,json,requestJSON,existingFile,equalSecret,redact} from '../common.js';
import {validateApplicationModule} from './application-module.js';
import {AuditLog,auditedResponse}  from './audit.js';
import {Operations} from './operations.js';
import {JobsRepository,ConfigurationRepository} from './storage/state-repositories.js';
import {OperationFeed,jobOperationSource,operationProgressSnapshot} from './operation-feed.js';
import {validateConfiguration,validateController,validateUpdater,validateActionRequest,normalizeStatus,publicContract} from './game-contract.js';
import {controllerAccess} from './routes.js';
import {SoftwareWorkers} from './software-workers.js';

// One controller/operation lock per installation. The module supplies game
// behavior; the core owns persistence, authentication and operation coordination.
export async function startController(module,{env=process.env,docker=dockerAPI,port=Number(env.PORT||8081),hostname='0.0.0.0'}={}){
  validateApplicationModule(module);
  const transport=dockerTransport(env,docker);docker=transport.docker;
  const config=validateConfiguration(module.configuration(env,{migrationBootstrap:true})),{state,library,backupDir}=config;
  if(env.FLEET_ID&&!transport.brokered)docker=ownedDocker(docker,env,{container:config.container,...module.managed});
  await module.validateInstallation?.(config);
  const token=(await fs.readFile(env.CONTROLLER_TOKEN_FILE||'/run/secrets/controller_token','utf8')).trim();
  for(const dir of [state,library,backupDir])await fs.mkdir(dir,{recursive:true});
  const maintenance=await managementMaintenance(state,env);
  const managementDocker=docker;docker=(method,...args)=>{assert(!maintenance.held||maintenance.preparing||method==='GET','Management startup is held. Docker changes require explicit operator activation.',409);return managementDocker(method,...args);};
  const jobsRepository=new JobsRepository(state),jobsSnapshot=await jobsRepository.read();
  let jobs=jobsSnapshot.value,active=null,retentionConfiguring=false;
  let jobWrites=Promise.resolve();
  const persistJobs=()=>{const snapshot=structuredClone(jobs),next=jobWrites.then(()=>jobsRepository.save(jobsSnapshot,snapshot));jobWrites=next.catch(()=>{});return next;};
  const audit=new AuditLog(state);
  if(maintenance.held)await audit.list();
  const operations=new Operations({failure:(error,job)=>retainOperationDiagnostic(state,error,{id:job.id,source:'application-operations',phase:job.phase||'unknown'}),record:event=>audit.append({...event,scope:env.FLEET_INSTANCE?'/servers/'+env.FLEET_INSTANCE:'standalone'}),getJobs:()=>jobs,setJobs:value=>{jobs=value;},getActive:()=>active,setActive:value=>{active=value;},persist:persistJobs,
    retryable:job=>module.contract.actions[job.action]?.retry==='convergent',inspect:async job=>{
      if(game.inspectOperation)return game.inspectOperation(job);
      for(const source of game.operationSources||[]){const observation=await source.inspectJob?.(job);if(observation)return observation;}
      game.invalidate();const value=normalizeStatus(module,await game.status());
      if(job.action==='start'&&value.ready)return {outcome:'succeeded',message:'The server is ready. The interrupted start has reached its requested state.'};
      if(job.action==='stop'&&value.running===false&&!value.error)return {outcome:'succeeded',message:'The server reports stopped. The interrupted stop has reached its requested state.'};
      return {message:`Current server state: ${value.ready?'ready':value.running?'running, readiness unconfirmed':'stopped or unavailable'}. Review logs and backups before retrying ${job.action}. No operation was replayed.`};
    }});
  await operations.init();
  const scheduleRepository=new ConfigurationRepository(state,'schedule',{enabled:false,hours:6,keep:12,lastRun:null}),scheduleSnapshot=await scheduleRepository.read();
  let schedule=scheduleSnapshot.value;
  let scheduleWrites=Promise.resolve();
  const changeSchedule=update=>{const next=scheduleWrites.then(async()=>{const value=update(schedule);await scheduleRepository.save(scheduleSnapshot,value);schedule=value;return value;});scheduleWrites=next.catch(()=>{});return next;};
  const timers=[];
  const every=(fn,ms)=>{const timer=setInterval(()=>{if(!maintenance.held)fn();},ms);timer.unref();timers.push(timer);return timer;};
  const host=createHost({docker,container:config.container,stopTimeout:module.stopTimeout});
  const softwareWorkers=transport.brokered&&env.FLEET_ID&&module.managed?.softwareWorker?new SoftwareWorkers({docker,env,declaration:module.managed.softwareWorker}):null;
  const ctx={config,env,host,docker,every,runJob,stageMessage,softwareWorkers,
    get jobs(){return jobs;},get active(){return active;},get schedule(){return schedule;},
    get updater(){return updater;},get backups(){return backups;},get imageMigrationPending(){return migrationPending;}};
  let migrationPending=false,migrationLaunching=false,migrationError=null,migrationWorker=null;
  const game=validateController(module,await module.createController(ctx));
  const backups=await createBackups({root:backupDir,state,game,getJobs:()=>jobs,getSchedule:()=>schedule});
  const applicationReleases=new ApplicationReleases();
  const updater=validateUpdater(env.FLEET_ID?noManagedUpdater((await readJSON(new URL('../package.json',import.meta.url))).version):module.createUpdater({config,env,docker,record:event=>audit.appendOnce({...event,scope:env.FLEET_INSTANCE?'/servers/'+env.FLEET_INSTANCE:'standalone'}),backup:label=>backups.create(label),canInstall:()=>!active&&!retentionConfiguring&&!operations.blocked,waitIdle:()=>game.waitIdle(),current:(await readJSON(new URL('../package.json',import.meta.url))).version}));
  let initialized=false,started=false;
  const initialize=async()=>{if(!initialized){await game.init();await updater.init();initialized=true;}};
  const activate=async()=>{if(maintenance.held){assert(!active&&!operations.blocked,'Review interrupted operations before management activation.',409);assertManagementIdle(await operationFeed.snapshot());}await initialize();if(!started){await game.start();started=true;}};
  if(!maintenance.held)await initialize();
  const operationFeed=new OperationFeed({scope:env.FLEET_INSTANCE?'/servers/'+env.FLEET_INSTANCE:'standalone',sources:[jobOperationSource(operations),...(updater.operationSource?[updater.operationSource()]:[]),...(game.operationSources||[])]});
  let migrationJournal=null;
  const legacyMigration=module.managed?.legacyMigration;
  const migrationFile=legacyMigration?.file(config,env)||path.join(state,'image-migration.json');
  if(!env.FLEET_ID&&legacyMigration){migrationJournal=await readJSON(migrationFile,null);const installed=await host.info().catch(error=>{if(error.status===404&&migrationJournal)return migrationJournal.original;throw error;});migrationPending=!!installed.Config?.Labels?.['com.docker.compose.project']&&(!ownedImage(module.id,installed.Config?.Image)||migrationImage(module.id,installed.Config?.Image)||migrationJournal&&migrationJournal.phase!=='complete');}

  const retention=new BackupRetention({root:backupDir,file:path.join(state,'backup-retention.json'),extension:game.backupExtension||'.zip',
    protectedNames:async()=>[...(await game.protectedBackups?.()||[]),...updater.jobs.filter(job=>job.recovery?.requiresWorldRestore).map(job=>job.backup),(await readJSON(migrationFile,null))?.backup,env.IMAGE_MIGRATION_BACKUP].filter(Boolean),
    validations:backups.validations,onDeleted:backups.deleted});
  await retention.init();
  const actions={...game.actions,
    backup:async(params,job)=>{const scheduled=job?.actor==='scheduled backup',name=await backups.create(scheduled?'scheduled':job?.actor==='automatic image migration'?'before-image-migration':'manual');if(scheduled)await retention.pruneScheduled(schedule.keep);return `Backup created: ${name}`;},
    'verify-backup':params=>backups.verify(params.name),
    'cleanup-backups':async(params,job)=>{
      const automatic=job.actor==='automatic backup cleanup';
      if(automatic&&!retention.due)return 'Automatic backup cleanup is no longer due.';
      try{const planId=automatic?(await retention.preview()).id:params.planId;return await retention.cleanup(planId);}
      finally{if(automatic)await retention.ran();}
    },
  };
  async function stageMessage(job,message,phase='working',target){await operations.checkpoint(job,phase,message,target);}
  async function runJob(action,params,actor,options={}){
    maintenance.assertAvailable();
    assert(Object.hasOwn(actions,action),'Unsupported action.');
    const previous=operations.existing({action,actor,input:params,requestId:options.requestId,retryOf:options.retryOf});if(previous)return operations.accepted(previous);
    await updater.refresh();assert(!updater.busy,'An update is in progress. Wait for it to finish.',409);
    assert(!updater.pendingRestore||action==='restore'&&params.name===updater.pendingRestore.backup,'Restore the recorded pre-update backup from Backups before running more server operations.',409);
    assert(!active&&!retentionConfiguring,'Another operation is in progress. Please wait.',409);
    const {job,duplicate}=await operations.reserve({action,actor,input:params,...options});
    if(!duplicate)void operations.execute(job,{before:()=>game.beforeJob(job),run:async()=>{const result=await actions[action](params,job);if(action==='restore')await updater.restored(params.name);return result;},
      after:async()=>{try{await game.afterJob(job,params);}finally{game.invalidate();}}});
    return job;
  }
  async function handle(req,res){
    if(req.url==='/health')return json(res,200,{ok:true});
    assert(equalSecret(req.headers.authorization,`Bearer ${token}`),'Unauthorized.',401);
    const url=new URL(req.url,'http://controller');
    if(await maintenance.handle(req,res,url,{token,prepare:activate,inspect:()=>operationFeed.snapshot()}))return;
    maintenance.assertAvailable();
    assert(controllerAccess(module,req.method,url.pathname),'Not found.',404);
    if(req.method==='POST'&&!req.auditContext)return auditedResponse(audit,req,res,{actor:req.headers['x-panel-user']||'controller',scope:env.FLEET_INSTANCE?'/servers/'+env.FLEET_INSTANCE:'standalone',action:'server.'+url.pathname.slice(1).replaceAll('/','.')},buffered=>handle(req,buffered));
    if(req.method==='GET'&&url.pathname==='/operations')return json(res,200,await operationFeed.snapshot());
    if(req.method==='POST'&&url.pathname==='/operations/recovery')return json(res,200,await operationFeed.recover(await requestJSON(req),req.headers['x-panel-user']||'administrator'));
    const migrationRequest=equalSecret(req.headers['x-lobby-goblin-migration'],token);
    if(req.method==='POST'&&url.pathname==='/jobs/recovery'){
      const body=await requestJSON(req),actor=req.headers['x-panel-user']||body.actor||'admin';
      if(body.operation==='retry'){
        if(migrationPending)assert(migrationRequest,'Automatic image migration is using this installation. Wait for it to complete.',409);
        assert(body.confirm===true,'Confirm retrying the interrupted operation.');
        const original=jobs.find(job=>job.id===body.id);assert(original&&module.contract.actions[original.action]?.retry==='convergent','This operation cannot be safely replayed. Review it and use the normal controls.',409);
        validateActionRequest(module,{action:original.action,params:{confirm:true}});await game.validateAction({action:original.action,params:{confirm:true}});
        return json(res,202,await runJob(original.action,{confirm:true},actor,{requestId:body.requestId,retryOf:original.id}));
      }
      return json(res,200,await operations.recover(body,actor));
    }
    if(req.method!=='GET'&&migrationPending)assert(migrationRequest,'Automatic image migration is using this installation. Wait for it to complete.',409);
    if(req.method!=='GET'&&!['/jobs','/operations/recovery'].includes(url.pathname))assert(!operations.blocked,'Review interrupted operations before making more changes.',409);
    if(req.method==='GET'&&url.pathname==='/application-releases')return json(res,200,await applicationReleases.read(module.id,await game.softwarePolicy?.()||module.managed?.software));
    if(url.pathname.startsWith('/update-')){
      if(req.method==='GET'&&url.pathname==='/update-status'){const value=await updater.refresh();return json(res,200,req.headers['x-panel-update-kind']==='game'?{...value,jobs:(value.jobs||[]).filter(job=>job.kind==='game').map(({recovery,...job})=>({...job,...(recovery?{recovery:{action:recovery.action}}:{})}))}:value);}
      if(req.method==='POST'&&url.pathname==='/update-plan'){const input=await requestJSON(req);assert(req.headers['x-panel-update-kind']!=='game'||input.kind==='game','This account can change game images only.',403);return json(res,200,await updater.plan(input));}
      if(req.method==='POST'&&url.pathname==='/update-install')return json(res,202,await updater.install(await requestJSON(req),req.headers['x-panel-user']||'administrator',{gameOnly:req.headers['x-panel-update-kind']==='game'}));
      throw new HttpError(404,'Not found.');
    }
    if(req.method!=='GET'){await updater.refresh();assert(!updater.busy,'An update is in progress. Wait for it to finish.',409);}
    if(req.method==='GET'&&url.pathname==='/status')return json(res,200,{...normalizeStatus(module,await game.status()),managementBusy:updater.busy,imageMigration:migrationPending?{state:migrationError?'attention':'pending',message:migrationError||'Automatic game image migration is pending.'}:null});
    if(req.method==='GET'&&url.pathname==='/capabilities')return json(res,200,publicContract(module));
    if(req.method==='GET'&&url.pathname==='/diagnostics')return json(res,200,await module.diagnostics({docker,container:config.container,version:updater.current,recentStatus:game.recentStatus(),locations:[...game.locations,{id:'backups',title:'Backup storage',path:backupDir},{id:'state',title:'Controller storage',path:state}]}));
    if(req.method==='GET'&&url.pathname==='/backups'){const items=await backups.list();return json(res,200,{backups:items,schedule,retention:retention.status(),health:await backups.health(items)});}
    if(req.method==='GET'&&url.pathname==='/audit')return json(res,200,await audit.list({before:url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined,search:url.searchParams.get('search')||''}));
    if(req.method==='GET'&&url.pathname==='/jobs')return json(res,200,url.searchParams.get('workflows')==='1'?await operationProgressSnapshot(operations,operationFeed):operations.status());
    if(req.method==='GET'&&url.pathname==='/download'&&url.searchParams.get('kind')==='backup'){
      const name=url.searchParams.get('name'),file=await existingFile(backupDir,name),stat=await fs.stat(file);
      assert(name.endsWith(game.backupExtension||'.zip'),'Unsupported backup format.');
      res.writeHead(200,{'content-type':module.contract.backup.mediaType,'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'content-length':stat.size});return pipeline(createReadStream(file),res);
    }
    if(req.method==='POST'&&url.pathname==='/jobs'){
      const body=validateActionRequest(module,await requestJSON(req));assert(Object.hasOwn(actions,body.action),'Unsupported action.');
      if(body.action==='cleanup-backups')assert(body.params?.confirm===true&&typeof body.params.planId==='string','Review and confirm backup cleanup first.');
      await game.validateAction(body);
      return json(res,202,await runJob(body.action,body.params||{},body.actor||'admin',{requestId:body.requestId}));
    }
    if(req.method==='POST'&&url.pathname==='/backup-retention'){
      const body=await requestJSON(req);
      if(body.operation==='preview')return json(res,200,await retention.preview(body.policy));
      assert(body.operation==='save','Choose a cleanup operation.');assert(!active&&!retentionConfiguring,'Wait for the current operation before changing cleanup settings.',409);
      retentionConfiguring=true;
      try{return json(res,200,await retention.configure(body.policy,body));}finally{retentionConfiguring=false;}
    }
    if(req.method==='POST'&&url.pathname==='/schedule'){
      const value=await requestJSON(req);assert(typeof value.enabled==='boolean'&&Number.isInteger(value.hours)&&value.hours>=1&&value.hours<=168&&Number.isInteger(value.keep)&&value.keep>=2&&value.keep<=100,'Invalid backup schedule.');
      game.validateSchedule?.(value);
      await changeSchedule(current=>({...current,enabled:value.enabled,hours:value.hours,keep:value.keep}));return json(res,200,{schedule});
    }
    // A module cannot expose undeclared controller endpoints.
    assert(module.routes.includes(url.pathname),'Not found.',404);
    return game.handle(req,res,url);
  }
  const server=http.createServer((req,res)=>handle(req,res).catch(error=>{if(!res.headersSent)json(res,error.status||500,{error:publicTransportMessage(error)??redact(error.message)});else res.end();}));
  server.requestTimeout=300000;
  // Timers are created only after successful initialization, and closed with the
  // listener so disposable hosts/tests cannot leak a scheduler.
  server.once('close',()=>{for(const timer of timers)clearInterval(timer);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,resolve);});
  console.log(`Internal ${module.name} controller ready.`);
  every(()=>void updater.refresh().catch(error=>console.error('Update state unavailable:',redact(error.message))),1000);
  if(!maintenance.held)await activate();
  every(async()=>{
    if(!migrationPending)return;
    try{
      migrationJournal=await readJSON(migrationFile,null);
      if(migrationJournal?.phase==='complete'){const current=await host.info();assert(current.Image===migrationJournal.imageId&&current.Config.Image===migrationJournal.target,'Completed migration container changed.',409);migrationPending=false;migrationError=null;return;}
      if(migrationLaunching){if(migrationWorker){const worker=await docker('GET','/containers/'+migrationWorker+'/json');assert(worker.State.Running,'Migration worker stopped before completion.',409);}return;}
      if(active||updater.busy)return;
      migrationLaunching=true;
      await game.waitIdle();
      migrationWorker=await launchStandaloneMigration({docker,game:module.id,journal:migrationJournal,names:legacyMigration.names(config,env)});
    }
    catch{migrationError='Automatic image migration needs attention. Data was preserved; inspect the migration worker and installation ownership.';}
  },1000);

  every(async()=>{
    if(migrationPending||operations.blocked||!schedule.enabled||active||updater.busy||await game.maintenancePending?.())return;
    try{
      const elapsed=Date.now()-new Date(schedule.lastRun||Date.now()).getTime();
      if(!schedule.lastRun){await changeSchedule(current=>({...current,lastRun:new Date().toISOString()}));return;}
      if(elapsed<schedule.hours*3600000)return;
      const job=await runJob('backup',{},'scheduled backup');while(['queued','running'].includes(job.state))await sleep(1000);await changeSchedule(current=>({...current,lastRun:new Date().toISOString()}));
    }
    catch(error){console.error('Scheduled backup failed:',redact(error.message));}
  },60000);
  let retentionPolling=false;
  every(async()=>{
    if(migrationPending||operations.blocked||retentionPolling||!retention.due||active||updater.busy||updater.pendingRestore||await game.maintenancePending?.())return;
    retentionPolling=true;
    try{const job=await runJob('cleanup-backups',{},'automatic backup cleanup');while(['queued','running'].includes(job.state))await sleep(1000);}
    catch(error){console.error('Automatic backup cleanup failed:',redact(error.message));}
    finally{retentionPolling=false;}
  },60000);
  return server;
}
