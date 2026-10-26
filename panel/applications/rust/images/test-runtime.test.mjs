import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {startup,shutdownEvidence,startupEvidence} from './entrypoint.mjs';
import {build} from './build.mjs';
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lobby-rust-image-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const identity=path.join(root,'server/lobby-goblin-rust');await fs.mkdir(path.join(identity,'cfg'),{recursive:true});const env={RUST_SERVER_IDENTITY:'lobby-goblin-rust',RUST_RCON_PASSWORD:'x'.repeat(48)};return {root,identity,env};}
test('fresh bootstrap installs once and uses configured ports without overriding server.cfg',async t=>{const f=await fixture(t);const cfg=path.join(f.identity,'cfg/server.cfg');await fs.writeFile(cfg,'server.hostname Private\nserver.maxplayers 7');const result=await startup(f.env,f.root);assert.equal(result.install,true);assert.ok(!result.args.includes('+server.hostname'));assert.match(await fs.readFile(cfg,'utf8'),/Private/);});
test('existing binary, save and player data survive unchanged and determine the map identity',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.root,'RustDedicated'),'same installed game build');await fs.writeFile(path.join(f.identity,'proceduralmap.1000.456.289.sav'),'same saved world');await fs.writeFile(path.join(f.identity,'player.blueprints.5.db'),'same player data');const result=await startup(f.env,f.root);assert.equal(result.install,false);assert.equal(result.args[result.args.indexOf('+server.seed')+1],'456');assert.equal(result.args[result.args.indexOf('+server.worldsize')+1],'1000');assert.equal(await fs.readFile(path.join(f.identity,'proceduralmap.1000.456.289.sav'),'utf8'),'same saved world');});
test('existing worlds cannot trigger a new game download, seed/size mismatch or ambiguous identity',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.identity,'proceduralmap.1000.456.289.sav'),'world');await assert.rejects(startup(f.env,f.root),/matching game installation/);await fs.writeFile(path.join(f.root,'RustDedicated'),'binary');await assert.rejects(startup({...f.env,RUST_SERVER_SEED:'789'},f.root),/seed differs/);await assert.rejects(startup({...f.env,RUST_SERVER_WORLDSIZE:'2000'},f.root),/size differs/);await fs.writeFile(path.join(f.identity,'other.sav'),'other');await fs.writeFile(path.join(f.identity,'proceduralmap.1000.789.289.sav'),'second');await assert.rejects(startup(f.env,f.root),/ambiguous/);});
test('symlinks, injected identities, custom commands and modified server modes are refused',async t=>{const f=await fixture(t);for(const env of [{...f.env,RUST_SERVER_IDENTITY:'../other'},{...f.env,RUST_SERVER_STARTUP_ARGUMENTS:'; wipe'},{...f.env,RUST_OXIDE_ENABLED:'1'}])await assert.rejects(startup(env,f.root));await fs.symlink('/bin/true',path.join(f.root,'RustDedicated'));await assert.rejects(startup(f.env,f.root),/link/);});
test('only a newly provisioned independent snapshot explicitly permits installing with a copied save',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.identity,'proceduralmap.1000.456.289.sav'),'clone');await assert.rejects(startup(f.env,f.root),/matching game/);await fs.writeFile(path.join(f.root,'.lobby-goblin-clone.json'),JSON.stringify({game:'rust',identity:'lobby-goblin-rust',snapshot:'a'.repeat(32)}));assert.equal((await startup(f.env,f.root)).install,true);assert.equal(await fs.readFile(path.join(f.identity,'proceduralmap.1000.456.289.sav'),'utf8'),'clone');});
test('Docker receives only an ephemeral public build context, never the installation checkout',async()=>{let directory;await build({run:async args=>{directory=args.at(-1);const files=await fs.readdir(directory,{recursive:true});assert.ok(files.includes('entrypoint.mjs'));assert.equal(files.filter(name=>name.endsWith('.js')||name.endsWith('.mjs')||name.endsWith('.json')||name.endsWith('Dockerfile')).length,5);assert.ok(!files.some(name=>/^(data|backups|\.env|\.panel-data)/.test(name)));}});assert.equal(await fs.stat(directory).catch(()=>null),null);});

test('self-termination is clean only after this shutdown saved and explicitly quit; crashes remain failures',()=>{
 const complete=()=>{const s=shutdownEvidence();s.request();s.observe('Saving com');s.observe('plete\n');s.acknowledgeSave();s.quit();s.observe('[Raknet] Server Shutting Down (quit)\n');return s;};
 assert.equal(complete().exitCode(null,'SIGKILL'),0);assert.equal(complete().exitCode(1,null),1);assert.equal(complete().exitCode(null,'SIGSEGV'),1);
 assert.equal(shutdownEvidence().exitCode(null,'SIGKILL'),1);
 for(const missing of ['request','observe','acknowledgeSave','quit']){const s=shutdownEvidence();if(missing!=='request')s.request();if(missing!=='observe')s.observe('Saving complete\n');if(missing!=='acknowledgeSave')s.acknowledgeSave();if(missing!=='quit')s.quit();if(missing!=='observe')s.observe('[Raknet] Server Shutting Down (quit)\n');assert.equal(s.exitCode(null,'SIGKILL'),1,missing);}
 const stale=complete();stale.request();assert.equal(stale.exitCode(null,'SIGKILL'),1);assert.equal(stale.exitCode(0,null),0);
});

