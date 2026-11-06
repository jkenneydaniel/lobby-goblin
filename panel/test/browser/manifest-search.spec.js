import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page),
      errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origins.fleet)
        return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      await use(page);
    } finally {
      page.manifestState?.releaseRemote?.();
      await routes.dispose();
    }
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  },
});
const local = 'a'.repeat(32),
  remote = 'd'.repeat(32),
  shared = 'f'.repeat(32);
const targetName = 'mods/Ünicode[世界]/Target.*<x>&+.cfg';
const query = (page) =>
  page.getByRole('searchbox', {name: 'Find files', exact: true});
const libraryQuery = (page) =>
  page.getByRole('searchbox', {name: 'Find snapshots', exact: true});
const disclosure = (page) => page.locator('[data-manifest-files]');
const count = (page) => page.locator('[data-file-count]');
const rows = (page) => page.locator('[data-file-results] tbody tr');
const nav = (page) => page.getByRole('navigation', {name: /navigation/});
const card = (page, title) =>
  page
    .locator('#snapshots article.card')
    .filter({has: page.getByRole('heading', {name: title, exact: true})});
async function login(page, user = 'Preview') {
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page
    .getByLabel('Password', {exact: true})
    .fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
  if (user !== 'Assigned')
    await nav(page)
      .getByRole('link', {name: 'Snapshot library', exact: true})
      .click();
}
async function logout(page) {
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Username', {exact: true})).toBeVisible();
}
async function fixture(page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL),
      blobs = new Map();
    globalThis.manifestCaptures = [];
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      blobs.set(url, blob);
      return url;
    };
    const click = globalThis.HTMLAnchorElement.prototype.click;
    globalThis.HTMLAnchorElement.prototype.click = function () {
      if (this.download.startsWith('snapshot-')) {
        globalThis.manifestCaptures.push({
          filename: this.download,
          blob: blobs.get(this.href),
        });
        return;
      }
      return click.call(this);
    };
  });
  const record = (title, sourceName) => ({
    id: shared,
    title,
    sourceName,
    game: 'factorio',
    image: 'synthetic-image',
    created: '2026-01-01T12:00:00Z',
    bytes: 1024,
    files: 246,
  });
  const state = {
    hosts: [
      {id: local, name: 'This host', local: true, connected: true},
      {id: remote, name: 'Weekend host', connected: true},
    ],
    local: [record('Local snapshot', 'Local source')],
    remote: [record('Remote snapshot <safe>', 'Remote source <safe>')],
    reads: 0,
    inspected: [],
    active: null,
    remoteManifest: {
      format: 'synthetic-manifest',
      id: shared,
      files: [
        ...Array.from({length: 245}, (_, index) => ({
          name: 'chunks/part-' + index + '.dat',
          size: index,
          sha256: String(index).padStart(64, '0'),
        })),
        {name: targetName, size: 1024, sha256: 'e'.repeat(64)},
      ],
    },
    localManifest: {
      format: 'synthetic-manifest',
      id: shared,
      files: [{name: 'local/world.zip', size: 7, sha256: 'a'.repeat(64)}],
    },
  };
  page.manifestState = state;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/hosts') {
      state.reads++;
      return route.fulfill({json: {hosts: state.hosts}});
    }
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?servers$/.test(path))
      return route.fulfill({json: {servers: []}});
    if (path === '/api/snapshots')
      return route.fulfill({json: {snapshots: state.local}});
    if (path === '/api/hosts/' + remote + '/snapshots')
      return route.fulfill({json: {snapshots: state.remote}});
    if (/\/snapshots\/[a-f0-9]{32}$/.test(path)) {
      state.inspected.push(path);
      const isRemote = path.includes('/hosts/');
      if (isRemote && state.holdRemote) {
        state.remoteStarted = true;
        await new Promise((resolve) => {
          state.releaseRemote = resolve;
        });
      }
      if (isRemote && state.failRemote)
        return route.fulfill({
          status: 503,
          json: {error: 'Synthetic inspection unavailable'},
        });
      const item = isRemote ? state.remote[0] : state.local[0];
      return route.fulfill({
        json: {
          ...item,
          verifiedAt: '2026-01-02T12:00:00Z',
          manifest: isRemote ? state.remoteManifest : state.localManifest,
        },
      });
    }
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?jobs$/.test(path))
      return route.fulfill({
        json: {jobs: state.active ? [state.active] : [], active: state.active},
      });
    return route.fallback();
  });
  return state;
}
async function inspect(page, title) {
  await card(page, title)
    .getByRole('button', {name: 'View contents', exact: true})
    .click();
  await expect(page.locator('.snapshot-details h2')).toHaveText(title);
  await disclosure(page).locator('summary').click();
  await expect(query(page)).toBeVisible();
}

