import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
import {catalog} from '../../fleet/catalog.js';
const test = base.extend({page: async ({page}, use) => {
  const routes = trackPageRoutes(page), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (Object.values(origins).includes(url.origin)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  try {await use(page);} finally {await routes.dispose();}
  expect(errors).toEqual([]); expect(external).toEqual([]);
}});
const local = 'a'.repeat(32), remote = 'd'.repeat(32), shared = 'f'.repeat(32), other = 'e'.repeat(32);
const form = page => page.locator('#create');
const context = page => page.locator('#snapshot-context');
const nav = page => page.getByRole('navigation', {name: /navigation/});
async function login(page, user = 'Preview') {
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('searchbox', {name: 'Find servers', exact: true})).toBeVisible();
}
async function signOut(page) {
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Username', {exact: true})).toBeVisible();
}
async function snapshots(page) {
  const record = (id, sourceName, image, created, extra = {}) => ({id, sourceName, image, created, title: 'Shared title', game: 'factorio', bytes: 10, files: 1, ...extra});
  const state = {
    hosts: [{id: local, name: 'This host', local: true, connected: true}, {id: remote, name: 'Weekend host', connected: true}],
    local: [record(shared, 'Local factory', catalog.factorio.image, '2026-01-01T12:00:00Z')],
    remote: [record(shared, 'Remote factory <crew>', catalog.factorio.runtimeImage, '2026-01-02T12:00:00Z'), record(other, 'Other source', catalog.factorio.runtimeImage, '2026-01-03T12:00:00Z'), record('8'.repeat(32), 'Rust source', catalog.rust.image, '2026-01-04T12:00:00Z', {game: 'rust'}), record('7'.repeat(32), 'Incompatible image', 'synthetic-unlisted:1', '2026-01-04T12:00:00Z'), record('6'.repeat(32), 'Unavailable snapshot', catalog.factorio.image, '2026-01-04T12:00:00Z', {unavailable: true})],
    checked: [], created: [], ready: true, snapshotReads: 0, inspected: [],
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === 'POST' && path.endsWith('/creation-preflight')) {
      state.checked.push({path, body: route.request().postDataJSON()});
      return route.fulfill({json: {ready: state.ready, checks: [{label: 'Fixture host', status: state.ready ? 'pass' : 'fail', message: state.ready ? 'Synthetic checks passed.' : 'Synthetic capacity check failed.'}]}});
    }
    if (method === 'POST' && /\/servers$/.test(path)) {
      state.created.push({path, body: route.request().postDataJSON()});
      return route.fulfill({status: 202, json: {id: 'synthetic-copy', state: 'queued'}});
    }
    if (method !== 'GET') return route.fallback();
    if (path === '/api/hosts') return route.fulfill({json: {hosts: state.hosts}});
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?servers$/.test(path)) return route.fulfill({json: {servers: []}});
    if (path.endsWith('/catalog')) return route.fulfill({json: {games: Object.values(catalog)}});
    if (path === '/api/snapshots' || path === '/api/hosts/' + remote + '/snapshots') {
      state.snapshotReads++; return route.fulfill({json: {snapshots: path.includes('/hosts/') ? state.remote : state.local}});
    }
    if (/\/snapshots\/[a-f0-9]{32}$/.test(path)) {
      state.inspected.push(path); const item = path.includes('/hosts/') ? state.remote[0] : state.local[0];
      return route.fulfill({json: {...item, verifiedAt: item.created, manifest: {files: [{name: 'synthetic.txt', size: 10, sha256: 'a'.repeat(64)}]}}});
    }
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?jobs$/.test(path)) return route.fulfill({json: {jobs: [], active: null}});
    return route.fallback();
  });
  return state;
}

