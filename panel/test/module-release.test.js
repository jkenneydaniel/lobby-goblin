import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sourceSnapshot,unpackRelease} from '../update-source.js';
import {legacySlug} from '../branding.js';
import {unpackRelease as unpack020} from './fixtures/updater-v0.2.0-alpha.mjs';
import {unpackRelease as unpack033} from './fixtures/updater-v0.3.3-alpha.mjs';
import {verifyImageContents} from './installer-image-smoke.js';

const run=promisify(execFile),project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

test('compatible release bundles contain an importable core/module runtime and preserve prepare-only setup',{timeout:90000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-module-release-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source');await fs.mkdir(source);
  // Only the existing public-source allowlist is read/copied, never data, auth,
  // backups, local .env files, diagnostics or the running installation.
  for(const name of Object.keys(await sourceSnapshot(project))){const target=path.join(source,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(project,name),target);}
  await run(process.execPath,['tools/release.mjs'],{cwd:source,timeout:10000});
  const {version}=JSON.parse(await fs.readFile(path.join(source,'panel/package.json'),'utf8'));
  const prefix=path.join(source,'dist/lobby-goblin-'+version);
  const historicalZip=path.join(source,'dist/'+legacySlug+'-'+version);
  const historicalArchive=await fs.readFile(historicalZip+'.zip');
  const historicalChecksum=await fs.readFile(historicalZip+'.sha256','utf8');
  const historicalMetadata=JSON.parse(await fs.readFile(historicalZip+'.update.json','utf8'));
  for(const unpack of [unpack020,unpack033]){
    const accepted=unpack(historicalArchive,historicalChecksum,version,historicalMetadata);
    assert.ok(accepted.has('Setup.sh'));
    assert.ok(accepted.has('panel/source-layout.js'));
    assert.ok(![...accepted.keys()].some(name=>/^(images|scripts|deploy)\//.test(name)));
  }
  for(const suffix of ['','.source']){
    const historical=path.join(source,'dist/'+legacySlug+'-'+version);
    const files=unpackRelease(await fs.readFile(historical+suffix+'.zip'),await fs.readFile(historical+suffix+'.sha256','utf8'),version,JSON.parse(await fs.readFile(historical+suffix+'.update.json','utf8')));
    assert.equal(files.get('panel/branding.js').toString(),await fs.readFile(path.join(source,'panel/branding.js'),'utf8'));
  }
  for(const suffix of ['','.source']){
    const files=unpackRelease(await fs.readFile(prefix+suffix+'.zip'),await fs.readFile(prefix+suffix+'.sha256','utf8'),version,JSON.parse(await fs.readFile(prefix+suffix+'.update.json','utf8')));
    for(const name of ['panel/core/managed-game.js','panel/core/game-contract.js','panel/core/permissions.js','panel/core/broker-client.js','panel/core/broker-policy.js','panel/core/docker-broker.js','panel/fleet/broker-compose.js','panel/fleet/broker-upgrade.js','panel/core/audit.js','panel/core/operations.js','panel/core/owned-docker.js','panel/core/routes.js','panel/applications/factorio/contract.js','panel/applications/rust/contract.js','panel/applications/factorio/managed.js','panel/applications/rust/managed.js','panel/public/client.js','panel/public/shell.js','panel/public/shell.css','panel/public/shared/contracts.js','panel/public/shared/session.js','panel/public/shared/operations.js','panel/public/shared/accounts.js','panel/public/shared/access.js','panel/public/shared/permission-editor.js','panel/public/shared/audit-history.js','panel/public/shared/backups.js','panel/public/fleet-entry.js','panel/public/fleet/creation.js','panel/public/fleet/host-settings.js','panel/applications/rust/public/rust/mods-page.js','panel/public/workflows.css'])assert.ok(files.has(name),'Missing shared product runtime: '+name);
    for(const name of ['panel/core/mod-library.js','panel/core/mod-downloads.js','panel/core/mod-store.js','panel/applications/factorio/mod-library.js','panel/applications/factorio/mod-catalog.js','panel/applications/rust/mod-library.js','panel/applications/rust/mod-catalog.js','panel/public/mod-library.js','panel/public/mod-library.css'])assert.ok(files.has(name),'Missing mod library runtime: '+name);
    for(const name of ['panel/agent-options.js','panel/health.js','panel/fleet/agent-identity.js','panel/fleet/agent-connection.js','panel/https.js','panel/host-install.js','panel/host-agent-control.js','panel/fleet/hosts.js','panel/fleet/agent-web.js','panel/fleet/host-compose.js','panel/fleet/host-setup.js','panel/fleet/ssh.js','panel/fleet/bootstrap-docker.js','panel/fleet/agent-update.js','panel/fleet/agent-update-worker.js','panel/public/fleet/hosts.js'])assert.ok(files.has(name),'Missing host-agent runtime: '+name);
    for(const name of ['panel/quality/package.json','panel/quality/package-lock.json','panel/quality/check.mjs','panel/quality/tsconfig.json','panel/quality/contract-probes.js'])assert.ok(files.has(name),'Missing developer quality tooling in source bundle: '+name);
    assert.ok(files.has('panel/package-lock.json'),'Release must include the locked Rust WebSocket dependency');
    for(const name of ['panel/core/image-migration.js','panel/core/standalone-migration.js','panel/fleet/migrations.js','panel/games/rust/image/Dockerfile','panel/games/rust/image/entrypoint.mjs','panel/games/rust/image/image.json'])assert.ok(files.has(name),'Missing migration or image source: '+name);
    for(const name of ['panel/fleet/manager.js','panel/fleet/controller.js','panel/fleet/web.js','panel/fleet/worker.js','panel/applications/factorio/helper-mount.js','panel/public/scope.js','panel/public/fleet/app.js','panel/core/controller.js','panel/core/web.js','panel/core/accounts.js','panel/applications/index.js','panel/applications/factorio/controller.js','panel/applications/factorio/setup.js','panel/applications/factorio/update-worker.js','panel/applications/rust/controller.js','panel/applications/rust/archive.js','panel/applications/rust/compose.yaml','panel/applications/rust/setup.js','panel/applications/rust/public/app.js'])assert.ok(files.has(name),'Missing module source in '+suffix+' bundle: '+name);
    assert.ok(![...files.keys()].some(name=>/^(data|backups|\.panel-data)\//.test(name)));
    for(const [name,data] of files){
      if(!name.endsWith('.md'))continue;
      for(const match of data.toString().matchAll(/\]\(([^\s)#]+)[^)]*\)/g)){
        const link=match[1];if(/^(?:[a-z]+:|\/)/i.test(link))continue;
        const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),decodeURIComponent(link)));
        assert.ok(files.has(target),'Broken release documentation link: '+name+' -> '+link);
      }
    }
    const freshRoots=['fleet.compose.yaml','.env.fleet.example','Fleet.ps1','Fleet.sh','Install.sh','Install.command','Install.ps1','Install-Docker.sh'];
    if(suffix){
      for(const name of freshRoots)assert.ok(files.has(name),'Missing host manager launcher '+name);
      for(const name of ['panel/install.js','docs/INSTALLATION.md','factorio-image/Dockerfile','factorio-image/test-build.mjs','panel/games/rust/image/build.mjs'])assert.ok(files.has(name),'Missing complete source '+name);
      assert.ok(![...files.keys()].some(name=>/^(images|scripts|deploy)\//.test(name)));
      const complete=path.join(root,'complete');await fs.mkdir(complete);
      for(const [name,data] of files){const target=path.join(complete,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);}
      const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
      const checked=await run(process.execPath,['--test','factorio-image/test-build.mjs','panel/games/rust/image/test-runtime.test.mjs','panel/test/host-setup.test.js','panel/test/installation.test.js'],{cwd:complete,env:childEnv,timeout:15000});
      assert.match(checked.stdout,/tests [1-9]\d*/,'Packaged acceptance must execute its tests, not inherit the parent test-runner context');
      for(const command of ['describe','runtime-describe']){const described=await run(process.execPath,['tools/factorio-image.mjs',command],{cwd:complete,timeout:5000});assert.match(JSON.parse(described.stdout).image,/ghcr.io\/jkenneydaniel\/factorio-server:/);}
      const catalogue=await run(process.execPath,['tools/application-images.mjs','matrix'],{cwd:complete,timeout:5000});
      assert.ok(JSON.parse(catalogue.stdout).include.some(recipe=>recipe.key==='status-page/server'));
      assert.ok(JSON.parse(catalogue.stdout).include.some(recipe=>recipe.key==='shared/steamcmd/runtime'));
      assert.ok(files.has('panel/providers/steamcmd/images/Dockerfile'));
      await run(process.execPath,['tools/application-images.mjs','check','shared/steamcmd/runtime'],{cwd:complete,env:childEnv,timeout:60000});
      // Repack an extracted source bundle without changing its installed paths.
      await run(process.execPath,['tools/release.mjs'],{cwd:complete,timeout:10000});
      continue;
    }
    for(const name of freshRoots)assert.ok(!files.has(name),'Historical updater must not receive new root files');
    const install=path.join(root,'install');await fs.mkdir(install);
    for(const [name,data] of files){const target=path.join(install,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);}
    // Model the checkout build context, rather than the compatibility archive:
    // independent image sources are packaged at old paths but do not ship in
    // the shared runtime. No Docker engine or image operations are used here.
    const image=path.join(root,'image');await fs.mkdir(image);
    const dockerfile=await fs.readFile(path.join(install,'panel/Dockerfile'),'utf8');
    for(const line of dockerfile.split('\n')){
      if(!line.startsWith('COPY --chown=node:node '))continue;
      const names=line.slice('COPY --chown=node:node '.length).trim().split(/\s+/),dest=names.pop();
      for(const name of names){
        if(name.startsWith('*.')){
          for(const file of await fs.readdir(path.join(source,'panel')))if(file.endsWith(name.slice(1)))await fs.copyFile(path.join(source,'panel',file),path.join(image,file));
        }else await fs.cp(path.join(source,'panel',name),path.join(image,dest),{recursive:true});
      }
    }
    await run(process.execPath,['--input-type=module','-e',"import {selectedApplication} from './applications/index.js'; import {startController} from './core/controller.js'; import {startWeb} from './core/web.js'; import './setup.js'; import './update-worker.js'; import './applications/rust/setup.js'; import './host-install.js'; import './host-agent-control.js'; import './fleet/controller.js'; import './fleet/agent-web.js'; import './fleet/agent-update-worker.js'; if(selectedApplication().id!=='factorio'||selectedApplication('rust').id!=='rust'||typeof startController!=='function'||typeof startWeb!=='function')throw Error('Incomplete runtime');"],{cwd:image,timeout:5000});
    // Exercise the same image/package comparison used by CI, including its
    // historical Rust image sources and rejection of changed runtime bytes.
    if(await fs.stat(path.join(source,'images/rust')).catch(()=>null))assert.equal(await fs.stat(path.join(image,'applications/rust/image')).catch(()=>null),null);
    await verifyImageContents(files,image);
    const runtimeFile=path.join(image,'applications/rust/controller.js'),original=await fs.readFile(runtimeFile);
    await fs.appendFile(runtimeFile,'\n// changed runtime fixture\n');
    await assert.rejects(verifyImageContents(files,image),/Image\/package mismatch/);
    await fs.writeFile(runtimeFile,original);
    // Exercise the exported setup function; the CLI prerequisite checks need
    // Docker, so no CLI, engine, socket or game process is used here.
    const prepare="import fs from 'node:fs/promises'; import {setup} from './setup.js'; const root=process.argv[1]; await setup(root,['--new-world'],{log:()=>{}}); const files=['.panel-data/auth/users.json','.panel-data/secrets/controller-token','.panel-data/registration-link.txt','data/config/server-settings.json']; const before=await Promise.all(files.map(f=>fs.readFile(root+'/'+f,'utf8'))); await setup(root,['--new-world'],{log:()=>{}}); const after=await Promise.all(files.map(f=>fs.readFile(root+'/'+f,'utf8'))); if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Setup changed existing state'); if((await fs.readdir(root+'/data/saves')).length)throw Error('Prepare-only setup created a world');";
    await run(process.execPath,['--input-type=module','-e',prepare,install],{cwd:image,timeout:5000});
  }
});
