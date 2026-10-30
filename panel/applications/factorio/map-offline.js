import fs from 'node:fs/promises';
import {assert} from '../../common.js';

export const bundledMapEntrypoint=['/bin/sh','-ec','d=/factorio/map-export; cp -R /opt/factorio/data "$d/data"; chmod u+w "$d/data/base"; cp "$d/instrument-control.lua" "$d/data/base/instrument-control.lua"; exec /opt/factorio/bin/x64/factorio "$@"','goblin-map-export'];
const init=await fs.readFile(new URL('../../map-init.lua',import.meta.url),'utf8');
const batch=await fs.readFile(new URL('../../map-batch.lua',import.meta.url),'utf8');

// Instrument only the helper's private engine copy. Using base preserves the
// saved enabled-mod set, unlike adding an exporter mod. The debug API is enabled
// only in this network-isolated worker; the active server is never instrumented.
export function offlineMapScript(jobId,{initialization=init,collection=batch}={}){
 assert(/^[a-f0-9-]{36}$/.test(jobId),'Invalid map export identity.');
 return [
  'if script.mod_name=="level" then',
  'local finished=false',
  'local function export()',
  'if finished then return end;finished=true;debug.sethook()',
  'local storage={};local rcon={print=function()end}',
  initialization,
  'for map_start=1,#storage.panel_map.queue,16 do',
  collection.replaceAll('MAP_START','map_start'),
  'end',
  'local output=storage.panel_map.output',
  'helpers.write_file("panel-map.json",helpers.table_to_json(output))',
  'helpers.write_file("panel-map.complete.json",helpers.table_to_json({format=1,jobId="'+jobId+'",tick=output.tick,chunks=#output.chunks,entities=#output.entities,engine=script.active_mods.base}))',
  'log("GOBLIN_MAP_EXPORT_COMPLETE")',
  'end',
  // Scenario code can replace its tick handler during control.lua or on_load.
  // Restore a no-op if it removes the handler, and intercept the actual current
  // callback before its body. Do not replace the scenario's existing callback.
  'local function noop()end',
  'script.on_event(defines.events.on_tick,noop)',
  'debug.sethook(function(event)',
  'if event=="return" then',
  'if not script.get_event_handler(defines.events.on_tick)then script.on_event(defines.events.on_tick,noop)end',
  'elseif game and debug.getinfo(2,"f").func==script.get_event_handler(defines.events.on_tick) then export()end',
  'end,"cr")',
  'end',
 ].join('\n');
}

export async function prepareOfflineMap(workspace,runtime,jobId){
 const script=offlineMapScript(jobId);
 await workspace.write('map-export/instrument-control.lua',script);
 // Runtime-delivered binaries are receipt-verified and already copied into this
 // job's private directory before their read-only engine overlay is mounted.
 const copied=runtime.env.includes('FACTORIO_RUNTIME_HELPER=true');
 if(copied)await workspace.write('engine/data/base/instrument-control.lua',script);
 await workspace.write('map-export/config.ini','[path]\nread-data='+(copied?'/opt/factorio/data':'/factorio/map-export/data')+'\nwrite-data=/factorio\n[other]\ncheck-updates=false\n');
 return {
  Entrypoint:copied?['/opt/factorio/bin/x64/factorio']:bundledMapEntrypoint,
  Cmd:['--config','/factorio/map-export/config.ini','--mod-directory','/factorio/mods','--instrument-mod','base','--enable-unsafe-lua-debug-api','--benchmark','/factorio/saves/source.zip','--benchmark-ticks','1','--benchmark-runs','1'],
 };
}

export function validateMapCompletion(receipt,value,jobId){
 assert(receipt?.format===1&&receipt.jobId===jobId&&receipt.tick===value.tick&&receipt.chunks===value.chunks.length&&receipt.entities===value.entities.length&&/^2\.\d{1,3}\.\d{1,4}$/.test(receipt.engine),'The offline map export did not complete. The previous map was kept.',409);
 return receipt;
}
