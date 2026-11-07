import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = {pathname: '/'};
const {backupHealthView: view} = await import('../public/shared/backups.js');
delete globalThis.location;

const observed = '2026-11-07T10:12:13.000Z';
const field = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;

test('existing observations render labelled inventory, successful integrity, attempt, schedule and storage fields', () => {
  const result = view({
    alerts: ['Existing warning'],
    count: 4,
    totalBytes: 2048,
    lastVerifiedAt: observed,
    lastAttempt: {state: 'succeeded', finished: observed},
    nextScheduledAt: observed,
    storage: {freeBytes: 1024},
    verifiedCount: 3,
    latestAt: observed,
  });
  for (const [label, value] of [
    ['Loaded archives', '4'],
    ['Loaded archive size', '2.0 KiB'],
    ['Latest successful integrity check', new Date(observed).toLocaleString()],
    ['Last recorded backup attempt', 'Succeeded'],
    ['Finished', new Date(observed).toLocaleString()],
    ['Next scheduled backup (reported)', new Date(observed).toLocaleString()],
    ['Observed free backup storage', '1.0 KiB'],
  ])
    assert.ok(result.includes(field(label, value)));
  assert.ok(result.includes('Existing warning'));
  assert.ok(
    result.includes(
      '3 verified archives · Latest backup: ' +
        new Date(observed).toLocaleString(),
    ),
  );
  assert.match(result, /does not prove game-load recovery/);
  assert.match(result, /not an execution guarantee/);
});

test('real numeric zeros remain visible while invalid numeric observations remain unknown', () => {
  const zero = view({
    count: 0,
    totalBytes: 0,
    verifiedCount: 0,
    storage: {freeBytes: 0},
  });
  assert.ok(zero.includes(field('Loaded archives', '0')));
  assert.ok(zero.includes(field('Loaded archive size', '0 B')));
  assert.ok(zero.includes(field('Observed free backup storage', '0 B')));
  assert.match(zero, /0 verified archives/);
  for (const value of [
    null,
    undefined,
    false,
    true,
    '0',
    -1,
    NaN,
    Infinity,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    {},
  ]) {
    const result = view({
      count: value,
      totalBytes: value,
      verifiedCount: value,
      storage: {freeBytes: value},
    });
    for (const label of [
      'Loaded archives',
      'Loaded archive size',
      'Observed free backup storage',
    ])
      assert.ok(result.includes(field(label, 'Unknown')));
    assert.match(result, /Unknown verified archives/);
  }
});

test('missing, scalar and legacy health observations are honestly unavailable or unknown', () => {
  for (const value of [null, undefined, false, 'PRIVATE', 1, []])
    assert.match(view(value), /Backup health observations unavailable/);
  for (const nested of [null, undefined, true, 1, 'PRIVATE', []]) {
    const result = view({lastAttempt: nested, storage: nested});
    for (const label of [
      'Last recorded backup attempt',
      'Finished',
      'Observed free backup storage',
    ])
      assert.ok(result.includes(field(label, 'Unknown')));
    assert.doesNotMatch(result, /PRIVATE/);
  }
  assert.ok(view({}).includes(field('Loaded archives', 'Unknown')));
});

test('invalid dates never display invented times or raw input', () => {
  for (const value of [
    null,
    undefined,
    '',
    'PRIVATE-INVALID',
    {},
    [],
    false,
    0,
  ]) {
    const result = view({
      lastVerifiedAt: value,
      latestAt: value,
      nextScheduledAt: value,
      lastAttempt: {finished: value},
    });
    for (const label of [
      'Latest successful integrity check',
      'Finished',
      'Next scheduled backup (reported)',
    ])
      assert.ok(result.includes(field(label, 'Unknown')));
    assert.match(result, /Latest backup: Unknown/);
    assert.doesNotMatch(result, /PRIVATE-INVALID|Invalid Date/);
  }
});

test('attempt states use fixed labels and never read raw messages or unrelated metadata', () => {
  for (const [state, label] of [
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['interrupted', 'Interrupted'],
    ['PRIVATE-STATE', 'Unknown'],
    ['constructor', 'Unknown'],
    [{state: 'PRIVATE'}, 'Unknown'],
  ]) {
    const attempt = {
      state,
      get message() {
        throw Error('must not read message');
      },
      get error() {
        throw Error('must not read error');
      },
    };
    const result = view({
      lastAttempt: attempt,
      privatePath: '/PRIVATE/path',
      software: {name: 'PRIVATE-SOFTWARE'},
      storage: {path: '/PRIVATE/storage'},
    });
    assert.ok(result.includes(field('Last recorded backup attempt', label)));
    assert.doesNotMatch(result, /PRIVATE|constructor|\[object Object\]/);
  }
});

test('accepted existing alert text remains escaped while malformed alert values are not coerced', () => {
  const result = view({
    alerts: [
      'Existing attempt warning: <img src=x> & reason',
      {raw: 'PRIVATE-OBJECT'},
      null,
    ],
  });
  assert.match(
    result,
    /Existing attempt warning: &lt;img src=x&gt; &amp; reason/,
  );
  assert.doesNotMatch(result, /<img|PRIVATE-OBJECT|\[object Object\]/);
  assert.doesNotThrow(() => view({alerts: 'PRIVATE'}));
  assert.doesNotMatch(view({alerts: 'PRIVATE'}), /PRIVATE/);
});
