import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', route => {
      const url = new URL(route.request().url());
      if (Object.values(origins).includes(url.origin)) return route.continue();
      external.push(url.origin); return route.abort();
    });
    try { await use(page); } finally { await routes.dispose(); }
    expect(errors).toEqual([]); expect(external).toEqual([]);
  },
});
const local = 'a'.repeat(32), remote = 'd'.repeat(32), remoteServer = 'e'.repeat(32);
const cards = page => page.locator('#servers article.card');
const search = page => page.getByRole('searchbox', {name: 'Find servers', exact: true});
const count = page => page.locator('#servers .server-count');
const nav = page => page.getByRole('navigation', {name: /navigation/});
async function login(page, username = 'Preview') {
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page.getByLabel('Password', {exact: true}).fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
  await expect(search(page)).toBeVisible();
}
async function fleet(page) {
  const server = (id, name, game, address) => ({id, name, game, applicationName: {factorio: 'Factorio', rust: 'Rust', 'status-page': 'Status Page'}[game], address, state: 'installed', cpu: 1, memoryGiB: 2});
  const state = {
    hosts: [{id: local, name: 'This host', local: true, connected: true}, {id: remote, name: 'Weekend host', local: false, connected: true}],
    local: [server('b'.repeat(32), 'Friday factory', 'factorio', 'factory.example.test:35000'), server('c'.repeat(32), 'Island crew', 'rust', 'island.example.test:35003')],
    remote: [server(remoteServer, 'Other factory <crew>', 'factorio', 'weekend.example.test:35006')],
    active: null, reads: 0,
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/hosts') {state.reads++; return route.fulfill({json: {hosts: state.hosts}});}
    if (path === '/api/servers') return route.fulfill({json: {servers: state.local}});
    if (path === '/api/hosts/' + remote + '/servers') return route.fulfill({json: {servers: state.remote}});
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?snapshots$/.test(path)) return route.fulfill({json: {snapshots: []}});
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?jobs$/.test(path)) return route.fulfill({json: {jobs: state.active ? [state.active] : [], active: state.active}});
    if (/\/servers\/[a-f0-9]{32}\/api\/status$/.test(path)) return route.fulfill({json: {ready: true, running: true, players: []}});
    return route.fallback();
  });
  return state;
}

test('fleet server search combines application and host filters, clears with the keyboard and keeps scoped links', async ({page}, info) => {
  await fleet(page); await login(page);
  await expect(count(page)).toHaveText('Showing 3 of 3 servers');
  await search(page).fill('FACTORY');
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole('combobox', {name: 'Application', exact: true}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Host', exact: true}).selectOption(remote);
  await expect(count(page)).toHaveText('Showing 1 of 3 servers');
  await expect(cards(page)).toContainText('Other factory <crew>');
  await expect(cards(page).getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + remoteServer + '/');
  await search(page).fill('nothing matches');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'No matching servers'})).toBeVisible();
  const clear = page.getByRole('button', {name: 'Clear filters', exact: true});
  await clear.focus(); await clear.press('Enter');
  await expect(search(page)).toBeFocused();
  await expect(cards(page)).toHaveCount(3);
  await search(page).fill('ISLAND.EXAMPLE'); await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Island crew');
  await search(page).fill('Weekend host'); await expect(cards(page)).toHaveCount(1);
  await page.screenshot({path: info.outputPath('fleet-server-search.png'), fullPage: true});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
});

