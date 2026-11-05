import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
const test = base.extend({page: async ({page}, use) => {
  const routes = trackPageRoutes(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => Object.values(origins).includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  try {await use(page);} finally {await routes.dispose();}
  expect(errors).toEqual([]);
}});
const local = 'a'.repeat(32), remote = 'd'.repeat(32), shared = 'f'.repeat(32);
const search = page => page.getByRole('searchbox', {name: 'Find snapshots', exact: true});
const cards = page => page.locator('#snapshots article.card');
const nav = page => page.getByRole('navigation', {name: /navigation/});
const sort = page => page.getByRole('combobox', {name: 'Sort snapshots', exact: true});
async function login(page, user = 'Preview') {
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
  if (user !== 'Assigned') await nav(page).getByRole('link', {name: 'Snapshot library', exact: true}).click();
}
async function library(page) {
  const record = (id, title, game, sourceName, created) => ({id, title, game, sourceName, created, files: 1, bytes: 25, image: 'synthetic-image'});
  const state = {
    hosts: [{id: local, name: 'This host', local: true, connected: true}, {id: remote, name: 'Weekend host', connected: true}],
    local: [record(shared, 'Friday world', 'factorio', 'Factory source', '2026-01-02T12:00:00Z'), record('1'.repeat(32), 'Alpha island', 'rust', 'Island source', '2026-01-01T12:00:00Z')],
    remote: [record(shared, 'Friday world', 'status-page', 'Service source <safe>', '2026-01-03T12:00:00Z')],
    reads: 0, details: [], active: null,
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/hosts') {state.reads++; return route.fulfill({json: {hosts: state.hosts}});}
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?servers$/.test(path)) return route.fulfill({json: {servers: []}});
    if (path === '/api/snapshots') return route.fulfill({json: {snapshots: state.local}});
    if (path === '/api/hosts/' + remote + '/snapshots') return route.fulfill({json: {snapshots: state.remote}});
    if (/\/snapshots\/[a-f0-9]{32}$/.test(path)) {
      state.details.push(path);
      const item = path.includes('/hosts/') ? state.remote[0] : state.local[0];
      return route.fulfill({json: {...item, verifiedAt: item.created, manifest: {files: [{name: 'synthetic.txt', size: 25, sha256: 'a'.repeat(64)}]}}});
    }
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?jobs$/.test(path)) return route.fulfill({json: {jobs: state.active ? [state.active] : [], active: state.active}});
    return route.fallback();
  });
  return state;
}

test('snapshot search combines source, application and host filters; clear preserves ordering and scoped inspection', async ({page}, info) => {
  const state = await library(page); await login(page);
  await expect(page.locator('.snapshot-count')).toHaveText('Showing 3 of 3 snapshots');
  await expect(cards(page).locator('h2')).toHaveText(['Friday world', 'Friday world', 'Alpha island']);
  await sort(page).selectOption('oldest');
  await expect(cards(page).locator('h2')).toHaveText(['Alpha island', 'Friday world', 'Friday world']);
  await search(page).fill('SERVICE SOURCE'); await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Service source <safe>');
  await search(page).fill('status page'); await expect(cards(page)).toHaveCount(1);
  await page.getByRole('combobox', {name: 'Filter snapshots by application'}).selectOption('status-page');
  await page.getByRole('combobox', {name: 'Filter snapshots by host'}).selectOption(remote);
  await cards(page).getByRole('button', {name: 'View contents'}).click();
  await expect(page.locator('.snapshot-details')).toContainText('Service source <safe>');
  expect(state.details).toEqual(['/api/hosts/' + remote + '/snapshots/' + shared]);
  await search(page).fill('no match');
  await expect(page.getByRole('heading', {name: 'No matching snapshots'})).toBeVisible();
  await expect(page.locator('.snapshot-details')).toBeVisible();
  const clear = page.getByRole('button', {name: 'Clear filters', exact: true});
  await clear.focus(); await clear.press('Enter');
  await expect(search(page)).toBeFocused(); await expect(sort(page)).toHaveValue('oldest');
  await expect(cards(page)).toHaveCount(3);
  await sort(page).selectOption('title'); await expect(cards(page).first()).toContainText('Alpha island');
  await search(page).fill('Weekend'); await expect(cards(page)).toHaveCount(1);
  await page.screenshot({path: info.outputPath('snapshot-library-search.png'), fullPage: true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('snapshot filter focus, caret, IME and choices survive refresh and navigation with cached offline fences', async ({page}) => {
  await page.clock.install(); const state = await library(page); await login(page);
  await search(page).fill('Friday'); await sort(page).selectOption('oldest');
  await search(page).evaluate(input => {input.focus(); input.setSelectionRange(1, 4);});
  let before = state.reads; await page.clock.fastForward(6000); await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(search(page)).toBeFocused(); expect(await search(page).evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([1, 4]);
  const input = await search(page).elementHandle();
  await input.dispatchEvent('compositionstart', {data: ''});
  await input.evaluate(element => {element.value = '工'; element.dispatchEvent(new InputEvent('input', {bubbles: true, isComposing: true}));});
  before = state.reads; await page.clock.fastForward(6000); await expect.poll(() => state.reads).toBeGreaterThan(before);
  expect(await input.evaluate(element => element.isConnected)).toBe(true);
  await input.evaluate(element => {element.value = 'Friday'; element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: 'Friday'}));});
  state.hosts[1].connected = false;
  await page.clock.fastForward(6000);
  const cached = cards(page).filter({hasText: 'Weekend host'});
  await expect(cached).toContainText('Host unavailable · last known snapshot information.');
  for (const name of ['View contents', 'Delete snapshot', 'Create server on this host']) await expect(cached.getByRole('button', {name, exact: true})).toBeDisabled();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Snapshot library', exact: true}).click();
  await expect(search(page)).toHaveValue('Friday'); await expect(sort(page)).toHaveValue('oldest');
  state.hosts[1].connected = true; await page.clock.fastForward(6000);
  await expect(cached.getByRole('button', {name: 'View contents'})).toBeEnabled();
  state.active = {id: 'busy', state: 'running', action: 'create', message: 'Synthetic host busy'};
  await page.clock.fastForward(6000);
  await expect(cached.getByRole('button', {name: 'Delete snapshot'})).toBeDisabled();
  await expect(cached.getByRole('button', {name: 'View contents'})).toBeEnabled();
});

test('viewer discovery is read-only, logout resets choices and assigned accounts have no library', async ({page}) => {
  await library(page); await login(page, 'Viewer');
  await expect(cards(page)).toHaveCount(3); await expect(cards(page).getByRole('button')).toHaveCount(0);
  await search(page).fill('island'); await expect(cards(page)).toHaveCount(1);
  await sort(page).selectOption('title');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click(); await login(page);
  await expect(search(page)).toHaveValue(''); await expect(sort(page)).toHaveValue('newest');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click(); await login(page, 'Assigned');
  await expect(nav(page).getByRole('link', {name: 'Snapshot library', exact: true})).toHaveCount(0);
  await expect(search(page)).toHaveCount(0);
});
