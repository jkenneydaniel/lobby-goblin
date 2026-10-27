import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {assert} from '../../common.js';
import {softwareReceipt} from '../../core/software-installation.js';

export function rustSoftwareReceipt(value){const receipt=softwareReceipt(value);assert(receipt.selection.application==='rust'&&receipt.selection.provider==='steamcmd'&&receipt.selection.platform==='linux/amd64'&&receipt.selection.source.kind==='steam'&&receipt.selection.source.appId==='258550','Invalid Rust backup software identity.',409);return receipt;}

const MAX_FILE=8*1024**3-1,MAX_TOTAL=64*1024**3,MAX_FILES=20000;
const safe=name=>typeof name==='string'&&name.length>0&&!name.startsWith('/')&&!name.includes('\\')&&!name.includes('\0')&&!name.split('/').some(part=>['','..','.'].includes(part));
const octal=(buffer,offset,length,value)=>buffer.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
function header(name,size){
  assert(safe(name),'Unsafe Rust backup path.');
  let leaf=name,prefix='';
  if(Buffer.byteLength(name)>100){const parts=name.split('/');leaf=parts.pop();while(parts.length&&Buffer.byteLength(parts.join('/'))>155)leaf=parts.pop()+'/'+leaf;prefix=parts.join('/');}
  assert(Buffer.byteLength(leaf)<=100&&Buffer.byteLength(prefix)<=155,'Rust backup path exceeds the USTAR filename limit.');
  const value=Buffer.alloc(512);value.write(leaf);if(prefix)value.write(prefix,345,155);octal(value,100,8,0o600);octal(value,108,8,0);octal(value,116,8,0);octal(value,124,12,size);octal(value,136,12,Math.floor(Date.now()/1000));
  value.fill(32,148,156);value[156]=48;value.write('ustar\0',257);value.write('00',263);octal(value,148,8,value.reduce((a,b)=>a+b,0));return value;
}
const padding=size=>Buffer.alloc((512-size%512)%512);

