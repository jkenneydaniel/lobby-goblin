import test from 'node:test';
import assert from 'node:assert/strict';
import {serverCards, serverTable} from '../public/fleet/cards.js';
import {createFleetModel} from '../public/fleet/model.js';

const server = (patch = {}) => ({id: 'same', hostId: 'local', hostName: 'Local', name: 'Factory', game: 'factorio', state: 'installed', cpu: 2, memoryGiB: 4, manageUrl: '/servers/same/', ...patch});
const snapshot = (patch = {}) => ({servers: [server()], hosts: [{id: 'local', connected: true}], live: new Map([['local:same', {running: true, ready: true, cpu: 240, memory: 1.5 * 1024 ** 3}]]), hostJobs: new Map(), ...patch});
const renders = [serverCards, serverTable];

test('cards and table show scoped mixed game/application samples alongside configured limits', () => {
  const data = snapshot({
    servers: [server(), server({hostId: 'remote', hostName: 'Remote', name: 'Rust crew', game: 'rust', manageUrl: '/hosts/remote/servers/same/'}), server({id: 'service', game: 'status-page', applicationName: 'Status Page', applicationKind: 'application'})],
    hosts: [{id: 'local', connected: true}, {id: 'remote', connected: true}],
    live: new Map([
      ['local:same', {running: true, ready: true, cpu: 0, memory: 0, players: ['one']}],
      ['remote:same', {running: true, ready: false, cpu: 240, memory: 1.5 * 1024 ** 3, players: 2}],
      ['local:service', {running: true, ready: true, cpu: 12.34, memory: 512 * 1024 ** 2}],
    ]),
  });
  for (const render of renders) {
    const html = render(data, false);
    assert.match(html, />0%</); assert.match(html, /0 B/);
    assert.match(html, /240%/); assert.match(html, /1.5 GiB/);
    assert.match(html, /12.3%/); assert.match(html, /512.0 MiB/);
    assert.match(html, /2 cores/); assert.match(html, /4 GiB/);
    assert.match(html, /Most recently received resource sample/);
    assert.match(html, /100% = one core/); assert.match(html, /Memory is container usage/);
    assert.match(html, /Starting/); assert.match(html, /Manage application/);
    assert.match(html, /href="\/hosts\/remote\/servers\/same\/"/);
    assert.doesNotMatch(html, /data-remove|data-snapshot/);
    const localOnly = render({...data, servers: [data.servers[0]]}, false);
    assert.match(localOnly, />0%</); assert.doesNotMatch(localOnly, /240%|1.5 GiB/);
    const remoteOnly = render({...data, servers: [data.servers[1]]}, false);
    assert.match(remoteOnly, /240%/); assert.doesNotMatch(remoteOnly, />0%/);
  }
});

test('each optional sample independently rejects missing, null, nonfinite, negative and nonnumeric data', () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, '240', '', false, {}, []]) {
    for (const render of renders) {
      for (const [cpu, memory] of [[invalid, invalid], [invalid, 1024], [100, invalid]]) {
        const html = render(snapshot({live: new Map([['local:same', {running: true, cpu, memory}]])}), false);
        assert.equal((html.match(/Unavailable/g) || []).length, (cpu === 100 || memory === 1024) ? 1 : 2);
        if (memory === 1024) assert.match(html, /1.0 KiB/);
        if (cpu === 100) assert.match(html, />100%</);
        assert.doesNotMatch(html, /NaN|Infinity|\[object Object\]/);
      }
    }
  }
});

test('retained samples are unavailable for removed, stopped, missing status and unavailable hosts or servers', () => {
  const sample = {running: true, ready: true, cpu: 240, memory: 1.5 * 1024 ** 3};
  const patches = [
    {servers: [server({state: 'removed'})]},
    {servers: [server({state: 'creating'})]},
    {servers: [server({state: 'stopped'})]},
    {servers: [server({unavailable: true})]},
    {hosts: []}, {hosts: [{id: 'local', connected: false}]},
    {live: new Map()},
    ...[{...sample, running: false}, {...sample, running: undefined}, {...sample, state: 'exited'}].map(value => ({live: new Map([['local:same', value]])})),
  ];
  for (const render of renders) for (const patch of patches) {
    const html = render(snapshot(patch), true);
    assert.equal((html.match(/Unavailable/g) || []).length, 2);
    assert.doesNotMatch(html, /240%|1.5 GiB/);
  }
});

test('busy hosts retain read-only samples and existing action fences; assigned cards disclose no resources', () => {
  for (const render of renders) {
    const busy = render(snapshot({hostJobs: new Map([['local', {id: 'busy'}]])}), true);
    assert.match(busy, /240%/); assert.match(busy, /data-snapshot="local:same" disabled/); assert.match(busy, /data-remove="local:same" disabled/);
    const assigned = render(snapshot({assigned: true}), false);
    assert.doesNotMatch(assigned, /sample|CPU|memory|240%|1.5 GiB|2 cores|4 GiB|<table/);
    assert.match(assigned, /Open server/);
  }
});

test('two-stage model refresh keeps samples fenced on host failure and deletes failed status samples', async () => {
  const user = {role: 'viewer'}, publications = [];
  let hostOnline = true, statusAvailable = true;
  const model = createFleetModel({getSession: () => user,
    request: async route => {
      if (route === '/hosts') return {hosts: [{id: 'local', name: 'Local', local: true, connected: hostOnline}]};
      if (route === '/servers') return {servers: [server()]};
      if (route === '/snapshots') return {snapshots: []};
      if (route === '/jobs') return {jobs: [], active: null};
      throw Error('Unexpected request: ' + route);
    },
    fetchStatus: async () => statusAvailable ? {running: true, ready: true, cpu: 240, memory: 1.5 * 1024 ** 3} : null,
    onChange: value => publications.push(renders.map(render => render(value, false))),
  });
  await model.refresh();
  assert.equal(publications.length, 2);
  for (const html of publications[1]) assert.match(html, /240%/);
  hostOnline = false; publications.length = 0; await model.refresh();
  assert.equal(publications.length, 2);
  for (const phase of publications) for (const html of phase) assert.doesNotMatch(html, /240%|1.5 GiB/);
  hostOnline = true; statusAvailable = false; publications.length = 0; await model.refresh();
  assert.equal(publications.length, 2);
  for (const html of publications[1]) assert.doesNotMatch(html, /240%|1.5 GiB/);
  assert.equal(model.snapshot.live.size, 0);
});
