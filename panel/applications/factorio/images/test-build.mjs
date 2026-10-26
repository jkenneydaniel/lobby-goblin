import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=(await import('node:fs')).existsSync(new URL('../../../package.json',import.meta.url))?new URL('../../../../',import.meta.url):(await fs.stat(new URL('../../panel/package.json',import.meta.url)).catch(()=>null)?new URL('../../',import.meta.url):new URL('../',import.meta.url));
const {gameSources,parseGameImage}=await import(new URL('panel/applications/factorio/public/game-images.js',root));
const {imageDefinition,buildImage,testImage}=await import(new URL('tools/factorio-image.mjs',root));
const {runtimeImageDefinition,buildRuntimeImage}=await import(new URL('tools/factorio-image.mjs',root));
const {publicSource,sourceSnapshot,unpackRelease,sha256}=await import(new URL('panel/update-source.js',root));
const {makeZip}=await import(new URL('panel/core/archive.js',root));
const owned=gameSources.factory.repository;
test('runtime image metadata and build sources ship independently from the bundled release',async()=>{
  const definition=await runtimeImageDefinition(),calls=[];await buildRuntimeImage(definition,async args=>calls.push(args));
  assert.equal(definition.image,owned+':runtime-fc.1');assert.equal(definition.version,undefined);
  assert.deepEqual(calls[0].slice(0,5),['build','--platform','linux/amd64','--file',calls[0][4]]);
  assert.ok(calls[0].some(value=>value.endsWith('runtime/Dockerfile')));
  for(const name of ['factorio-image/runtime/Dockerfile','factorio-image/runtime/image.json','factorio-image/runtime.py','factorio-image/test_runtime_install.py','panel/applications/factorio/runtime.js','panel/applications/factorio/runtime-update.js'])assert.equal(publicSource(name),true,name);
  const ignore=await fs.readFile(new URL('./.dockerignore',import.meta.url),'utf8');assert.match(ignore,/^!runtime\.py$/m);
});
test('the independent image definition pins Debian, the official archive and the x86 platform and owns deployment defaults',async()=>{
  const definition=await imageDefinition(),calls=[];await buildImage(definition,async args=>calls.push(args));
  assert.equal(definition.image,owned+':2.0.77-fc.3');assert.match(definition.baseImage,/^debian:.*@sha256:/);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,5),['build','--platform','linux/amd64','--file',calls[0][4]]);
  const dockerfile=await fs.readFile(new URL('./Dockerfile',import.meta.url),'utf8');
  assert.ok(!dockerfile.includes('factoriotools'));assert.match(dockerfile,/www.factorio.com\/get-download/);assert.match(dockerfile,/sha256sum -c/);
  assert.match(await fs.readFile(new URL('compose.yaml',root),'utf8'),/FACTORIO_IMAGE:-ghcr.io\/jkenneydaniel\/factorio-server:2.0.77-fc.3/);
  assert.match(await fs.readFile(new URL('.env.example',root),'utf8'),/^FACTORIO_IMAGE=ghcr.io\/jkenneydaniel\/factorio-server:2.0.77-fc.3/m);
});
test('container acceptance commands use only unique disposable resources and clean up a failed start',async()=>{
  const definition=await imageDefinition(),config={Entrypoint:['/docker-entrypoint.sh'],Volumes:{'/factorio':{}},ExposedPorts:{'34197/udp':{},'27015/tcp':{}},Env:['SAVES=/factorio/saves','CONFIG=/factorio/config','MODS=/factorio/mods','SCENARIOS=/factorio/scenarios','SCRIPTOUTPUT=/factorio/script-output','PUID=845','PGID=845','PORT=34197','RCON_PORT=27015'],Labels:{'factorio.version':definition.version,'io.lobby-goblin.compatibility':'1','io.lobby-goblin.image-revision':String(definition.revision)}};
  for(const [fail,classic] of [[false,false],[true,false],[false,true]]){
    let ticks=0;const calls=[],run=async args=>{
      calls.push(args);
      if(args[0]==='image'){
        if(!classic&&args[2]!=='--platform')return JSON.stringify([{Config:{}}]);
        if(classic)assert.equal(args.includes('--platform'),false,'Classic Docker clients do not need platform-specific inspect');
        else assert.deepEqual(args.slice(2,4),['--platform','linux/amd64']);
        const parsed=parseGameImage(args.at(-1));
        return JSON.stringify([{Id:'sha256:'+'a'.repeat(64),RepoDigests:classic&&parsed?.source==='factory'?[]:[(parsed?gameSources[parsed.source].repository:'factoriotools/factorio')+'@sha256:'+'b'.repeat(64)],Architecture:'amd64',Os:'linux',Config:config}]);
      }
      if(args[0]==='inspect')return JSON.stringify([{State:{ExitCode:0}}]);
      if(args[0]==='logs')return 'Loading map /factorio/saves/Compatibility.zip: fixture';
      if(args[0]==='start'&&fail)throw Error('simulated start failure');
      if(args.includes('--read-only'))return 'Version: '+definition.version+' (build fixture)';
      if(args[0]==='exec')return args.at(-1)==='/version'?definition.version:args.at(-1).includes('game.tick')?(++ticks===1?'':'42'):'';
      return args[0]==='run'&&args.includes(definition.image)?'compatible':'';
    };
    if(fail)await assert.rejects(testImage(definition,run),/simulated start failure/);else await testImage(definition,run);
    const volume=calls.find(a=>a[0]==='volume'&&a[1]==='create')[2];assert.match(volume,/^fc-image-test-[a-f0-9-]+-data$/);
    assert.ok(calls.some(a=>a[0]==='volume'&&a[1]==='rm'&&a[2]===volume));assert.ok(calls.some(a=>a[0]==='rm'&&a[1]==='-f'&&a[2]===volume.replace(/-data$/,'-server')));
    assert.ok(calls.every(a=>!a.includes('compose')&&!a.some(v=>v.includes('type=bind')||v==='factorio-server'||v==='-v')));
    assert.ok(calls.filter(a=>a.includes('--mount')).every(a=>a.includes('type=volume,source='+volume+',target=/factorio')));
  }
});
test('image build sources are included in update snapshots and public packages, private files remain excluded',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fc-image-source-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files={'compose.yaml':'fixture','panel/package.json':'{"version":"0.2.2-alpha"}','panel/Dockerfile':'fixture','panel/server.js':'fixture','panel/update-worker.js':'fixture','factorio-image/Dockerfile':'FROM debian','factorio-image/entrypoint.py':'# fixture','factorio-image/docker-entrypoint.sh':'#!/bin/sh','factorio-image/config.ini':'[path]','tools/factorio-image.mjs':'// fixture'};
  for(const [name,text] of Object.entries(files)){assert.equal(publicSource(name),true,name);await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),text);}
  for(const name of ['.env','data/saves/World.zip','factorio-image/private.pem','factorio-image/__pycache__/entrypoint.pyc'])assert.equal(publicSource(name),false,name);
  assert.deepEqual(Object.keys(await sourceSnapshot(root)).sort(),Object.keys(files).sort());
  const archive=makeZip(Object.entries(files).map(([name,text])=>({name:'lobby-goblin-0.2.2-alpha/'+name,data:Buffer.from(text)})));
  assert.equal(unpackRelease(archive,sha256(archive)+'  lobby-goblin-0.2.2-alpha.zip','0.2.2-alpha',{format:1,version:'0.2.2-alpha',updater:1,stateVersion:1,rollbackSafe:true}).size,Object.keys(files).length);
});

test('image CI watches the Factorio image validator implementation for pushes and pull requests',async()=>{
  const workflow=await fs.readFile(new URL('.github/workflows/game-images.yml',root),'utf8');
  for(const event of ['push','pull_request']){
    const paths=workflow.match(new RegExp('  '+event+':\\n    paths: (\\[[^\\n]+\\])'))?.[1];
    assert.ok(paths,event+' must have image path filters');
    assert.ok(paths.includes("'panel/applications/**'"),event+' must watch the implementation');
    assert.ok(paths.includes("'panel/update-worker.js'"),event+' must keep watching the wrapper');
  }
});
