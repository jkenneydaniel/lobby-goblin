import path from 'node:path';
import {assert} from '../../common.js';
import {realDirectory} from '../../core/mod-store.js';
import {createModDownloads,digest} from '../../core/mod-downloads.js';
import {createModLibrary} from '../../core/mod-library.js';
import {frameworks} from './mod-packages.js';
import {createRustCatalog} from './mod-catalog.js';

export function createRustModLibrary(ctx,{mods,changes=null,owned,start,stop,command,ready,fetcher=fetch}){
  const {installRoot,state}=ctx.config;
  const assertStopped=async()=>{assert(!(await owned()).State?.Running,'Stop Rust before changing plugins.',409);await mods.assertReady();};
  const adapter={
    game:'rust',note:'Public Rust plugins from uMod. Use Oxide or Carbon; check plugin compatibility and compilation after starting. Frameworks and paid plugins are managed separately.',
    editable:async()=>{const status=await mods.status();return (!changes||!(await changes.inspect()).pending)&&status.available&&['oxide','carbon'].includes(status.framework)&&!(await owned()).State?.Running&&!ctx.active&&!ctx.imageMigrationPending&&!ctx.updater.busy;},
    async store(context){assert(installRoot&&frameworks[context.scope],'Install Oxide or Carbon before changing plugins.',409);return mods.store(context.scope);},
    policy:async()=>({running:!!(await owned()).State?.Running,hotAvailable:true}),
    async reviewMode(mode){const status=await mods.status();assert(frameworks[status.framework],'Install Oxide or Carbon first.',409);if(mode==='stopped')await assertStopped();if(mode==='hot'){await ready();assert(await realDirectory((await adapter.store({scope:status.framework})).root),'The framework plugin folder is not ready. Choose automatic stop/start.',409);}},
    async prepare(mode){if(mode!=='restart'||!(await owned()).State?.Running)return false;await stop();return true;},
    assertApplying:async mode=>{if(mode==='hot'){await mods.assertReady();await ready();}else await assertStopped();},
    finish:async mode=>{if(mode==='restart')await start();},
    async afterApply(plan,context){const prefix=context.scope==='carbon'?'c.':'oxide.';for(const file of plan.files){if(!file.name.endsWith('.cs'))continue;const name=file.name.slice(0,-3),operation=file.sha256===null?'unload':context.files.has(file.name)?'reload':'load';const output=await command(prefix+operation+' '+name);assert(!/failed|error|exception/i.test(output),'Plugin reload reported an error. Check Logs.',409);}},
    async afterRestore(transaction){const scope=(await mods.status()).framework;for(const file of transaction.files){if(file.name.endsWith('.cs')){const output=await command((scope==='carbon'?'c.':'oxide.')+(file.before===null?'unload':'reload')+' '+file.name.slice(0,-3));assert(!/failed|error|exception/i.test(output),'Previous plugin could not be reloaded. Stop Rust and recover the change.',409);}}},
    async inventory(){
      await owned();const status=await mods.status(),scope=status.framework;
      const files=frameworks[scope]?(await adapter.store({scope})).list():new Map();
      const resolved=await files,items=[...resolved].map(([name,file])=>{const base=name.replace(/\.disabled$/,''),header=file.data.toString('utf8').match(/\[Info\(\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"(\d+(?:\.\d+){1,3})"/);return {id:base.slice(0,-3).toLowerCase(),name:base,title:header?.[1]||base,version:header?.[2]||null,enabled:!name.endsWith('.disabled'),sha256:digest(file.data)};});
      assert(new Set(items.map(item=>item.id)).size===items.length,'Both enabled and disabled copies of a plugin exist. Preserve one copy before using the library.',409);
      return {scope,version:status.version||null,files:resolved,items};
    },
    async changes({context,releases,operation,id}){
      if(operation==='install')return releases.map(release=>({name:release.name+(context.items.find(item=>item.name===release.name)?.enabled===false?'.disabled':''),data:release.data}));
      const item=context.items.find(item=>item.id===id);assert(item,'Choose an installed plugin.',404);
      const name=item.name+(item.enabled?'':'.disabled'),file=context.files.get(name);assert(file,'Plugin changed. Refresh Installed.',409);
      if(operation==='remove')return [{name,data:null}];
      assert(operation==='enable'?!item.enabled:item.enabled,'The plugin already has this state.',409);
      return [{name:item.name+(operation==='enable'?'':'.disabled'),data:file.data},{name,data:null}];
    }
  };
  return createModLibrary({state:path.join(state,'mods'),provider:createRustCatalog(createModDownloads(fetcher)),adapter,assertStopped,getActive:()=>ctx.active,canPlan:()=>!ctx.active&&!ctx.updater.busy&&!ctx.imageMigrationPending});
}
