import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assert} from '../../common.js';
import {initializePanel} from '../../init.js';
import {ownedImages} from '../../core/game-images.js';
import {rustConfiguration} from './index.js';

const panelSource=fileURLToPath(new URL('../../',import.meta.url)),sourceRoot=path.dirname(panelSource.replace(/\/$/,''));
// Preparation only: no Docker/socket calls, network access, server discovery,
// existing install adoption, or reuse of Factorio files/secrets.
export async function prepareRust({directory,image=ownedImages.rust,address='http://localhost:8088'}){
  assert(typeof directory==='string'&&path.isAbsolute(directory),'Choose an absolute path for a new Rust installation.');
  const root=path.resolve(directory),parent=await fs.realpath(path.dirname(root)),target=path.join(parent,path.basename(root));
  assert(/^[A-Za-z0-9/_. -]+$/.test(target),'Use a Rust installation path containing letters, numbers, spaces, dots, dashes or underscores.');
  assert(target!==sourceRoot&&!target.startsWith(sourceRoot+'/')&&!sourceRoot.startsWith(target+'/'),'Create the Rust installation outside the Factorio checkout.');
  const url=new URL(address);assert(['http:','https:'].includes(url.protocol)&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'Choose an HTTP(S) panel origin.');
  const instance=crypto.randomBytes(16).toString('hex'),container=`lobby-goblin-rust-${instance}`;
  rustConfiguration({RUST_INSTANCE_ID:instance,RUST_CONTAINER:container,RUST_IMAGE:image,RUST_HOST_DATA:path.join(target,'data')});
  await fs.mkdir(target,{mode:0o700}); // EEXIST is intentional: never adopt data.
  try{
    for(const relative of ['data/server/lobby-goblin-rust/cfg','backups','control'])await fs.mkdir(path.join(target,relative),{recursive:true});
    await fs.cp(panelSource,path.join(target,'panel'),{recursive:true,filter:async source=>{
      const relative=path.relative(panelSource,source),parts=relative.split(path.sep),stat=await fs.lstat(source);
      assert(!stat.isSymbolicLink(),'Panel runtime source cannot contain symbolic links.');
      if(!relative)return true;
      if(parts.length===1){if(stat.isDirectory())return ['core','applications','public','fleet'].includes(parts[0]);return /\.(js|lua)$/.test(parts[0])||['package.json','package-lock.json','management-runtime.json','world-defaults.json','Dockerfile','LICENSE','.dockerignore'].includes(parts[0]);}
      if(stat.isDirectory())return !parts.some(part=>part.startsWith('.'));
      return /\.(js|json|lua|html|css|yaml|yml|md)$/.test(source)&&!parts.some(part=>['users.json','controller-token','registration-link.txt'].includes(part));
    }});
    await fs.copyFile(new URL('compose.yaml',import.meta.url),path.join(target,'compose.yaml'));
    const {link}=await initializePanel(path.join(target,'control'),url.origin);
    for(const relative of ['data/server','control/controller','backups'])await fs.writeFile(path.join(target,relative,'.lobby-goblin-rust.json'),JSON.stringify({game:'rust',instance})+'\n',{mode:0o600});
    const password=crypto.randomBytes(48).toString('base64url');
    await fs.writeFile(path.join(target,'control/secrets/rust-rcon-password'),password+'\n',{mode:0o600});
    await fs.chmod(path.join(target,'control/secrets/controller-token'),0o444);
    await fs.writeFile(path.join(target,'rust.env'),`RUST_RCON_PASSWORD=${password}\n`,{mode:0o600});
    await fs.writeFile(path.join(target,'data/server/lobby-goblin-rust/cfg/server.cfg'),'server.hostname "Rust server"\nserver.description ""\nserver.maxplayers 50\nserver.saveinterval 600\n',{mode:0o600});
    const port=url.port||String(url.protocol==='https:'?443:80);
    await fs.writeFile(path.join(target,'.env'),`RUST_INSTANCE_ID=${instance}\nRUST_IMAGE=${image}\nPANEL_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin:0.3.10-alpha\nRUST_HOST_DATA='${target}/data'\nRUST_PANEL_HOSTS=${url.hostname},localhost,127.0.0.1\nRUST_PANEL_PORT=${port}\nRUST_PANEL_BIND=127.0.0.1\nRUST_GAME_ADDRESS=localhost:28015\nPANEL_UID=${process.getuid?.()??1000}\nPANEL_GID=${process.getgid?.()??1000}\n`,{mode:0o600});
    await fs.writeFile(path.join(target,'installation.json'),JSON.stringify({game:'rust',version:1,instance,image,container,identity:'lobby-goblin-rust'},null,2)+'\n',{mode:0o600});
    return {directory:target,instance,link};
  }catch(error){await fs.rm(target,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
  const result=await prepareRust({directory:value('--directory'),image:value('--image'),address:value('--url')});
  console.log(`Rust installation prepared at ${result.directory}. No containers have been started.\n${result.link}`);
}
