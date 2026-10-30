import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeZip,zipEntries} from '../core/archive.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function until(check){for(let i=0;i<160;i++){const value=await check();if(value)return value;await delay(25);}throw new Error('Test condition timed out.');}

test('save-triggered exports use the completed autosave, coalesce saves, and never save recursively',{timeout:20000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factorio-auto-map-')),data=path.join(root,'data'),state=path.join(root,'state'),backups=path.join(root,'backups');
  for(const dir of ['saves','mods','config'])await fs.mkdir(path.join(data,dir),{recursive:true});await fs.mkdir(state);await fs.writeFile(path.join(state,'map-refresh.json'),JSON.stringify({enabled:true,intervalMinutes:0}));
  const world=value=>makeZip([{name:'Factory/level.dat0',data:Buffer.from(value)}]);
  await fs.writeFile(path.join(data,'saves/Factory.zip'),world('original'));await fs.writeFile(path.join(data,'mods/mod-list.json'),'{}');
  await fs.writeFile(path.join(data,'config/server-settings.json'),'{"name":"Test","description":""}');
  const log=path.join(data,'factorio-current.log');await fs.writeFile(log,'0 Loading map /factorio/saves/Factory.zip: 100 bytes.\n');
  const tokenFile=path.join(root,'token');await fs.writeFile(tokenFile,'test-token');
  const socket=process.platform==='win32'?`\\\\.\\pipe\\factorio-auto-${crypto.randomUUID()}`:path.join(root,'docker.sock');
  const helpers=new Map(),execs=new Map(),copied=[];let liveSaves=0,holdFirst=true;
  const engine=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},url=new URL(req.url,'http://docker');
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(value===undefined?'':JSON.stringify(value));};
    if(url.pathname==='/containers/json')return reply(200,[]);
    if(url.pathname==='/containers/factorio-panel-controller/json')return reply(200,{Mounts:[{Type:'bind',Destination:state,Source:state}]});
    if(url.pathname==='/containers/factorio-server/json')return reply(200,{State:{Running:true,Status:'running'},Config:{Image:'test-factorio:2.0.77'},Mounts:[{Type:'bind',Destination:'/factorio',Source:data}]});
    if(url.pathname==='/containers/create'){
      assert.equal(url.searchParams.get('platform'),'linux/amd64');
      assert.equal(body.HostConfig.CpuShares,128);assert.equal(body.HostConfig.Memory,1073741824);
      assert.equal(body.HostConfig.NanoCpus,undefined,'Background priority must not impose a hard CPU quota.');
      assert.equal(body.HostConfig.NetworkMode,'none');assert.ok(body.Cmd.includes('--benchmark'));assert.ok(body.Cmd.includes('--instrument-mod'));assert.ok(!body.Cmd.includes('--start-server'));const name=url.searchParams.get('name');helpers.set(name,{work:path.join(state,'.panel-work',name.slice('factorio-panel-map-'.length)),jobId:body.Labels['factorio-panel.job']});return reply(201,{Id:name});
    }
    const execMatch=url.pathname.match(/^\/containers\/([^/]+)\/exec$/);
    if(execMatch){const id=crypto.randomUUID();execs.set(id,{name:execMatch[1],command:body.Cmd[1]});return reply(201,{Id:id});}
    const start=url.pathname.match(/^\/exec\/([^/]+)\/start$/);
    if(start){
      const {name,command}=execs.get(start[1]);let output='';
      if(command==='/version')output='Version: 2.0.77';
      else if(name==='factorio-server'){
        assert.equal(command,'/server-save','Automatic exports must not run Lua on the live game.');liveSaves++;
        await fs.writeFile(path.join(data,'saves/Factory.zip'),world('manual-'+liveSaves));
        await fs.appendFile(log,`${100+liveSaves} Saving game as /factorio/saves/Factory.zip\n${101+liveSaves} Saving finished\n`);output='Saved';
      }else assert.fail('Offline map workers must not need RCON.');
      const buffer=Buffer.from(output),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(buffer.length,4);res.writeHead(200);return res.end(Buffer.concat([header,buffer]));
    }
    if(/^\/exec\/[^/]+\/json$/.test(url.pathname))return reply(200,{ExitCode:0});
    const name=url.pathname.split('/')[2];
    if(url.pathname.endsWith('/wait')){
      const helper=helpers.get(name);copied.push(zipEntries(await fs.readFile(path.join(helper.work,'saves/source.zip')))[0].read().toString());
      if(copied.length===1)await until(()=>!holdFirst);
      await fs.mkdir(path.join(helper.work,'script-output'),{recursive:true});
      await fs.writeFile(path.join(helper.work,'script-output/panel-map.json'),JSON.stringify({version:1,step:2,seed:123,tick:100,chunks:[{x:0,y:0,tiles:[1,256]}],palette:[{name:'grass',color:[60,70,30]}],entities:[],players:[],tags:[]}));
      await fs.writeFile(path.join(helper.work,'script-output/panel-map.complete.json'),JSON.stringify({format:1,jobId:helper.jobId,tick:100,chunks:1,entities:0,engine:'2.0.77'}));return reply(200,{StatusCode:0});
    }
    if(req.method==='DELETE'){helpers.delete(name);return reply(204);}
    if(url.pathname.endsWith('/start')||url.pathname.endsWith('/stop'))return reply(204);
    return reply(404,{message:'No such container'});
  });
  await new Promise(resolve=>engine.listen(socket,resolve));
  const portProbe=http.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const controller=spawn(process.execPath,['server.js'],{cwd:project,env:{...process.env,MODE:'controller',PORT:String(port),CONTROLLER_TOKEN_FILE:tokenFile,DOCKER_SOCKET:socket,FACTORIO_DATA:data,BACKUPS_DIR:backups,STATE_DIR:state,UPDATE_STATE_DIR:path.join(root,'updates'),MAP_MANUAL_REFRESH_COOLDOWN_MS:'0',MAP_SAVE_POLL_MS:'25',MAP_SAVE_DEBOUNCE_MS:'75'},stdio:'pipe'});
  let errors='';controller.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{holdFirst=false;controller.kill();await new Promise(resolve=>controller.once('close',resolve));await new Promise(resolve=>engine.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  async function api(route,body){const result=await fetch(`http://127.0.0.1:${port}`+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(result.ok,await result.clone().text());return result.json();}
  await until(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/health`)).ok;}catch{assert.equal(controller.exitCode,null,errors);return false;}});
  async function autosave(number,complete=true){await fs.writeFile(path.join(data,`saves/_autosave${number}.zip`),world('autosave-'+number));await fs.appendFile(log,`${number*10} Saving to _autosave${number} (blocking).\n`+(complete?`${number*10+1} Saving finished\n`:''));}
  await autosave(1,false);await delay(200);assert.equal((await api('/jobs')).jobs.length,0,'Save-start must not render an incomplete save');
  await fs.appendFile(log,'11 Saving finished\n');await until(()=>copied.length===1);
  await autosave(2);await delay(35);await autosave(3);await delay(120);assert.equal(copied.length,1,'Only one map worker can run');holdFirst=false;
  await until(async()=>{const {jobs,active}=await api('/jobs');return jobs.length===2&&!active&&jobs.every(job=>job.state==='succeeded');});
  assert.deepEqual(copied,['autosave-1','autosave-3']);assert.equal(liveSaves,0);
  const map=await api('/map');assert.equal(map.snapshot.world,'Factory.zip');assert.equal(map.snapshot.sourceFile,'_autosave3.zip');assert.equal(map.automatic.enabled,true);assert.equal(map.automatic.pending,false);
  const override=await fetch(`http://127.0.0.1:${port}/jobs`,{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({action:'refresh-map',params:{automatic:{source:'_autosave1.zip'}}})});assert.equal(override.status,400);
  await api('/jobs',{action:'refresh-map',params:{},actor:'manual test'});
  await until(async()=>{const {jobs,active}=await api('/jobs');return jobs.length===3&&!active&&jobs.every(job=>job.state==='succeeded');});
  await delay(300);assert.equal((await api('/jobs')).jobs.length,3,'A manual refresh must satisfy its own save event');assert.equal(liveSaves,1);assert.equal(helpers.size,0);
  const status=await api('/map-status');assert.equal(status.automatic.pending,false);assert.equal(status.automatic.running,false);assert.ok(status.created);
});
