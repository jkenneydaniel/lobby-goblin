import test from 'node:test';
import assert from 'node:assert/strict';
import {storageWorkerFailure,storageWorkerMessage} from '../fleet/storage-worker.js';
import {HttpError} from '../common.js';

test('storage failures expose actionable categories without raw filesystem errors or credentials',()=>{
  for(const [code,pattern] of [['EACCES',/access was denied/],['ENOSPC',/Storage is full/],['EDQUOT',/quota/],['EROFS',/read-only/],['ENOENT',/missing/]]){
    const result=storageWorkerFailure(Object.assign(Error('/private/token must never leak'),{code}));
    assert.match(result.error,pattern);assert.ok(!result.error.includes('/private/token'));
  }
  assert.equal(storageWorkerFailure(new HttpError(409,'Backup has no active world.')).error,'Backup has no active world.');
  assert.ok(!storageWorkerFailure(Error('private runtime details')).error.includes('private runtime'));
  assert.match(storageWorkerMessage(null,{oomKilled:true,exitCode:137}),/out of memory/);
  assert.match(storageWorkerMessage({version:1,error:'x'.repeat(10000)},{exitCode:7}),/exit 7/);
  assert.match(storageWorkerMessage({version:1,error:'injected\nline'}),/stopped/);
});

test('worker teardown preserves private causes through owner transport without exposing them in public messages',()=>{
 const failure=storageWorkerFailure(Error('private-worker-cause /operator/token'));
 const publicError=storageWorkerMessage(failure,{exitCode:1});
 assert.doesNotMatch(publicError,/private-worker-cause|operator\/token/);
 assert.equal(failure.privateCauses[0].message,'private-worker-cause /operator/token');
});
