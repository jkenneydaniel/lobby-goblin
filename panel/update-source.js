import {releasePrefixes} from './branding.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert,inside,readJSON,writeJSON} from './common.js';
import {zipEntries} from './core/archive.js';
import {installationPath} from './source-layout.js';

const roots=new Set(['.gitignore','.gitattributes','.env.example','compose.yaml','README.md','LICENSE','CHANGELOG.md','SECURITY.md','THIRD_PARTY_NOTICES.md','Setup.sh','Setup.command','Setup.ps1','Start-Server.sh','Start-Server.ps1','Configure-Lan.ps1','Configure-Autostart.ps1','Register-LanAnnouncer.ps1','Start-LanAnnouncer.ps1','tools/release.mjs','tools/factorio-image.mjs','tools/application-images.mjs','fleet.compose.yaml','.env.fleet.example','Fleet.ps1','Fleet.sh']);
for(const name of ['Install.sh','Install.command','Install.ps1','Install-Docker.sh'])roots.add(name);
export const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
export function publicSource(name){
  if(typeof name!=='string'||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'||p==='node_modules'||p.startsWith('.test-')))return false;
  return roots.has(name)||/^(?:panel|docs|factorio-image|\.github)\//.test(name)&&/(?:\.(?:js|mjs|json|lua|html|css|md|yml|yaml|py|ini|sh)|\/Dockerfile|\/LICENSE|\/\.dockerignore)$/.test(name);
}
export async function sourceSnapshot(root){
  const files={};
  const directories=['panel','docs','factorio-image','.github','tools','images','scripts','deploy'];
  const sourcePath=name=>publicSource(name)||publicSource(installationPath(name));
  async function walk(relative=''){
    for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+item.name:item.name;
      if(item.isSymbolicLink()&&(directories.some(p=>name===p||name.startsWith(p+'/'))||sourcePath(name)))throw new Error('Installation source contains a symlink: '+name);
      if(item.isDirectory()&&directories.some(p=>name===p||name.startsWith(p+'/'))&&!['node_modules','__pycache__'].includes(item.name)&&!item.name.startsWith('.test-'))await walk(name);
      else if(sourcePath(name)){
        assert(item.isFile(),'Installation source contains a symlink or special file: '+name);
        files[name]=sha256(await fs.readFile(inside(root,name)));
      }
    }
  }
  await walk();return files;
}
export async function initializeUpdateBaseline(root){
  // Unit fixtures can initialize accounts without a complete source checkout.
  if(!await fs.stat(path.join(root,'compose.yaml')).catch(()=>null))return;
  const target=path.join(root,'.panel-data/updates/baseline.json');
  if(!await readJSON(target,null))await writeJSON(target,{format:1,files:await sourceSnapshot(root)});
}
export async function assertUnmodified(root,baseline){
  assert(baseline?.format===1&&baseline.files,'Run the updated host setup once to initialize update support.');
  const current=await sourceSnapshot(root);
  assert(JSON.stringify(Object.entries(current).sort())===JSON.stringify(Object.entries(baseline.files).sort()),'Installation source has local changes. Preserve and reconcile them before updating; no files were replaced.',409);
}
export function unpackRelease(buffer,checksum,version,metadata){
  const names=releasePrefixes(version),suffix=(metadata?.bundle==='source'?'.source':'')+'.zip';
  const checksumEntry=checksum.trim().match(/^([a-fA-F0-9]{64}) {2}(\S+)$/);
  const name=names.find(name=>checksumEntry?.[2]===name+suffix);
  assert(name,'Release checksum file is invalid.');
  assert(sha256(buffer)===checksum.slice(0,64).toLowerCase(),'Release checksum does not match.');
  assert(metadata?.format===1&&metadata.version===version&&metadata.updater===1&&metadata.stateVersion===1&&metadata.rollbackSafe===true&&(!metadata.bundle||metadata.bundle==='source'),'This release needs an installer or state migration not supported by this updater.');
  const files=new Map();
  for(const entry of zipEntries(buffer)){
    assert(entry.name.startsWith(name+'/'),'Release archive has an unexpected root.');
    if(entry.name.endsWith('/'))continue;
    const relative=entry.name.slice(name.length+1);
    assert(publicSource(relative),'Unexpected release path: '+relative);
    files.set(relative,entry.read());
  }
  for(const required of ['compose.yaml','panel/package.json','panel/Dockerfile','panel/server.js','panel/update-worker.js'])assert(files.has(required),'Incomplete update package: '+required);
  assert(JSON.parse(files.get('panel/package.json')).version===version,'Release package version does not match.');
  return files;
}
export function setEnvironment(text,key,value){
  assert(/^[A-Z_]+$/.test(key)&&!/[\r\n\0]/.test(value),'Invalid installation setting.');
  let found=false;const result=text.replace(/\r/g,'').split('\n').map(line=>{if(line.startsWith(key+'=')){found=true;return key+'='+value;}return line;});
  if(!found)result.push(key+'='+value);return result.join('\n');
}
export function daemonPath(value){
  value=String(value).replaceAll('\\','/').replace(/\/$/,'');
  if(/^[A-Za-z]:\//.test(value))value='/run/desktop/mnt/host/'+value[0].toLowerCase()+value.slice(2);
  assert(value.startsWith('/')&&!value.split('/').includes('..'),'Unsupported installation path.');return value;
}
