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
    active: null, reads: 0, status: {}, statusReads: [],
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fallback();
    if (path === '/api/hosts') {state.reads++; return route.fulfill({json: {hosts: state.hosts}});}
    if (path === '/api/servers') return route.fulfill({json: {servers: state.local}});
    if (path === '/api/hosts/' + remote + '/servers') return route.fulfill({json: {servers: state.remote}});
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?snapshots$/.test(path)) return route.fulfill({json: {snapshots: []}});
    if (/^\/api\/(?:hosts\/[a-f0-9]{32}\/)?jobs$/.test(path)) return route.fulfill({json: {jobs: state.active ? [state.active] : [], active: state.active}});
    if (/\/servers\/[a-f0-9]{32}\/api\/status$/.test(path)) {state.statusReads.push(path); return route.fulfill({json: Object.hasOwn(state.status, path) ? state.status[path] : {ready: true, running: true, players: []}});}
    return route.fallback();
  });
  return state;
}

test('server name sorting keeps host order by default and combines with filters without requests', async ({page}, info) => {
  await page.clock.install();
  const state = await fleet(page);
  state.local[0].name = 'Zulu service';
  state.local[1].name = 'Alpha crew';
  state.remote[0].name = 'alpha crew';
  state.remote[0].id = state.local[1].id;
  await login(page);
  const order = page.getByRole('combobox', {name: 'Sort servers', exact: true});
  const names = () => cards(page).locator('h2');
  await expect(order).toHaveValue('host');
  await expect(names()).toHaveText(['Zulu service', 'Alpha crew', 'alpha crew']);
  const requests = [];
  page.on('request', request => {if (request.url().includes('/api/')) requests.push(request.method() + ' ' + new URL(request.url()).pathname);});
  await order.focus(); await order.press('ArrowDown'); await order.press('Enter');
  await expect(order).toHaveValue('name'); await expect(order).toBeFocused();
  await expect(names()).toHaveText(['Alpha crew', 'alpha crew', 'Zulu service']);
  await expect(cards(page).nth(1).getByRole('link', {name: 'Open server', exact: true})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + state.remote[0].id + '/');
  await order.selectOption('name-desc');
  await expect(names()).toHaveText(['Zulu service', 'Alpha crew', 'alpha crew']);
  await search(page).fill('CREW');
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(remote);
  await page.getByRole('combobox', {name: 'Filter by status', exact: true}).selectOption('Ready');
  await expect(names()).toHaveText(['alpha crew']);
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(order).toHaveValue('name-desc');
  await expect(names()).toHaveText(['Zulu service', 'Alpha crew', 'alpha crew']);
  await expect(count(page)).toHaveText('Showing 3 of 3 servers');
  expect(requests).toEqual([]);
  await page.screenshot({path: info.outputPath('fleet-name-order.png'), fullPage: true});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
});

test('server name order survives refresh and navigation and resets for the next session', async ({page}) => {
  await page.clock.install(); const state = await fleet(page); await login(page);
  const order = page.getByRole('combobox', {name: 'Sort servers', exact: true});
  await order.selectOption('name-desc'); await order.focus();
  state.local[0].name = 'Zulu factory';
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(cards(page).locator('h2')).toHaveText(['Zulu factory', 'Other factory <crew>', 'Island crew']);
  await expect(order).toBeFocused();
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await expect(order).toHaveValue('name-desc');
  await expect(cards(page).locator('h2')).toHaveText(['Zulu factory', 'Other factory <crew>', 'Island crew']);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await login(page, 'Viewer');
  await expect(order).toHaveValue('host');
  await expect(cards(page).locator('h2')).toHaveText(['Zulu factory', 'Island crew', 'Other factory <crew>']);
  await order.selectOption('name');
  await expect(cards(page).locator('h2')).toHaveText(['Island crew', 'Other factory <crew>', 'Zulu factory']);
  await expect(cards(page).getByRole('button', {name: 'Remove', exact: true})).toHaveCount(0);
});

