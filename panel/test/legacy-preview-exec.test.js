import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedDocker} from '../core/owned-docker.js';

test('legacy fleet previews can use declared RCON but cannot execute arbitrary commands or foreign workers', async () => {
  const fleet='a'.repeat(32),id='b'.repeat(32),volume=`lobby-goblin-${fleet}-${id}`;
  const labels={'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.instance':id};
  const owner={Id:'game-id',Name:'/game',Image:'image-id',Config:{Image:'game-image',Labels:labels},Mounts:[{Type:'volume',Name:volume,Destination:'/factorio'}],HostConfig:{Mounts:[{Type:'volume',Source:volume,Target:'/factorio',VolumeOptions:{Subpath:'data'}}]}};
  let worker;
  const mutations=[];
  const request=async(method,route,body)=>{
    if(method==='GET'&&route.startsWith('/containers/'))return route.includes('game')?owner:route.includes('foreign')?{...worker,Config:{Labels:{}}}:worker;
    if(route==='/exec/exec-id/json')return {ContainerID:'worker-id',ExitCode:0};
    mutations.push({method,route,body});
    if(route.startsWith('/containers/create')){worker={Id:'worker-id',Name:'/preview',Image:'image-id',Config:{Labels:body.Labels},HostConfig:body.HostConfig};return {Id:worker.Id};}
    if(route==='/containers/worker-id/exec')return {Id:'exec-id'};
    return Buffer.from('2.0.77');
  };
  const docker=ownedDocker(request,{FLEET_ID:fleet,FLEET_INSTANCE:id,FLEET_VOLUME:volume},{container:'game',dataTarget:'/factorio',previewWorker:{root:'state/.panel-work',target:'/factorio'},execCommands:[{executable:'rcon',arguments:1,maxArgumentBytes:65536}]});
  await docker('POST','/containers/create?name=preview',{Image:'image-id',HostConfig:{NetworkMode:'none',Memory:1024**3,Mounts:[{Type:'volume',Source:volume,Target:'/factorio',VolumeOptions:{Subpath:'state/.panel-work/test'}}]}});
  assert.equal(worker.Config.Labels['io.lobby-goblin.worker-kind'],'game-preview');
  const exec=await docker('POST','/containers/preview/exec',{Cmd:['rcon','/version'],AttachStdout:true,AttachStderr:true});
  await docker('POST',`/exec/${exec.Id}/start`,{Detach:false,Tty:false});
  assert.equal((await docker('GET',`/exec/${exec.Id}/json`)).ExitCode,0);
  const before=mutations.length;
  for(const body of [{Cmd:['sh','-c','anything']},{Cmd:['rcon']},{Cmd:['rcon','/version'],Privileged:true},{Cmd:['rcon','/version'],Env:['INJECT=1']},{Cmd:['rcon','x'.repeat(65537)]}])await assert.rejects(docker('POST','/containers/preview/exec',body));
  await assert.rejects(docker('POST','/containers/foreign/exec',{Cmd:['rcon','/version']}));
  assert.equal(mutations.length,before);
});