test('manifest find searches full names before cap, keeps local controls and downloads the original full manifest', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await login(page);
  await inspect(page, 'Remote snapshot <safe>');
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await expect(rows(page)).toHaveCount(200);
  await expect(count(page)).toHaveText(
    'Showing 200 of 246 matching files · 246 loaded files.',
  );
  await expect(page.locator('[data-file-cap]')).toBeVisible();
  const requests = [],
    downloads = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/'))
      requests.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
  page.on('download', (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await query(page).fill('chunks/');
  await expect(count(page)).toHaveText(
    'Showing 200 of 245 matching files · 246 loaded files.',
  );
  await expect(rows(page).first().locator('td').first()).toHaveText(
    'chunks/part-0.dat',
  );
  await expect(rows(page).last().locator('td').first()).toHaveText(
    'chunks/part-199.dat',
  );
  await query(page).fill('  TARGET.*<X>&+  ');
  await expect(count(page)).toHaveText(
    'Showing 1 of 1 matching files · 246 loaded files.',
  );
  await expect(rows(page).locator('td')).toHaveText([
    targetName,
    '1.0 KiB',
    'e'.repeat(64),
  ]);
  await expect(page.locator('[data-file-cap]')).toBeHidden();
  await query(page).evaluate((input) => {
    globalThis.manifestInput = input;
    input.setSelectionRange(2, 7);
  });
  for (const value of ['^mods', 'e'.repeat(64), '1024', 'Target.*cfg$']) {
    await query(page).fill(value);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('[data-file-results]')).toContainText(
      'No matching files in the loaded manifest.',
    );
  }
  await query(page).fill('Ünicode[世界]');
  await libraryQuery(page).fill('no library match');
  await expect(
    page.getByRole('heading', {name: 'No matching snapshots', exact: true}),
  ).toBeVisible();
  await expect(query(page)).toHaveValue('Ünicode[世界]');
  await expect(disclosure(page)).toHaveAttribute('open', '');
  await page
    .getByRole('button', {name: 'Clear file search', exact: true})
    .focus();
  await page.keyboard.press('Enter');
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue('');
  await expect(libraryQuery(page)).toHaveValue('no library match');
  await expect(rows(page)).toHaveCount(200);
  await query(page).fill('not found');
  await query(page).press('Escape');
  await expect(query(page)).toHaveValue('');
  await expect(libraryQuery(page)).toHaveValue('no library match');
  await query(page).evaluate((input) => {
    input.dispatchEvent(
      new globalThis.CompositionEvent('compositionstart', {bubbles: true}),
    );
    input.value = 'Ü';
    input.dispatchEvent(
      new globalThis.InputEvent('input', {bubbles: true, isComposing: true}),
    );
  });
  await expect(rows(page)).toHaveCount(200);
  await query(page).evaluate((input) => {
    input.value = 'üNICODE[世界]';
    input.dispatchEvent(
      new globalThis.CompositionEvent('compositionend', {bubbles: true}),
    );
  });
  await expect(rows(page)).toHaveCount(1);
  expect(
    await query(page).evaluate((input) => input === globalThis.manifestInput),
  ).toBe(true);
  await expect(disclosure(page)).toHaveAttribute('open', '');
  await expect(page.locator('.snapshot-details')).toContainText(
    'Remote source <safe>',
  );
  await expect(page.locator('.snapshot-details')).toContainText('Excluded');
  expect(requests).toEqual([]);
  expect(downloads).toEqual([]);
  await page
    .getByRole('button', {name: 'Download manifest', exact: true})
    .click();
  const captured = await page.evaluate(async () => ({
    filename: globalThis.manifestCaptures[0].filename,
    type: globalThis.manifestCaptures[0].blob.type,
    text: await globalThis.manifestCaptures[0].blob.text(),
  }));
  expect(captured).toEqual({
    filename: 'snapshot-' + shared + '.manifest.json',
    type: 'application/json',
    text: JSON.stringify(state.remoteManifest, null, 2),
  });
  expect(JSON.parse(captured.text).files).toHaveLength(246);
  expect(requests).toEqual([]);
  expect(downloads).toEqual([]);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('manifest-name-find.png'),
    fullPage: true,
  });
});