// Reject links and special files rather than silently producing an incomplete
// identity backup. The game is stopped before the final inventory and reads.
export async function inventory(root,{requireSave=true,prefix='identity/'}={}){
  assert((await fs.lstat(root)).isDirectory()&&await fs.realpath(root)===path.resolve(root),'Rust identity must be a real directory without symbolic links.');
  const files=[];let total=0;
  async function walk(relative='',depth=0){
    assert(depth<=32,'Rust identity directory nesting is too deep.');
    for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+entry.name:entry.name,stat=await fs.lstat(path.join(root,name));
      assert(!stat.isSymbolicLink(),'Rust backups cannot include symbolic links.');
      if(stat.isDirectory())await walk(name,depth+1);
      else {assert(stat.isFile(),'Rust backups cannot include special files.');header(prefix+name,stat.size);total+=stat.size;
        assert(stat.size<=MAX_FILE&&total<=MAX_TOTAL&&files.length<MAX_FILES,'Rust backup limit: 8 GiB per file, 64 GiB total, 20,000 files.');files.push({name,size:stat.size});}
    }
  }
  await walk();if(requireSave)assert(files.some(file=>file.name.endsWith('.sav')&&file.size>0),'No Rust world save exists in this identity yet.');return files;
}
export async function writeArchive(target,root,{identity,instance,label,extras=[],software}){
  if(software)software=rustSoftwareReceipt(software);
  const files=(await inventory(root)).map(file=>({...file,archive:'identity/'+file.name,source:path.join(root,file.name)})),records=[];
  for(const extra of extras){
    assert(['mods/carbon','mods/oxide','mod-state'].includes(extra.prefix),'Unsupported Rust backup root.');
    if(!await fs.lstat(extra.root).catch(error=>{if(error.code!=='ENOENT')throw error;return null;}))continue;
    for(const file of await inventory(extra.root,{requireSave:false,prefix:extra.prefix+'/'}))files.push({...file,archive:extra.prefix+'/'+file.name,source:path.join(extra.root,file.name)});
  }
  assert(files.length<=MAX_FILES&&files.reduce((n,file)=>n+file.size,0)<=MAX_TOTAL,'Rust backup exceeds its limits.');
  const version=extras.length?2:1;
  async function* contents(){
    for(const file of files){
      yield header(file.archive,file.size);const hash=crypto.createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(file.source)){bytes+=chunk.length;assert(bytes<=file.size,'Rust files changed during backup.');hash.update(chunk);yield chunk;}
      assert(bytes===file.size,'Rust files changed during backup.');yield padding(file.size);records.push({name:version===1?file.name:file.archive,size:file.size,sha256:hash.digest('hex')});
    }
    const manifest=Buffer.from(JSON.stringify({format:'lobby-goblin-rust',version,identity,instance,label,created:new Date().toISOString(),files:records,...(software?{software}:{})}));
    assert(manifest.length<=4*1024*1024,'Rust backup manifest exceeds its limit.');yield header('manifest.json',manifest.length);yield manifest;yield padding(manifest.length);yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(contents()),createGzip(),createWriteStream(target,{flags:'wx',mode:0o600}));
}
export async function verifyArchive(file){
  const input=createReadStream(file),unzip=createGunzip(),finished=pipeline(input,unzip);void finished.catch(()=>{});
  const iterator=unzip[Symbol.asyncIterator]();let buffered=Buffer.alloc(0),total=0,manifest=null;const records=[];
  async function take(size){while(buffered.length<size){const next=await iterator.next();assert(!next.done,'Truncated Rust backup.');buffered=Buffer.concat([buffered,next.value]);}const data=buffered.subarray(0,size);buffered=buffered.subarray(size);return data;}
  try{
    while(true){
      const block=await take(512);
      if(block.every(byte=>byte===0)){assert((await take(512)).every(byte=>byte===0),'Invalid Rust backup terminator.');break;}
      const expected=parseInt(block.subarray(148,156).toString().replace(/\0.*$/,'').trim(),8),check=Buffer.from(block);check.fill(32,148,156);
      assert(check.reduce((a,b)=>a+b,0)===expected&&block.subarray(257,262).toString()==='ustar'&&block[156]===48,'Invalid Rust backup header.');
      const prefix=block.subarray(345,500).toString().replace(/\0.*$/,''),name=(prefix?prefix+'/':'')+block.subarray(0,100).toString().replace(/\0.*$/,''),size=parseInt(block.subarray(124,136).toString().replace(/\0.*$/,'').trim(),8);
      assert(safe(name)&&Number.isSafeInteger(size)&&size>=0&&size<=MAX_FILE&&!manifest,'Invalid Rust backup entry.');
      total+=size;assert(total<=MAX_TOTAL+4*1024*1024&&records.length<=MAX_FILES,'Rust backup exceeds its limits.');
      assert(name==='manifest.json'||['identity/','mods/carbon/','mods/oxide/','mod-state/'].some(prefix=>name.startsWith(prefix)),'Unexpected Rust backup path.');
      const hash=crypto.createHash('sha256'),parts=[];
      if(name==='manifest.json')assert(size<=4*1024*1024,'Rust backup manifest exceeds its limit.');
      for(let remaining=size;remaining>0;){const chunk=await take(Math.min(65536,remaining));remaining-=chunk.length;hash.update(chunk);if(name==='manifest.json')parts.push(chunk);}
      assert((await take((512-size%512)%512)).every(byte=>byte===0),'Invalid Rust backup padding.');
      if(name==='manifest.json')manifest=JSON.parse(Buffer.concat(parts));else records.push({name,size,sha256:hash.digest('hex')});
    }
    assert(buffered.every(byte=>byte===0),'Unexpected data after Rust backup.');
    let trailing=buffered.length;for await(const chunk of { [Symbol.asyncIterator]:()=>iterator }){trailing+=chunk.length;assert(trailing<=1024&&chunk.every(byte=>byte===0),'Unexpected data after Rust backup.');}
    await finished;
    assert(manifest?.format==='lobby-goblin-rust'&&[1,2].includes(manifest.version)&&Array.isArray(manifest.files),'Missing Rust backup manifest.');
    const expected=manifest.version===1?records.map(file=>({...file,name:file.name.slice(9)})):records;
    assert((manifest.version!==1||records.every(file=>file.name.startsWith('identity/')))&&new Set(records.map(file=>file.name)).size===records.length&&JSON.stringify(expected)===JSON.stringify(manifest.files),'Rust backup files do not match the manifest.');
    assert(records.some(file=>file.name.startsWith('identity/')&&file.name.endsWith('.sav')&&file.size>0),'Rust backup has no world save.');
    return {files:records.length,identity:manifest.identity,modded:records.some(file=>!file.name.startsWith('identity/')),version:manifest.version,bytes:records.reduce((sum,file)=>sum+file.size,0),...(manifest.software?{software:rustSoftwareReceipt(manifest.software)}:{})};
  }finally{input.destroy();unzip.destroy();await finished.catch(()=>{});}
}
