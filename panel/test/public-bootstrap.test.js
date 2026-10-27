import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const unix=process.platform==='win32'?test.skip:test;
const script=await fs.readFile(new URL('../../Install.sh',import.meta.url),'utf8');
async function fixture(t,{tool='curl',version='0.3.12-alpha',link=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'goblin public bootstrap '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'archive/lobby-goblin-fixture'),bin=path.join(root,'bin'),temporary=path.join(root,'temporary');
 await fs.mkdir(path.join(source,'panel'),{recursive:true});await fs.mkdir(bin);await fs.mkdir(temporary);
 await fs.writeFile(path.join(source,'panel/package.json'),JSON.stringify({version},null,2));
 await fs.writeFile(path.join(source,'Install.sh'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$BOOTSTRAP_ARGS"\nprintf installed > "$BOOTSTRAP_DONE"\n');
 if(link)await fs.symlink('/outside-must-not-be-read',path.join(source,'escape'));
 const archive=path.join(root,'source.tar.gz');execFileSync('tar',['-czf',archive,'-C',path.dirname(source),path.basename(source)]);
 for(const command of ['tar','gzip','grep','sed','awk','mktemp','rm','mkdir','cp','sh','dirname']){
  const target=execFileSync('which',[command],{encoding:'utf8'}).trim();await fs.symlink(target,path.join(bin,command));
 }
 const download='#!/bin/sh\noutput=""\nnext=no\nfor arg do\n if [ "$next" = yes ]; then output=$arg; next=no; fi\n case "$arg" in --output) next=yes ;; --output-document=*) output=${arg#--output-document=} ;; esac\ndone\nprintf "%s\\n" "$@" > "$BOOTSTRAP_DOWNLOAD"\ncp "$BOOTSTRAP_ARCHIVE" "$output"\n[ "${BOOTSTRAP_FAIL_DOWNLOAD:-0}" != 1 ] || exit 22\n';
 await fs.writeFile(path.join(bin,tool),download,{mode:0o755});
 const env={...process.env,PATH:bin,TMPDIR:temporary,BOOTSTRAP_ARCHIVE:archive,BOOTSTRAP_ARGS:path.join(root,'args'),BOOTSTRAP_DONE:path.join(root,'done'),BOOTSTRAP_DOWNLOAD:path.join(root,'download')};
 const run=(args=['--version','0.3.12-alpha','--host-agent','--prepare','--directory','new host'])=>spawnSync('/bin/bash',['-s','--',...args],{input:script,encoding:'utf8',cwd:root,env});
 return {root,temporary,env,run};
}
for(const tool of ['curl','wget'])unix(`piped ${tool} bootstrap downloads the selected tag, forwards exact arguments and cleans temporary source`,async t=>{
 const f=await fixture(t,{tool}),result=f.run();assert.equal(result.status,0,result.stderr);
 assert.deepEqual((await fs.readFile(f.env.BOOTSTRAP_ARGS,'utf8')).trim().split('\n'),['--host-agent','--prepare','--directory','new host']);
 assert.match(await fs.readFile(f.env.BOOTSTRAP_DOWNLOAD,'utf8'),/https:\/\/github.com\/jkenneydaniel\/lobby-goblin\/archive\/refs\/tags\/v0.3.12-alpha.tar.gz/);
 assert.deepEqual(await fs.readdir(f.temporary),[]);
});
unix('bootstrap rejects an invalid version before download and a source version mismatch before execution',async t=>{
 const f=await fixture(t,{version:'0.3.11-alpha'});
 assert.notEqual(f.run(['--version','1.2.3;touch hacked']).status,0);assert.equal(await fs.stat(f.env.BOOTSTRAP_DOWNLOAD).catch(()=>null),null);
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/does not match/);assert.equal(await fs.stat(f.env.BOOTSTRAP_DONE).catch(()=>null),null);assert.deepEqual(await fs.readdir(f.temporary),[]);
});
unix('bootstrap rejects archive links before extracting or executing',async t=>{
 const f=await fixture(t,{link:true}),result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/unsupported file types/);assert.equal(await fs.stat(f.env.BOOTSTRAP_DONE).catch(()=>null),null);assert.deepEqual(await fs.readdir(f.temporary),[]);
});
unix('bootstrap help performs no download',async t=>{
 const f=await fixture(t),result=f.run(['--help']);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/--version VERSION/);assert.equal(await fs.stat(f.env.BOOTSTRAP_DOWNLOAD).catch(()=>null),null);
});

unix('a failed download never executes even a complete-looking source archive',async t=>{
 const f=await fixture(t);f.env.BOOTSTRAP_FAIL_DOWNLOAD='1';const result=f.run();assert.notEqual(result.status,0);assert.equal(await fs.stat(f.env.BOOTSTRAP_DONE).catch(()=>null),null);assert.deepEqual(await fs.readdir(f.temporary),[]);
});

unix('bootstrap canonicalizes temporary aliases so Node module entrypoint guards execute',async t=>{
 const f=await fixture(t),source=path.join(f.root,'archive/lobby-goblin-fixture');
 await fs.writeFile(path.join(source,'Install.sh'),'#!/bin/sh\nexec "$BOOTSTRAP_NODE" "$(dirname "$0")/panel/help.mjs"\n');
 await fs.writeFile(path.join(source,'panel/help.mjs'),'import path from "node:path";import fs from "node:fs";import {fileURLToPath} from "node:url";if(path.resolve(process.argv[1])===fileURLToPath(import.meta.url))fs.writeFileSync(process.env.BOOTSTRAP_DONE,"executed");');
 execFileSync('tar',['-czf',f.env.BOOTSTRAP_ARCHIVE,'-C',path.dirname(source),path.basename(source)]);
 const alias=path.join(f.root,'temporary-alias');await fs.symlink(f.temporary,alias);f.env.TMPDIR=alias;f.env.BOOTSTRAP_NODE=process.execPath;
 const result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(await fs.readFile(f.env.BOOTSTRAP_DONE,'utf8'),'executed');assert.deepEqual(await fs.readdir(f.temporary),[]);
});