test('manifest query and disclosure survive ordinary repaint while scoped selection, close, removal and session reset them', async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  await inspect(page, 'Remote snapshot <safe>');
  await query(page).fill('üNICODE[世界]');
  await query(page).evaluate((input) => {
    globalThis.manifestInput = input;
    input.focus();
    input.setSelectionRange(1, 4);
  });
  let before = state.reads;
  await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue('üNICODE[世界]');
  expect(
    await query(page).evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([1, 4]);
  expect(
    await query(page).evaluate((input) => input === globalThis.manifestInput),
  ).toBe(true);
  await expect(disclosure(page)).toHaveAttribute('open', '');
  expect(state.inspected).toHaveLength(1);
  await query(page).evaluate((input) => {
    input.dispatchEvent(
      new globalThis.CompositionEvent('compositionstart', {bubbles: true}),
    );
    input.value = '世';
    input.dispatchEvent(
      new globalThis.InputEvent('input', {bubbles: true, isComposing: true}),
    );
  });
  before = state.reads;
  await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  expect(
    await query(page).evaluate(
      (input) => input === globalThis.manifestInput && input.isConnected,
    ),
  ).toBe(true);
  await query(page).evaluate((input) => {
    input.value = '世界';
    input.dispatchEvent(
      new globalThis.CompositionEvent('compositionend', {bubbles: true}),
    );
  });
  await expect(rows(page)).toHaveCount(1);
  await expect(query(page)).toBeFocused();
  await page.getByRole('button', {name: 'Close details', exact: true}).click();
  await expect(query(page)).toHaveCount(0);
  await inspect(page, 'Local snapshot');
  await expect(query(page)).toHaveValue('');
  await expect(rows(page).locator('td').first()).toHaveText('local/world.zip');
  await query(page).fill('local');
  await inspect(page, 'Remote snapshot <safe>');
  await expect(query(page)).toHaveValue('');
  expect(state.inspected.slice(0, 3)).toEqual([
    '/api/hosts/' + remote + '/snapshots/' + shared,
    '/api/snapshots/' + shared,
    '/api/hosts/' + remote + '/snapshots/' + shared,
  ]);
  await query(page).fill('Target');
  const removed = state.remote;
  state.remote = [];
  await page.clock.fastForward(6000);
  await expect(query(page)).toHaveCount(0);
  state.remote = removed;
  await page.clock.fastForward(6000);
  await inspect(page, 'Remote snapshot <safe>');
  await expect(query(page)).toHaveValue('');
  await logout(page);
  await login(page, 'Viewer');
  await expect(query(page)).toHaveCount(0);
  await expect(page.locator('#snapshots article.card button')).toHaveCount(0);
  await logout(page);
  await login(page, 'Assigned');
  await expect(
    nav(page).getByRole('link', {name: 'Snapshot library', exact: true}),
  ).toHaveCount(0);
  await expect(query(page)).toHaveCount(0);
});

test('manifest find retains existing stale inspection, error, offline and busy fences and distinguishes empty inventory', async ({
  page,
}) => {
  const state = await fixture(page);
  await login(page);
  state.holdRemote = true;
  await card(page, 'Remote snapshot <safe>')
    .getByRole('button', {name: 'View contents', exact: true})
    .click();
  await expect.poll(() => state.remoteStarted).toBe(true);
  await expect(page.locator('#snapshots')).toContainText(
    'Verifying snapshot files',
  );
  await inspect(page, 'Local snapshot');
  await query(page).fill('world');
  state.holdRemote = false;
  state.releaseRemote();
  await expect(page.locator('.snapshot-details h2')).toHaveText(
    'Local snapshot',
  );
  await expect(query(page)).toHaveValue('world');
  state.failRemote = true;
  await card(page, 'Remote snapshot <safe>')
    .getByRole('button', {name: 'View contents', exact: true})
    .click();
  await expect(page.locator('#snapshots')).toContainText(
    'Synthetic inspection unavailable',
  );
  await expect(query(page)).toHaveCount(0);
  state.failRemote = false;
  state.active = {
    id: 'busy',
    state: 'running',
    action: 'create',
    message: 'Synthetic host busy',
  };
  await page.clock.fastForward(6000);
  const remoteCard = card(page, 'Remote snapshot <safe>');
  await expect(
    remoteCard.getByRole('button', {name: 'Delete snapshot', exact: true}),
  ).toBeDisabled();
  await expect(
    remoteCard.getByRole('button', {
      name: 'Create server on this host',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    remoteCard.getByRole('button', {name: 'View contents', exact: true}),
  ).toBeEnabled();
  await inspect(page, 'Remote snapshot <safe>');
  await query(page).fill('Target');
  state.hosts[1].connected = false;
  await page.clock.fastForward(6000);
  await expect(remoteCard).toContainText('Host unavailable');
  await expect(
    remoteCard.getByRole('button', {name: 'View contents', exact: true}),
  ).toBeDisabled();
  await expect(query(page)).toHaveValue('Target');
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole('button', {name: 'Close details', exact: true}).click();
  state.localManifest.files = [];
  await inspect(page, 'Local snapshot');
  await expect(count(page)).toHaveText(
    'Showing 0 of 0 matching files · 0 loaded files.',
  );
  await expect(page.locator('[data-file-results]')).toHaveText(
    'No files in the loaded manifest.',
  );
});