test('assigned inventory name sorting uses only authorized minimal records', async ({page}) => {
  await page.clock.install(); await fleet(page);
  const assigned = [
    {id: '1'.repeat(32), name: 'Alpha assigned', game: 'factorio', applicationName: 'Factorio', manageUrl: '/hosts/' + remote + '/servers/' + '1'.repeat(32) + '/', address: 'one.example.test:35000', cpu: 240, memoryGiB: 99},
    {id: '1'.repeat(32), name: 'alpha assigned', game: 'status-page', applicationName: 'Status Page', applicationKind: 'application', manageUrl: '/servers/' + '1'.repeat(32) + '/', address: 'two.example.test:35001'},
  ];
  await page.route('**/api/assigned-servers', route => route.fulfill({json: {servers: assigned}}));
  const reads = [];
  page.on('request', request => {if (request.url().includes('/api/')) reads.push(new URL(request.url()).pathname);});
  await login(page, 'Assigned');
  const order = page.getByRole('combobox', {name: 'Sort servers', exact: true});
  const before = [...reads]; await order.selectOption('name');
  await expect(cards(page).locator('h2')).toHaveText(['Alpha assigned', 'alpha assigned']);
  await expect(cards(page).first().getByRole('link', {name: 'Open server', exact: true})).toHaveAttribute('href', assigned[0].manageUrl);
  await expect(cards(page).nth(1).getByRole('link', {name: 'Manage application', exact: true})).toHaveAttribute('href', assigned[1].manageUrl);
  expect(reads).toEqual(before);
  assigned.reverse();
  await page.clock.fastForward(6000);
  await expect.poll(() => reads.length).toBeGreaterThan(before.length);
  await expect(cards(page).locator('h2')).toHaveText(['Alpha assigned', 'alpha assigned']);
  await expect(page.getByRole('combobox', {name: 'Filter by host', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Filter by status', exact: true})).toHaveCount(0);
  await expect(page.getByRole('region', {name: 'Loaded server availability', exact: true})).toHaveCount(0);
  await expect(cards(page).getByRole('button', {name: 'Remove', exact: true})).toHaveCount(0);
  expect(reads.some(path => /^\/api\/(?:hosts|servers|snapshots|jobs)(?:[/?]|$)/.test(path))).toBe(false);
  expect(reads.some(path => /\/servers\/.*\/api\/status$/.test(path))).toBe(false);
  await expect(cards(page).locator('.stats')).toHaveCount(0);
  await expect(page.locator('#servers')).not.toContainText(/sample|configured CPU|configured memory|240|99/);
});

test('fleet server search combines application and host filters, clears with the keyboard and keeps scoped links', async ({page}, info) => {
  await fleet(page); await login(page);
  await expect(count(page)).toHaveText('Showing 3 of 3 servers');
  await search(page).fill('FACTORY');
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(remote);
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
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('factorio');
  await search(page).fill('Friday');
  await search(page).evaluate(input => {input.focus(); input.setSelectionRange(2, 5);});
  state.local[0].name = 'Friday factory revised';
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(cards(page)).toContainText('Friday factory revised');
  await expect(search(page)).toBeFocused();
  expect(await search(page).evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 5]);
  await expect(page.getByRole('combobox', {name: 'Filter by application', exact: true})).toHaveValue('factorio');
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
  await expect(page.getByRole('combobox', {name: 'Filter by application', exact: true})).toHaveValue('factorio');
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
  await expect(page.getByRole('combobox', {name: 'Filter by host', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Filter by status', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Filter by application', exact: true}).locator('option')).toHaveText(['All applications', 'Factorio']);
  await search(page).fill('Island'); await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(cards(page)).toContainText('Friday factory');
  await expect(cards(page).getByRole('button', {name: 'Copy address', exact: true})).toHaveCount(1);
  await expect(cards(page).getByRole('button')).toHaveCount(1);
  await expect(cards(page).getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/servers/' + 'b'.repeat(32) + '/');
  expect(reads.some(path => /^\/api\/(?:hosts|servers|snapshots|jobs)(?:[/?]|$)/.test(path))).toBe(false);
  await search(page).fill('Friday');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await login(page, 'Viewer');
  await expect(search(page)).toHaveValue('');
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).getByRole('button', {name: 'Copy address', exact: true})).toHaveCount(2);
  await expect(cards(page).getByRole('button')).toHaveCount(2);
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
  await expect(page.getByRole('combobox', {name: 'Filter by application', exact: true})).toContainText('Status Page');
  await search(page).fill('Status Page');
  await expect(cards(page)).toHaveCount(1); await expect(cards(page)).toContainText('Service dashboard');
});


test('copy address uses the exact selected host and supports keyboard and read-only accounts', async ({page}) => {
  await page.addInitScript(() => {
    globalThis.copiedAddresses = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => globalThis.copiedAddresses.push(value)}});
  });
  const state = await fleet(page);
  // IDs overlap across hosts; the button must resolve both host and server.
  state.remote[0].id = state.local[0].id;
  await login(page, 'Viewer');
  await search(page).fill('Other factory');
  const copy = cards(page).getByRole('button', {name: 'Copy address', exact: true});
  await copy.focus(); await copy.press('Enter');
  await expect(page.locator('#notice')).toHaveText('Server address copied.');
  expect(await page.evaluate(() => globalThis.copiedAddresses)).toEqual(['weekend.example.test:35006']);
  await expect(search(page)).toHaveValue('Other factory');
  await expect(cards(page).getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + state.remote[0].id + '/');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  // The minimal assigned projection deliberately omits hostId. Its scoped
  // management URL still distinguishes identical IDs across hosts.
  await page.route('**/api/assigned-servers', route => route.fulfill({json: {servers: [
    {...state.local[0], manageUrl: '/servers/' + state.local[0].id + '/'},
    {...state.remote[0], manageUrl: '/hosts/' + remote + '/servers/' + state.remote[0].id + '/'},
  ]}}));
  await login(page, 'Assigned');
  const assignedRemote = cards(page).filter({has: page.getByRole('heading', {name: 'Other factory <crew>', exact: true})});
  await assignedRemote.getByRole('button', {name: 'Copy address', exact: true}).click();
  await expect(page.locator('#notice')).toHaveText('Server address copied.');
  expect(await page.evaluate(() => globalThis.copiedAddresses)).toEqual(['weekend.example.test:35006']);
  await expect(assignedRemote.getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + state.remote[0].id + '/');
});

