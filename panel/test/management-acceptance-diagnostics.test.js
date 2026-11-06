import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {diagnosticRecords, diagnosticPrefix, failurePrefix, safeFailureReports, validDiagnostic, maxRecords, maxLogBytes, withApplyFailureDiagnostics, instrumentManagementAcceptance} from './management-acceptance-diagnostics.mjs';

const execute = promisify(execFile), source = fileURLToPath(new URL('../', import.meta.url));
const record = {phase:'apply',stage:'final-inspection',method:'GET',operation:'container-inspect',status:409};
test('strict extraction rejects malformed/private fields and bounds every published record', () => {
  const line = value => diagnosticPrefix+JSON.stringify(value)+'\n';
  const privatePayloads = [{...record,route:'/PRIVATE?token=PRIVATE'}, {...record,body:'PRIVATE'}, {...record,status:'409'}, {...record,status:600}, {...record,stage:'PRIVATE'}, {...record,method:'PRIVATE'}, {...record,transport:'socket'}, {...record,operation:'PRIVATE'}];
  const text='PRIVATE daemon text\n'+diagnosticPrefix+'{invalid}\n'+privatePayloads.map(line).join('')+line(record);
  assert.deepEqual(diagnosticRecords(text),[record]);
  assert.equal(diagnosticRecords(line(record).repeat(100)).length,maxRecords);
  assert.deepEqual(diagnosticRecords('PRIVATE'.repeat(maxLogBytes)),[]);
  assert.deepEqual(diagnosticRecords({private:'PRIVATE'}),[]);
  assert.equal(validDiagnostic({...record,status:NaN}),false);
  const report={version:1,complete:false,failed:true,records:[record]};
  assert.deepEqual(safeFailureReports(failurePrefix+JSON.stringify(report)),[report]);
  for(const bad of [{...report,complete:true},{...report,private:'PRIVATE'},{...report,records:[{...record,headers:'PRIVATE'}]},{...report,records:Array(65).fill(record)}])
    assert.deepEqual(safeFailureReports(failurePrefix+JSON.stringify(bad)),[]);
  assert.deepEqual(safeFailureReports('x'.repeat(maxLogBytes+1)),[]);
});

test('collection and emission failures preserve the identical original failure without dumping private errors', async () => {
  const original=Error('original synthetic apply failure'), output=[];
  await assert.rejects(withApplyFailureDiagnostics(async()=>{throw original;},async()=>{throw Object.assign(Error('PRIVATE'),{stdout:'PRIVATE',stderr:'PRIVATE',cause:Error('PRIVATE')});},line=>output.push(line)),error=>error===original);
  assert.deepEqual(safeFailureReports(output[0]),[{version:1,complete:false,failed:true,records:[]}]);
  assert.doesNotMatch(output.join(''),/PRIVATE/);
  await assert.rejects(withApplyFailureDiagnostics(async()=>{throw original;},async()=>diagnosticPrefix+JSON.stringify(record),()=>{throw Error('PRIVATE');}),error=>error===original);
  let collections=0;
  assert.equal(await withApplyFailureDiagnostics(async()=>42,async()=>{collections++;}),42);
  assert.equal(collections,0);
});

test('actual outer runner failure block exits nonzero and emits only validated metadata',async()=>{
  const sourceText=await fs.readFile(path.join(source,'test/management-panel-acceptance.mjs'),'utf8');
  const start=sourceText.indexOf('try {\n  console.log(await docker(common));'),end=sourceText.indexOf('const result = JSON.parse',start);
  assert.ok(start>0&&end>start);
  const report={version:1,complete:false,failed:true,records:[record]};
  const script=`import {safeFailureReports,failurePrefix} from ${JSON.stringify(new URL('./management-acceptance-diagnostics.mjs',import.meta.url).href)};
const common=[];const docker=async()=>{throw Object.assign(Error('PRIVATE daemon error'),{stdout:${JSON.stringify('PRIVATE raw log\n'+failurePrefix+JSON.stringify(report)+'\n')},stderr:'PRIVATE stderr',cmd:'PRIVATE command',cause:Error('PRIVATE cause')});};\n`+sourceText.slice(start,end);
  await assert.rejects(execute(process.execPath,['--input-type=module','-e',script]),error=>{
    assert.equal(error.code,1);
    assert.equal(error.stdout,failurePrefix+JSON.stringify(report)+'\n');
    assert.equal(error.stderr,'Disposable management panel acceptance failed; no retry was attempted.\n');
    return true;
  });
});