test('snapshot choices show source and date, preserve compatible host identity and clear stale context', async ({page}, info) => {
  const state = await snapshots(page); await login(page);
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  const picker = form(page).locator('[name=snapshotId]');
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption(shared); await expect(context(page)).toContainText('Local factory');
  await expect(form(page).locator('[name=softwareMode]')).toHaveValue('image');
  let release, started;
  const gate = new Promise(resolve => {release = resolve;}), requested = new Promise(resolve => {started = resolve;});
  await page.route('**/api/hosts/' + remote + '/catalog', async route => {started(); await gate; return route.fulfill({json: {games: Object.values(catalog)}});}, {times: 1});
  try {
    await form(page).locator('[name=hostId]').selectOption(remote); await requested;
    await expect(context(page)).toBeHidden(); await expect(context(page)).toBeEmpty();
    release(); await expect(page.locator('#create-submit')).toHaveText('Create on Weekend host');
  } finally {release();}
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(picker.locator('option')).toContainText(['New world', 'Shared title — Remote factory <crew>', 'Shared title — Other source']);
  const date = await page.evaluate(value => new Date(value).toLocaleString(), state.remote[0].created);
  await expect(picker.locator('option[value="' + shared + '"]')).toContainText(date);
  await picker.focus(); await picker.press('ArrowDown'); await picker.press('Enter');
  await expect(picker).toHaveValue(shared);
  await expect(context(page)).toContainText('Remote factory <crew>');
  await expect(context(page)).toContainText('Weekend host'); await expect(context(page)).toContainText(date);
  await expect(context(page).locator('script')).toHaveCount(0);
  await expect(form(page).locator('[name=softwareMode]')).toHaveValue('runtime');
  await expect(form(page).locator('[name=softwareMode]')).toBeDisabled();
  await expect(form(page).locator('[name=seed]')).toBeDisabled();
  await page.screenshot({path: info.outputPath('selected-snapshot-context.png'), fullPage: true});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  await picker.selectOption(other); await expect(context(page)).toContainText('Other source');
  await expect(context(page)).not.toContainText('Remote factory');
  await form(page).locator('[name=game]').selectOption('rust');
  await expect(context(page)).toBeHidden(); await expect(picker.locator('option')).toHaveCount(2);
  await expect(picker.locator('option')).toContainText(['New world', 'Rust source']);
  await form(page).getByRole('button', {name: 'Close', exact: true}).click();
  await expect(context(page)).toBeEmpty();
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  await expect(context(page)).toBeHidden(); await expect(picker).toHaveValue('');
  expect(state.checked).toEqual([]); expect(state.created).toEqual([]);
});

