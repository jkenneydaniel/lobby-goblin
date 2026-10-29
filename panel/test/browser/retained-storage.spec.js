import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';

const local = 'a'.repeat(32), remote = 'd'.repeat(32), id = '9'.repeat(32);
const test = base.extend({page: async ({page}, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origins.fleet ? route.continue() : route.abort());
  await page.route('**/api/hosts', route => route.fulfill({json: {hosts: [{id: local, name: 'This host', local: true, connected: true}]}}));
  await use(page);
  expect(errors).toEqual([]);
}});
const removed = () => ({id, name: 'Retired island', game: 'rust', volume: 'synthetic-retained-volume', removedAt: '2026-10-27T12:00:00Z'});
const review = (token = 'synthetic-review') => ({token, inspectedAt: new Date().toISOString(), fingerprint: 'synthetic', summary: {files: 1234, bytes: 4 * 1024 ** 3, sections: {data: {files: 1200, bytes: 3 * 1024 ** 3}, backups: {files: 34, bytes: 1024 ** 3}}}, recovery: {ready: true}});
const card = (page, name = 'Retired island') => page.getByRole('article').filter({has: page.getByRole('heading', {name, exact: true})});
async function open(page, user = 'Preview') {
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  if (user === 'Preview') await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Server storage', exact: true}).click();
}
async function mockStorage(page, item, options = {}) {
  const prefix = options.host ? '/hosts/' + options.host : '', requests = [], jobs = [];
  let inspections = 0;
  const fixture = {requests, jobs, refuse: false, complete() {
    item.storageReview = review('synthetic-review-' + (++inspections));
    Object.assign(jobs[0], {state: 'succeeded', message: 'Storage checked.'});
  }, fail(message) { Object.assign(jobs[0], {state: 'failed', message}); }};
  await page.route('**/api' + prefix + '/jobs**', route => route.fulfill({json: {jobs, active: jobs.find(job => job.state === 'running') || null}}));
  await page.route('**/api' + prefix + '/removed-servers**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({json: {servers: [item]}});
    const action = pathname.split('/').at(-1), body = request.postDataJSON();
    requests.push({path: pathname, body});
    if (action === 'remove' && fixture.refuse) return route.fulfill({status: 409, json: {error: 'A container still uses this volume. Storage was preserved.'}});
    const job = {id: 'synthetic-' + requests.length, action: {inspect: 'inspectStorage', recover: 'recoverStorage', remove: 'deleteStorage'}[action], state: 'succeeded', started: new Date().toISOString(), message: 'Storage operation complete.', target: {serverId: item.id}};
    jobs.unshift(job);
    if (action === 'inspect') {
      if (options.delay) job.state = 'running';
      else { fixture.complete(); if (options.recovery) item.storageReview.recovery = options.recovery; }
    } else if (action === 'recover') job.result = {serverId: '8'.repeat(32)};
    else { item.storageDeletedAt = new Date().toISOString(); delete item.storageReview; }
    return route.fulfill({status: 202, json: job});
  });
  return fixture;
}

test('choosing recovery checks storage and opens its form without another click', async ({page}, info) => {
  const item = removed(), fixture = await mockStorage(page, item);
  await open(page);
  const entry = card(page);
  await expect(entry.getByRole('button', {name: 'Recover', exact: true})).toBeVisible();
  await expect(entry.getByRole('button', {name: 'Delete data', exact: true})).toBeVisible();
  expect(fixture.requests).toEqual([]);
  await entry.getByRole('button', {name: 'Recover', exact: true}).click();
  const form = entry.locator('[data-recover-storage]');
  await expect(form.getByLabel('New server name')).toBeVisible();
  expect(fixture.requests.map(request => request.path.split('/').at(-1))).toEqual(['inspect']);
  await form.getByLabel('New server name').fill('Recovered island');
  await form.getByRole('textbox', {name: /confirm the source/}).fill(item.name);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', {name: 'Recover stopped server'}).click();
  await expect(entry.getByRole('link', {name: 'Open recovered server'})).toHaveAttribute('href', '/servers/' + '8'.repeat(32) + '/');
  await expect(form).toHaveCount(0);
  expect(fixture.requests[1]).toMatchObject({path: '/api/removed-servers/' + id + '/recover', body: {name: item.name, newName: 'Recovered island', confirm: true, reviewToken: 'synthetic-review-1'}});
  await page.screenshot({path: info.outputPath('storage-recovered.png')});
});

