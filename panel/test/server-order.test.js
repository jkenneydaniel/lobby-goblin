import test from 'node:test';
import assert from 'node:assert/strict';
import {selectServers, serverCollection} from '../public/fleet/server-filters.js';

const filters = {search: '', application: '', host: '', status: '', sort: 'host'};
const item = (hostId, id, name, game = 'factorio') => Object.freeze({hostId, id, name, game, hostName: hostId, state: 'installed', manageUrl: '/hosts/' + hostId + '/servers/' + id + '/'});
const records = Object.freeze([item('b', '1', 'Zulu'), item('b', '2', 'alpha'), item('a', '2', 'Alpha', 'rust'), item('a', '3', 'Bravo')]);
const snapshot = {servers: records, games: [], hosts: [{id: 'a', connected: true}, {id: 'b', connected: true}], live: new Map(), hostJobs: new Map()};
const keys = rows => rows.map(row => row.hostId + ':' + row.id);

test('server name ordering uses stable scoped ties without changing current model order', () => {
  assert.deepEqual(selectServers(snapshot, filters), records);
  assert.deepEqual(keys(selectServers(snapshot, {...filters, sort: 'name'})), ['a:2', 'b:2', 'a:3', 'b:1']);
  assert.deepEqual(keys(selectServers(snapshot, {...filters, sort: 'name-desc'})), ['b:1', 'a:3', 'a:2', 'b:2']);
  assert.deepEqual(keys(selectServers(snapshot, {...filters, sort: 'host'})), ['b:1', 'b:2', 'a:2', 'a:3']);
  assert.deepEqual(keys(selectServers({...snapshot, servers: [...records].reverse()}, {...filters, sort: 'name'})), ['a:2', 'b:2', 'a:3', 'b:1']);
});

test('name ordering composes with current search, host, application and live status filters', () => {
  assert.deepEqual(keys(selectServers(snapshot, {...filters, sort: 'name', search: 'ALPHA'})), ['a:2', 'b:2']);
  assert.deepEqual(keys(selectServers(snapshot, {...filters, sort: 'name', search: 'ALPHA', application: 'factorio', host: 'b', status: 'Checking'})), ['b:2']);
  assert.equal(selectServers(snapshot, {...filters, sort: 'name', status: 'Ready'}).length, 0);
  const assigned = {...snapshot, assigned: true, hosts: [], servers: [item(undefined, '2', 'Zulu'), item(undefined, '1', 'Alpha')]};
  assert.deepEqual(selectServers(assigned, {...filters, sort: 'name', status: 'Ready'}).map(row => row.id), ['1', '2']);
});

test('assigned equal names and IDs keep scoped host links stable when source order changes', () => {
  const assigned = [
    {id: 'same', name: 'Alpha', game: 'factorio', manageUrl: '/hosts/b/servers/same/'},
    {id: 'same', name: 'alpha', game: 'factorio', manageUrl: '/hosts/a/servers/same/'},
  ];
  const urls = rows => rows.map(row => row.manageUrl);
  for (const sort of ['name', 'name-desc']) {
    const first = selectServers({...snapshot, assigned: true, servers: assigned}, {...filters, sort});
    const reversed = selectServers({...snapshot, assigned: true, servers: [...assigned].reverse()}, {...filters, sort});
    assert.deepEqual(urls(first), ['/hosts/a/servers/same/', '/hosts/b/servers/same/']);
    assert.deepEqual(urls(reversed), urls(first));
  }
});

test('sort choice is presentation-only and does not activate Clear filters or hide empty states', () => {
  const html = serverCollection(snapshot, false, {...filters, sort: 'name-desc'});
  assert.match(html, /Sort servers/);
  assert.match(html, /value="name-desc" selected/);
  assert.match(html, /data-clear-server-filters disabled/);
  assert.match(html, /Showing 4 of 4 servers/);
  assert.match(serverCollection(snapshot, false, {...filters, sort: 'name', search: 'missing'}), /No matching servers/);
  assert.match(serverCollection({...snapshot, servers: []}, false, {...filters, sort: 'name'}), /Your first server starts here/);
});
