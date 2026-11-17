import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSnapshots, snapshotCollection} from '../public/fleet/snapshot-filters.js';
const item = (hostId, id, title, created) => ({hostId, id, title, created, game: 'status-page', hostName: 'Weekend host', sourceName: 'Service source <safe>'});
test('snapshot ordering is deterministic across hosts, keeps unknown dates last and never mutates model order', () => {
  const records = [item('b','1','Friday','invalid'),item('b','2','Alpha','2026-01-02'),item('a','2','alpha','2026-01-02'),item('a','1','Friday','2026-01-01')];
  const snapshot = {snapshots: records, games: []}, filters = {search:'', application:'',host:'',sort:'newest'};
  const keys = items => items.map(item => item.hostId + item.id);
  assert.deepEqual(keys(selectSnapshots(snapshot, filters)), ['a2','b2','a1','b1']);
  assert.deepEqual(keys(selectSnapshots(snapshot, {...filters, sort:'oldest'})), ['a1','a2','b2','b1']);
  assert.deepEqual(keys(selectSnapshots(snapshot, {...filters, sort:'title'})), ['a2','b2','a1','b1']);
  assert.deepEqual(keys(records), ['b1','b2','a2','a1']);
  assert.equal(selectSnapshots(snapshot, {...filters,search:'STATUS PAGE',host:'b'}).length, 2);
  assert.equal(selectSnapshots(snapshot, {...filters,search:'service source',application:'rust'}).length, 0);
});
test('snapshot discovery escapes labels and distinguishes empty library from filtered results', () => {
  const snapshot = {snapshots:[{...item('a','1','<world>','2026-01-01'),files:1,bytes:1}],games:[],hostJobs:new Map()}, filters={search:'',application:'',host:'',sort:'newest'};
  assert.match(snapshotCollection(snapshot,false,filters), /&lt;world&gt;/);
  assert.match(snapshotCollection(snapshot,false,{...filters,search:'absent'}), /No matching snapshots/);
  assert.match(snapshotCollection({...snapshot,snapshots:[]},false,filters), /A library worth returning to/);
});
