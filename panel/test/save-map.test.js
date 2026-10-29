import test from 'node:test';
import assert from 'node:assert/strict';
import {completedSave,saveVersion,SaveMapQueue,mapRefreshSettings} from '../applications/factorio/save-map.js';

const loaded='0.1 Loading map /factorio/saves/Factory.zip: 100 bytes.\n';
test('completed saves include autosaves, manual saves, disconnect saves, and shutdown saves',()=>{
  for(const [start,finish,source] of [
    ['1 Info AppManager.cpp:324: Saving to _autosave4 (blocking).','2 Info AppManagerStates.cpp:2111: Saving finished','_autosave4.zip'],
    ['1 Info AppManager.cpp:416: Saving game as /factorio/saves/Factory.zip','2 Info AppManagerStates.cpp:2111: Saving finished','Factory.zip'],
    ['1 Info ServerMultiplayerManager.cpp:1231: Auto saving map as /factorio/saves/Factory.zip\n1 Info AppManager.cpp:416: Saving game as /factorio/saves/Factory.zip','2 Info AppManagerStates.cpp:2111: Saving finished','Factory.zip'],
    ['1 Info MainLoop.cpp:437: Saving map as /factorio/saves/Factory.zip','2 Info MainLoop.cpp:448: Saving progress: 100.000000%','Factory.zip']
  ]){
    assert.deepEqual(completedSave(loaded+start+'\n'),{completed:null,saving:true});
    assert.deepEqual(completedSave(loaded+start+'\n'+finish+'\n'),{completed:{world:'Factory.zip',source},saving:false});
    assert.equal(completedSave(loaded+start+'\n'+finish).completed,null,'partial lines must wait for the newline');
  }
});
test('unfinished saves and log rotation cannot reuse a completion for another world',()=>{
  const log=loaded+'1 Saving game as /factorio/saves/Factory.zip\n2 Saving finished\n';
  assert.equal(completedSave(log+'3 Saving to _autosave1 (non-blocking).\n').saving,true);
  assert.deepEqual(completedSave(log+'0 Loading map /factorio/saves/Next.zip: 200 bytes.\n'),{completed:null,saving:false});
  assert.deepEqual(completedSave(loaded+'2 Saving finished\n'),{completed:null,saving:false});
  assert.notEqual(saveVersion('Factory.zip','_autosave1.zip',{size:10,mtimeMs:100}),saveVersion('Next.zip','_autosave1.zip',{size:10,mtimeMs:100}));
});
test('save queue coalesces bursts, waits for other jobs, and retains newer saves during an export',()=>{
  const queue=new SaveMapQueue({}, {debounceMs:100,retryMs:1000}),first={world:'Factory.zip',source:'_autosave1.zip',version:'one'},latest={...first,source:'_autosave3.zip',version:'three'};
  queue.observe(first,null,0);assert.equal(queue.claim(false,99),null);assert.equal(queue.claim(true,100),null);
  const task=queue.claim(false,100);assert.equal(task.version,'one');assert.equal(queue.claim(false,101),null);
  queue.observe({...first,version:'two'},null,102);queue.observe(latest,null,103);queue.finish(task,true,null,104);
  assert.equal(queue.pending.version,'three');assert.equal(queue.claim(false,202),null);assert.equal(queue.claim(false,203).version,'three');
  queue.finish(latest,true,null,204);assert.equal(queue.pending,null);
  queue.observe(latest,{world:'Factory.zip',sourceVersion:'three'},205);assert.equal(queue.claim(false,1000),null,'exporting the same saved file must not cause a loop');
});
test('failed exports retry later, pending saves survive restart, and manual exports satisfy queued work',()=>{
  const candidate={world:'Factory.zip',source:'Factory.zip',version:'latest'},queue=new SaveMapQueue({}, {debounceMs:10,retryMs:1000});
  queue.observe(candidate,null,0);queue.claim(false,10);queue.finish(candidate,false,'Worker unavailable',20);assert.equal(queue.claim(false,1019),null);
  const restarted=new SaveMapQueue(JSON.parse(JSON.stringify(queue)),{debounceMs:10,retryMs:1000});assert.equal(restarted.claim(false,1020).version,'latest');
  restarted.finish(candidate,true);assert.equal(restarted.lastError,null);
  const manual=new SaveMapQueue();manual.observe(candidate,null,0);manual.observe(candidate,{world:'Factory.zip',sourceVersion:'latest'},1);assert.equal(manual.pending,null);
});
test('refresh preferences preserve legacy defaults and coalesce newer saves across persisted rate limits',()=>{
  const first={world:'Factory.zip',source:'Factory.zip',version:'one'},second={...first,version:'two'},latest={...first,version:'three'},queue=new SaveMapQueue({}, {debounceMs:0});
  assert.deepEqual(mapRefreshSettings({enabled:true,intervalMinutes:0}),{enabled:true,intervalMinutes:0});
  assert.equal(queue.status().intervalMinutes,0);assert.equal(queue.status().enabled,true);
  queue.configure({enabled:true,intervalMinutes:5});queue.observe(first,null,1000);const task=queue.claim(false,1000);
  queue.finish(task,true,null,1001);queue.observe(second,null,2000);queue.observe(latest,null,3000);
  const restarted=new SaveMapQueue(JSON.parse(JSON.stringify(queue)),{debounceMs:0});
  assert.equal(restarted.claim(false,300999),null);assert.equal(restarted.claim(false,301000).version,'three');
  restarted.configure({enabled:false,intervalMinutes:5});restarted.finish(latest,true,null,301001);
  restarted.observe({...first,version:'four'},null,400000);assert.equal(restarted.claim(false,900000),null);
  const disabled=new SaveMapQueue(JSON.parse(JSON.stringify(restarted)),{debounceMs:0});assert.equal(disabled.status().enabled,false);
  disabled.configure({enabled:true,intervalMinutes:0});assert.equal(disabled.claim(false,900000).version,'four');
});
test('refresh preferences reject unknown keys, coercions and unbounded intervals',()=>{
  for(const value of [null,[],{}, {enabled:'false',intervalMinutes:0},{enabled:true,intervalMinutes:-1},{enabled:true,intervalMinutes:1441},{enabled:true,intervalMinutes:0.5},{enabled:true,intervalMinutes:'5'},{enabled:true,intervalMinutes:0,source:'another.zip'}])assert.throws(()=>mapRefreshSettings(value),/Choose automatic refresh/);
});

test('manual cooldown survives restart, shares recent automatic work, and is reserved before effects', () => {
  const queue=new SaveMapQueue({}, {manualCooldownMs:120000});
  queue.claimManual(1000);assert.equal(queue.manualStatus(1001).availableAt,121000);
  assert.throws(()=>queue.claimManual(120999),error=>error.status===429);
  const restarted=new SaveMapQueue(queue.toJSON());assert.throws(()=>restarted.claimManual(1002),/cooling down/);
  restarted.claimManual(121000);
  const automatic=new SaveMapQueue({lastStartedAt:200000});assert.throws(()=>automatic.claimManual(200001),/cooling down/);
  automatic.claimManual(320000);
  assert.throws(()=>new SaveMapQueue({}, {manualCooldownMs:NaN}),/Invalid manual/);
});
