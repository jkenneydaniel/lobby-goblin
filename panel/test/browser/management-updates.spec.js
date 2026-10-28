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
  // Private LAN HTTP does not expose randomUUID. getRandomValues remains
  // available there, so update confirmation must not require a secure context.
  await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'randomUUID', {value: undefined}));
  let update = null, reads = 0; const writes = [];
  await page.route('**/api/management-update', route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); writes.push(input);
      if (input.action === 'plan') update = {...review(), requestId: input.requestId, action: input.action};
      else {expect(input).toMatchObject({action: 'apply', id, confirm: true}); update = {...update, requestId: input.requestId, action: input.action, state: 'running', phase: 'stopping', actions: [], message: 'Updating management services. Waiting for the panel to reconnect…'}; return route.abort('connectionreset');}
    } else if (update?.state === 'running' && ++reads > 1) update = {...update, state: 'complete', phase: 'complete', message: 'Management update complete. Application containers and storage were preserved.'};
    return route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}});
  });
  await open(page); await page.getByRole('button', {name: 'Review update'}).click();
  await expect(page.getByRole('status').filter({hasText: 'Ready to install'})).toBeVisible();
  await page.screenshot({path: info.outputPath('updates-review-clean.png'), fullPage: true});
  await page.getByText('Update details', {exact: true}).click();
  await expect(page.getByText('5 panel services · 2 game containers preserved')).toBeVisible();
  await expect(page.getByText('Verified runtime image', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  await page.locator('.management-update').scrollIntoViewIfNeeded();
  await page.screenshot({path: info.outputPath('management-review.png')});
  await page.getByRole('button', {name: 'Install update', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Game servers keep running and their worlds are preserved');
  await page.getByRole('dialog').getByRole('button', {name: 'Install update', exact: true}).click();
  await expect(page.getByRole('status', {name: ''}).filter({hasText: 'Update complete'})).toBeVisible();
  expect(writes.map(input => input.action)).toEqual(['plan', 'apply']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(new Set(writes.map(input => input.requestId)).size).toBe(2);
  await page.reload(); await expect(page.getByRole('status', {name: ''}).filter({hasText: 'Update complete'})).toBeVisible();
});
test('a rejected management action remains visible after successful status reconciliation', async ({page}) => {
  await page.route('**/api/management-update', route => route.request().method() === 'POST' ?
    route.fulfill({status: 409, json: {error: 'Wait for the active application operation to finish.'}}) :
    route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page); await page.getByRole('button', {name: 'Review update'}).click();
  await expect(page.getByRole('alert')).toContainText('Wait for the active application operation to finish.');
  await expect(page.getByRole('button', {name: 'Review update'})).toBeEnabled();
});
test('a confirmed never-started coordinator can be reset before a new review', async ({page}) => {
  let update = {...review(), state: 'attention', actions: ['reset'], message: 'The review coordinator never started. Reset this failed review to try again.'};
  const writes = [];
  await page.route('**/api/management-update', route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); writes.push(input);
      expect(input).toMatchObject({action: 'reset', id, confirm: true});
      update = {...update, state: 'failed', actions: [], message: 'The review coordinator never started. You can review the release again.'};
    }
    return route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}});
  });
  await open(page); await page.getByRole('button', {name: 'Reset failed review', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Confirm', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Review update'})).toBeEnabled();
  expect(writes).toHaveLength(1);
});
test('expired reviews allow cancellation and committed recovery offers only forward resume', async ({page}) => {
  let update = {...review(), expires: Date.now() - 60000};
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}}));
  await open(page); await expect(page.getByRole('button', {name: 'Install update', exact: true})).toBeDisabled();
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
  await open(page); await page.getByRole('combobox', {name: 'Host', exact: true}).selectOption(remote);
  await expect(page.getByText(/This host needs a one-time setup/)).toBeVisible();
  await expect(page.getByRole('button', {name: /Review update/})).toHaveCount(0); expect(writes).toEqual([]);
});

