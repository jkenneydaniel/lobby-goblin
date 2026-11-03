import {test as base, expect} from '@playwright/test';
import {origins, scope} from './playwright.config.js';

const test = base.extend({page: async ({page}, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => Object.values(origins).includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await use(page);
  expect(errors).toEqual([]);
}});

async function openBackups(page, game, state) {
  await page.clock.install();
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({json: {...status, summary: {...status.summary, state: state.stopped ? 'stopped' : 'ready'}, running: !state.stopped, ready: !state.stopped, activeJob: null}});
  });
  if (game === 'factorio') {
    await page.goto(origins.factorio + scope + '/#backups');
  } else {
    await page.goto(origins.rust);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('rust-preview-password');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Backups', exact: true}).click();
  }
  await expect(page.getByRole('button', {name: 'Save schedule', exact: true})).toBeEnabled();
}

for (const game of ['factorio', 'rust']) {
  test(game + ' keeps a schedule save pending through status refresh and permits a deliberate retry after rejection', async ({page}) => {
    const state = {stopped: false}, writes = [];
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    await page.route('**/api/schedule', async route => {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        await gate;
        await route.fulfill({status: 503, json: {error: 'Synthetic schedule rejection'}});
      } else await route.fulfill({json: {ok: true}});
    });
    try {
      await openBackups(page, game, state);
      await page.getByLabel('Create backups on a schedule', {exact: true}).uncheck();
      await page.getByLabel('Every (hours)', {exact: true}).fill('17');
      const save = page.getByRole('button', {name: 'Save schedule', exact: true});
      await save.click();
      await expect.poll(() => writes.length).toBe(1);
      await expect(save).toBeDisabled();
      state.stopped = true;
      await page.clock.fastForward(6000);
      await expect(page.locator('#connection-state')).toContainText(/stopped/i);
      await expect(save).toBeDisabled();
      // Submission events can occur without activating the disabled button.
      await page.locator('#schedule-form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
      expect(writes).toHaveLength(1);
      release();
      await expect(page.getByText('Synthetic schedule rejection', {exact: true})).toBeVisible();
      await expect(save).toBeEnabled();
      await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue('17');
      expect(writes).toHaveLength(1);
      await save.click();
      await expect.poll(() => writes.length).toBe(2);
      await expect(save).toBeEnabled();
      expect(writes[1]).toEqual(writes[0]);
    } finally {release();}
  });
}

test('Rust keeps schedule confirmation pending through refresh and unlocks after cancellation', async ({page}) => {
  const state = {stopped: false}, writes = [];
  await page.route('**/api/schedule', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({json: {ok: true}});
  });
  await openBackups(page, 'rust', state);
  await page.getByLabel('Create backups on a schedule', {exact: true}).check();
  const save = page.getByRole('button', {name: 'Save schedule', exact: true});
  await save.click();
  await expect(page.getByRole('dialog')).toContainText('save, stop and resume');
  state.stopped = true;
  await page.clock.fastForward(6000);
  await expect(page.locator('#connection-state')).toContainText(/stopped/i);
  await expect(save).toBeDisabled();
  await page.locator('#schedule-form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(save).toBeEnabled();
  expect(writes).toEqual([]);
  await save.click();
  await page.getByRole('dialog').getByRole('button', {name: 'Continue', exact: true}).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({enabled: true, confirmDowntime: true});
  await expect(save).toBeEnabled();
});