async function prepared(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lgb-acceptance-diagnostics-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const context=path.join(root,'context');
  await execute(process.execPath,[path.join(source,'test/prepare-runtime-acceptance.mjs'),'--out',context]);
  const panel=path.join(context,'panel');
  const original=await fs.readFile(path.join(source,'core/docker.js'),'utf8');
  assert.equal(await fs.readFile(path.join(panel,'core/docker.js'),'utf8'),original);
  await instrumentManagementAcceptance(panel);
  assert.equal(await fs.readFile(path.join(source,'core/docker.js'),'utf8'),original);
  const hooks=await import(pathToFileURL(path.join(panel,'test/management-acceptance-diagnostics.mjs')));
  const {docker}=await import(pathToFileURL(path.join(panel,'core/docker.js')));
  return {root,panel,hooks,docker};
}
function fakeHTTP(t, response) {
  const original=http.request;
  http.request=(options,callback)=>{
    const request=new EventEmitter();
    request.setTimeout=()=>request;
    request.destroy=error=>request.emit('error',error);
    request.end=body=>queueMicrotask(()=>{
      try {
        const value=response(options,body?JSON.parse(body):undefined);
        if(value.error) return request.emit('error',value.error);
        const stream=new EventEmitter();stream.statusCode=value.status;
        callback(stream);
        stream.emit('data',Buffer.from(JSON.stringify(value.body??null)));
        stream.emit('end');
      } catch(error) {request.emit('error',error);}
    });
    return request;
  };
  t.after(()=>{http.request=original;});
}
test('instrumentation fails closed on repeated/changed copied boundaries without partial writes',async t=>{
  const f=await prepared(t),dockerFile=path.join(f.panel,'core/docker.js'),panelFile=path.join(f.panel,'core/management-panel.js');
  const before=await Promise.all([fs.readFile(dockerFile,'utf8'),fs.readFile(panelFile,'utf8')]);
  await assert.rejects(instrumentManagementAcceptance(f.panel),/diagnostic source boundary changed/);
  assert.deepEqual(await Promise.all([fs.readFile(dockerFile,'utf8'),fs.readFile(panelFile,'utf8')]),before);
});
test('copied raw HTTP boundary retains 409 versus 502 and 404/success before original mapping',async t=>{
  const f=await prepared(t),lines=[];
  let status=409;
  fakeHTTP(t,()=>({status,body:{message:'PRIVATE daemon body',headers:'PRIVATE'}}));
  for(const original of [409,502,404,200]) {
    status=original;
    await f.hooks.managementApplyDiagnostics('apply',()=>f.hooks.managementDiagnosticStage('initial-inspection',async()=>{
      if(status>=400) await assert.rejects(f.docker('GET','/containers/PRIVATE/json?token=PRIVATE'),error=>error.status===(status===404?404:502));
      else assert.equal((await f.docker('GET','/containers/PRIVATE/json')).message,'PRIVATE daemon body');
    }),line=>lines.push(line));
  }
  assert.deepEqual(diagnosticRecords(lines.join('\n')).map(item=>item.status),[409,502,404,200]);
  assert.doesNotMatch(lines.join(''),/PRIVATE|token|message|headers/);
  const failure=Object.assign(Error('PRIVATE socket failure'),{code:'ECONNRESET'});
  // Exercise the copied request error listener as well as the pure hook.
  http.request=()=>{
    const request=new EventEmitter();request.setTimeout=()=>request;
    request.end=()=>queueMicrotask(()=>request.emit('error',failure));return request;
  };
  const socketLines=[];
  await assert.rejects(f.hooks.managementApplyDiagnostics('apply',()=>f.docker('GET','/info'),line=>socketLines.push(line)),error=>error===failure);
  assert.deepEqual(diagnosticRecords(socketLines.join('\n')),[{phase:'apply',stage:'unknown',method:'GET',operation:'engine-info',transport:'socket'}]);
});

test('fixed stages/categories preserve response order, isolate concurrent work, and bound transport-only failures',async t=>{
  const f=await prepared(t),lines=[];
  await f.hooks.managementApplyDiagnostics('apply',async()=>{
    await f.hooks.managementDiagnosticStage('initial-inspection',async()=>{f.hooks.dockerDiagnostic('GET','/containers/PRIVATE/json').http(200);});
    await f.hooks.managementDiagnosticStage('worker-create',async()=>{f.hooks.dockerDiagnostic('POST','/containers/create?name=PRIVATE').http(201);});
    await f.hooks.managementDiagnosticStage('worker-start',async()=>{f.hooks.dockerDiagnostic('POST','/containers/PRIVATE/start').http(204);});
    await f.hooks.managementDiagnosticStage('final-inspection',async()=>{f.hooks.dockerDiagnostic('GET','/containers/PRIVATE/json').http(409);});
  },line=>lines.push(line));
  assert.deepEqual(diagnosticRecords(lines.join('\n')).map(item=>[item.stage,item.operation,item.status]),[
    ['initial-inspection','container-inspect',200],['worker-create','container-create',201],['worker-start','container-start',204],['final-inspection','container-inspect',409],
  ]);
  const separate=[];
  await Promise.all([
    f.hooks.managementApplyDiagnostics('apply',async()=>{await Promise.resolve();f.hooks.dockerDiagnostic('GET','/info').http(200);},line=>separate.push(line)),
    f.hooks.managementApplyDiagnostics('status',async()=>{await Promise.resolve();f.hooks.dockerDiagnostic('GET','/PRIVATE').http(502);}),
  ]);
  assert.equal(separate.length,1);
  const transports=[];
  await f.hooks.managementApplyDiagnostics('apply',async()=>{
    f.hooks.dockerDiagnostic('GET','/info').transport(Object.assign(Error('PRIVATE'),{code:'ENOENT'}));
    f.hooks.dockerDiagnostic('GET','/info').transport(Error('Docker operation timed out.'));
    f.hooks.dockerDiagnostic('GET','/info').transport(Error('PRIVATE'));
    const received=f.hooks.dockerDiagnostic('GET','/info');received.http(502);received.transport(Error('PRIVATE'));
    for(let n=0;n<100;n++)f.hooks.dockerDiagnostic('GET','/info').http(200);
  },line=>transports.push(line));
  const values=diagnosticRecords(transports.join('\n'));
  assert.equal(transports.length,maxRecords);
  assert.deepEqual(values.slice(0,4).map(item=>item.transport??item.status),['socket','timeout','other',502]);
  assert.doesNotMatch(transports.join(''),/PRIVATE/);
});