test('clipboard failure keeps the address visible and does not claim success or mutate servers', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: {writeText: async () => {throw new Error('Denied');}}}));
  const state = await fleet(page); state.local[1].address = '';
  await login(page);
  const mutations = [];
  page.on('request', request => {if (request.method() !== 'GET') mutations.push(request.url());});
  const card = cards(page).filter({has: page.getByRole('heading', {name: 'Friday factory', exact: true})});
  await card.getByRole('button', {name: 'Copy address', exact: true}).click();
  await expect(page.locator('#error')).toHaveText('Clipboard unavailable. Select and copy the address shown on the server card.');
  await expect(page.locator('#notice')).toBeHidden();
  await expect(card.locator('.server-address code')).toHaveText('factory.example.test:35000');
  await expect(cards(page).filter({has: page.getByRole('heading', {name: 'Island crew', exact: true})}).getByRole('button', {name: 'Copy address', exact: true})).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('missing clipboard API provides manual copy guidance', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: undefined}));
  await fleet(page); await login(page);
  await cards(page).first().getByRole('button', {name: 'Copy address', exact: true}).click();
  await expect(page.locator('#error')).toContainText('Select and copy the address');
  await expect(page.locator('#notice')).toBeHidden();
});


test('copy success is announced only after the clipboard write completes', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: {writeText: () => new Promise(resolve => {globalThis.completeClipboardWrite = resolve;})}}));
  await fleet(page); await login(page);
  await cards(page).first().getByRole('button', {name: 'Copy address', exact: true}).click();
  await expect.poll(() => page.evaluate(() => typeof globalThis.completeClipboardWrite)).toBe('function');
  await expect(page.locator('#notice')).toBeHidden();
  await page.evaluate(() => globalThis.completeClipboardWrite());
  await expect(page.locator('#notice')).toHaveText('Server address copied.');
});


test('status filtering combines fleet filters and follows refresh, offline status and session reset', async ({page}, info) => {
  await page.clock.install(); const state = await fleet(page);
  const rustStatus = '/servers/' + 'c'.repeat(32) + '/api/status';
  state.status[rustStatus] = {ready: false, running: false, state: 'exited', players: []};
  await login(page);
  const status = page.getByRole('combobox', {name: 'Filter by status', exact: true});
  await expect(status.locator('option')).toHaveText(['All statuses', 'Ready (2)', 'Stopped (1)']);
  await status.focus(); await status.press('End'); await status.press('Enter');
  await expect(status).toHaveValue('Stopped');
  await expect(cards(page)).toHaveCount(1); await expect(cards(page)).toContainText('Island crew');
  await search(page).fill('Island');
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('rust');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(local);
  await expect(count(page)).toHaveText('Showing 1 of 3 servers');
  await status.selectOption('Ready'); await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('region', {name: 'Loaded server availability', exact: true})).toContainText('Stopped: 1');
  await expect(status.locator('option')).toHaveText(['All statuses', 'Ready (0)', 'Stopped (1)']);
  await expect(page.getByRole('heading', {name: 'No matching servers'})).toBeVisible();
  const clear = page.getByRole('button', {name: 'Clear filters', exact: true});
  await clear.focus(); await clear.press('Enter');
  await expect(search(page)).toBeFocused(); await expect(cards(page)).toHaveCount(3);
  await expect(status).toHaveValue('');
  await status.selectOption('Stopped');
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await expect(status).toHaveValue('Stopped');
  state.status[rustStatus] = {ready: false, running: true, players: []};
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(count(page)).toHaveText('Showing 0 of 3 servers');
  await expect(status).toHaveValue('Stopped');
  await status.selectOption('Starting'); await expect(cards(page)).toContainText('Island crew');
  state.hosts[0].connected = false; await page.clock.fastForward(6000);
  await expect(cards(page)).toHaveCount(0);
  await status.selectOption('Host unavailable'); await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).locator('.status')).toHaveText(['Host unavailable', 'Host unavailable']);
  for (const card of await cards(page).all()) {
    await expect(card.getByRole('button', {name: 'Remove', exact: true})).toBeDisabled();
    await expect(card.getByRole('button', {name: 'Publish snapshot', exact: true})).toBeDisabled();
  }
  await page.screenshot({path: info.outputPath('fleet-status-filter.png'), fullPage: true});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  state.hosts[0].connected = true;
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await login(page, 'Viewer'); await expect(status).toHaveValue('');
});

