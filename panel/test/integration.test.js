import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeZip,zipEntries} from '../core/archive.js';
import {hashPassword} from '../auth.js';
import {PLAYER_QUERY} from '../applications/factorio/live-players.js';
import {settingsTar,waitForIdleJob} from './fixtures.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('authenticated panel and controller manage isolated worlds, backups, and failed switch recovery',{timeout:30000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factorio-panel-test-')),data=path.join(root,'data'),backups=path.join(root,'backups'),state=path.join(root,'state'),auth=path.join(root,'auth');
  for(const dir of [path.join(data,'saves'),path.join(data,'config'),path.join(data,'mods'),path.join(backups,'panel-worlds'),state,auth])await fs.mkdir(dir,{recursive:true});
  const save=makeZip([{name:'world/level.dat0',data:Buffer.from('test map data')}]);
  await fs.writeFile(path.join(data,'saves/Original.zip'),save);await fs.writeFile(path.join(backups,'panel-worlds/Next.zip'),save);await fs.writeFile(path.join(backups,'panel-worlds/Broken.zip'),save);
  const settings={name:'Test factory',description:'',max_players:0,auto_pause:true,autosave_interval:5,autosave_slots:10,require_user_verification:false,visibility:{public:false,lan:true}};
  await fs.writeFile(path.join(data,'config/server-settings.json'),JSON.stringify(settings));await fs.writeFile(path.join(data,'mods/mod-list.json'),'{}');
  const log=path.join(data,'factorio-current.log');await fs.writeFile(log,'0.000 Loading map /factorio/saves/Original.zip: 100 bytes.\n');
  await fs.writeFile(path.join(auth,'users.json'),JSON.stringify({admin:{...hashPassword('test-admin-password'),role:'admin'},viewer:{...hashPassword('test-viewer-password'),role:'viewer'}}));
  const tokenFile=path.join(root,'controller-token');await fs.writeFile(tokenFile,'test-controller-token');
  let running=true,current='Original.zip';const executions=new Map(),execTargets=new Map(),helpers=new Map();let generatedConfiguration=null,previewHelper=null,activeScripts=0,engineMutations=0;
  let startedAt=new Date(Date.now()-20000).toISOString();const gameQueries=[];
  const worldDefaults=JSON.parse(await fs.readFile(path.join(project,'world-defaults.json'),'utf8'));
  const socket=process.platform==='win32'?`\\\\.\\pipe\\factorio-panel-test-${crypto.randomUUID()}`:path.join(root,'docker.sock');
  const engine=http.createServer(async(req,res)=>{
    if(req.method!=='GET')engineMutations++;
    let body='';for await(const chunk of req)body+=chunk;
    const value=body?JSON.parse(body):{},url=new URL(req.url,'http://docker');const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(data===undefined?'':JSON.stringify(data));};
    if(url.pathname==='/containers/json')return reply(200,[]);
    if(url.pathname==='/containers/factorio-server/archive'){res.writeHead(200,{'content-type':'application/x-tar'});return res.end(settingsTar(worldDefaults.map_settings));}
    if(url.pathname==='/containers/factorio-panel-controller/json')return reply(200,{Mounts:[{Type:'bind',Source:state,Destination:state}]});
    if(url.pathname==='/containers/factorio-server/json')return reply(200,{Image:'sha256:installed-game',State:{Running:running,Status:running?'running':'exited',StartedAt:startedAt},Config:{Image:'factoriotools/factorio:2.0.77'},Mounts:[{Type:'bind',Source:data,Destination:'/factorio'}]});
    if(url.pathname.endsWith('/stats'))return reply(200,{cpu_stats:{cpu_usage:{total_usage:20},system_cpu_usage:100,online_cpus:2},precpu_stats:{cpu_usage:{total_usage:10},system_cpu_usage:50},memory_stats:{usage:123456}});
    if(url.pathname==='/containers/create'){assert.equal(url.searchParams.get('platform'),'linux/amd64');assert.equal(value.Image,'sha256:installed-game');if(value.Labels?.['factorio-panel.preview']==='true')previewHelper=value;helpers.set(url.searchParams.get('name'),value);return reply(201,{Id:url.searchParams.get('name')});}
    const helperName=url.pathname.split('/')[2],helper=helpers.get(helperName);
    if(helper&&url.pathname.endsWith('/start')){const work=helper.HostConfig.Mounts[0].Source;if(helper.Cmd?.includes('--create')){generatedConfiguration={map_gen_settings:JSON.parse(await fs.readFile(path.join(work,'config/new-map-gen-settings.json'),'utf8')),map_settings:JSON.parse(await fs.readFile(path.join(work,'config/new-map-settings.json'),'utf8'))};await fs.writeFile(path.join(work,'saves/generated.zip'),save);}else if(helper.Cmd?.includes('--generate-map-preview'))await fs.writeFile(path.join(work,'preview.png'),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(24)]));return reply(204);}
    if(helper&&url.pathname.endsWith('/wait'))return reply(200,{StatusCode:0});
    if(helper&&url.pathname.endsWith('/stop'))return reply(204);
    if(helper&&req.method==='DELETE'){helpers.delete(helperName);return reply(204);}
    if(/^\/containers\/[^/]+\/exec$/.test(url.pathname)){const id=crypto.randomUUID();executions.set(id,value.Cmd[1]);execTargets.set(id,helperName);return reply(201,{Id:id});}
    if(/^\/exec\/[^/]+\/start$/.test(url.pathname)){
      const execId=url.pathname.split('/')[2],command=executions.get(execId),target=execTargets.get(execId);let output='';
      if(target==='factorio-server')gameQueries.push(command);
      if(command?.startsWith('/silent-command')&&target==='factorio-server')activeScripts++;
      if(command?.includes('export-settings.json')&&helpers.has(target)){const work=helpers.get(target).HostConfig.Mounts[0].Source;await fs.mkdir(path.join(work,'script-output'),{recursive:true});await fs.writeFile(path.join(work,'script-output/export-settings.json'),JSON.stringify(worldDefaults));}
      if(command==='/version'&&(!running||current==='Broken.zip'))output='unavailable';
      else if(command==='/version')output='Version: 2.0.77';
      else if(command==='/players online')output='Online players (1):\n  TestEngineer (online)\n';
      else if(command==='/time')output='1 hour';else if(command==='/seed')output='12345';
      else if(command===PLAYER_QUERY)output='PANEL_LIVE_PLAYERS:'+JSON.stringify({seed:12345,tick:123,players:[{name:'TestEngineer',x:10,y:-5,surface:'nauvis',color:[1,.5,.1]}]});
      else if(command==='/server-save'){await fs.appendFile(log,'10.000 Info AppManagerStates.cpp:1: Saving finished\n');output='Saving the map';}
      const data=Buffer.from(output),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(data.length,4);res.writeHead(200,{'content-type':'application/vnd.docker.raw-stream'});return res.end(Buffer.concat([header,data]));
    }
    if(/^\/exec\/[^/]+\/json$/.test(url.pathname))return reply(200,{ExitCode:0});
    if(url.pathname.endsWith('/stop')){running=false;return reply(204);}
    if(url.pathname.endsWith('/start')||url.pathname.endsWith('/restart')){
      running=true;startedAt=new Date().toISOString();const entries=(await fs.readdir(path.join(data,'saves'))).filter(name=>name.endsWith('.zip'));current=entries.find(name=>!name.startsWith('_'))||entries[0];await fs.writeFile(log,`0.000 Loading map /factorio/saves/${current}: 100 bytes.\n`);return reply(204);
    }
    return reply(404,{message:'Unexpected mock Docker request '+url.pathname});
  });
  await new Promise(resolve=>engine.listen(socket,resolve));
  const controllerPort=await freePort(),panelPort=await freePort();
  const shared={...process.env,CONTROLLER_TOKEN_FILE:tokenFile,RELEASE_CHECKS:'false',UPDATE_STATE_DIR:path.join(root,'updates')};
  const controller=spawn(process.execPath,['server.js'],{cwd:project,env:{...shared,MODE:'controller',PORT:String(controllerPort),DOCKER_SOCKET:socket,FACTORIO_DATA:data,BACKUPS_DIR:backups,STATE_DIR:state,FACTORIO_READY_TIMEOUT_MS:'1200'},stdio:'pipe'});
  const panel=spawn(process.execPath,['server.js'],{cwd:project,env:{...shared,MODE:'panel',PORT:String(panelPort),AUTH_DIR:auth,CONTROLLER_URL:`http://127.0.0.1:${controllerPort}`,PANEL_HOSTS:'127.0.0.1'},stdio:'pipe'});
  let errors='';controller.stderr.on('data',chunk=>errors+=chunk);panel.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{controller.kill();panel.kill();await Promise.all([new Promise(resolve=>controller.once('close',resolve)),new Promise(resolve=>panel.once('close',resolve))]);await new Promise(resolve=>engine.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${panelPort}`;
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)break;}catch{}if(i===99)throw new Error('Panel startup failed: '+errors);await delay(30);}
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${controllerPort}/health`)).ok)break;}catch{}if(i===99)throw new Error('Controller startup failed: '+errors);await delay(30);}
  async function login(username,password){const result=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(result.status,200);const data=await result.json();return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:data.csrf};}
  const admin=await login('admin','test-admin-password'),viewer=await login('viewer','test-viewer-password');
  async function request(route,{method='GET',body,user=admin,csrf=true}={}){return fetch(origin+'/api'+route,{method,headers:{origin,cookie:user.cookie,...(csrf?{'x-csrf-token':user.csrf}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
  async function action(name,params={}){
    const response=await request('/jobs',{method:'POST',body:{action:name,params}});
    assert.equal(response.status,202,await response.clone().text());
    const job=await response.json();
    return waitForIdleJob(async()=>{
      const result=await request('/jobs');assert.equal(result.status,200,await result.clone().text());return result.json();
    },job.id);
  }
  await t.test('unauthenticated access, cross-site requests, and viewer mutations are rejected',async()=>{
    assert.equal((await fetch(origin+'/api/status')).status,401);
    assert.equal((await request('/jobs',{method:'POST',body:{action:'save'},csrf:false})).status,403);
    assert.equal((await request('/jobs',{method:'POST',body:{action:'save'},user:viewer})).status,403);
    assert.equal((await fetch(origin+'/api/jobs',{method:'POST',headers:{origin:'https://other.example',cookie:admin.cookie,'x-csrf-token':admin.csrf},body:'{}'})).status,403);
    assert.equal((await request('/jobs',{method:'POST',body:{action:'switch',params:{}}})).status,400);
  });
  await t.test('dashboard reports real controller data',async()=>{const result=await request('/status');assert.equal(result.status,200);const value=await result.json();assert.deepEqual(value.players,['TestEngineer']);assert.equal(value.currentWorld,'Original.zip');assert.equal(value.seed,'12345');});
  await t.test('fresh dashboard samples retain live player/time checks and reuse stable metadata',async()=>{
    await delay(3100);let before=gameQueries.length;
    assert.equal((await (await request('/status')).json()).ready,true);
    assert.deepEqual(gameQueries.slice(before),['/players online','/time']);
    startedAt=new Date().toISOString();await delay(3100);before=gameQueries.length;
    assert.equal((await (await request('/status')).json()).ready,true);
    assert.deepEqual(gameQueries.slice(before),['/players online','/time','/seed','/version']);
  });
  await t.test('diagnostics and saved setups require admin, isolate accounts, and enforce CSRF and revisions',async()=>{
    for(const route of ['/diagnostics','/world-setups']){
      assert.equal((await fetch(origin+'/api'+route)).status,401);
      assert.equal((await request(route,{user:viewer})).status,403);
    }
    const report=await (await request('/diagnostics')).json();assert.equal(report.checks.find(c=>c.id==='panel').state,'pass');assert.equal(report.checks.find(c=>c.id==='controller').state,'pass');assert.ok(!JSON.stringify(report).includes(root));
    const initial=await (await request('/world-setups')).json();assert.equal(initial.revision,0);
    const body={operation:'save-preset',revision:0,name:'A quiet evening',configuration:worldDefaults,image:'fixture:2.0.77'};
    assert.equal((await request('/world-setups',{method:'POST',body,csrf:false})).status,403);
    assert.equal((await request('/world-setups',{method:'POST',body,user:viewer})).status,403);
    const saved=await request('/world-setups',{method:'POST',body});assert.equal(saved.status,200);assert.equal((await saved.json()).presets[0].name,body.name);
    assert.equal((await request('/world-setups',{method:'POST',body})).status,409);
    const secondSession=await login('admin','test-admin-password');assert.equal((await (await request('/world-setups',{user:secondSession})).json()).presets.length,1);
  });
  await t.test('backup cleanup enforces review, age window, authorization and persistence without game commands',async()=>{
    const initial=await (await request('/backups')).json();assert.equal(initial.retention.policy.enabled,false);
    const policy={enabled:false,days:30,includeManual:false,includeSafety:false},body={operation:'preview',policy};
    assert.equal((await fetch(origin+'/api/backup-retention',{method:'POST',headers:{origin},body:JSON.stringify(body)})).status,401);
    assert.equal((await request('/backup-retention',{method:'POST',body,user:viewer})).status,403);
    assert.equal((await request('/backup-retention',{method:'POST',body,csrf:false})).status,403);
    assert.equal((await request('/backup-retention',{method:'POST',body:{...body,policy:{...policy,days:0}}})).status,400);
    assert.equal((await request('/jobs',{method:'POST',body:{action:'cleanup-backups',params:{planId:'invented'}}})).status,400);
    const directory=path.join(backups,'panel-backups'),names=Array.from({length:5},(_,i)=>`fixture-${i}-scheduled.zip`),before=engineMutations,original=await fs.readFile(path.join(data,'saves/Original.zip'));
    try{
      for(const [i,name] of names.entries()){await fs.writeFile(path.join(directory,name),'synthetic backup');const old=new Date(Date.now()-(40+i)*86400000);await fs.utimes(path.join(directory,name),old,old);}
      const plan=await (await request('/backup-retention',{method:'POST',body})).json();assert.equal(plan.candidates.length,3);
      assert.equal((await request('/jobs',{method:'POST',body:{action:'cleanup-backups',params:{planId:plan.id,confirm:true}},user:viewer})).status,403);
      const enabled={...policy,enabled:true};assert.equal((await request('/backup-retention',{method:'POST',body:{operation:'save',policy:enabled,revision:0}})).status,400);
      const enabledPlan=await (await request('/backup-retention',{method:'POST',body:{...body,policy:enabled}})).json();
      const configured=await request('/backup-retention',{method:'POST',body:{operation:'save',policy:enabled,revision:0,planId:enabledPlan.id,confirm:true}});assert.equal(configured.status,200);
      assert.equal((await fs.readdir(directory)).length,5,'saving policy does not clean up inline');
      assert.equal((await request('/backup-retention',{method:'POST',body:{operation:'save',policy,revision:0}})).status,409);
      await request('/backup-retention',{method:'POST',body:{operation:'save',policy,revision:1}});
      const stored=JSON.parse(await fs.readFile(path.join(state,'backup-retention.json'),'utf8'));assert.equal(stored.policy.enabled,false);assert.equal(stored.revision,2);
      const stale=await action('cleanup-backups',{planId:plan.id,confirm:true});assert.equal(stale.state,'failed');assert.match(stale.message,/expired/);
      const fresh=await (await request('/backup-retention',{method:'POST',body})).json();
      const cleanup=await action('cleanup-backups',{planId:fresh.id,confirm:true});assert.equal(cleanup.state,'succeeded',cleanup.message);assert.match(cleanup.message,/Deleted 3/);assert.equal(cleanup.result.deleted.length,3);
      assert.deepEqual((await fs.readdir(directory)).sort(),names.slice(0,2));assert.equal(engineMutations,before);assert.equal(running,true);assert.equal(current,'Original.zip');assert.deepEqual(await fs.readFile(path.join(data,'saves/Original.zip')),original);
    }finally{for(const name of names)await fs.rm(path.join(directory,name),{force:true});}
  });
  await t.test('onboarding requires admin, CSRF and real readiness before completion',async()=>{
    assert.equal((await fetch(origin+'/api/onboarding')).status,401);
    assert.equal((await request('/onboarding',{user:viewer})).status,403);
    assert.equal((await request('/onboarding',{method:'POST',body:{complete:true},csrf:false})).status,403);
    assert.equal((await request('/onboarding',{method:'POST',body:{complete:false}})).status,400);
    assert.equal((await request('/onboarding',{method:'POST',body:{complete:true}})).status,409);
    assert.equal((await (await request('/onboarding')).json()).completed,true,'legacy admin is not automatically onboarded');
    for(const asset of ['/icons.js','/onboarding.js','/backup-retention.js']){const result=await fetch(origin+asset);assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/javascript/);}
  });
  await t.test('release metadata requires administrator access and cannot install updates',async()=>{
    assert.equal((await fetch(origin+'/api/updates')).status,401);
    assert.equal((await request('/updates',{user:viewer})).status,403);
    const result=await request('/updates');assert.equal(result.status,200);
    const value=await result.json();assert.equal(value.state,'disabled');assert.equal(value.installation,'manual');
    assert.equal((await request('/updates',{method:'POST',body:{install:true}})).status,404);
    assert.equal((await fetch(origin+'/api/updates/check',{method:'POST',headers:{origin}})).status,401);
    assert.equal((await request('/updates/check',{method:'POST',body:{},user:viewer})).status,403);
    assert.equal((await request('/updates/check',{method:'POST',body:{},csrf:false})).status,403);
    assert.equal((await request('/updates/check')).status,404);
    const checked=await request('/updates/check',{method:'POST',body:{}});assert.equal(checked.status,200);assert.equal((await checked.json()).state,'disabled');
  });
  await t.test('update review, installation and history require an administrator and CSRF verification',async()=>{
    for(const route of ['/update-status','/update-plan','/update-install'])assert.equal((await request(route,{user:viewer})).status,403);
    assert.equal((await fetch(origin+'/api/update-status')).status,401);
    assert.equal((await request('/update-install',{method:'POST',body:{confirm:true},csrf:false})).status,403);
    assert.equal((await request('/update-install',{method:'POST',body:{confirm:false}})).status,400);
    const history=await (await request('/update-status')).json();assert.equal(history.busy,false);assert.deepEqual(history.jobs,[]);
  });
  await t.test('draft previews are authenticated, bounded, reusable images without world creation or active-game commands',async()=>{
    assert.equal((await fetch(origin+'/api/world-preview')).status,401);
    assert.equal((await request('/world-preview',{user:viewer})).status,403);
    const body={configuration:structuredClone(worldDefaults),seed:123456};
    assert.equal((await request('/world-preview',{method:'POST',body,user:viewer})).status,403);
    assert.equal((await request('/world-preview',{method:'POST',body,csrf:false})).status,403);
    assert.equal((await request('/world-preview',{method:'POST',body:{...body,seed:0}})).status,400);
    const scripts=activeScripts,files=await fs.readdir(path.join(backups,'panel-worlds')),savesBefore=await fs.readdir(path.join(data,'saves'));
    const response=await request('/world-preview',{method:'POST',body});assert.equal(response.status,202);const first=await response.json();
    let preview;for(let i=0;i<100;i++){preview=await (await request('/world-preview')).json();if(preview.state==='ready'||preview.state==='error')break;await delay(20);}assert.equal(preview.state,'ready',preview.error);
    const image=await request('/world-preview-image?id='+first.id);assert.equal(image.status,200);assert.match(image.headers.get('content-type'),/image\/png/);assert.ok((await image.arrayBuffer()).byteLength>=24);
    assert.equal((await request('/world-preview-image?id=not-current')).status,404);
    assert.ok(previewHelper);assert.equal(previewHelper.Cmd[previewHelper.Cmd.indexOf('--threads')+1],'1');assert.equal(previewHelper.Cmd[previewHelper.Cmd.indexOf('--map-preview-size')+1],'1024');
    assert.equal(previewHelper.HostConfig.NanoCpus,1000000000);assert.equal(previewHelper.HostConfig.Memory,1073741824);assert.equal(previewHelper.HostConfig.NetworkMode,'none');
    const repeat=await (await request('/world-preview',{method:'POST',body})).json();assert.equal(repeat.id,first.id);assert.equal(repeat.state,'ready');
    assert.equal(activeScripts,scripts);assert.equal(current,'Original.zip');assert.deepEqual(await fs.readdir(path.join(backups,'panel-worlds')),files);assert.deepEqual(await fs.readdir(path.join(data,'saves')),savesBefore);assert.equal(helpers.size,0);
  });
  await t.test('custom world creation passes exact chosen settings and seed without scripting or switching the active world',async()=>{
    const editor=await fetch(origin+'/world-editor.js');assert.equal(editor.status,200);assert.match(editor.headers.get('content-type'),/javascript/);
    assert.equal((await fetch(origin+'/world-fields.js')).status,200);
    const defaultsResult=await (await request('/world-options')).json();assert.equal(defaultsResult.defaults.map_gen_settings.width,0);
    assert.equal((await request('/world-options',{user:viewer})).status,403);
    assert.equal((await request('/jobs',{method:'POST',body:{action:'create',params:{configuration:{map_gen_settings:{width:-1},map_settings:{}}}}})).status,400);
    const configuration=structuredClone(defaultsResult.defaults);configuration.map_gen_settings.autoplace_controls['iron-ore']={frequency:2,size:3,richness:6};configuration.map_gen_settings.peaceful_mode=true;configuration.map_gen_settings.width=1000;configuration.map_gen_settings.height=500;configuration.map_settings.pollution.enabled=false;configuration.map_settings.difficulty_settings.technology_price_multiplier=2;
    const invalid=structuredClone(configuration);invalid.map_gen_settings.autoplace_controls['iron-ore'].richness=7;
    assert.equal((await request('/jobs',{method:'POST',body:{action:'create',params:{configuration:invalid}}})).status,400);
    const scriptsBefore=activeScripts;
    const created=await action('create',{name:'Custom',seed:'987654',configuration,preview:true,activate:false});assert.equal(created.state,'succeeded',created.message);
    assert.equal(generatedConfiguration.map_gen_settings.seed,987654);delete generatedConfiguration.map_gen_settings.seed;const expected=structuredClone(configuration);delete expected.map_gen_settings.seed;assert.deepEqual(generatedConfiguration,expected);
    assert.equal(activeScripts,scriptsBefore);assert.equal(current,'Original.zip');assert.equal(running,true);assert.ok((await fs.stat(path.join(backups,'panel-worlds/Custom.zip'))).size);assert.equal((await (await request('/worlds')).json()).worlds.find(w=>w.name==='Custom').hasPreview,true);assert.equal(helpers.size,0);
    const prepared=await action('world-options');assert.equal(prepared.state,'succeeded',prepared.message);const copied=await (await request('/world-options')).json();assert.equal(copied.copied.sourceWorld,'Original.zip');assert.deepEqual(copied.copied.configuration,worldDefaults);assert.equal(activeScripts,scriptsBefore);assert.equal(current,'Original.zip');
  });
  await t.test('live positions are disabled until an administrator acknowledges the achievement impact',async()=>{
    assert.equal((await fetch(origin+'/api/live-players')).status,401);
    assert.equal((await (await request('/live-players',{user:viewer})).json()).state,'disabled');
    const body={action:'live-tracking',params:{enabled:true,world:'Original.zip',seed:12345}};
    assert.equal((await request('/jobs',{method:'POST',body,user:viewer})).status,403);
    assert.equal((await request('/jobs',{method:'POST',body})).status,400);
    const enabled=await action('live-tracking',{...body.params,confirm:true});assert.equal(enabled.state,'succeeded',enabled.message);
    const positions=await (await request('/live-players',{user:viewer})).json();assert.equal(positions.state,'live');assert.equal(positions.players[0].x,10);assert.equal(positions.players[0].name,'TestEngineer');
    const list=await (await request('/backups')).json();assert.ok(list.backups.some(item=>item.relative.endsWith('-before-live-player-tracking.zip')));
    assert.equal((await action('live-tracking',{enabled:false})).state,'succeeded');assert.equal((await (await request('/live-players')).json()).state,'disabled');
  });
  await t.test('browser registration is invitation-only, same-origin, persistent, and role constrained',async()=>{
    assert.equal((await request('/accounts',{user:viewer})).status,403);
    assert.equal((await request('/invitations',{method:'POST',body:{role:'admin'},user:viewer})).status,403);
    assert.equal((await request('/invitations',{method:'POST',body:{role:'admin'},csrf:false})).status,403);
    const invitation=await (await request('/invitations',{method:'POST',body:{role:'viewer'}})).json();
    const body={token:invitation.token,username:'NewEngineer',password:'my new long password',role:'admin'};
    const register=(value,source=origin)=>fetch(origin+'/api/register',{method:'POST',headers:{origin:source,'content-type':'application/json'},body:JSON.stringify(value)});
    assert.equal((await register(body,'https://other.example')).status,403);
    assert.equal((await register({...body,token:'invalid'})).status,400);
    const registered=await register(body);assert.equal(registered.status,200);assert.equal((await registered.json()).role,'viewer');
    assert.match(registered.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await register({...body,username:'AnotherEngineer'})).status,400);
    const newUser=await login('NewEngineer',body.password);assert.equal((await request('/jobs',{method:'POST',body:{action:'save'},user:newUser})).status,403);
    const other=await (await request('/invitations',{method:'POST',body:{role:'admin'}})).json();
    const list=await (await request('/accounts')).json();assert.equal(list.users.some(item=>item.hash),false);
    await request('/invitations',{method:'POST',body:{revoke:list.invitations[0].id}});
    assert.equal((await register({...body,token:other.token,username:'Revoked'})).status,400);
  });
  await t.test('saving confirms completion and backup ZIP contains saves and settings',async()=>{
    assert.equal((await action('save')).state,'succeeded');assert.equal((await action('backup')).state,'succeeded');
    const list=await (await request('/backups')).json();assert.equal(list.backups.length,2);const result=await request('/download?kind=backup&name='+encodeURIComponent(list.backups[0].relative));assert.equal(result.status,200);
    const entries=zipEntries(Buffer.from(await result.arrayBuffer()));assert.ok(entries.some(entry=>entry.name==='saves/Original.zip'));assert.ok(entries.some(entry=>entry.name==='config/server-settings.json'));for(const entry of entries)entry.read();
    assert.equal(list.backups[0].validation.ok,true);assert.equal(list.health.verifiedCount,2);assert.equal((await action('verify-backup',{name:list.backups[0].relative})).state,'succeeded');
  });
  await t.test('completed onboarding persists into later authenticated sessions',async()=>{
    const result=await request('/onboarding',{method:'POST',body:{complete:true}});assert.equal(result.status,200,await result.clone().text());
    const fresh=await login('admin','test-admin-password');const value=await (await request('/session',{user:fresh})).json();assert.equal(value.onboarding.completed,true);assert.ok(value.onboarding.completedAt);
  });
  await t.test('saved map and shared pins enforce explored bounds and read-only permissions',async()=>{
    assert.equal((await (await request('/map')).json()).snapshot,null);
    await fs.writeFile(path.join(state,'map.json'),JSON.stringify({world:'Original.zip',seed:123,chunks:[{x:0,y:0,tiles:[1,256]}]}));
    assert.equal((await request('/pins',{method:'POST',body:{label:'Mine',x:5,y:6},user:viewer})).status,403);
    assert.equal((await request('/pins',{method:'POST',body:{label:'Hidden',x:1000,y:1000}})).status,400);
    assert.equal((await request('/pins',{method:'POST',body:{label:'Mine',x:5,y:6}})).status,200);
    const map=await (await request('/map',{user:viewer})).json();assert.equal(map.pins.length,1);assert.equal(map.staleWorld,false);
    await request('/pins',{method:'POST',body:{remove:map.pins[0].id}});assert.equal((await (await request('/map')).json()).pins.length,0);
  });
  await t.test('map refresh preferences require administrator permissions and CSRF and persist without game commands',async()=>{
    const before=gameQueries.length,body={enabled:false,intervalMinutes:15};
    assert.equal((await fetch(origin+'/api/map-settings',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
    assert.equal((await request('/map-settings',{method:'POST',body,user:viewer})).status,403);
    assert.equal((await request('/map-settings',{method:'POST',body,csrf:false})).status,403);
    assert.equal((await request('/map-settings',{method:'POST',body:{...body,intervalMinutes:1441}})).status,400);
    const response=await request('/map-settings',{method:'POST',body});assert.equal(response.status,200);assert.equal((await response.json()).enabled,false);
    const saved=JSON.parse(await fs.readFile(path.join(state,'map-refresh.json'),'utf8'));assert.equal(saved.enabled,false);assert.equal(saved.intervalMinutes,15);
    assert.equal((await (await request('/map-status')).json()).automatic.intervalMinutes,15);
    const file=path.join(state,'map-refresh.json');await fs.rm(file);await fs.mkdir(file);
    assert.equal((await request('/map-settings',{method:'POST',body:{enabled:true,intervalMinutes:5}})).status,500);
    const retained=(await (await request('/map-status')).json()).automatic;assert.equal(retained.enabled,false);assert.equal(retained.intervalMinutes,15,'A failed durable write must not change active preferences.');
    await fs.rm(file,{recursive:true});assert.equal((await request('/map-settings',{method:'POST',body})).status,200);
    assert.equal(gameQueries.length,before,'Changing map cadence must not save, restart or script the game.');
  });
  await t.test('password changes, session revocation, roles and account removal take effect immediately',async()=>{
    const first=await login('NewEngineer','my new long password'),second=await login('NewEngineer','my new long password');
    const list=await (await request('/sessions',{user:first})).json();assert.equal(list.sessions.some(item=>item.id===second.cookie.split('=')[1]),false);
    await request('/sessions',{method:'POST',body:{others:true},user:first});assert.equal((await request('/session',{user:second})).status,401);
    assert.equal((await request('/password',{method:'POST',body:{currentPassword:'wrong',password:'replacement long password'},user:first})).status,403);
    const changed=await request('/password',{method:'POST',body:{currentPassword:'my new long password',password:'replacement long password'},user:first});assert.equal(changed.status,200);
    assert.equal((await request('/session',{user:first})).status,401);
    const updated=await login('NewEngineer','replacement long password');
    assert.equal((await request('/accounts',{method:'POST',body:{username:'admin',operation:'role',role:'viewer',confirm:true}})).status,409);
    assert.equal((await request('/accounts',{method:'POST',body:{username:'NewEngineer',operation:'role',role:'admin',confirm:true}})).status,200);
    assert.equal((await request('/session',{user:updated})).status,401);
    const promoted=await login('NewEngineer','replacement long password');assert.equal((await request('/accounts',{user:promoted})).status,200);
    assert.equal((await request('/accounts',{method:'POST',body:{username:'NewEngineer',operation:'delete',confirm:true}})).status,200);
    assert.equal((await request('/session',{user:promoted})).status,401);
  });
  await t.test('world switch archives the old save and loads the selected world',async()=>{
    assert.equal((await action('live-tracking',{enabled:true,confirm:true,world:'Original.zip',seed:12345})).state,'succeeded');
    const id=Buffer.from('archive:panel-worlds/Next.zip').toString('base64url');const result=await action('switch',{id,confirm:true});assert.equal(result.state,'succeeded',result.message);assert.deepEqual(await fs.readdir(path.join(data,'saves')),['Next.zip']);assert.ok((await fs.readdir(path.join(backups,'panel-worlds'))).some(name=>name.startsWith('before-switch')));
    assert.equal((await (await request('/live-players')).json()).state,'disabled');
  });
  await t.test('a failed world load recovers the previous working save',async()=>{
    const id=Buffer.from('archive:panel-worlds/Broken.zip').toString('base64url');const result=await action('switch',{id,confirm:true});assert.equal(result.state,'failed');assert.match(result.message,/previous saves were restored/);assert.deepEqual(await fs.readdir(path.join(data,'saves')),['Next.zip']);assert.equal(running,true);
  });
  await t.test('full backup restore recovers saves and settings together',async()=>{
    assert.equal((await action('live-tracking',{enabled:true,confirm:true,world:'Next.zip',seed:12345})).state,'succeeded');
    const list=await (await request('/backups')).json(),original=list.backups.find(item=>item.relative.endsWith('-manual.zip'));
    const result=await action('restore',{name:original.relative,confirm:true});assert.equal(result.state,'succeeded',result.message);
    assert.deepEqual(await fs.readdir(path.join(data,'saves')),['Original.zip']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'config/server-settings.json'),'utf8')),settings);
    assert.equal(running,true);
    assert.equal((await (await request('/live-players')).json()).state,'disabled');
    assert.equal((await request('/download?kind=backup&name='+encodeURIComponent(original.relative),{user:viewer})).status,403);
  });
  await t.test('arbitrary Lua is rejected and the viewer can sign out',async()=>{
    const result=await action('console',{command:'/c game.cheat_mode=true'});assert.equal(result.state,'failed');assert.match(result.message,/supported/);
    assert.equal((await request('/logout',{method:'POST',body:{},user:viewer})).status,200);
  });
});