test('copied panel apply identifies post-launch inspection failure without replay',async t=>{
  const f=await prepared(t),{ManagementPanel}=await import(pathToFileURL(path.join(f.panel,'core/management-panel.js'))),lines=[];
  const fleet='a'.repeat(32),image='sha256:'+'b'.repeat(64),project='lobby-goblin-fleet-'+fleet;
  const containers=new Map(),volumes=new Map();let starts=0,finalFault=false;
  const host='lobby-goblin-host-'+fleet;
  containers.set(host,{Id:host,Image:image,Config:{Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.role':'host-controller','com.docker.compose.project':project,'com.docker.compose.project.working_dir':'/synthetic/PRIVATE'}},Mounts:[{Type:'bind',Source:'/synthetic/PRIVATE.sock',Destination:'/var/run/docker.sock'},{Type:'volume',Name:project+'-state',Destination:'/fleet'}]});
  fakeHTTP(t,(options,data)=>{
    const url=new URL(options.path,'http://fixture');
    if(url.pathname==='/info')return {status:200,body:{ID:'fixture-engine',OSType:'linux'}};
    if(url.pathname==='/volumes/create'){const value={...data,Options:{}};volumes.set(data.Name,value);return {status:201,body:value};}
    if(url.pathname.startsWith('/volumes/'))return {status:volumes.has(url.pathname.slice(9))?200:404,body:volumes.get(url.pathname.slice(9))};
    if(url.pathname==='/containers/create'){
      const name=url.searchParams.get('name'),value={Id:crypto.createHash('sha256').update(name).digest('hex'),Name:'/'+name,Image:data.Image,Config:{...data,HostConfig:undefined},HostConfig:data.HostConfig,State:{Running:false,Status:'created',StartedAt:'0001-01-01T00:00:00Z'}};
      containers.set(name,value);containers.set(value.Id,value);return {status:201,body:{Id:value.Id}};
    }
    const [, ,name,action]=url.pathname.split('/'),value=containers.get(name);
    if(!value)return {status:404,body:{message:'PRIVATE missing'}};
    if(options.method==='DELETE'){containers.delete(name);containers.delete(value.Name.slice(1));return {status:404,body:{message:'PRIVATE already absent'}};}
    if(action==='start'){value.State.Running=true;starts++;return {status:204};}
    assert.equal(action,'json');
    if(finalFault&&value.State?.Running&&name!==host)return {status:409,body:{message:'PRIVATE final inspect conflict'}};
    return {status:200,body:value};
  });
  const panel=new ManagementPanel({root:path.join(f.root,'state'),fleet,docker:f.docker,runtimeImage:image,profile:'legacy'});await panel.init();
  await panel.handle({action:'plan',version:'99.0.0-alpha',requestId:'c'.repeat(32)});
  const current=await panel.current();containers.get(current.worker.Id).State.Running=false;
  await fs.writeFile(path.join(panel.root,current.job.attempt,'result.json'),JSON.stringify({state:'reviewed',message:'Synthetic review',plan:{id:current.job.id,commit:false}}));
  const apply={action:'apply',id:current.job.id,confirm:true,requestId:'d'.repeat(32)};
  // Capture console only for the instrumented copied helper's fixed output.
  const log=console.log;console.log=line=>lines.push(line);t.after(()=>{console.log=log;});
  finalFault=true;
  await assert.rejects(panel.handle(apply),error=>error.status===502);
  const values=diagnosticRecords(lines.join('\n'));
  assert.equal(values[0].stage,'initial-inspection');
  assert.ok(values.find(item=>item.stage==='retained-worker-delete'&&item.status===404),'already-absent delete is observed and still allows the existing apply path');
  assert.equal(values.at(-1).stage,'final-inspection');assert.equal(values.at(-1).status,409);
  assert.ok(values.find(item=>item.stage==='worker-start'&&item.status===204));
  assert.equal(starts,2,'one plan and one apply launch; no failure-triggered replay');
  assert.doesNotMatch(lines.join(''),/PRIVATE/);
  finalFault=false;
  await panel.handle(apply);
  assert.equal(starts,2,'same request is read back, not replayed');
});