test('viewer status filtering distinguishes unavailable status data, attention and creation without writes', async ({page}) => {
  const state = await fleet(page);
  state.local[0].state = 'attention'; state.local[1].state = 'creating';
  state.status['/servers/' + 'b'.repeat(32) + '/api/status'] = null;
  state.status['/servers/' + 'c'.repeat(32) + '/api/status'] = null;
  state.status['/hosts/' + remote + '/servers/' + remoteServer + '/api/status'] = null;
  await login(page, 'Viewer');
  await expect(page.getByRole('region', {name: 'Loaded server availability', exact: true})).toContainText('Checking: 1 · Creating: 1 · Needs attention: 1');
  const requests = []; page.on('request', request => {if (request.method() !== 'GET') requests.push(request.url());});
  const status = page.getByRole('combobox', {name: 'Filter by status', exact: true});
  await status.selectOption('Needs attention'); await expect(cards(page)).toContainText('Friday factory');
  await expect(cards(page)).toHaveCount(1); await expect(cards(page).locator('.status')).toHaveText('Needs attention');
  await status.selectOption('Creating'); await expect(cards(page)).toContainText('Island crew');
  await expect(cards(page).locator('.status')).toHaveText('Creating');
  await status.selectOption('Checking'); await expect(cards(page)).toContainText('Other factory');
  await expect(cards(page).locator('.status')).toHaveText('Checking');
  await expect(cards(page).getByRole('button', {name: 'Remove', exact: true})).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('table view uses the loaded filtered order, supports keyboard and contains wide rows', async ({page}, info) => {
  await page.clock.install();
  await page.addInitScript(() => {
    globalThis.copiedAddresses = [];
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => globalThis.copiedAddresses.push(value)}});
  });
  const state = await fleet(page);
  state.remote[0].id = state.local[0].id;
  state.remote[0].name = 'Other factory <crew> ' + 'long'.repeat(45);
  await login(page);
  const view = page.getByRole('combobox', {name: 'View servers', exact: true});
  const table = page.getByRole('table', {name: /Fleet servers/});
  await expect(view).toHaveValue('cards');
  const requests = [];
  page.on('request', request => {if (request.url().includes('/api/')) requests.push(request.method() + ' ' + new URL(request.url()).pathname);});
  await view.focus(); await view.press('ArrowDown'); await view.press('Enter');
  await expect(view).toHaveValue('table'); await expect(view).toBeFocused();
  await expect(cards(page)).toHaveCount(0);
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Application', 'Host', 'Status', 'Address', 'Configured CPU', 'Configured memory', 'Players', 'Sampled CPU', 'Sampled container memory', 'Actions']);
  await page.getByRole('combobox', {name: 'Sort servers', exact: true}).selectOption('name-desc');
  await expect(table.getByRole('rowheader')).toHaveText([state.remote[0].name, 'Island crew', 'Friday factory']);
  await search(page).fill('factory');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(remote);
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Filter by status', exact: true}).selectOption('Ready');
  await expect(count(page)).toHaveText('Showing 1 of 3 servers');
  await expect(table.getByRole('link', {name: 'Open server', exact: true})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + state.remote[0].id + '/');
  const copy = table.getByRole('button', {name: 'Copy address', exact: true});
  await copy.focus(); await copy.press('Enter');
  expect(await page.evaluate(() => globalThis.copiedAddresses)).toEqual(['weekend.example.test:35006']);
  await search(page).fill('missing');
  await expect(table).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'No matching servers'})).toBeVisible();
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(view).toHaveValue('table');
  await expect(page.getByRole('combobox', {name: 'Sort servers', exact: true})).toHaveValue('name-desc');
  await expect(table.getByRole('rowheader')).toHaveText([state.remote[0].name, 'Island crew', 'Friday factory']);
  const region = page.getByRole('region', {name: 'Fleet servers table', exact: true});
  await region.focus(); await expect(region).toBeFocused();
  if (info.project.name === 'mobile') {
    expect(await region.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  expect(requests).toEqual([]);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({path: info.outputPath('fleet-table.png'), fullPage: true});
});

