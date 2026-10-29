import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const version=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');

// Background save detection needs only three fields, not the full terrain and
// entity payload. Parse once per file change and retain only that small index.
export class SnapshotMetadata {
  constructor(file,{stat=fs.stat,readFile=fs.readFile}={}){
    Object.assign(this,{file,stat,readFile});this.version=null;this.value=null;this.pending=null;
  }
  read(){
    if(!this.pending)this.pending=this.load().finally(()=>{this.pending=null;});
    return this.pending;
  }
  clear(){this.version=null;this.value=null;this.seed=null;}
  get revision(){return this.version?crypto.createHash('sha256').update(this.version).digest('hex'):null;}
  async document(known){
    try{
      const before=version(await this.stat(this.file));
      if(before===this.version&&known&&known===this.revision)
        return {unchanged:true,revision:this.revision,world:this.value?.world};
      // Full payloads are deliberately not retained by the controller. Coalesce
      // concurrent readers, but keep only the small metadata after they finish.
      if(!this.documentPending)this.documentPending=this.loadDocument().finally(()=>{this.documentPending=null;});
      return await this.documentPending;
    }catch(error){this.clear();if(error.code==='ENOENT')return {snapshot:null,revision:null};throw error;}
  }
  async loadDocument(){
    const before=version(await this.stat(this.file));
    const snapshot=JSON.parse(await this.readFile(this.file,'utf8'));
    const after=version(await this.stat(this.file));
    this.seed=snapshot?.seed;
    this.value=snapshot?{world:snapshot.world,sourceVersion:snapshot.sourceVersion,created:snapshot.created}:null;
    this.version=before===after?after:null;
    return {snapshot,revision:this.revision};
  }
  async load(){
    try{
      const before=version(await this.stat(this.file));
      if(before===this.version)return this.value;
      const snapshot=JSON.parse(await this.readFile(this.file,'utf8'));
      this.seed=snapshot?.seed;
      const value=snapshot?{world:snapshot.world,sourceVersion:snapshot.sourceVersion,created:snapshot.created}:null;
      const after=version(await this.stat(this.file));
      // A concurrent atomic replacement is picked up on the next read. Never
      // associate a parsed value with a different version of the file.
      this.value=value;this.version=before===after?after:null;
      return value;
    }catch(error){this.clear();if(error.code==='ENOENT')return null;throw error;}
  }
}
