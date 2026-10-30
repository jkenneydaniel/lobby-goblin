import {mapObjectLimit,mapChunkLimit,mapExportByteLimit} from './public/map-limits.js';
import {runtimeHelper} from './runtime.js';
import {prepareOfflineMap,validateMapCompletion} from './map-offline.js';
import {helperWorkspace,readScopedFile,removeHelperWorker} from '../../core/helper-workspace.js';
import path from 'node:path';
import {docker as dockerAPI,demultiplex} from '../../core/docker.js';
import {gameContainerRoute as containerRoute} from './transport.js';
import {assert,HttpError,writeJSON} from '../../common.js';
import {saveVersion} from './save-map.js';

export function validateMap(value){
  assert(value?.version===1&&Array.isArray(value.chunks)&&value.chunks.length<=mapChunkLimit&&Array.isArray(value.entities)&&value.entities.length<=mapObjectLimit&&Array.isArray(value.palette)&&value.palette.length<1000,'Invalid map export.');
  assert(value.step===2&&Number.isFinite(value.seed),'Invalid map metadata.');
  for(const item of [...value.palette,...value.entities])assert(Array.isArray(item.color)&&item.color.length===3&&item.color.every(component=>Number.isInteger(component)&&component>=0&&component<=255),'Invalid map color.');
  for(const chunk of value.chunks){
    assert(Number.isInteger(chunk.x)&&Number.isInteger(chunk.y)&&Array.isArray(chunk.tiles)&&chunk.tiles.length%2===0,'Invalid map chunk.');
    let count=0;for(let i=0;i<chunk.tiles.length;i+=2){assert(Number.isInteger(chunk.tiles[i])&&chunk.tiles[i]>0&&chunk.tiles[i]<=value.palette.length&&Number.isInteger(chunk.tiles[i+1])&&chunk.tiles[i+1]>0,'Invalid terrain run.');count+=chunk.tiles[i+1];}assert(count===256,'Incomplete map chunk.');
  }
  return value;
}
export async function exportMap({data,state,env={},server,source,world=source,save=true,expectedVersion,saveNow,running,job,stageMessage},{docker=dockerAPI,gameContainerRoute=containerRoute}={}){
  assert(source,'No world save is available.');
  if(save&&running){await stageMessage(job,'Saving the latest progress for the map…');await saveNow();}
  const helper=`factorio-panel-map-${job.id}`,workspace=await helperWorkspace({data,state,env,server,docker},job.id);
  let exists=false;
  const started=performance.now();
  try{
    await workspace.copyInputs();
    const runtime = await runtimeHelper(workspace,{data,server});
    const {bytes,stat:sourceStat}=await readScopedFile(data,'saves/'+source),version=saveVersion(world,source,sourceStat);
    assert(!expectedVersion||expectedVersion===version,'The saved file changed before map export. Waiting for the latest save.');
    await workspace.write('saves/source.zip',bytes);
    const command=await prepareOfflineMap(workspace,runtime,job.id),prepared=performance.now();

    await stageMessage(job,'Exporting the map from an isolated world copy…');
    // Favor the active game when CPU is contested; let exports use idle CPU.
    await docker('POST',gameContainerRoute(helper),{Image:server.Image||server.Config.Image,...command,Env:runtime.env,Labels:{'factorio-panel.job':job.id},HostConfig:{NetworkMode:'none',Mounts:runtime.mounts,Memory:1073741824,CpuShares:128}});exists=true;
    await docker('POST',`/containers/${helper}/start`);
    const result=await docker('POST',`/containers/${helper}/wait?condition=not-running`,undefined,{timeout:180000}),exported=performance.now();
    if(result.StatusCode!==0){
      const status=await docker('GET',`/containers/${helper}/json`),logs=await docker('GET',`/containers/${helper}/logs?stdout=1&stderr=1&tail=30`,undefined,{raw:true}).then(demultiplex).catch(()=> 'Worker logs unavailable.');
      const error=new HttpError(409,status.State?.OOMKilled?'The offline map export exceeded its 1 GiB memory budget. The previous map was kept.':'The offline map exporter failed with exit code '+result.StatusCode+'. Check operation details; the previous map was kept.');
      error.cause=new Error(logs.slice(-12000));throw error;
    }
    const value=JSON.parse((await workspace.read('script-output/panel-map.json',mapExportByteLimit)).toString());for(const key of ['chunks','palette','entities','players','tags'])if(value[key]&&!Array.isArray(value[key])&&Object.keys(value[key]).length===0)value[key]=[];
    validateMap(value);const receipt=await workspace.json('script-output/panel-map.complete.json').catch(()=>null);validateMapCompletion(receipt,value,job.id);
    Object.assign(value,{world,sourceFile:source,sourceVersion:version,created:new Date().toISOString(),sourceModified:sourceStat.mtime.toISOString()});
    await writeJSON(path.join(state,'map-export-metrics.json'),{version:1,jobId:job.id,engine:receipt.engine,chunks:value.chunks.length,entities:value.entities.length,prepareMs:Math.round(prepared-started),workerMs:Math.round(exported-prepared),decodeMs:Math.round(performance.now()-exported)});
    await writeJSON(path.join(state,'map.json'),value);
    return `Map refreshed: ${value.chunks.length} explored chunks and ${value.entities.length} objects.${value.limited?' Limited to the 4,096 chunks nearest spawn.':''}`;
  }finally{
    if(exists)await removeHelperWorker(docker,helper);
    await workspace.remove();
  }
}
