import {releasePrefixes} from '../panel/branding.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {makeZip} from '../panel/core/archive.js';
import {sourceMoves,repositoryPath,installationPath} from '../panel/source-layout.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(await fs.readFile(path.join(root,'panel/package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(version))throw new Error('Expected an alpha version.');
const name='lobby-goblin-'+version;
const exact=new Set(['.gitignore','.env.example','.gitattributes','compose.yaml','README.md','LICENSE','CHANGELOG.md','SECURITY.md','THIRD_PARTY_NOTICES.md','Start-Server.ps1','Configure-Lan.ps1','Configure-Autostart.ps1','Register-LanAnnouncer.ps1','Start-LanAnnouncer.ps1']);
for(const file of ['Setup.sh','Setup.command','Setup.ps1','Start-Server.sh','fleet.compose.yaml','.env.fleet.example','Fleet.ps1','Fleet.sh'])exact.add(file);
const installerRoots=new Set(['Install.sh','Install.command','Install.ps1','Install-Docker.sh']);
for(const file of installerRoots)exact.add(file);
const prefixes=['panel/','docs/','factorio-image/','.github/'];
const sourceExact=new Set([...exact,...[...exact].map(repositoryPath)]);
const sourcePrefixes=[...prefixes,'images/factorio/','images/rust/'];
const files=[];
// Rebase documentation links when the document or its target moves in a release.
// Commands and workflow paths also describe the extracted installation layout.
function packagedText(text,file,name,targetPath=value=>value){
  if(file.endsWith('.md'))text=text.replace(/(\]\()([^\s)#]+)([^)]*\))/g,(match,start,target,end)=>{
    if(/^(?:[a-z]+:|\/|#)/i.test(target))return match;
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(file),target));
    const relocated=targetPath(installationPath(resolved));
    return start+(path.posix.relative(path.posix.dirname(name),relocated)||'.')+end;
  });
  if((file.endsWith('.md')&&file!=='docs/REPOSITORY.md')||file.startsWith('.github/')){
    for(const [installed,source] of [...sourceMoves].sort((a,b)=>b[1].length-a[1].length))text=text.replaceAll(source,installed);
  }
  return text;
}
async function walk(relative=''){
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const file=(relative?relative+'/':'')+entry.name;
    if(!sourceExact.has(file)&&!sourcePrefixes.some(prefix=>file.startsWith(prefix)||prefix.startsWith(file+'/'))&&![...sourceExact].some(name=>name.startsWith(file+'/'))&&file!=='tools'&&!['tools/release.mjs','tools/factorio-image.mjs','tools/application-images.mjs'].includes(file))continue;
    if(entry.isSymbolicLink())throw new Error('Symlink in source allowlist: '+file);
    if(/^(?:data|backups|\.panel-data|import|users\.json|controller-token|registration-link\.txt|initial-login\.txt|rconpw|server-settings\.json|map\.json)$/.test(entry.name))throw new Error('Runtime/private path in source: '+file);
    if(entry.isDirectory()){
      if(['node_modules','__pycache__'].includes(entry.name)||entry.name.startsWith('.test-'))continue;
      await walk(file);continue;
    }
    if(!entry.isFile())throw new Error('Unexpected source entry: '+file);
    if(file.startsWith('tools/')&&!['tools/release.mjs','tools/factorio-image.mjs','tools/application-images.mjs'].includes(file))continue;
    const name=installationPath(file);
    if(!exact.has(name)&&!/(?:\.(?:js|mjs|json|lua|html|css|md|yml|yaml|py|ini|sh)|\/Dockerfile|\/LICENSE|\/\.dockerignore)$/.test(file))throw new Error('Unexpected source file type: '+file);
    const data=await fs.readFile(path.join(root,file));
    if(data.includes(0))throw new Error('Binary source file: '+file);
    const text=data.toString('utf8');
    const checks=[[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,'private key'],[/\b(?:172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)\b/,'private deployment address'],[/\b(?:[\dA-F]{2}[:-]){5}[\dA-F]{2}\b/i,'hardware address'],[/C:[\\/]Users[\\/](?!Public\b)[^\s"'<>]+/i,'personal Windows path'],[/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/,'access key']];
    for(const [pattern,label] of checks)if(pattern.test(text))throw new Error(`${label} detected in ${file}`);
    if(files.some(entry=>entry.name===name))throw new Error('Duplicate installed source path: '+name);
    files.push({name,data:Buffer.from(packagedText(text,file,name))});
  }
}
await walk();files.sort((a,b)=>a.name.localeCompare(b.name));
for(const required of ['LICENSE','README.md','compose.yaml','.env.example','.github/workflows/ci.yml','panel/setup.js'])if(!files.some(file=>file.name===required))throw new Error('Missing release file: '+required);
const dist=path.join(root,'dist');await fs.mkdir(dist,{recursive:true});
const destination=path.join(dist,name);
// Refuse replacement so a manual review artifact is never silently overwritten.
await fs.mkdir(destination);
for(const file of files){const target=path.join(destination,file.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.data);if(/\.(?:sh|command)$/.test(file.name))await fs.chmod(target,0o755);}
// Bump this state contract when auth/controller persistence requires migration.
const metadata={format:1,version,updater:1,stateVersion:1,rollbackSafe:true,panelImage:'ghcr.io/jkenneydaniel/lobby-goblin:'+version};
// Existing 0.2.x workers only admit their original source paths. Keep their ZIP
// installable while the new installer can use a complete image-source bundle.
const fleetRoots=new Set(['fleet.compose.yaml','.env.fleet.example','Fleet.ps1','Fleet.sh']);
const legacyGuide='docs/FACTORIO_IMAGE.md';
const legacyTarget=name=>name==='factorio-image/README.md'?legacyGuide:name;
const legacy=files.filter(({name})=>exact.has(name)&&!fleetRoots.has(name)&&!installerRoots.has(name)||name==='tools/release.mjs'||/^(?:panel|docs|\.github)\//.test(name)&&/(?:\.(?:js|mjs|json|lua|html|css|md|yml|yaml)|\/Dockerfile|\/LICENSE|\/\.dockerignore)$/.test(name)).map(file=>file.name.endsWith('.md')?{...file,data:Buffer.from(packagedText(file.data.toString(),file.name,file.name,legacyTarget))}:file);
// Older validators admit docs but not Factorio's image-source directory. Keep
// their guide links usable without expanding that archive's executable surface.
const imageGuide=files.find(file=>file.name==='factorio-image/README.md');
if(imageGuide){
  if(files.some(file=>file.name===legacyGuide))throw new Error('Generated documentation path already exists: '+legacyGuide);
  legacy.push({name:legacyGuide,data:Buffer.from(packagedText(imageGuide.data.toString(),imageGuide.name,legacyGuide,legacyTarget))});
  legacy.sort((a,b)=>a.name.localeCompare(b.name));
}
// Publish historical aliases as well: already installed updaters require their
// original asset names and ZIP root. Both variants contain identical sources.
for(const name of releasePrefixes(version))for(const [suffix,entries] of [['',legacy],['.source',files]]){
  const basename=name+suffix;
  const manifest=entries.map(file=>`${crypto.createHash('sha256').update(file.data).digest('hex')}  ${file.name}`).join('\n')+'\n';
  const archive=makeZip(entries.map(file=>({name:name+'/'+file.name,data:file.data,executable:/\.(?:sh|command)$/.test(file.name)})));
  await fs.writeFile(path.join(dist,basename+'.zip'),archive);
  await fs.writeFile(path.join(dist,basename+'.manifest.txt'),manifest);
  await fs.writeFile(path.join(dist,basename+'.sha256'),crypto.createHash('sha256').update(archive).digest('hex')+'  '+basename+'.zip\n');
  await fs.writeFile(path.join(dist,basename+'.update.json'),JSON.stringify({...metadata,...(suffix?{bundle:'source'}:{})},null,2)+'\n');
}
console.log(`Prepared ${files.length} source files in dist/${name}/, compatible update ZIP and complete source ZIP with checksums/manifests. No runtime data copied.`);
