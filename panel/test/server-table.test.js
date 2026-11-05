import test from 'node:test';
import assert from 'node:assert/strict';
import {serverCards, serverTable} from '../public/fleet/cards.js';
import {serverCollection} from '../public/fleet/server-filters.js';

const item = (patch = {}) => ({id: 'same', hostId: 'local', hostName: 'This host', name: 'Factory', game: 'factorio', applicationName: 'Factorio', state: 'installed', address: 'factory.example.test:35000', manageUrl: '/servers/same/', cpu: 2, memoryGiB: 4, ...patch});
const snapshot = (servers, patch = {}) => ({servers, games: [], hosts: [{id: 'local', connected: true}], live: new Map([['local:same', {ready: true, players: ['one', 'two']}]]), hostJobs: new Map(), ...patch});
const filters = {search: '', application: '', host: '', status: '', sort: 'host', view: 'table'};

test('table shares filtered name order, counts and empty states with cards', () => {
  const data = snapshot([item({name: 'Zulu'}), item({id: 'other', name: 'Alpha', manageUrl: '/servers/other/'})]);
  const html = serverCollection(data, false, {...filters, sort: 'name'});
  assert.match(html, /<caption>Fleet servers.*configured limits, not current usage/);
  assert.match(html, /<th scope="row">Alpha<\/th>.*<th scope="row">Zulu<\/th>/s);
  assert.equal((html.match(/scope="col"/g) || []).length, 9);
  assert.match(html, /Showing 2 of 2 servers/);
  assert.match(html, /data-clear-server-filters disabled/);
  for (const view of ['cards', 'table']) {
    const noMatches = serverCollection(data, false, {...filters, view, search: 'missing'});
    assert.match(noMatches, /Showing 0 of 2 servers/);
    assert.match(noMatches, /No matching servers/);
    assert.doesNotMatch(noMatches, /<table/);
    assert.match(serverCollection(snapshot([]), false, {...filters, view}), /Your first server starts here/);
  }
  assert.doesNotMatch(serverCollection(data, false, {...filters, view: undefined}), /<table/);
});

test('cards and table preserve removed, busy, offline and viewer fences', () => {
  for (const render of [serverCards, serverTable]) {
    const removed = render(snapshot([item({state: 'removed'})]), true);
    assert.match(removed, /Removed · data kept/);
    assert.match(removed, /storage and published snapshots were retained/);
    assert.doesNotMatch(removed, /Open server|data-snapshot|data-remove/);
    for (const patch of [{hosts: []}, {hostJobs: new Map([['local', {id: 'busy'}]])}]) {
      const html = render(snapshot([item()], patch), true);
      assert.match(html, /data-snapshot="local:same" disabled/);
      assert.match(html, /data-remove="local:same" disabled/);
      assert.match(html, /href="\/servers\/same\/"/);
    }
    const viewer = render(snapshot([item()]), false);
    assert.doesNotMatch(viewer, /data-snapshot|data-remove/);
    assert.match(viewer, /Copy address/);
  }
});

test('table keeps escaped labels, exact scoped links and configured resource values', () => {
  const remote = item({hostId: 'remote', hostName: '<host>', name: '<crew>', address: 'remote.example.test:35001', manageUrl: '/hosts/remote/servers/same/'});
  const html = serverTable(snapshot([item(), remote], {hosts: [{id: 'local', connected: true}, {id: 'remote', connected: true}]}), true);
  assert.match(html, /&lt;crew&gt;/); assert.match(html, /&lt;host&gt;/);
  assert.doesNotMatch(html, /<crew>|<host>/);
  assert.match(html, /data-copy-address="\/hosts\/remote\/servers\/same\/"/);
  assert.match(html, /href="\/hosts\/remote\/servers\/same\/"/);
  assert.match(html, /data-snapshot="remote:same"/);
  assert.match(html, /<td>2 cores<\/td><td>4 GiB<\/td><td>2<\/td>/);
  const app = serverTable(snapshot([item({applicationKind: 'application', applicationName: 'Status Page'})]), false);
  assert.match(app, /Manage application/);
  assert.match(app, /<td>—<\/td>/);
  assert.doesNotMatch(app, /Open server/);
});

test('assigned table requests fall back to minimal cards without host or resource disclosures', () => {
  const assigned = snapshot([item({hostName: 'Private host', cpu: 99, memoryGiB: 123})], {assigned: true});
  const html = serverCollection(assigned, false, filters);
  assert.doesNotMatch(html, /View servers|<table|Private host|99|123|Filter by host|Filter by status/);
  assert.match(html, /<article class="card"/);
  assert.match(html, /Copy address/);
  assert.match(serverTable(snapshot([], {assigned: true}), false), /No servers have been assigned/);
});
