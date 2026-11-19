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
const chip = (html, value) => {
  const buttons = html.match(/<button[^>]*data-server-choice="status"[^>]*>.*?<\/button>/g) || [];
  return buttons.find(button => button.includes('value="' + value + '"'));
};
const count = (html, value, total, pressed = false) => {
  const button = chip(html, value);
  assert.ok(button, 'Missing status: ' + value);
  assert.ok(button.includes('aria-pressed="' + pressed + '"'));
  assert.ok(button.includes('<strong>' + total + '</strong>'));
};

test('status chips share displayed states and scoped IDs without mutating source', () => {
  const data = fixture(), before = structuredClone(data);
  for (const view of ['cards', 'table']) {
    const html = serverCollection(data, false, {...filters, view});
    for (const status of ['Ready', 'Starting', 'Stopped', 'Needs attention', 'Creating', 'Checking', 'Removed · data kept', 'Host unavailable'])
      count(html, status, 1);
    count(html, '', 8, true);
    assert.match(html, /Unavailable hosts may have servers missing/);
  }
  assert.deepEqual(data, before);
});

test('status counts follow search, application and host while retaining the selected status', () => {
  const data = fixture();
  const chosen = {...filters, search: 'ready', application: 'factorio', host: 'a', status: 'Stopped'};
  const html = serverCollection(data, true, chosen);
  assert.match(html, /Showing 0 of 8 servers/);
  count(html, '', 1);
  count(html, 'Ready', 1);
  count(html, 'Stopped', 0, true);
  assert.doesNotMatch(html, /Unavailable hosts may have servers missing/);
  const noMatches = serverCollection(data, false, {...filters, search: '<missing>'});
  count(noMatches, '', 0, true);
  assert.match(noMatches, /No matching servers/);
  count(serverCollection(data, false, {...filters, status: 'Old <state>'}), 'Old &lt;state&gt;', 0, true);
});

test('cold unavailable hosts disclose incomplete loaded inventory even without cached servers', () => {
  const data = {...fixture(), servers: [], live: new Map()};
  const html = serverCollection(data, false, filters);
  count(html, '', 0, true);
  assert.match(html, /Unavailable hosts may have servers missing/);
  assert.doesNotMatch(serverCollection(data, false, {...filters, host: 'a'}), /Unavailable hosts/);
  const cached = fixture(); cached.hosts[1].connected = true; cached.servers[7].unavailable = true;
  const fallback = serverCollection(cached, false, filters);
  count(fallback, 'Host unavailable', 1);
  assert.match(fallback, /Unavailable hosts may have servers missing/);
});

test('refresh observations update the counts and preserve an absent status at zero', () => {
  const data = fixture();
  data.live.set('a:ready', {state: 'exited'});
  const html = serverCollection(data, false, {...filters, status: 'Ready'});
  assert.match(html, /Showing 0 of 8 servers/);
  count(html, 'Ready', 0, true);
  count(html, 'Stopped', 2);
});

test('assigned accounts retain minimal output with no status or completeness disclosures', () => {
  const html = serverCollection({...fixture(), assigned: true}, false, {...filters, status: 'Ready'});
  assert.doesNotMatch(html, /data-server-choice="status"|Most recently received|Host unavailable|Filter by status|Unavailable hosts/);
  assert.match(html, /Showing 8 of 8 servers/);
});