test('milestone journey finds, inspects and selects the remote snapshot before cancel or checked independent creation', async ({page}) => {
  const state = await snapshots(page); await login(page);
  await nav(page).getByRole('link', {name: 'Snapshot library', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Find snapshots', exact: true}).fill('Remote factory');
  await page.getByRole('combobox', {name: 'Filter snapshots by application'}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Filter snapshots by host'}).selectOption(remote);
  await page.getByRole('combobox', {name: 'Sort snapshots'}).selectOption('oldest');
  const card = page.locator('#snapshots article.card'); await expect(card).toHaveCount(1);
  await card.getByRole('button', {name: 'View contents'}).click();
  await expect(page.locator('.snapshot-details')).toContainText('Remote factory <crew>');
  expect(state.inspected).toEqual(['/api/hosts/' + remote + '/snapshots/' + shared]);
  await card.getByRole('button', {name: 'Create server on this host'}).click();
  await expect(form(page).locator('[name=hostId]')).toHaveValue(remote);
  await expect(form(page).locator('[name=snapshotId]')).toHaveValue(shared);
  await expect(context(page)).toContainText('Remote factory <crew>');
  await form(page).getByRole('button', {name: 'Close', exact: true}).click();
  expect(state.checked).toEqual([]); expect(state.created).toEqual([]);
  await card.getByRole('button', {name: 'Create server on this host'}).click();
  await expect(context(page)).toContainText('Remote factory <crew>');
  await expect(form(page).locator('[name=name]')).toHaveValue('Shared title copy');
  await form(page).locator('[name=name]').fill('Independent remote copy');
  state.ready = false; await page.locator('#check-creation').click();
  await expect(page.locator('#creation-checks')).toContainText('Synthetic capacity check failed');
  await page.locator('#create-submit').click(); await expect.poll(() => state.checked.length).toBe(2);
  expect(state.created).toEqual([]); await expect(context(page)).toContainText('Remote factory <crew>');
  state.ready = true; await page.locator('#create-submit').click(); await expect.poll(() => state.created.length).toBe(1);
  const created = state.created[0], {requestId, ...body} = created.body;
  expect(created.path).toBe('/api/hosts/' + remote + '/servers'); expect(requestId).toEqual(expect.any(String));
  expect(body).toEqual(state.checked.at(-1).body);
  expect(body).toMatchObject({hostId: remote, game: 'factorio', snapshotId: shared, softwareMode: 'runtime', name: 'Independent remote copy'});
  for (const key of ['sourceName', 'created', 'hostName', 'snapshotContext']) expect(body).not.toHaveProperty(key);
  await expect(page.locator('#create-dialog')).not.toBeVisible(); await expect(context(page)).toBeEmpty();
});

test('snapshot selection adds no creation controls or library reads to restricted accounts', async ({page}) => {
  const state = await snapshots(page); await login(page, 'Viewer');
  await expect(page.getByRole('button', {name: 'Create server', exact: true})).toHaveCount(0);
  await nav(page).getByRole('link', {name: 'Snapshot library', exact: true}).click();
  await expect(page.locator('#snapshots article.card').getByRole('button')).toHaveCount(0);
  await expect(context(page)).toBeEmpty();
  await signOut(page); const reads = state.snapshotReads; await login(page, 'Assigned');
  await expect(page.getByRole('button', {name: 'Create server', exact: true})).toHaveCount(0);
  await expect(nav(page).getByRole('link', {name: 'Snapshot library', exact: true})).toHaveCount(0);
  await expect(context(page)).toBeEmpty(); expect(state.snapshotReads).toBe(reads);
});

test('a cancelled clone catalogue cannot restore snapshot context in a later dialog', async ({page}) => {
  const state = await snapshots(page); await login(page);
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  await expect(page.locator('#create-submit')).toBeEnabled();
  await form(page).getByRole('button', {name: 'Close', exact: true}).click();
  let releaseOld, releaseCurrent, oldStarted, currentStarted;
  const oldGate = new Promise(resolve => {releaseOld = resolve;}),
    currentGate = new Promise(resolve => {releaseCurrent = resolve;}),
    oldRequest = new Promise(resolve => {oldStarted = resolve;}),
    currentRequest = new Promise(resolve => {currentStarted = resolve;});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET' || !path.endsWith('/catalog')) return route.fallback();
    if (path.includes('/hosts/')) {oldStarted(); await oldGate;}
    else {currentStarted(); await currentGate;}
    return route.fulfill({json: {games: Object.values(catalog)}});
  });
  try {
    await nav(page).getByRole('link', {name: 'Snapshot library', exact: true}).click();
    await page.getByRole('searchbox', {name: 'Find snapshots', exact: true}).fill('Remote factory');
    await page.locator('#snapshots article.card').getByRole('button', {name: 'Create server on this host'}).click();
    await oldRequest;
    await form(page).getByRole('button', {name: 'Close', exact: true}).click();
    await page.getByRole('button', {name: 'Create server', exact: true}).click(); await currentRequest;
    await expect(context(page)).toBeHidden(); await expect(context(page)).toBeEmpty();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/hosts/' + remote + '/catalog');
    releaseOld(); await (await response).finished();
    // Flush rendering after the deliberately delayed fetch body has arrived.
    await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
    await expect(context(page)).toBeHidden(); await expect(context(page)).toBeEmpty();
    await expect(form(page).locator('[name=snapshotId]')).toHaveValue('');
    await expect(form(page).locator('[name=name]')).toHaveValue('');
    await expect(page.locator('#create-submit')).toBeDisabled();
    releaseCurrent(); await expect(page.locator('#create-submit')).toBeEnabled();
    await expect(context(page)).toBeHidden(); await expect(context(page)).toBeEmpty();
    expect(state.checked).toEqual([]); expect(state.created).toEqual([]);
  } finally {releaseOld(); releaseCurrent();}
});