test('table selection and order survive refresh and navigation, while sign-out resets the view', async ({page}) => {
  await page.clock.install(); const state = await fleet(page); await login(page);
  const view = page.getByRole('combobox', {name: 'View servers', exact: true});
  const table = page.getByRole('table', {name: /Fleet servers/});
  await view.selectOption('table');
  await page.getByRole('combobox', {name: 'Sort servers', exact: true}).selectOption('name-desc');
  await view.focus();
  state.local[0].name = 'Zulu factory';
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(view).toBeFocused();
  await expect(table.getByRole('rowheader')).toHaveText(['Zulu factory', 'Other factory <crew>', 'Island crew']);
  const region = page.getByRole('region', {name: 'Fleet servers table', exact: true});
  await region.focus();
  const scrollLeft = await region.evaluate(element => {element.scrollLeft = 350; return element.scrollLeft;});
  if (page.viewportSize().width < 600) expect(scrollLeft).toBeGreaterThan(0);
  const beforeScrollRefresh = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(beforeScrollRefresh);
  await expect(region).toBeFocused();
  expect(await region.evaluate(element => element.scrollLeft)).toBe(scrollLeft);
  // A filter retaining focus must not reset the table's horizontal position.
  await view.focus();
  const beforeFilterRefresh = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(beforeFilterRefresh);
  await expect(view).toBeFocused();
  expect(await region.evaluate(element => element.scrollLeft)).toBe(scrollLeft);
  state.active = {id: 'fixture-busy', state: 'running', action: 'create', message: 'Synthetic host busy'};
  await page.clock.fastForward(6000);
  await expect(table.getByRole('button', {name: 'Publish snapshot'}).first()).toBeDisabled();
  state.active = null; state.hosts[0].connected = false;
  await page.clock.fastForward(6000);
  await expect(table.getByRole('row').filter({has: page.getByRole('rowheader', {name: 'Zulu factory', exact: true})})).toContainText('Host unavailable');
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await expect(view).toHaveValue('table');
  await expect(page.getByRole('combobox', {name: 'Sort servers', exact: true})).toHaveValue('name-desc');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Username', {exact: true})).toBeVisible();
  await login(page, 'Viewer');
  await expect(view).toHaveValue('cards');
  await view.selectOption('table');
  await expect(table.getByRole('button', {name: 'Remove', exact: true})).toHaveCount(0);
  await expect(table.getByRole('button', {name: 'Publish snapshot'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Username', {exact: true})).toBeVisible();
  await login(page, 'Assigned');
  await expect(view).toHaveCount(0); await expect(table).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);
});

test('table distinguishes public applications from games and scopes dialog actions to the selected row', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: {writeText: async () => {throw new Error('Synthetic clipboard denied');}}}));
  await page.clock.install(); const state = await fleet(page);
  state.local[0].game = 'status-page'; state.local[0].applicationName = 'Status Page';
  state.local[0].applicationKind = 'application'; state.local[0].webProtocol = 'http';
  state.remote[0].id = state.local[0].id;
  await login(page);
  await page.getByRole('combobox', {name: 'View servers', exact: true}).selectOption('table');
  const table = page.getByRole('table', {name: /Fleet servers/});
  const app = table.getByRole('row').filter({has: page.getByRole('rowheader', {name: 'Friday factory', exact: true})});
  await expect(app.getByRole('link', {name: 'Manage application', exact: true})).toHaveAttribute('href', '/servers/' + state.local[0].id + '/');
  await expect(app.getByRole('link', {name: 'Open application', exact: true})).toHaveAttribute('href', 'http://factory.example.test:35000/');
  await expect(app.getByRole('link', {name: 'Open application', exact: true})).toHaveAttribute('rel', 'noopener noreferrer');
  await app.getByRole('button', {name: 'Copy address', exact: true}).click();
  await expect(page.locator('#error')).toHaveText('Clipboard unavailable. Select and copy the address shown in the server table.');
  await expect(app).toContainText('factory.example.test:35000');
  await expect(app.getByRole('cell').nth(6)).toHaveText('—');
  await expect(app.getByRole('link', {name: 'Open server', exact: true})).toHaveCount(0);
  const other = table.getByRole('row').filter({has: page.getByRole('rowheader', {name: 'Other factory <crew>', exact: true})});
  await expect(other.getByRole('link', {name: 'Open application', exact: true})).toHaveCount(0);
  await other.getByRole('button', {name: 'Publish snapshot', exact: true}).click();
  await expect(page.locator('#publish input[name="hostId"]')).toHaveValue(remote);
  await expect(page.locator('#publish input[name="serverId"]')).toHaveValue(state.remote[0].id);
  await page.locator('#cancel-publish').click();
  await other.getByRole('button', {name: 'Remove', exact: true}).click();
  await expect(page.locator('#remove input[name="hostId"]')).toHaveValue(remote);
  await expect(page.locator('#remove input[name="serverId"]')).toHaveValue(state.remote[0].id);
  await page.locator('#cancel-remove').click();
  state.hosts[0].connected = false; await page.clock.fastForward(6000);
  await expect(app.getByRole('link', {name: 'Open application', exact: true})).toHaveCount(0);
  await expect(app.getByRole('button', {name: 'Remove', exact: true})).toBeDisabled();
});

test('fleet resource samples use scoped status for local Factorio, remote Rust and applications in both views', async ({page}, info) => {
  await page.clock.install(); const state = await fleet(page);
  state.remote[0].id = state.local[0].id;
  state.remote[0].game = 'rust'; state.remote[0].applicationName = 'Rust';
  state.local[1].game = 'status-page'; state.local[1].applicationName = 'Status Page';
  state.local[1].applicationKind = 'application'; state.local[1].webProtocol = 'http';
  const localStatus = '/servers/' + state.local[0].id + '/api/status';
  const remoteStatus = '/hosts/' + remote + '/servers/' + state.remote[0].id + '/api/status';
  const appStatus = '/servers/' + state.local[1].id + '/api/status';
  state.status[localStatus] = {running: true, ready: true, cpu: 0, memory: 0, players: ['one']};
  state.status[remoteStatus] = {running: true, ready: false, cpu: 240, memory: 1.5 * 1024 ** 3, players: 2};
  state.status[appStatus] = {running: true, ready: true, cpu: 12.34, memory: 512 * 1024 ** 2};
  await login(page, 'Viewer');
  await expect(cards(page).nth(0).locator('.resource-sample strong')).toHaveText(['0%', '0 B']);
  await expect(cards(page).nth(1).locator('.resource-sample strong')).toHaveText(['12.3%', '512.0 MiB']);
  await expect(cards(page).nth(2).locator('.resource-sample strong')).toHaveText(['240%', '1.5 GiB']);
  await expect(cards(page).nth(2).locator('.status')).toHaveText('Starting');
  await expect(cards(page).first()).toContainText('configured CPU limit');
  await expect(cards(page).first()).toContainText('configured memory limit');
  await expect(cards(page).first()).toContainText('Most recently received resource sample. CPU: 100% = one core. Memory is container usage.');
  expect(state.statusReads).toHaveLength(3);
  await page.screenshot({path: info.outputPath('fleet-resource-cards.png'), fullPage: true});
  const reads = [...state.statusReads], requests = [];
  page.on('request', request => {if (request.url().includes('/api/')) requests.push(request.method() + ' ' + new URL(request.url()).pathname);});
  await page.getByRole('combobox', {name: 'View servers', exact: true}).selectOption('table');
  const table = page.getByRole('table', {name: /Fleet servers/});
  const rows = table.getByRole('row');
  for (const [index, values] of [[1, ['0%', '0 B']], [2, ['12.3%', '512.0 MiB']], [3, ['240%', '1.5 GiB']]]) {
    await expect(rows.nth(index).getByRole('cell').nth(7)).toHaveText(values[0]);
    await expect(rows.nth(index).getByRole('cell').nth(8)).toHaveText(values[1]);
    await expect(rows.nth(index).getByRole('cell').nth(4)).toHaveText('1 cores');
    await expect(rows.nth(index).getByRole('cell').nth(5)).toHaveText('2 GiB');
  }
  await expect(rows.nth(2).getByRole('cell').nth(6)).toHaveText('—');
  await expect(rows.nth(2).getByRole('link', {name: 'Manage application', exact: true})).toBeVisible();
  await expect(rows.nth(3).getByRole('link', {name: 'Open server', exact: true})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + state.remote[0].id + '/');
  await expect(table.getByRole('button', {name: 'Remove', exact: true})).toHaveCount(0);
  expect(state.statusReads).toEqual(reads); expect(requests).toEqual([]);
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  await page.screenshot({path: info.outputPath('fleet-resource-table.png'), fullPage: true});
});