test('deletion checks automatically, requires explicit confirmation, and keeps drafts after rejection', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item);
  fixture.refuse = true;
  await open(page);
  const entry = card(page);
  await entry.getByRole('button', {name: 'Delete data', exact: true}).click();
  let form = entry.locator('[data-delete-storage]');
  await expect(form.getByRole('textbox')).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await form.getByRole('textbox').fill(item.name);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', {name: 'Permanently delete data'}).click();
  await expect(entry.getByRole('alert')).toContainText('still uses');
  expect(item.storageDeletedAt).toBeUndefined();
  await entry.getByRole('button', {name: 'Check storage again'}).click();
  form = entry.locator('[data-delete-storage]');
  await expect(form.getByRole('textbox')).toHaveValue(item.name);
  await expect(form.getByRole('checkbox')).toBeChecked();
  fixture.refuse = false;
  await form.getByRole('button', {name: 'Permanently delete data'}).click();
  await expect(entry).toHaveCount(0);
  await page.getByRole('combobox', {name: 'Storage status', exact: true}).selectOption('deleted');
  await expect(card(page).getByText('Data permanently deleted.', {exact: true})).toBeVisible();
  expect(fixture.requests.filter(request => request.path.endsWith('/remove'))).toHaveLength(2);
  expect(fixture.requests.at(-1).body.reviewToken).toBe('synthetic-review-2');
});

test('a delayed inspection shows progress and preserves the chosen action through refreshes', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item, {delay: true});
  await open(page);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  await expect(card(page).getByText(/Checking storage size/)).toBeVisible();
  await expect(card(page).locator('[data-delete-storage]')).toHaveCount(0);
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  expect(fixture.requests).toHaveLength(1);
  fixture.complete();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  const form = card(page).locator('[data-delete-storage]');
  await expect(form.getByRole('textbox')).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await form.getByRole('textbox').fill('Retired');
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(form.getByRole('textbox')).toHaveValue('Retired');
  await expect(card(page).getByRole('heading', {name: 'Delete retained data', exact: true})).toBeVisible();
});

test('failed background inspection exposes the cause and allows a deliberate retry', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item, {delay: true});
  await open(page);
  await card(page).getByRole('button', {name: 'Recover', exact: true}).click();
  fixture.fail('The volume is absent from this host.');
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(card(page).getByRole('alert')).toHaveText('The volume is absent from this host.');
  await expect(card(page).locator('form')).toHaveCount(0);
  await card(page).getByRole('button', {name: 'Check storage again'}).click();
  fixture.complete();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(card(page).getByLabel('New server name')).toBeVisible();
});

test('expired reviews are renewed and unsupported recovery explains why deletion is still available', async ({page}) => {
  const item = {...removed(), storageReview: {...review(), inspectedAt: '2020-01-01T00:00:00Z'}}, fixture = await mockStorage(page, item, {recovery: {ready: false, reason: 'An interrupted application change needs manual recovery review before copying.'}});
  await open(page);
  await card(page).getByRole('button', {name: 'Recover', exact: true}).click();
  await expect(card(page).getByText(/Recovery needs review:.*interrupted application change/)).toBeVisible();
  await expect(card(page).locator('[data-recover-storage]')).toHaveCount(0);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  await expect(card(page).locator('[data-delete-storage]')).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
});

