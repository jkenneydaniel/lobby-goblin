// Run inside the built release image with only dist/ mounted read-only. All setup
// state lives in its temporary filesystem; no Docker socket or game is involved.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

export async function verifyImageContents(files,imageRoot){
  for(const [name,data] of files){
    const relative=name.startsWith('panel/')?name.slice(6):'';
    // Release archives retain this historical image-source path for old
    // updaters. The shared runtime does not ship independent game builders.
    if(relative.startsWith('games/rust/image/')||/^applications\/[^/]+\/images\//.test(relative))continue;
    if(relative&&(['public/','core/','applications/','fleet/'].some(prefix=>relative.startsWith(prefix))||!relative.includes('/')&&(/\.(js|json|lua)$/.test(relative)||relative==='LICENSE')))assert.deepEqual(await fs.readFile(path.join(imageRoot,relative)),data,'Image/package mismatch: '+name);
  }
}

async function main(){
  const {unpackRelease,assertUnmodified,sha256}=await import('/app/update-source.js');
  const {version}=JSON.parse(await fs.readFile('/app/package.json','utf8'));
  const prefix='/release/lobby-goblin-'+version;
  const files=unpackRelease(await fs.readFile(prefix+'.zip'),await fs.readFile(prefix+'.sha256','utf8'),version,JSON.parse(await fs.readFile(prefix+'.update.json','utf8')));
  const root=await fs.mkdtemp('/tmp/factory-install-');
  for(const [name,data] of files){
    const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);
  }
  await verifyImageContents(files,'/app');
  await fs.writeFile(path.join(root,'.env'),'SERVER_ADDRESS=localhost\n');
  const run=promisify(execFile);
  const install=()=>run(process.execPath,['/app/setup.js','--new-world'],{env:{...process.env,SETUP_ROOT:root,PANEL_URL:'http://localhost:8080'},timeout:30000,maxBuffer:1024*1024});
  const first=await install();assert.match(first.stdout,/Updater prerequisites verified/);
  const important=['.panel-data/auth/users.json','.panel-data/secrets/controller-token','.panel-data/registration-link.txt','data/config/server-settings.json'];
  const hashes=await Promise.all(important.map(async name=>sha256(await fs.readFile(path.join(root,name)))));
  assert.match(first.stdout,/#register=/);
  const second=await install();assert.doesNotMatch(second.stdout,/#register=/);
  assert.deepEqual(await Promise.all(important.map(async name=>sha256(await fs.readFile(path.join(root,name))))),hashes,'A setup rerun changed existing private data');
  await assertUnmodified(root,JSON.parse(await fs.readFile(path.join(root,'.panel-data/updates/baseline.json'),'utf8')));
  assert.deepEqual(await fs.readdir(path.join(root,'data/saves')),[],'Prepare-only setup unexpectedly created a world');
  const config=JSON.parse(await fs.readFile(path.join(root,'data/config/server-settings.json'),'utf8'));
  assert.equal(config.visibility.public,false);assert.equal(config.auto_pause,true);
  console.log('Release ZIP matches the image; first-time setup and safe rerun passed without network, Docker socket or a running game.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