test('up-to-date view shows the installed version once and keeps settings out of the main flow', async ({page}, info) => {
  await page.route(/\/api\/updates(?:\/check)?$/, route => route.fulfill({json: {current: '0.3.15-alpha', state: 'current', available: false, channel: 'preview', checkedAt: '2026-10-28T12:00:00Z', latest: {tag: 'v0.3.15-alpha', notes: 'Current release', url: 'https://github.com/jkenneydaniel/lobby-goblin/releases/tag/v0.3.15-alpha'}}}));
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.15-alpha', update: null}}));
  await open(page);
  await expect(page.getByRole('status').filter({hasText: 'Up to date'})).toBeVisible();
  await expect(page.getByText('Installed 0.3.15-alpha', {exact: true})).toHaveCount(1);
  await expect(page.getByRole('combobox', {name: 'Host', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Release channel', exact: true})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Review update', exact: true})).toHaveCount(0);
  expect(await page.locator('#updates-view').innerText()).not.toContain('→');
  await page.screenshot({path: info.outputPath('updates-current-clean.png'), fullPage: true});
  await page.locator('#updates-view').screenshot({path: info.outputPath('updates-current-content.png')});
  await page.getByText('Update settings', {exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Release channel', exact: true})).toBeVisible();
});
test('older hosts show one actionable setup message', async ({page}, info) => {
  await page.route(/\/api\/updates(?:\/check)?$/, route => route.fulfill({json: {current: '0.3.14-alpha', state: 'current', available: false, latest: {tag: 'v0.3.14-alpha', url: 'https://github.com/jkenneydaniel/lobby-goblin/releases/tag/v0.3.14-alpha'}}}));
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: false, update: null}}));
  await open(page);
  await expect(page.getByRole('link', {name: 'Set up panel updates', exact: true})).toBeVisible();
  await expect(page.getByRole('combobox', {name: 'Release channel', exact: true})).toBeHidden();
  await expect(page.getByText(/broker and registered controllers/)).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  await page.screenshot({path: info.outputPath('updates-setup-clean.png'), fullPage: true});
  await page.locator('#updates-view').screenshot({path: info.outputPath('updates-setup-content.png')});
});
test('temporarily unavailable update controls can be retried without claiming setup is required', async ({page}) => {
  let unavailable = true;
  await page.route('**/api/management-update', route => unavailable ? route.fulfill({status: 502, json: {error: 'The host is temporarily unavailable.'}}) : route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('link', {name: 'Set up panel updates', exact: true})).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', {name: 'Retry update controls', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Review update', exact: true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('polling keeps expanded details and unsaved release settings', async ({page}) => {
  let reads = 0;
  await page.route('**/api/management-update', route => {reads++; return route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: {...review(), state: 'running', actions: []}}});});
  await open(page);
  await page.getByText('Update details', {exact: true}).click();
  await page.getByText('Update settings', {exact: true}).click();
  await page.getByRole('combobox', {name: 'Release channel', exact: true}).selectOption('stable');
  const previous = reads;
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(page.getByText('Verified runtime image', {exact: true})).toBeVisible();
  await expect(page.getByRole('combobox', {name: 'Release channel', exact: true})).toHaveValue('stable');
});
test('game updates lead to server controls and keep release catalogues optional', async ({page}, info) => {
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page);
  await page.getByRole('combobox', {name: 'Server', exact: true}).selectOption(local + ':' + 'b'.repeat(32));
  const controls = page.getByRole('link', {name: 'Manage game updates', exact: true});
  await expect(controls).toBeVisible();
  await expect(controls).toHaveAttribute('href', /servers\/b+\/#settings\/updates$/);
  await expect(page.getByRole('combobox', {name: 'Published server version', exact: true})).toBeHidden();
  await page.screenshot({path: info.outputPath('updates-game-clean.png'), fullPage: true});
  await page.getByText('Browse releases', {exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Published server version', exact: true})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Version changes', exact: true})).toHaveAttribute('href', /2.0.78/);
});

test('cancelling a review is explicit and does not describe an installation', async ({page}) => {
  let update = review(); const writes = [];
  await page.route('**/api/management-update', route => {
    if (route.request().method() === 'POST') {const input = route.request().postDataJSON(); writes.push(input); update = {...update, state: 'rolled-back', actions: []};}
    return route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update}});
  });
  await open(page);
  await page.getByRole('button', {name: 'Cancel review', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Review the release again when you are ready to install.');
  await expect(dialog).not.toContainText('restart');
  await dialog.getByRole('button', {name: 'Confirm', exact: true}).click();
  expect(writes.map(input => input.action)).toEqual(['cancel']);
});

test('checking releases does not silently rebase an unsaved settings change', async ({page}) => {
  let revision = 0;
  await page.route('**/api/updates/settings', route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().revision).toBe(0);
      return route.fulfill({status: 409, json: {error: 'Release settings changed in another session. Reload before saving.'}});
    }
    return route.fulfill({json: {enabled: true, channel: 'preview', revision, editable: true}});
  });
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page);
  await page.getByText('Update settings', {exact: true}).click();
  await page.getByRole('combobox', {name: 'Release channel', exact: true}).selectOption('stable');
  revision = 1;
  await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Release channel', exact: true})).toHaveValue('stable');
  await page.getByRole('button', {name: 'Save settings', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('changed in another session');
});
test('a failed initial release-settings read can be retried from Check for updates', async ({page}) => {
  let failed = true;
  await page.route('**/api/updates/settings', route => failed ? route.fulfill({status: 502, json: {error: 'Release settings are temporarily unavailable.'}}) : route.fulfill({json: {enabled: true, channel: 'preview', revision: 0, editable: true}}));
  await page.route('**/api/management-update', route => route.fulfill({json: {supported: true, currentVersion: '0.3.14-alpha', update: null}}));
  await open(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  failed = false;
  await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Review update', exact: true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
