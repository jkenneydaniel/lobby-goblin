import test from 'node:test';
import assert from 'node:assert/strict';
import {reportedVersion, compareVersions} from '../public/shared/versions.js';

test('reported versions normalize exact receipts, RCON status and bundled image revisions without changing release parsing',()=>{
  for (const input of ['2.0.77','Version: 2.0.77','Version: 2.0.77 (build 80123, linux64, headless)','Factorio 2.0.77','2.0.77-fc.3']) {
    assert.equal(reportedVersion(input),'2.0.77');
    assert.equal(compareVersions('2.1.23',reportedVersion(input)),1);
  }
  for(const input of [null,undefined,{},'Installing…','unknown','Version: 2.0.77.8','Version: 02.0.77','unexpected 2.0.77']) assert.equal(reportedVersion(input),null);
  assert.throws(()=>compareVersions('Version: 2.0.77','2.1.23'),/Invalid version/);
});