test('all registered server storage is searchable and filterable without inspecting assigned volumes', async ({page}, info) => {
  const item = removed(), fixture = await mockStorage(page, item);
  await page.route('**/api/servers', route => route.fulfill({json: {servers: [{id: 'b'.repeat(32), name: 'Friday factory', game: 'factorio', state: 'installed', volume: 'synthetic-factory-data'}]}}));
  await open(page);
  await expect(page.getByRole('heading', {name: 'Server storage', exact: true})).toBeVisible();
  const assigned = card(page, 'Friday factory');
  await expect(assigned.getByText('Assigned to server', {exact: true})).toBeVisible();
  await expect(assigned.getByRole('link', {name: 'Open server'})).toHaveAttribute('href', '/servers/' + 'b'.repeat(32) + '/');
  await expect(assigned.getByRole('button')).toHaveCount(0);
  await page.getByLabel('Find storage').pressSequentially('synthetic-factory');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByLabel('Find storage')).toBeFocused();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(page.getByLabel('Find storage')).toHaveValue('synthetic-factory');
  await page.getByRole('button', {name: 'Clear filters'}).click();
  await page.getByRole('combobox', {name: 'Storage status', exact: true}).selectOption('retained');
  await expect(card(page)).toBeVisible();
  await expect(assigned).toHaveCount(0);
  await page.getByLabel('Find storage').fill('no such volume');
  await expect(page.getByRole('heading', {name: 'No matching storage'})).toBeVisible();
  await page.getByRole('button', {name: 'Clear filters'}).click();
  expect(fixture.requests).toEqual([]);
  await page.screenshot({path: info.outputPath('server-storage.png')});
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
});

test('viewers never see storage navigation or fetch retained volume details', async ({page}) => {
  const reads = [];
  page.on('request', request => {if (request.url().includes('/removed-servers')) reads.push(request.url());});
  await open(page, 'Viewer');
  await expect(page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Server storage', exact: true})).toHaveCount(0);
  await page.goto(origins.fleet + '/#storage');
  await expect(page.getByRole('heading', {name: /servers/i}).first()).toBeVisible();
  expect(reads).toEqual([]);
});

test('host filtering keeps recovery scoped to the remote host when server IDs overlap', async ({page}) => {
  const item = removed(), other = {...removed(), name: 'Remote island'}, localFixture = await mockStorage(page, item), remoteFixture = await mockStorage(page, other, {host: remote});
  for (const [resource, data] of [['servers', {servers: []}], ['snapshots', {snapshots: []}]]) await page.route('**/api/hosts/' + remote + '/' + resource, route => route.fulfill({json: data}));
  await page.route('**/api/hosts', route => route.fulfill({json: {hosts: [{id: local, name: 'This host', local: true, connected: true}, {id: remote, name: 'Remote host', local: false, connected: true}]}}));
  await open(page);
  await page.getByRole('combobox', {name: 'Host', exact: true}).selectOption(remote);
  await expect(card(page)).toHaveCount(0);
  const entry = card(page, 'Remote island');
  await entry.getByRole('button', {name: 'Recover', exact: true}).click();
  const form = entry.locator('[data-recover-storage]');
  await form.getByLabel('New server name').fill('Remote recovered');
  await form.getByRole('textbox', {name: /confirm the source/}).fill(other.name);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', {name: 'Recover stopped server'}).click();
  await expect(entry.getByRole('link', {name: 'Open recovered server'})).toHaveAttribute('href', '/hosts/' + remote + '/servers/' + '8'.repeat(32) + '/');
  expect(remoteFixture.requests[1]).toMatchObject({path: '/api/hosts/' + remote + '/removed-servers/' + id + '/recover', body: {newName: 'Remote recovered', name: other.name}});
  expect(localFixture.requests).toEqual([]);
});

test('offline hosts retain last known inventory and disable all storage actions', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item);
  let connected = true;
  await page.route('**/api/hosts', route => route.fulfill({json: {hosts: [{id: local, name: 'This host', local: true, connected}]}}));
  await open(page);
  await expect(card(page)).toBeVisible();
  connected = false;
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(card(page).getByText('Host offline · last known storage')).toBeVisible();
  await expect(card(page).getByRole('button', {name: 'Recover', exact: true})).toBeDisabled();
  await expect(card(page).getByRole('button', {name: 'Delete data', exact: true})).toBeDisabled();
  await expect(page.getByRole('combobox', {name: 'Host', exact: true})).toContainText('This host (offline)');
  expect(fixture.requests).toEqual([]);
});