test('refresh replaces sampled values and hides retained samples for stopped, failed, offline and removed servers', async ({page}) => {
  await page.clock.install(); const state = await fleet(page);
  const path = '/servers/' + state.local[0].id + '/api/status';
  const good = {running: true, ready: true, cpu: 240, memory: 1.5 * 1024 ** 3};
  state.status[path] = good;
  await login(page);
  const factory = () => cards(page).filter({has: page.getByRole('heading', {name: 'Friday factory', exact: true})});
  const sample = () => factory().locator('.resource-sample strong');
  await expect(sample()).toHaveText(['240%', '1.5 GiB']);
  state.status[path] = {...good, running: false, ready: false, state: 'exited'};
  await page.clock.fastForward(6000);
  await expect(factory().locator('.status')).toHaveText('Stopped');
  await expect(sample()).toHaveText(['Unavailable', 'Unavailable']);
  state.status[path] = {...good, cpu: -1, memory: null};
  await page.clock.fastForward(6000);
  await expect(factory().locator('.status')).toHaveText('Ready');
  await expect(sample()).toHaveText(['Unavailable', 'Unavailable']);
  state.status[path] = null; await page.clock.fastForward(6000);
  await expect(factory().locator('.status')).toHaveText('Checking');
  await expect(sample()).toHaveText(['Unavailable', 'Unavailable']);
  state.status[path] = good; await page.clock.fastForward(6000);
  await expect(sample()).toHaveText(['240%', '1.5 GiB']);
  state.local[0].unavailable = true; await page.clock.fastForward(6000);
  await expect(sample()).toHaveText(['Unavailable', 'Unavailable']);
  await expect(factory().getByRole('button', {name: 'Remove', exact: true})).toBeDisabled();
  delete state.local[0].unavailable; await page.clock.fastForward(6000);
  await expect(sample()).toHaveText(['240%', '1.5 GiB']);
  state.hosts[0].connected = false; await page.clock.fastForward(6000);
  await expect(sample()).toHaveText(['Unavailable', 'Unavailable']);
  await page.getByRole('combobox', {name: 'View servers', exact: true}).selectOption('table');
  const row = page.getByRole('row').filter({has: page.getByRole('rowheader', {name: 'Friday factory', exact: true})});
  await expect(row.getByRole('cell').nth(7)).toHaveText('Unavailable');
  await expect(row.getByRole('cell').nth(8)).toHaveText('Unavailable');
  state.hosts[0].connected = true; state.local[0].state = 'removed'; await page.clock.fastForward(6000);
  await expect(row).toHaveCount(0);
  await expect(count(page)).toHaveText('Showing 2 of 2 servers');
});

