import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApplicationReleases,
  boundedJSON,
} from '../core/application-releases.js';
import {parseHeadlessChecksums, headlessChecksums} from '../applications/factorio/headless-releases.js';

const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: {'content-type': 'application/json'},
  });
const checksums = (...versions) => new Response(versions.map(version => 'a'.repeat(64) + '  factorio-headless_linux_' + version + '.tar.xz').join('\n'), {headers:{'content-type':'text/plain'}});
test('Factorio separates latest upstream versions from published supported images and sorts revisions', async () => {
  const calls = [];
  const service = new ApplicationReleases({
    fetcher: async (url, options) => {
      calls.push(url);
      if (url.includes('latest-releases'))
        return json({
          stable: {headless: '2.1.23'},
          experimental: {headless: '2.1.24'},
        });
      if (url.includes('/token?'))
        return json({token: 'public-registry-token'});
      assert.equal(
        options.headers.authorization,
        'Bearer public-registry-token',
      );
      return json({
        name: 'jkenneydaniel/factorio-server',
        tags: [
          '2.0.77-fc.2',
          'latest',
          '2.0.76-fc.1',
          '2.1.23-fc.1',
          '2.0.77-fc.3',
          'evil:tag',
        ],
      });
    },
  });
  const [a, b] = await Promise.all([
    service.read('factorio'),
    service.read('factorio'),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
  assert.equal(a.stable, '2.1.23');
  assert.deepEqual(
    a.choices.map((value) => value.imageRevision),
    [3, 2, 1],
  );
  assert.ok(
    a.choices.every((value) =>
      value.image.startsWith('ghcr.io/jkenneydaniel/factorio-server:2.0.'),
    ),
  );
  await service.read('factorio');
  assert.equal(calls.length, 3);
});
test('registry failure retains upstream discovery without offering unverified install choices', async () => {
  const service = new ApplicationReleases({
    fetcher: async (url) =>
      url.includes('latest-releases')
        ? json({stable: {headless: '2.0.77'}})
        : new Response('<html>login</html>', {
            status: 200,
            headers: {'content-type': 'text/html'},
          }),
  });
  const value = await service.read('factorio');
  assert.equal(value.stable, '2.0.77');
  assert.deepEqual(value.choices, []);
  assert.match(value.imageError, /could not be checked/);
});
test('offline errors cache and stale catalogues cannot be mistaken for a current result', async () => {
  let calls = 0,
    now = 1000,
    offline = false;
  const service = new ApplicationReleases({
    now: () => now,
    fetcher: async () => {
      calls++;
      if (offline) throw Error('secret upstream details');
      return json({appnews: {appid: 252490, newsitems: []}});
    },
  });
  assert.equal((await service.read('rust')).stale, false);
  now += 16 * 60000;
  offline = true;
  const value = await service.read('rust');
  assert.equal(value.stale, true);
  assert.equal(value.updateAvailable, null);
  assert.ok(!JSON.stringify(value).includes('secret'));
  await service.read('rust');
  assert.equal(calls, 2);
  await assert.rejects(service.read('unknown'), /supported application/);
});
test('Steam announcements are bounded plain text and never imply build availability', async () => {
  const service = new ApplicationReleases({
    fetcher: async () =>
      json({
        appnews: {
          appid: 252490,
          newsitems: [
            {
              gid: '12345',
              title: '<script>unsafe</script>',
              url: 'javascript:alert(1)',
              contents: 'notes',
              date: 1000,
            },
          ],
        },
      }),
  });
  const value = await service.read('rust');
  assert.equal(value.updateAvailable, null);
  assert.deepEqual(value.choices, []);
  assert.equal(
    value.news[0].url,
    'https://store.steampowered.com/news/app/252490/view/12345',
  );
});
test('release fetches reject HTML, oversized bodies, status failures and redirects', async () => {
  for (const response of [
    new Response('bad', {status: 503}),
    new Response('{}', {headers: {'content-type': 'text/html'}}),
    new Response('x'.repeat(2 * 1024 ** 2 + 1), {
      headers: {'content-type': 'application/json'},
    }),
  ])
    await assert.rejects(
      boundedJSON(async (_url, options) => {
        assert.equal(options.redirect, 'error');
        return response;
      }, 'https://example.test'),
    );
});
test('runtime-installed Factorio discovers software versions independently of image publication', async () => {
  const calls = [],
    service = new ApplicationReleases({
      fetcher: async (url) => {
        calls.push(url);
        if (url === 'https://factorio.com/download/sha256sums/') return checksums('2.0.76','2.0.77','2.1.23','2.1.24');
        assert.ok(url.includes('factorio.com/api/latest-releases'));
        return json({
          stable: {headless: '2.1.23'},
          experimental: {headless: '2.1.24'},
        });
      },
    });
  const software = {
    version: 1,
    mode: 'runtime',
    provider: 'factorio-headless',
    initial: {channel: 'stable'},
    storage: 'application-volume',
    updates: 'manual',
  };
  const value = await service.read('factorio', software);
  assert.equal(calls.length, 2);
  assert.equal(value.software.updateKind, 'software');
  assert.equal(value.requiresImageChange, false);
  assert.equal(value.console, null, 'Stable is never inferred to be the console release.');
  assert.deepEqual(
    value.choices.map((choice) => choice.version),
    ['2.1.24', '2.1.23', '2.0.77', '2.0.76'],
  );
  assert.ok(
    value.choices.every(
      (choice) =>
        choice.kind === 'software' &&
        choice.image === undefined &&
        choice.downloadUrl.startsWith('https://factorio.com/get-download/'),
    ),
  );
});
test('image and runtime delivery have separate caches and equal stable/experimental versions are not duplicated', async () => {
  const service = new ApplicationReleases({
    fetcher: async (url) =>
      url.includes('sha256sums') ? checksums('2.1.23') : url.includes('latest-releases')
        ? json({
            stable: {headless: '2.1.23'},
            experimental: {headless: '2.1.23'},
          })
        : url.includes('/token?')
          ? json({token: 'registry'})
          : json({
              name: 'jkenneydaniel/factorio-server',
              tags: ['2.0.77-fc.3'],
            }),
  });
  const image = await service.read('factorio');
  const runtime = await service.read('factorio', {
    version: 1,
    mode: 'runtime',
    provider: 'factorio-headless',
    initial: {channel: 'stable'},
    storage: 'application-volume',
    updates: 'manual',
  });
  assert.equal(image.choices[0].imageRevision, 3);
  assert.equal(runtime.choices.length, 1);
  assert.equal(runtime.choices[0].channel, 'stable');
  assert.equal(runtime.choices[0].version, '2.1.23');
});

test('console metadata is independent of stable and labels only an officially listed headless release',async()=>{
  const service=new ApplicationReleases({fetcher:async url=>url.includes('sha256sums')?checksums('2.0.77','2.1.23'):json({stable:{headless:'2.1.23'},console:{headless:'2.0.77'}})});
  const value=await service.read('factorio',{version:1,mode:'runtime',provider:'factorio-headless',initial:{channel:'stable'},storage:'application-volume',updates:'manual'});
  assert.equal(value.console,'2.0.77');
  assert.deepEqual(value.choices.find(choice=>choice.version==='2.0.77').channels,['console']);
  assert.deepEqual(value.choices.find(choice=>choice.version==='2.1.23').channels,['stable']);
});
test('headless inventory excludes unrelated binaries and unsupported releases; ambiguous inventories fail closed',async()=>{
  const sha='a'.repeat(64),line=version=>sha+'  factorio-headless_linux_'+version+'.tar.xz';
  assert.deepEqual([...parseHeadlessChecksums([line('2.0.77'),sha+'  factorio_linux_2.1.23.tar.xz',line('1.1.110')].join('\n')).keys()],['2.0.77']);
  for(const body of [line('2.0.77')+'\n'+line('2.0.77'),'invalid  factorio-headless_linux_2.0.77.tar.xz','<html>not checksums</html>'])assert.throws(()=>parseHeadlessChecksums(body));
  for(const response of [new Response('unavailable',{status:503}),new Response(line('2.0.77'),{headers:{'content-type':'text/html'}}),new Response('x'.repeat(2*1024**2+1),{headers:{'content-type':'text/plain'}})])await assert.rejects(headlessChecksums(async(_url,options)=>{assert.equal(options.redirect,'error');return response;}));
});
