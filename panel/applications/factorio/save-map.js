// Read only complete log lines. A save-start alone must never publish a map.
export function completedSave(log){
  let world=null,pending=null,completed=null;
  for(const line of log.slice(0,log.lastIndexOf('\n')+1).split('\n')){
    const loaded=line.match(/Loading map \/factorio\/saves\/([^/\\\r\n]+\.zip):/);
    if(loaded){world=loaded[1];pending=null;completed=null;}
    const named=line.match(/Saving (?:game|map) as \/factorio\/saves\/([^/\\\r\n]+\.zip)\s*$/);
    const autosave=line.match(/Saving to (_autosave\d+) \(/);
    if(named)pending=named[1];else if(autosave)pending=autosave[1]+'.zip';
    if(/Saving finished|Saving progress: 100(?:\.0+)?%?\s*$/.test(line)&&pending){
      completed={world:world||pending,source:pending};pending=null;
    }
  }
  return {completed,saving:pending!==null};
}
export const saveVersion=(world,source,stat)=>JSON.stringify([world,source,stat.size,stat.mtimeMs]);

import {assert} from '../../common.js';

export function mapRefreshSettings(value){
  assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['enabled','intervalMinutes'].includes(key))&&typeof value.enabled==='boolean'&&Number.isInteger(value.intervalMinutes)&&value.intervalMinutes>=0&&value.intervalMinutes<=1440,'Choose automatic refresh and a whole interval from 0 to 1440 minutes.');
  return {enabled:value.enabled,intervalMinutes:value.intervalMinutes};
}
// There is one pending slot: newer saves replace it while a worker is busy.
// Keep that slot in persistent state until the corresponding export succeeds.
export class SaveMapQueue {
  constructor(saved={}, {debounceMs=2000,retryMs=60000}={}){
    this.pending=saved.pending||null;this.due=saved.due||0;this.lastError=saved.lastError||null;
    this.running=null;this.debounceMs=debounceMs;this.retryMs=retryMs;
    this.enabled=typeof saved.enabled==='boolean'?saved.enabled:true;
    this.intervalMinutes=Number.isInteger(saved.intervalMinutes)&&saved.intervalMinutes>=0&&saved.intervalMinutes<=1440?saved.intervalMinutes:0;
    this.lastStartedAt=Number.isFinite(saved.lastStartedAt)&&saved.lastStartedAt>=0?saved.lastStartedAt:null;
  }
  configure(value){Object.assign(this,mapRefreshSettings(value));}
  observe(candidate,snapshot,now=Date.now()){
    if(!candidate)return;
    if(snapshot?.sourceVersion===candidate.version&&snapshot.world===candidate.world){
      if(this.pending?.version===candidate.version)this.pending=null;
      return;
    }
    if(this.pending?.version!==candidate.version){this.pending=candidate;this.due=now+this.debounceMs;}
  }
  claim(busy,now=Date.now()){
    if(!this.enabled||busy||this.running||!this.pending||now<this.due||this.lastStartedAt!==null&&now<this.lastStartedAt+this.intervalMinutes*60000)return null;
    this.running=this.pending.version;this.lastStartedAt=now;return {...this.pending};
  }
  finish(task,ok,error=null,now=Date.now()){
    this.running=null;
    if(ok){this.lastError=null;if(this.pending?.version===task.version)this.pending=null;}
    else{this.lastError=error||'Automatic map refresh failed.';if(this.pending?.version===task.version)this.due=now+this.retryMs;}
  }
  toJSON(){return {pending:this.pending,due:this.due,lastError:this.lastError,enabled:this.enabled,intervalMinutes:this.intervalMinutes,lastStartedAt:this.lastStartedAt};}
  status(){return {enabled:this.enabled,intervalMinutes:this.intervalMinutes,pending:!!this.pending,running:!!this.running,lastError:this.lastError};}
}