test('sampled resource ordering uses raw scoped values in both views without additional IO', async ({
  page,
}, info) => {
  await page.clock.install();
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {writeText: async () => {}},
    }),
  );
  const state = await fleet(page);
  state.local[0].name = 'Alpha rounded';
  state.local[0].cpu = 99;
  state.local[1].name = 'Zero crew';
  state.remote[0].id = state.local[0].id;
  state.remote[0].name = 'Zulu rounded';
  state.remote[0].cpu = 0.1;
  state.local.push(
    {...state.local[0], id: '8'.repeat(32), name: 'High CPU'},
    {...state.local[0], id: '9'.repeat(32), name: 'Unknown crew'},
  );
  const samples = [
    [state.local[0], 12.31, 512 * 1024 ** 2],
    [state.local[1], 0, 0],
    [state.local[2], 240, 1024],
    [state.local[3], null, -1],
  ];
  for (const [server, cpu, memory] of samples)
    state.status['/servers/' + server.id + '/api/status'] = {
      running: true,
      ready: true,
      cpu,
      memory,
    };
  state.status[
    '/hosts/' + remote + '/servers/' + state.remote[0].id + '/api/status'
  ] = {running: true, ready: true, cpu: 12.34, memory: 1.5 * 1024 ** 3};
  await login(page);
  await expect(
    cards(page)
      .filter({hasText: 'High CPU'})
      .locator('.resource-sample strong')
      .first(),
  ).toHaveText('240%');
  await expect.poll(() => state.statusReads.length).toBe(5);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/'))
      requests.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
  const sort = page.getByRole('combobox', {name: 'Sort servers', exact: true}),
    view = page.getByRole('combobox', {name: 'View servers', exact: true});
  await expect(sort.locator('option')).toHaveText([
    'Current host order',
    'Name A–Z',
    'Name Z–A',
    'Sampled CPU, high to low',
    'Sampled memory, high to low',
  ]);
  for (const mode of ['cards', 'table']) {
    await view.selectOption(mode);
    const names = () =>
      mode === 'table'
        ? page
            .getByRole('table', {name: /Fleet servers/})
            .getByRole('rowheader')
        : cards(page).locator('h2');
    for (const [order, expected] of [
      [
        'sample-cpu',
        [
          'High CPU',
          'Zulu rounded',
          'Alpha rounded',
          'Zero crew',
          'Unknown crew',
        ],
      ],
      [
        'sample-memory',
        [
          'Zulu rounded',
          'Alpha rounded',
          'High CPU',
          'Zero crew',
          'Unknown crew',
        ],
      ],
    ]) {
      await sort.focus();
      await sort.selectOption(order);
      await expect(sort).toBeFocused();
      await expect(names()).toHaveText(expected);
    }
    const selected =
      mode === 'table'
        ? page
            .getByRole('row')
            .filter({
              has: page.getByRole('rowheader', {
                name: 'Zulu rounded',
                exact: true,
              }),
            })
        : cards(page).filter({
            has: page.getByRole('heading', {name: 'Zulu rounded', exact: true}),
          });
    await expect(
      selected.getByRole('link', {name: 'Open server', exact: true}),
    ).toHaveAttribute(
      'href',
      '/hosts/' + remote + '/servers/' + state.remote[0].id + '/',
    );
    await selected
      .getByRole('button', {name: 'Copy address', exact: true})
      .click();
    await selected
      .getByRole('button', {name: 'Publish snapshot', exact: true})
      .click();
    await expect(page.locator('#publish input[name="hostId"]')).toHaveValue(
      remote,
    );
    await expect(page.locator('#publish input[name="serverId"]')).toHaveValue(
      state.remote[0].id,
    );
    await page.locator('#cancel-publish').click();
    await selected.getByRole('button', {name: 'Remove', exact: true}).click();
    await expect(page.locator('#remove input[name="hostId"]')).toHaveValue(
      remote,
    );
    await page.locator('#cancel-remove').click();
    await search(page).fill('ROUNDED');
    await page
      .getByRole('combobox', {name: 'Filter by application', exact: true})
      .selectOption('factorio');
    await page
      .getByRole('combobox', {name: 'Filter by host', exact: true})
      .selectOption(remote);
    await page
      .getByRole('combobox', {name: 'Filter by status', exact: true})
      .selectOption('Ready');
    await expect(names()).toHaveText(['Zulu rounded']);
    await expect(count(page)).toHaveText('Showing 1 of 5 servers');
    await search(page).fill('missing');
    await expect(count(page)).toHaveText('Showing 0 of 5 servers');
    await page
      .getByRole('button', {name: 'Clear filters', exact: true})
      .click();
    await expect(search(page)).toBeFocused();
    await expect(sort).toHaveValue('sample-memory');
    await expect(view).toHaveValue(mode);
    await expect(names()).toHaveText([
      'Zulu rounded',
      'Alpha rounded',
      'High CPU',
      'Zero crew',
      'Unknown crew',
    ]);
  }
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('sampled-resource-order.png'),
    fullPage: true,
  });
});

test('sampled resource order follows refreshed eligibility while preserving query caret, table scroll and session choices', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fleet(page),
    localPath = '/servers/' + state.local[0].id + '/api/status',
    remotePath =
      '/hosts/' + remote + '/servers/' + state.remote[0].id + '/api/status';
  state.local[0].name = 'Local crew';
  state.local[1].name = 'Unknown crew';
  state.remote[0].name = 'Remote crew';
  state.status[localPath] = {
    running: true,
    ready: true,
    cpu: 240,
    memory: 1024,
  };
  state.status[remotePath] = {
    running: true,
    ready: true,
    cpu: 100,
    memory: 512 * 1024 ** 2,
  };
  await login(page, 'Viewer');
  const sort = page.getByRole('combobox', {name: 'Sort servers', exact: true}),
    view = page.getByRole('combobox', {name: 'View servers', exact: true});
  await sort.selectOption('sample-cpu');
  await view.selectOption('table');
  await search(page).fill('crew');
  const table = page.getByRole('table', {name: /Fleet servers/}),
    names = table.getByRole('rowheader'),
    region = page.getByRole('region', {
      name: 'Fleet servers table',
      exact: true,
    });
  await expect(names).toHaveText(['Local crew', 'Remote crew', 'Unknown crew']);
  const scrollLeft = await region.evaluate((element) => {
    element.scrollLeft = 350;
    return element.scrollLeft;
  });
  await search(page).focus();
  await search(page).evaluate((input) => input.setSelectionRange(1, 3));
  state.status[remotePath].cpu = 300;
  await page.clock.fastForward(6000);
  await expect(names).toHaveText(['Remote crew', 'Local crew', 'Unknown crew']);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue('crew');
  expect(
    await search(page).evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([1, 3]);
  expect(await region.evaluate((element) => element.scrollLeft)).toBe(
    scrollLeft,
  );
  await expect(sort).toHaveValue('sample-cpu');
  await region.focus();
  state.status[remotePath].running = false;
  state.status[remotePath].state = 'exited';
  await page.clock.fastForward(6000);
  await expect(names).toHaveText(['Local crew', 'Remote crew', 'Unknown crew']);
  await expect(region).toBeFocused();
  expect(await region.evaluate((element) => element.scrollLeft)).toBe(
    scrollLeft,
  );
  state.status[remotePath] = {
    running: true,
    ready: true,
    cpu: 999,
    memory: 999,
  };
  state.hosts[1].connected = false;
  await page.clock.fastForward(6000);
  await expect(names).toHaveText(['Local crew', 'Remote crew', 'Unknown crew']);
  await expect(
    table
      .getByRole('row')
      .filter({
        has: page.getByRole('rowheader', {name: 'Remote crew', exact: true}),
      }),
  ).toContainText('Unavailable');
  await nav(page)
    .getByRole('link', {name: 'Snapshot library', exact: true})
    .click();
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await expect(sort).toHaveValue('sample-cpu');
  await expect(view).toHaveValue('table');
  await expect(search(page)).toHaveValue('crew');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByLabel('Username', {exact: true})).toBeVisible();
  await login(page, 'Assigned');
  await expect(sort).toHaveValue('host');
  await expect(sort.locator('option')).toHaveText([
    'Current host order',
    'Name A–Z',
    'Name Z–A',
  ]);
  await expect(view).toHaveCount(0);
  await expect(page.locator('.resource-sample')).toHaveCount(0);
});