test('expiry withdraws a confirmation form until rechecked and preserves the entered name', async ({page}) => {
  const item = {...removed(), storageReview: review()}, fixture = await mockStorage(page, item);
  await open(page);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  let form = card(page).locator('[data-delete-storage]');
  await form.getByRole('textbox').fill(item.name);
  await form.getByRole('checkbox').check();
  item.storageReview.inspectedAt = '2020-01-01T00:00:00Z';
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(form).toHaveCount(0);
  expect(fixture.requests).toEqual([]);
  await card(page).getByRole('button', {name: 'Check storage again'}).click();
  form = card(page).locator('[data-delete-storage]');
  await expect(form.getByRole('textbox')).toHaveValue(item.name);
  await expect(form.getByRole('checkbox')).toBeChecked();
  expect(fixture.requests.map(request => request.path.split('/').at(-1))).toEqual(['inspect']);
});

test('background refresh preserves checkbox focus and the open confirmation', async ({page}) => {
  const item = {...removed(), storageReview: review()};
  await mockStorage(page, item);
  await open(page);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  const checkbox = card(page).getByRole('checkbox');
  await checkbox.check();
  await checkbox.focus();
  item.storageReview.summary.files = 1235;
  await expect(card(page).getByText(/4.0 GiB · 1,235 files/).first()).toBeVisible({timeout: 10000});
  await expect(checkbox).toBeFocused();
  await expect(checkbox).toBeChecked();
});

test('leaving during a check and returning never repeats the check or submits the chosen deletion', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item, {delay: true});
  await open(page);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  await expect(card(page).getByText(/Checking storage size/)).toBeVisible();
  await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Servers', exact: true}).click();
  fixture.complete();
  await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Server storage', exact: true}).click();
  await expect(card(page).locator('[data-delete-storage]')).toBeVisible();
  expect(fixture.requests.map(request => request.path.split('/').at(-1))).toEqual(['inspect']);
});

test('a completed check without fresh details offers recovery instead of waiting forever or using an old review', async ({page}) => {
  const item = {...removed(), storageReview: {...review(), inspectedAt: '2020-01-01T00:00:00Z'}}, fixture = await mockStorage(page, item, {delay: true});
  await open(page);
  await card(page).getByRole('button', {name: 'Delete data', exact: true}).click();
  Object.assign(fixture.jobs[0], {state: 'succeeded'});
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(card(page).getByRole('alert')).toContainText('fresh storage details are unavailable');
  await expect(card(page).getByRole('button', {name: 'Check storage again'})).toBeEnabled();
  await expect(card(page).locator('[data-delete-storage]')).toHaveCount(0);
  expect(fixture.requests).toHaveLength(1);
});

test('a published review is not treated as an error while its job snapshot is still running', async ({page}) => {
  const item = removed(), fixture = await mockStorage(page, item, {delay: true});
  await open(page);
  const entry = card(page);
  await entry.getByRole('button', {name: 'Delete data', exact: true}).click();
  await expect(entry.getByText(/Checking storage size/)).toBeVisible();
  fixture.complete();
  Object.assign(fixture.jobs[0], {state: 'running', message: 'Inspecting retained storage without changing its contents…'});
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  const form = entry.locator('[data-delete-storage]');
  await expect(form.getByRole('textbox')).toBeVisible();
  await expect(entry.getByRole('alert')).toHaveCount(0);
  await expect(form.getByRole('button', {name: 'Permanently delete data'})).toBeDisabled();
  fixture.jobs[0].state = 'succeeded';
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(form.getByRole('button', {name: 'Permanently delete data'})).toBeEnabled();
  await expect(entry.getByRole('alert')).toHaveCount(0);
  expect(fixture.requests.map(request => request.path.split('/').at(-1))).toEqual(['inspect']);
});