test('fleet filters and typing caret survive live refresh, offline/busy fences and navigation', async ({page}) => {
  await page.clock.install(); const state = await fleet(page); await login(page);
  await page.getByRole('combobox', {name: 'Application', exact: true}).selectOption('factorio');
  await search(page).fill('Friday');
  await search(page).evaluate(input => {input.focus(); input.setSelectionRange(2, 5);});
  state.local[0].name = 'Friday factory revised';
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(cards(page)).toContainText('Friday factory revised');
  await expect(search(page)).toBeFocused();
  expect(await search(page).evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 5]);
  await expect(page.getByRole('combobox', {name: 'Application', exact: true})).toHaveValue('factorio');
  state.active = {id: 'fixture-busy', state: 'running', action: 'create', message: 'Synthetic host busy'};
  await page.clock.fastForward(6000);
  await expect(cards(page).getByRole('button', {name: 'Publish snapshot'})).toBeDisabled();
  state.active = null; state.hosts[0].connected = false;
  await page.clock.fastForward(6000);
  await expect(cards(page)).toContainText('Host unavailable');
  await expect(cards(page).getByRole('button', {name: 'Remove', exact: true})).toBeDisabled();
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await expect(search(page)).toHaveValue('Friday');
  await expect(page.getByRole('combobox', {name: 'Application', exact: true})).toHaveValue('factorio');
  state.hosts[0].connected = true; state.local = [];
  await page.clock.fastForward(6000);
  await expect(count(page)).toHaveText('Showing 0 of 1 server');
  await expect(page.getByRole('heading', {name: 'No matching servers'})).toBeVisible();
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).not.toContainText('Friday');
});

test('assigned server search exposes only the minimal authorized list and session reset drops prior filters', async ({page}) => {
  const state = await fleet(page); state.hosts.splice(1); state.remote = [];
  const reads = [];
  page.on('request', request => {if (request.url().includes('/api/')) reads.push(new URL(request.url()).pathname);});
  await login(page, 'Assigned');
  await expect(count(page)).toHaveText('Showing 1 of 1 server');
  await expect(page.getByRole('combobox', {name: 'Host', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Application', exact: true}).locator('option')).toHaveText(['All applications', 'Factorio']);
  await search(page).fill('Island'); await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(cards(page)).toContainText('Friday factory');
  await expect(cards(page).getByRole('button')).toHaveCount(0);
  await expect(cards(page).getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/servers/' + 'b'.repeat(32) + '/');
  expect(reads.some(path => /^\/api\/(?:hosts|servers|snapshots|jobs)(?:[/?]|$)/.test(path))).toBe(false);
  await search(page).fill('Friday');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await login(page, 'Viewer');
  await expect(search(page)).toHaveValue('');
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).getByRole('button')).toHaveCount(0);
});

test('background fleet refresh preserves scroll while restoring search focus', async ({page}) => {
  await page.clock.install(); const state = await fleet(page);
  for (let i = 16; i < 36; i++) state.local.push({...state.local[0], id: i.toString(16).padStart(32, '0'), name: 'Factory ' + i});
  await login(page); await search(page).fill('factory');
  await page.evaluate(() => globalThis.scrollTo(0, 1700));
  const top = await page.evaluate(() => globalThis.scrollY);
  expect(top).toBeGreaterThan(500);
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(search(page)).toBeFocused();
  expect(await page.evaluate(() => globalThis.scrollY)).toBe(top);
});

test('search composition keeps its input mounted through interim typing and a background refresh', async ({page}) => {
  await page.clock.install(); const state = await fleet(page); await login(page);
  const input = await search(page).elementHandle();
  await input.dispatchEvent('compositionstart', {data: ''});
  await input.evaluate(element => {element.value = '工'; element.dispatchEvent(new globalThis.InputEvent('input', {bubbles: true, isComposing: true}));});
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  expect(await input.evaluate(element => element.isConnected)).toBe(true);
  await input.evaluate(element => {element.value = 'Factory'; element.dispatchEvent(new globalThis.CompositionEvent('compositionend', {bubbles: true, data: 'Factory'}));});
  await expect(search(page)).toHaveValue('Factory');
  await expect(cards(page)).toHaveCount(2);
});

for (const username of ['Viewer', 'Assigned']) test('application names are searchable before creation for ' + username, async ({page}) => {
  const state = await fleet(page), item = {...state.local[0], name: 'Service dashboard', game: 'status-page', applicationName: 'Status Page'};
  state.local = [item]; state.remote = []; state.hosts.splice(1);
  if (username === 'Assigned') await page.route('**/api/assigned-servers', route => route.fulfill({json: {servers: [{...item, manageUrl: '/servers/' + item.id + '/'}]}}));
  await login(page, username);
  await expect(page.getByRole('combobox', {name: 'Application', exact: true})).toContainText('Status Page');
  await search(page).fill('Status Page');
  await expect(cards(page)).toHaveCount(1); await expect(cards(page)).toContainText('Service dashboard');
});