test('loaded availability keeps context across status choices and updates with existing refresh', async ({page}, info) => {
  await page.clock.install();
  const state = await fleet(page);
  state.remote[0].id = state.local[0].id;
  const rustStatus = '/servers/' + state.local[1].id + '/api/status';
  state.status[rustStatus] = {state: 'exited', running: false, ready: false};
  await login(page);
  const summary = page.getByRole('region', {name: 'Loaded server availability', exact: true});
  const status = page.getByRole('combobox', {name: 'Filter by status', exact: true});
  await expect(summary).toContainText('3 servers matching search, application and host filters (before status).');
  await expect(summary).toContainText('Ready: 2 · Stopped: 1');
  const requests = [];
  page.on('request', request => {if (request.url().includes('/api/')) requests.push(request.method() + ' ' + new URL(request.url()).pathname);});
  await status.selectOption('Stopped');
  await expect(cards(page)).toHaveCount(1);
  await expect(summary).toContainText('Ready: 2 · Stopped: 1');
  await search(page).fill('factory');
  await page.getByRole('combobox', {name: 'Filter by application', exact: true}).selectOption('factorio');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(remote);
  await expect(summary).toContainText('1 server matching');
  await expect(summary).toContainText('Ready: 1');
  await expect(status.locator('option')).toHaveText(['All statuses', 'Ready (1)', 'Stopped (0)']);
  await expect(cards(page)).toHaveCount(0);
  await status.selectOption('Ready');
  await page.getByRole('combobox', {name: 'View servers', exact: true}).selectOption('table');
  await expect(page.getByRole('table').locator('.status')).toHaveText('Ready');
  expect(requests).toEqual([]);
  await search(page).evaluate(input => {input.focus(); input.setSelectionRange(1, 4);});
  state.hosts[1].connected = false;
  const before = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(summary).toContainText('Host unavailable: 1');
  await expect(summary).toContainText('Unavailable hosts may have servers missing from this loaded inventory.');
  await expect(status).toHaveValue('Ready');
  await expect(status.locator('option:checked')).toHaveText('Ready (0)');
  await expect(search(page)).toBeFocused();
  expect(await search(page).evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([1, 4]);
  await status.selectOption('Host unavailable'); await status.focus();
  await expect(page.getByRole('table').locator('.status')).toHaveText('Host unavailable');
  state.hosts[1].connected = true;
  const refresh = state.reads; await page.clock.fastForward(6000);
  await expect.poll(() => state.reads).toBeGreaterThan(refresh);
  await expect(summary).toContainText('Ready: 1');
  await expect(summary).not.toContainText('Unavailable hosts');
  await expect(status).toBeFocused();
  await search(page).fill('missing'); await expect(summary).toContainText('No matching loaded servers.');
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click();
  await expect(summary).toContainText('Ready: 2 · Stopped: 1');
  await page.screenshot({path: info.outputPath('loaded-availability.png'), fullPage: true});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
});

test('cold unavailable host does not make loaded availability claim a complete inventory', async ({page}) => {
  await page.clock.install(); const state = await fleet(page);
  state.hosts[1].connected = false;
  await login(page, 'Viewer');
  const summary = page.getByRole('region', {name: 'Loaded server availability', exact: true});
  await expect(summary).toContainText('2 servers matching');
  await expect(summary).toContainText('Ready: 2');
  await expect(summary).toContainText('Unavailable hosts may have servers missing');
  await page.getByRole('combobox', {name: 'Filter by host', exact: true}).selectOption(local);
  await expect(summary).not.toContainText('Unavailable hosts');
  await expect(summary).toContainText('Ready: 2');
});
