export const automaticMapActor = 'automatic map refresh';
const minimumIntervalMinutes = 15;
const refreshInterval = (minutes) =>
  Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440
    ? Math.max(minimumIntervalMinutes, minutes)
    : minimumIntervalMinutes;

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
  return {enabled:value.enabled,intervalMinutes:refreshInterval(value.intervalMinutes)};
}
// There is one pending slot: newer saves replace it while a worker is busy.
// Keep that slot in persistent state until the corresponding export succeeds.
export class SaveMapQueue {
  constructor(saved={}, {debounceMs=2000,retryMs=60000,manualCooldownMs=120000}={}){
    assert(Number.isInteger(manualCooldownMs)&&manualCooldownMs>=0&&manualCooldownMs<=3600000,'Invalid manual map refresh cooldown.');
    this.pending=saved.pending||null;this.due=saved.due||0;this.lastError=saved.lastError||null;
    this.running=null;this.debounceMs=debounceMs;this.retryMs=retryMs;this.manualCooldownMs=manualCooldownMs;
    this.lastManualStartedAt=Number.isFinite(saved.lastManualStartedAt)&&saved.lastManualStartedAt>=0?saved.lastManualStartedAt:null;
    this.enabled=typeof saved.enabled==='boolean'?saved.enabled:true;
    this.intervalMinutes=refreshInterval(saved.intervalMinutes);
    this.lastStartedAt=Number.isFinite(saved.lastStartedAt)&&saved.lastStartedAt>=0?saved.lastStartedAt:null;
    this.workerId=/^[0-9a-f-]{36}$/.test(saved.workerId||'')?saved.workerId:null;
  }
  get lastRefreshStartedAt(){
    return Math.max(this.lastManualStartedAt??-Infinity,this.lastStartedAt??-Infinity);
  }
  manualStatus(now=Date.now()){
    return {availableAt:Number.isFinite(this.lastRefreshStartedAt)?this.lastRefreshStartedAt+this.manualCooldownMs:0,serverNow:now};
  }
  claimManual(now=Date.now()){
    const remaining=this.manualStatus(now).availableAt-now;
    assert(remaining<=0,'Map refresh is cooling down. Try again in '+Math.ceil(remaining/1000)+' seconds.',429);
    this.lastManualStartedAt=now;
  }
  configure(value){Object.assign(this,mapRefreshSettings(value));}
  observe(candidate,snapshot,now=Date.now()){
    if(!candidate)return;
    if(snapshot?.sourceVersion===candidate.version&&snapshot.world===candidate.world){
      // A manual export can cover a newer save than the queued autosave.
      this.pending=null;
      return;
    }
    if(this.pending?.version!==candidate.version){this.pending=candidate;this.due=now+this.debounceMs;}
  }
  claim(busy,now=Date.now()){
    if(!this.enabled||busy||this.running||!this.pending||now<this.due||now<this.lastRefreshStartedAt+this.intervalMinutes*60000)return null;
    this.running=this.pending.version;this.lastStartedAt=now;return {...this.pending};
  }
  finish(task,ok,error=null,now=Date.now()){
    this.running=null;
    if(ok){this.lastError=null;if(this.pending?.version===task.version)this.pending=null;}
    else{this.lastError=error||'Automatic map refresh failed.';if(this.pending?.version===task.version)this.due=now+this.retryMs;}
  }
  toJSON(){return {pending:this.pending,due:this.due,lastError:this.lastError,enabled:this.enabled,intervalMinutes:this.intervalMinutes,lastStartedAt:this.lastStartedAt,lastManualStartedAt:this.lastManualStartedAt,...(this.workerId&&{workerId:this.workerId})};}
  status(){return {enabled:this.enabled,intervalMinutes:this.intervalMinutes,pending:!!this.pending,running:!!this.running,lastError:this.lastError};}
}
