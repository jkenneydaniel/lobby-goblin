import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
const local = 'a'.repeat(32), remote = 'd'.repeat(32), id = 'c'.repeat(32);
const test = base.extend({page: async ({page}, use) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origins.fleet ? route.continue() : route.abort());
  await page.route('**/api/hosts', route => route.fulfill({json: {hosts: [{id: local, name: 'This host', local: true, connected: true}]}}));
  await page.route('**/api/updates/settings', route => route.fulfill({json: {enabled: true, channel: 'preview', revision: 0, editable: true}}));
  await page.route(/\/api\/updates(?:\/check)?$/, route => route.fulfill({json: {current: '0.3.14-alpha', state: 'available', available: true, latest: {tag: 'v99.0.0-alpha', notes: 'Synthetic management release', url: 'https://github.com/jkenneydaniel/lobby-goblin/releases/tag/v99.0.0-alpha'}}}));
  await use(page); await page.unrouteAll({behavior: 'wait'}); expect(errors).toEqual([]);
}});
async function open(page, user = 'Preview') {
  await page.goto(origins.fleet); await page.getByLabel('Username', {exact: true}).fill(user);
  await page.getByLabel('Password', {exact: true}).fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  if (user === 'Preview') await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Updates', exact: true}).click();
}
const review = () => ({id, version: '99.0.0-alpha', state: 'reviewed', expires: Date.now() + 900000, image: 'ghcr.io/jkenneydaniel/lobby-goblin@sha256:' + 'a'.repeat(64), phase: 'planned', committed: false, actions: ['apply', 'cancel'], services: {management: 5, applications: 2}, message: 'Review complete. Management services will restart together; game containers keep running.'});
test('review, confirm, survive a lost install response and reconnect to durable completion', async ({page}, info) => {
  let update = null, reads = 0; const writes = [];
  await page.route('**/api/management-update', route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); writes.push(input);
      if (input.action === 'plan') update = {...review(), requestId: input.requestId, action: input.action};
      else {expect(input).toMatchObject({action: 'apply', id, confirm: true}); update = {...update, requestId: input.requestId, action: input.action, state: 'running', phase: 'stopping', actions: [], message: 'Updating management services. Waiting for the panel to reconnect…'}; return route.abort('connectionreset');}
    } else if (update?.state === 'running' && ++reads > 1) update = {...update, state: 'complete', phase: 'complete', message: 'Management update complete. Application containers and storage were preserved.'};
    return route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}});
  });
  await open(page); await page.getByRole('button', {name: 'Review management update to 99.0.0-alpha'}).click();
  await expect(page.getByText('5 management services · 2 application containers preserved')).toBeVisible();
  await page.getByText('Verified runtime image', {exact: true}).click();
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  await page.locator('.management-update').scrollIntoViewIfNeeded();
  await page.screenshot({path: info.outputPath('management-review.png')});
  await page.getByRole('button', {name: 'Install management update', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Game containers and worlds are preserved');
  await page.getByRole('dialog').getByRole('button', {name: 'Install management update', exact: true}).click();
  await expect(page.getByText('Management update complete. Application containers and storage were preserved.', {exact: true})).toBeVisible();
  expect(writes.map(input => input.action)).toEqual(['plan', 'apply']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(new Set(writes.map(input => input.requestId)).size).toBe(2);
  await page.reload(); await expect(page.getByText('Management update complete. Application containers and storage were preserved.', {exact: true})).toBeVisible();
});
test('a rejected management action remains visible after successful status reconciliation', async ({page}) => {
  await page.route('**/api/management-update', route => route.request().method() === 'POST' ?
    route.fulfill({status: 409, json: {error: 'Wait for the active application operation to finish.'}}) :
    route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page); await page.getByRole('button', {name: 'Review management update to 99.0.0-alpha'}).click();
  await expect(page.getByRole('alert')).toContainText('Wait for the active application operation to finish.');
  await expect(page.getByRole('button', {name: 'Review management update to 99.0.0-alpha'})).toBeEnabled();
});
test('expired reviews allow cancellation and committed recovery offers only forward resume', async ({page}) => {
  let update = {...review(), expires: Date.now() - 60000};
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}}));
  await open(page); await expect(page.getByRole('button', {name: 'Install management update', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Cancel review', exact: true})).toBeEnabled();
  update = {...review(), state: 'attention', committed: true, phase: 'activating', actions: ['resume'], message: 'The management update needs recovery.'};
  await page.reload(); await expect(page.getByRole('button', {name: 'Resume update', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Restore previous management', exact: true})).toHaveCount(0);
});
test('remote management controls stay scoped and older hosts receive the bootstrap guide', async ({page}) => {
  await page.route('**/api/hosts', route => route.fulfill({json: {hosts: [{id: local, name: 'This host', local: true, connected: true}, {id: remote, name: 'Remote host', local: false, connected: true}]}}));
  for (const [resource, data] of [['servers', {servers: []}], ['snapshots', {snapshots: []}], ['jobs**', {jobs: [], active: null}]]) await page.route('**/api/hosts/' + remote + '/' + resource, route => route.fulfill({json: data}));
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  const writes = [];
  await page.route('**/api/hosts/' + remote + '/management-update', route => {
    if (route.request().method() === 'POST') writes.push(route.request().postDataJSON());
    return route.fulfill({json: {supported: false, update: null}});
  });
  await open(page); await page.getByRole('combobox', {name: 'Management host', exact: true}).selectOption(remote);
  await expect(page.getByText(/This host needs one host-side upgrade/)).toBeVisible();
  await expect(page.getByRole('button', {name: /Review management update/})).toHaveCount(0); expect(writes).toEqual([]);
});
