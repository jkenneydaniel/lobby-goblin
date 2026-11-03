import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';

const test = base.extend({page: async ({page}, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => Object.values(origins).includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await use(page);
  expect(errors).toEqual([]);
}});
const nav = page => page.getByRole('navigation', {name: /navigation/});
async function login(page, game) {
  await page.goto(origins[game]);
  await page.getByLabel('Username', {exact: true}).fill(game === 'rust' ? 'admin' : 'Owner');
  await page.getByLabel('Password', {exact: true}).fill(game === 'rust' ? 'rust-preview-password' : 'application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(nav(page)).toBeVisible();
}
async function editable(page) {
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), running: false, activeJob: null}});
  });
  let saved;
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    saved = await response.json();
    await route.fulfill({json: {...saved, editable: true}});
  });
  return () => saved;
}
async function rejectSaves(page) {
  const writes = [];
  await page.route(/\/api\/jobs(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push(route.request().postDataJSON());
    return route.fulfill({status: 503, json: {error: 'Synthetic settings rejection'}});
  });
  return writes;
}

for (const field of ['Player limit', 'Autosave interval (seconds)']) {
  test('Rust preserves blank ' + field + ' through navigation, rejection and explicit reload', async ({page}) => {
    const saved = await editable(page), writes = await rejectSaves(page);
    await login(page, 'rust');
    await nav(page).getByRole('link', {name: 'Settings', exact: true}).click();
    const player = page.getByRole('spinbutton', {name: 'Player limit', exact: true});
    const autosave = page.getByRole('spinbutton', {name: 'Autosave interval (seconds)', exact: true});
    const input = page.getByRole('spinbutton', {name: field, exact: true});
    await expect(player).toBeEnabled();
    await player.fill('64'); await autosave.fill('900'); await input.fill('');
    await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
    await nav(page).getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(input).toHaveValue('');
    expect(writes).toEqual([]);
    await input.fill(field === 'Player limit' ? '64' : '900');
    await page.getByRole('button', {name: 'Save settings', exact: true}).click();
    await expect(page.getByText('Synthetic settings rejection', {exact: true})).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({action: 'save-settings', params: {values: {'server.maxplayers': 64, 'server.saveinterval': 900}, revision: expect.any(String)}});
    await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
    await nav(page).getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(player).toHaveValue('64'); await expect(autosave).toHaveValue('900');
    const reload = page.getByRole('button', {name: 'Reload saved configuration', exact: true});
    await reload.click();
    await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(player).toHaveValue('64');
    await reload.click();
    await page.getByRole('dialog').getByRole('button', {name: 'Continue', exact: true}).click();
    await expect(player).toHaveValue(String(saved().values['server.maxplayers']));
    await expect(autosave).toHaveValue(String(saved().values['server.saveinterval']));
    expect(writes).toHaveLength(1);
  });
}

test('shared numeric drafts preserve zero and required blank validation with numeric submission', async ({page}) => {
  // Exercise a required, zero-allowing UI descriptor without changing any
  // production descriptors or backend bounds. All writes are intercepted.
  await page.route('**/application-definition.json', async route => {
    const response = await route.fetch(), definition = await response.json();
    const settings = definition.presentation.screens.find(screen => screen.component === 'settings');
    const field = settings.options.fields.find(field => field.key === 'concurrency');
    field.min = 0; field.required = true;
    await route.fulfill({json: definition});
  });
  await editable(page); const writes = await rejectSaves(page);
  await login(page, 'application');
  const open = () => nav(page).getByRole('link', {name: 'Configuration', exact: true}).click();
  const leave = () => nav(page).getByRole('link', {name: 'Services', exact: true}).click();
  await open();
  const input = page.getByRole('spinbutton', {name: 'Queue concurrency', exact: true});
  await expect(input).toBeEnabled(); await input.fill('0');
  await leave(); await open(); await expect(input).toHaveValue('0');
  await input.fill(''); await leave(); await open(); await expect(input).toHaveValue('');
  await page.getByRole('button', {name: 'Save configuration', exact: true}).click();
  expect(await input.evaluate(element => element.validity.valueMissing)).toBe(true);
  expect(writes).toEqual([]);
  await input.fill('0');
  await page.getByRole('button', {name: 'Save configuration', exact: true}).click();
  await expect(page.getByText('Synthetic settings rejection', {exact: true})).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].params.values.concurrency).toBe(0);
});
