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

const sampledFleet = () => {
  const servers = [
    {...item('b', 'same', 'High CPU'), cpu: 0.1, memoryGiB: 100},
    {...item('a', 'same', 'Zulu rounded'), cpu: 99, memoryGiB: 0.1},
    item('a', 'lower', 'Alpha rounded'),
    item('a', 'zero', 'Zero'),
    item('a', 'unknown', 'Unknown'),
  ].map(Object.freeze);
  return {
    ...snapshot,
    servers: Object.freeze(servers),
    live: new Map([
      ['b:same', Object.freeze({running: true, cpu: 240, memory: 1024})],
      [
        'a:same',
        Object.freeze({running: true, cpu: 12.34, memory: 1.5 * 1024 ** 3}),
      ],
      [
        'a:lower',
        Object.freeze({running: true, cpu: 12.31, memory: 512 * 1024 ** 2}),
      ],
      ['a:zero', Object.freeze({running: true, cpu: 0, memory: 0})],
      ['a:unknown', Object.freeze({running: true, cpu: null, memory: -1})],
    ]),
  };
};

test('resource order uses eligible raw numbers, zero before unknown and independent memory units without mutation', () => {
  const data = sampledFleet(),
    before = structuredClone(data);
  assert.deepEqual(
    keys(selectServers(data, {...filters, sort: 'sample-cpu'})),
    ['b:same', 'a:same', 'a:lower', 'a:zero', 'a:unknown'],
  );
  assert.deepEqual(
    keys(selectServers(data, {...filters, sort: 'sample-memory'})),
    ['a:same', 'a:lower', 'b:same', 'a:zero', 'a:unknown'],
  );
  assert.deepEqual(
    keys(
      selectServers(data, {
        ...filters,
        sort: 'sample-cpu',
        search: 'rounded',
        application: 'factorio',
        host: 'a',
        status: 'Starting',
      }),
    ),
    ['a:same', 'a:lower'],
  );
  assert.deepEqual(data, before);
});

test('resource order shares unavailable gates with display and does not suppress busy samples', () => {
  const first = item('a', 'high', 'Alpha'),
    zero = item('b', 'zero', 'Zulu');
  const good = {running: true, cpu: 999, memory: 999};
  const data = {
    ...snapshot,
    servers: [first, zero],
    live: new Map([
      ['a:high', good],
      ['b:zero', {running: true, cpu: 0, memory: 0}],
    ]),
  };
  const patches = [
    ...['removed', 'creating', 'stopped'].map((state) => ({
      servers: [{...first, state}, zero],
    })),
    {servers: [{...first, unavailable: true}, zero]},
    {
      hosts: [
        {id: 'a', connected: false},
        {id: 'b', connected: true},
      ],
    },
    {hosts: [{id: 'b', connected: true}]},
    ...[false, undefined, 1].map((running) => ({
      live: new Map([
        ['a:high', {...good, running}],
        ['b:zero', {running: true, cpu: 0, memory: 0}],
      ]),
    })),
    {
      live: new Map([
        ['a:high', {...good, state: 'exited'}],
        ['b:zero', {running: true, cpu: 0, memory: 0}],
      ]),
    },
    {live: new Map([['b:zero', {running: true, cpu: 0, memory: 0}]])},
  ];
  for (const sort of ['sample-cpu', 'sample-memory']) {
    for (const patch of patches)
      assert.deepEqual(
        keys(selectServers({...data, ...patch}, {...filters, sort})),
        ['b:zero', 'a:high'],
      );
    for (const state of ['installed', 'starting', 'attention'])
      assert.deepEqual(
        keys(
          selectServers(
            {
              ...data,
              servers: [{...first, state}, zero],
              hostJobs: new Map([['a', {id: 'busy'}]]),
            },
            {...filters, sort},
          ),
        ),
        ['a:high', 'b:zero'],
      );
  }
});

test('invalid CPU and memory remain independently unavailable for ordering', () => {
  const data = sampledFleet();
  const servers = [data.servers[0], data.servers[3]];
  for (const invalid of [
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    -1,
    '240',
    '',
    false,
    {},
    [],
  ]) {
    for (const [cpu, memory, cpuOrder, memoryOrder] of [
      [invalid, 1024, ['a:zero', 'b:same'], ['b:same', 'a:zero']],
      [100, invalid, ['b:same', 'a:zero'], ['a:zero', 'b:same']],
    ]) {
      const patch = {
        ...data,
        servers,
        live: new Map([
          ['b:same', {running: true, cpu, memory}],
          ['a:zero', {running: true, cpu: 0, memory: 0}],
        ]),
      };
      assert.deepEqual(
        keys(selectServers(patch, {...filters, sort: 'sample-cpu'})),
        cpuOrder,
      );
      assert.deepEqual(
        keys(selectServers(patch, {...filters, sort: 'sample-memory'})),
        memoryOrder,
      );
    }
  }
});

test('resource ties use ascending name, scoped key and management URL even when all samples are unavailable', () => {
  const servers = [
    {...item('b', 'same', 'alpha'), manageUrl: '/z/'},
    {...item('a', 'same', 'Alpha'), manageUrl: '/z/'},
    {...item('a', 'same', 'Alpha'), manageUrl: '/a/'},
    item('a', 'last', 'Zulu'),
  ];
  for (const live of [
    new Map(),
    new Map([
      ['b:same', {running: true, cpu: 1, memory: 1}],
      ['a:same', {running: true, cpu: 1, memory: 1}],
      ['a:last', {running: true, cpu: 1, memory: 1}],
    ]),
  ])
    for (const sort of ['sample-cpu', 'sample-memory'])
      for (const source of [servers, [...servers].reverse()])
        assert.deepEqual(
          selectServers(
            {...snapshot, servers: source, live},
            {...filters, sort},
          ).map((row) => row.hostId + ':' + row.id + ':' + row.manageUrl),
          [
            'a:same:/a/',
            'a:same:/z/',
            'b:same:/z/',
            'a:last:/hosts/a/servers/last/',
          ],
        );
});

test('assigned resource sorts retain source order without consulting hidden hosts or metrics, and choices remain hidden', () => {
  const assigned = {...snapshot, assigned: true};
  Object.defineProperties(assigned, {
    hosts: {
      get() {
        throw Error('Assigned sort accessed hosts');
      },
    },
    live: {
      get() {
        throw Error('Assigned sort accessed metrics');
      },
    },
  });
  for (const sort of ['sample-cpu', 'sample-memory']) {
    assert.deepEqual(selectServers(assigned, {...filters, sort}), records);
    const html = serverCollection(
      {
        ...snapshot,
        assigned: true,
        hosts: [],
        live: {
          get() {
            throw Error('Assigned render accessed metrics');
          },
        },
      },
      false,
      {...filters, sort},
    );
    assert.doesNotMatch(
      html,
      /sample-cpu|sample-memory|Sampled CPU|Sampled memory|resource-sample/,
    );
    assert.match(html, /Showing 4 of 4 servers/);
  }
});
