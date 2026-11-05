import {test as base, expect} from '@playwright/test';
import {scope, origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page),
      errors = [],
      external = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.context().route('**/*', (route) => {
      if (
        Object.values(origins).includes(new URL(route.request().url()).origin)
      )
        return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      await use(page);
    } finally {
      await routes.dispose();
    }
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  },
});
const search = (page) =>
  page.getByRole('searchbox', {name: 'Search log lines', exact: true});
const count = (page) => page.locator('[data-log-line-count]');
const clear = (page) =>
  page.getByRole('button', {name: 'Clear search', exact: true});
const nav = (page) => page.getByRole('navigation', {name: /navigation/});
async function open(page, game, state, username) {
  await page.route('**/api/logs', async (route) => {
    state.reads++;
    const text = state.text,
      wait = state.hold,
      failed = state.failed;
    if (wait) await wait;
    return route.fulfill(
      failed
        ? {status: 503, json: {error: 'Synthetic logs unavailable.'}}
        : {json: {text, logs: text}},
    );
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET')
      state.writes.push(new URL(request.url()).pathname);
  });
  if (game === 'factorio') {
    await page.route('**/api/session', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: {...(await response.json()), onboarding: {completed: true}},
      });
    });
    await page.goto(origins.factorio + scope + '/#logs');
  } else {
    await page.goto(origins[game]);
    await page
      .getByLabel('Username', {exact: true})
      .fill(username || (game === 'rust' ? 'admin' : 'Owner'));
    await page
      .getByLabel('Password', {exact: true})
      .fill(
        game === 'rust'
          ? 'rust-preview-password'
          : 'application-preview-password',
      );
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await nav(page)
      .getByRole('link', {name: 'Activity', exact: true})
      .or(nav(page).getByRole('link', {name: 'Logs', exact: true}))
      .click();
  }
  await expect(search(page)).toBeVisible();
  await expect(count(page)).toContainText('loaded');
  state.writes.length = 0;
}
const state = () => ({
  text: 'Ready\n  ERROR [worker] <img data-log-payload src=x>\nerror: Ångström timeout\nSaved world\n',
  reads: 0,
  writes: [],
  failed: false,
  hold: null,
});
for (const game of ['factorio', 'rust', 'application'])
  test(
    game + ' filters existing log lines literally without reads or commands',
    async ({page}, info) => {
      const data = state();
      await open(page, game, data);
      await expect(count(page)).toHaveText('Showing 4 of 4 loaded lines.');
      const reads = data.reads;
      await search(page).fill('ErRoR');
      await expect(count(page)).toHaveText('Showing 2 of 4 loaded lines.');
      await expect(page.locator('#logs')).toHaveJSProperty(
        'textContent',
        '  ERROR [worker] <img data-log-payload src=x>\nerror: Ångström timeout',
      );
      await expect(page.locator('[data-log-payload]')).toHaveCount(0);
      await search(page).fill('[worker]');
      await expect(count(page)).toHaveText('Showing 1 of 4 loaded lines.');
      await search(page).fill('ångström');
      await expect(page.locator('#logs')).toHaveText('error: Ångström timeout');
      await search(page).fill('.*');
      await expect(count(page)).toHaveText('Showing 0 of 4 loaded lines.');
      await expect(page.locator('#logs')).toHaveText(
        'No lines match your search.',
      );
      await clear(page).focus();
      await clear(page).press('Enter');
      await expect(search(page)).toBeFocused();
      await expect(page.locator('#logs')).toHaveJSProperty(
        'textContent',
        data.text,
      );
      expect(data.reads).toBe(reads);
      expect(data.writes).toEqual([]);
      expect(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(game + '-log-search.png'),
        fullPage: true,
      });
    },
  );
test('query and caret survive refresh/navigation; empty output and failed refresh stay distinct', async ({
  page,
}) => {
  const data = state();
  await open(page, 'factorio', data);
  await search(page).fill('error');
  await search(page).evaluate((input) => input.setSelectionRange(1, 3));
  data.text = 'ERROR new line\nReady\n';
  await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
  await expect(count(page)).toHaveText('Showing 1 of 2 loaded lines.');
  await expect(search(page)).toHaveValue('error');
  await search(page).focus();
  expect(
    await search(page).evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([1, 3]);
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Activity', exact: true}).click();
  await expect(search(page)).toHaveValue('error');
  await expect(count(page)).toHaveText('Showing 1 of 2 loaded lines.');
  data.failed = true;
  await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
  await expect(count(page)).toContainText(
    'Refresh failed; showing previously loaded output.',
  );
  await expect(page.locator('#logs')).toHaveText('ERROR new line');
  data.failed = false;
  data.text = '';
  await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
  await expect(count(page)).toHaveText('Showing 0 of 0 loaded lines.');
  await expect(page.locator('#logs')).toHaveText('No log output yet.');
  expect(data.writes).toEqual([]);
});
test('a late refresh cannot overwrite newer output or another activation', async ({
  page,
}) => {
  const data = state();
  await open(page, 'factorio', data);
  await search(page).fill('error');
  let release;
  data.hold = new Promise((resolve) => {
    release = resolve;
  });
  data.text = 'ERROR old delayed output';
  try {
    const before = data.reads;
    await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
    await expect.poll(() => data.reads).toBe(before + 1);
    data.hold = null;
    data.text = 'ERROR new output';
    await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
    await expect(page.locator('#logs')).toHaveText('ERROR new output');
    release();
    await expect(page.locator('#logs')).toHaveText('ERROR new output');
    await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
    await nav(page).getByRole('link', {name: 'Activity', exact: true}).click();
    await expect(page.locator('#logs')).toHaveText('ERROR new output');
    expect(data.writes).toEqual([]);
  } finally {
    release();
  }
});
test('session reset drops prior search and lower privilege accounts cannot gain the log screen', async ({
  page,
}) => {
  const data = state();
  await open(page, 'application', data);
  await search(page).fill('private prior search');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await page.getByLabel('Username', {exact: true}).fill('Owner');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Logs', exact: true}).click();
  await expect(search(page)).toHaveValue('');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await page.getByLabel('Username', {exact: true}).fill('Read');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(
    nav(page).getByRole('link', {name: 'Logs', exact: true}),
  ).toHaveCount(0);
  const before = data.reads;
  await page.evaluate(() => {
    globalThis.location.hash = '#logs';
  });
  await expect(search(page)).toHaveCount(0);
  expect(data.reads).toBe(before);
});

test('an older failed refresh cannot report an error after a newer successful refresh', async ({
  page,
}) => {
  const data = state();
  await open(page, 'factorio', data);
  let release;
  data.hold = new Promise((resolve) => {
    release = resolve;
  });
  data.failed = true;
  try {
    const before = data.reads;
    await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
    await expect.poll(() => data.reads).toBe(before + 1);
    data.hold = null;
    data.failed = false;
    data.text = 'New current output';
    await page.getByRole('button', {name: 'Refresh logs', exact: true}).click();
    await expect(page.locator('#logs')).toHaveText('New current output');
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/logs') && response.status() === 503,
    );
    release();
    await (await oldResponse).finished();
    await expect(count(page)).toHaveText('Showing 1 of 1 loaded line.');
    await expect(
      page.locator('.product-feedback[data-error=true]'),
    ).toHaveCount(0);
    expect(data.writes).toEqual([]);
  } finally {
    release();
  }
});
