// Runs inside the built public image; no socket, network or installation mounts.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startWeb} from '/app/core/web.js';
import {selectedApplication} from '/app/applications/index.js';
import {createGuardedModStore} from '/app/core/guarded-mod-store.js';
await fs.mkdir('/tmp/runtime-smoke/auth',{recursive:true});
await fs.writeFile('/tmp/runtime-smoke/token','disposable-runtime-smoke-token');
for(const game of ['factorio','rust']){
 const server=await startWeb(selectedApplication(game),{env:{AUTH_DIR:'/tmp/runtime-smoke/auth',CONTROLLER_TOKEN_FILE:'/tmp/runtime-smoke/token',RELEASE_CHECKS:'false',PANEL_HOSTS:'127.0.0.1'},port:0,hostname:'127.0.0.1'});
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(origin+'/health')).status,200);
  assert.match(await (await fetch(origin+'/')).text(),/Lobby Goblin/);
  for(const entry of ['core/controller.js','fleet/controller.js','fleet/worker.js','update-worker.js','applications/rust/controller.js'])await fs.access('/app/'+entry);
 }finally{await new Promise(resolve=>server.close(resolve));}
}
console.log('Shared runtime serves both game panels and includes controller/worker entrypoints.');

// Exercise the Linux descriptor seam as the image's controller UID on both
// architectures. This tmpfs fixture has no game mount or Docker connection.
const anchor='/tmp/runtime-smoke/mod-data';
await fs.mkdir(anchor,{mode:0o755});
const store=createGuardedModStore(anchor,'server/probe/mods/oxide/plugins');
await store.write('Probe.cs',Buffer.from('disposable plugin source'));
assert.equal((await store.read('Probe.cs')).data.toString(),'disposable plugin source');
assert.deepEqual([...(await store.list()).keys()],['Probe.cs']);
await fs.symlink('/tmp/runtime-smoke/token',store.root+'/Private.cs');
await assert.rejects(store.read('Private.cs'),/links/);
assert.equal(await fs.readFile('/tmp/runtime-smoke/token','utf8'),'disposable-runtime-smoke-token');
await store.write('Probe.cs',null);
assert.equal(await store.read('Probe.cs'),null);
console.log('Guarded mutable stores use directory descriptors inside the read-only runtime.');