test('shutdown proof keeps streams separate, drains unterminated lines and accepts explicit save replies',()=>{
 const s=shutdownEvidence();s.request();s.observe('unrelated partial diagnostic','stderr');s.observe('Saving complete\n','stdout');s.acknowledgeSave('');s.quit();s.observe('[Raknet] Server Shutting Down (quit)','stdout');assert.equal(s.exitCode(null,'SIGKILL'),0);
 const reply=shutdownEvidence();reply.request();reply.acknowledgeSave('Saving complete');reply.quit();reply.observe('[Raknet] Server Shutting Down (quit)\n');assert.equal(reply.exitCode(null,'SIGKILL'),0);
 const incomplete=shutdownEvidence();incomplete.request();incomplete.observe('Saving com');incomplete.acknowledgeSave('Saving');incomplete.quit();incomplete.observe('[Raknet] Server Shutting Down (quit)\n','stderr');assert.equal(incomplete.exitCode(null,'SIGKILL'),1);
});

test('startup health proof requires a complete game line and never combines unrelated streams',()=>{
 const s=startupEvidence();assert.equal(s.observe('Server start'),false);assert.equal(s.observe('unrelated diagnostic\n','stderr'),false);assert.equal(s.observe('up complete\n'),true);assert.equal(s.observe('later log\n'),true);
 assert.equal(startupEvidence().observe('WebRCON ready\n'),false);assert.equal(startupEvidence().observe('Server startup complete'),false);assert.equal(startupEvidence().observe('chat: Server startup complete\n'),false);
});

async function carbonFixture(t){
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'carbon/managed'),{recursive:true});
 for(const name of ['libdoorstop.so','carbon/managed/Carbon.Preloader.dll'])await fs.writeFile(path.join(f.root,name),'reviewed loader');
 await fs.writeFile(path.join(f.root,'.lobby-goblin-mods.json'),JSON.stringify({format:1,status:'complete',framework:'carbon'}));return f;
}
test('managed Carbon disables framework and hook downloads before boot without changing reviewed loaders',async t=>{
 const f=await carbonFixture(t);await startup(f.env,f.root);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'carbon/config.json'),'utf8')),{SelfUpdating:{Enabled:false,HookUpdates:false}});
 for(const name of ['libdoorstop.so','carbon/managed/Carbon.Preloader.dll'])assert.equal(await fs.readFile(path.join(f.root,name),'utf8'),'reviewed loader');
});
test('Carbon pinning preserves existing settings and becomes read-only after its first preparation',async t=>{
 const f=await carbonFixture(t),target=path.join(f.root,'carbon/config.json');
 await fs.writeFile(target,JSON.stringify({Language:'de',SelfUpdating:{Enabled:true,HookUpdates:true,RedirectUri:'preserved'},Compiler:{EnableProxy:false}}),{mode:0o640});
 await startup(f.env,f.root);const prepared=await fs.readFile(target,'utf8');
 assert.deepEqual(JSON.parse(prepared),{Language:'de',SelfUpdating:{Enabled:false,HookUpdates:false,RedirectUri:'preserved'},Compiler:{EnableProxy:false}});
 assert.equal((await fs.stat(target)).mode&0o777,0o640);await fs.utimes(target,1,1);await startup(f.env,f.root);
 assert.equal(await fs.readFile(target,'utf8'),prepared);assert.equal((await fs.stat(target)).mtimeMs,1000);
});
test('Carbon preparation refuses malformed, oversized and linked configuration without changing outside files',async t=>{
 const f=await carbonFixture(t),target=path.join(f.root,'carbon/config.json');
 for(const value of ['{broken','[]','null','{"SelfUpdating":[]}','{"SelfUpdating":"enabled"}',JSON.stringify({large:'x'.repeat(512*1024)})]){
  await fs.writeFile(target,value);await assert.rejects(startup(f.env,f.root));assert.equal(await fs.readFile(target,'utf8'),value);
 }
 await fs.unlink(target);const outside=path.join(f.root,'outside.json');await fs.writeFile(outside,'{}');await fs.symlink(outside,target);
 await assert.rejects(startup(f.env,f.root),/regular file/);assert.equal(await fs.readFile(outside,'utf8'),'{}');
 await fs.unlink(target);await fs.rename(path.join(f.root,'carbon'),path.join(f.root,'outside-carbon'));await fs.symlink(path.join(f.root,'outside-carbon'),path.join(f.root,'carbon'));
 await assert.rejects(startup(f.env,f.root),/linked/);assert.equal(await fs.stat(path.join(f.root,'outside-carbon/config.json')).catch(()=>null),null);
});
