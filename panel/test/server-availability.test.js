import test from 'node:test';
import assert from 'node:assert/strict';
import {serverCollection} from '../public/fleet/server-filters.js';

const filters = {search: '', application: '', host: '', status: '', sort: 'host'};
const server = (id, patch = {}) => ({id, name: id, hostId: 'a', hostName: 'Alpha', game: 'factorio', state: 'installed', manageUrl: '/servers/' + id + '/', ...patch});
const fixture = () => ({
  servers: [server('ready'), server('starting'), server('stopped'), server('attention', {state: 'attention'}), server('creating', {state: 'creating'}), server('unknown'), server('removed', {state: 'removed'}), server('ready', {hostId: 'b', hostName: 'Beta', game: 'rust', manageUrl: '/hosts/b/servers/ready/'})],
  hosts: [{id: 'a', connected: true}, {id: 'b', connected: false}],
  games: [], hostJobs: new Map(),
  live: new Map([['a:ready', {ready: true}], ['a:starting', {running: true}], ['a:stopped', {state: 'exited'}], ['b:ready', {ready: true}]]),
});
const summary = html => html.match(/<section class="server-availability"[^>]*>(.*?)<\/section>/s)?.[1];

test('loaded availability shares displayed statuses and scoped IDs without mutating source', () => {
  const data = fixture(), before = structuredClone(data);
  for (const view of ['cards', 'table']) {
    const html = serverCollection(data, false, {...filters, view});
    for (const status of ['Ready', 'Starting', 'Stopped', 'Needs attention', 'Creating', 'Checking', 'Removed · data kept', 'Host unavailable']) {
      assert.ok(summary(html).includes(status + ': 1'), status);
      assert.ok(html.includes('>' + status + ' (1)</option>'), status);
    }
    assert.match(summary(html), /8 servers matching search, application and host filters \(before status\)/);
    assert.match(summary(html), /Most recently received observations/);
    assert.match(summary(html), /Unavailable hosts may have servers missing/);
    assert.equal((html.match(/role="status"/g) || []).length, 1);
  }
  assert.deepEqual(data, before);
});

test('context counts follow search application and host but retain distribution across status choices', () => {
  const data = fixture();
  const chosen = {...filters, search: 'ready', application: 'factorio', host: 'a', status: 'Stopped'};
  const html = serverCollection(data, true, chosen);
  assert.match(html, /Showing 0 of 8 servers/);
  assert.match(summary(html), /1 server matching/);
  assert.match(summary(html), /Ready: 1/);
  assert.doesNotMatch(summary(html), /Host unavailable|Unavailable hosts/);
  assert.match(html, /value="Stopped" selected>Stopped \(0\)/);
  assert.match(html, /value="Ready" >Ready \(1\)/);
  const noMatches = serverCollection(data, false, {...filters, search: '<missing>'});
  assert.match(summary(noMatches), /No matching loaded servers/);
  assert.match(noMatches, /No matching servers/);
  const stale = serverCollection(data, false, {...filters, status: 'Old <state>'});
  assert.match(stale, /value="Old &lt;state&gt;" selected>Old &lt;state&gt; \(0\)/);
});

test('cold unavailable hosts disclose incomplete loaded inventory even without cached servers', () => {
  const data = {...fixture(), servers: [], live: new Map()};
  assert.match(summary(serverCollection(data, false, filters)), /0 servers matching.*Unavailable hosts may have servers missing/s);
  assert.doesNotMatch(summary(serverCollection(data, false, {...filters, host: 'a'})), /Unavailable hosts/);
  const cached = fixture(); cached.hosts[1].connected = true; cached.servers[7].unavailable = true;
  assert.match(summary(serverCollection(cached, false, filters)), /Host unavailable: 1.*Unavailable hosts may have servers missing/s);
});

test('refresh observations update summary and selected absent status keeps its value with zero count', () => {
  const data = fixture();
  data.live.set('a:ready', {state: 'exited'});
  const html = serverCollection(data, false, {...filters, status: 'Ready'});
  assert.match(html, /Showing 0 of 8 servers/);
  assert.match(html, /value="Ready" selected>Ready \(0\)/);
  assert.match(summary(html), /Stopped: 2/);
  assert.doesNotMatch(summary(html), /Ready: /);
});

test('assigned accounts retain minimal output with no status or completeness disclosures', () => {
  const html = serverCollection({...fixture(), assigned: true}, false, {...filters, status: 'Ready'});
  assert.equal(summary(html), undefined);
  assert.doesNotMatch(html, /Loaded availability|Most recently received|Host unavailable|Filter by status|Unavailable hosts|Ready \(/);
  assert.match(html, /Showing 8 of 8 servers/);
});
