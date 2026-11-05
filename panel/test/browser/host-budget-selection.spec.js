import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page),
      errors = [],
      external = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (Object.values(origins).includes(url.origin)) return route.continue();
      external.push(url.origin);
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
const local = 'a'.repeat(32),
  remote = 'd'.repeat(32),
  remotePath = '/api/hosts/' + remote + '/host-settings';
const nav = (page) => page.getByRole('navigation', {name: /navigation/});
const picker = (page) => page.locator('#host-settings-host');
const budget = (page) => page.locator('#host-budget');
const save = (page) =>
  page.getByRole('button', {name: 'Save memory budget', exact: true});
const reload = (page) =>
  page.getByRole('button', {name: 'Reload current settings', exact: true});
function settings(value, revision, allocated, docker, name) {
  return {
    memoryBudgetGiB: value,
    revision,
    allocatedMemoryGiB: allocated,
    availableMemoryGiB: value - allocated,
    dockerMemoryGiB: docker,
    minMemoryBudgetGiB: allocated,
    maxMemoryBudgetGiB: docker - 2,
    hostHeadroomGiB: 2,
    allocations: [
      {
        name,
        game: 'factorio',
        gameGiB: allocated - 1,
        controllerGiB: 1,
        totalGiB: allocated,
      },
    ],
    updatedAt: null,
  };
}
async function fixture(page, username = 'Preview') {
  const state = {
    hosts: [
      {id: local, name: 'This host', local: true, connected: true},
      {
        id: remote,
        name: 'Weekend host',
        local: false,
        connected: true,
        aligned: true,
      },
    ],
    reads: [],
    writes: [],
    local: settings(24, 2, 17, 32, 'Local factory'),
    remote: settings(16, 7, 3, 24, 'Remote factory'),
    abortSave: false,
    holdSave: null,
    holdRead: null,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (method === 'GET' && path === '/api/hosts')
      return route.fulfill({json: {hosts: state.hosts}});
    if (path === '/api/host-settings' || path === remotePath) {
      const target = path === remotePath ? 'remote' : 'local';
      if (method === 'GET') {
        state.reads.push(path);
        const response = structuredClone(state[target]);
        if (state.holdRead) await state.holdRead;
        return route.fulfill({json: response});
      }
      const body = route.request().postDataJSON();
      state.writes.push({path, body});
      if (body.revision !== state[target].revision)
        return route.fulfill({
          status: 409,
          json: {error: 'Settings changed. Reload.'},
        });
      state[target] = {
        ...state[target],
        memoryBudgetGiB: body.memoryBudgetGiB,
        availableMemoryGiB:
          body.memoryBudgetGiB - state[target].allocatedMemoryGiB,
        revision: body.revision + 1,
      };
      if (state.holdSave) await state.holdSave;
      if (state.abortSave) return route.abort('failed');
      return route.fulfill({json: state[target]});
    }
    if (method === 'GET' && /\/(servers|snapshots)$/.test(path))
      return route.fulfill({json: {servers: [], snapshots: []}});
    if (method === 'GET' && /\/jobs$/.test(path))
      return route.fulfill({json: {jobs: [], active: null}});
    return route.fallback();
  });
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page
    .getByLabel('Password', {exact: true})
    .fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
  await page.goto(origins.fleet + '/#host');
  return state;
}
async function selectRemote(page) {
  await picker(page).selectOption('/hosts/' + remote + '/host-settings');
  await expect(page.locator('#host-title')).toHaveText(
    'Settings for Weekend host',
  );
  await expect(budget(page)).toBeEnabled();
}
test('direct settings entry discovers hosts and saves only the selected host with its own revision', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await expect(picker(page).locator('option')).toHaveCount(2);
  await expect(budget(page)).toHaveValue('24');
  await budget(page).fill('25');
  await selectRemote(page);
  await expect(budget(page)).toHaveValue('16');
  await expect(page.locator('#host-allocations')).toContainText(
    'Remote factory',
  );
  await budget(page).fill('20');
  await save(page).click();
  await expect(page.locator('#host-saved')).toContainText(
    'saved for Weekend host',
  );
  expect(state.writes).toEqual([
    {path: remotePath, body: {memoryBudgetGiB: 20, revision: 7}},
  ]);
  expect(state.local.memoryBudgetGiB).toBe(24);
  await picker(page).selectOption('/host-settings');
  await expect(budget(page)).toHaveValue('25');
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await nav(page)
    .getByRole('link', {name: 'Host settings', exact: true})
    .click();
  await expect(budget(page)).toHaveValue('25');
  await reload(page).click();
  await expect(budget(page)).toHaveValue('24');
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('selected-host-budget.png'),
    fullPage: true,
  });
});
test('per-host raw drafts keep their revisions until an explicit selected-host reload', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  await expect(budget(page)).toBeEnabled();
  await budget(page).fill('');
  await selectRemote(page);
  await budget(page).fill('20');
  state.remote.revision = 8;
  state.remote.memoryBudgetGiB = 18;
  state.remote.availableMemoryGiB = 15;
  await page.clock.fastForward(6000);
  await expect(page.locator('#host-conflict')).toBeVisible();
  await expect(budget(page)).toHaveValue('20');
  await expect(save(page)).toBeDisabled();
  await picker(page).selectOption('/host-settings');
  await expect(budget(page)).toHaveValue('');
  await selectRemote(page);
  await expect(budget(page)).toHaveValue('20');
  await reload(page).click();
  await expect(budget(page)).toHaveValue('18');
  await expect(save(page)).toBeEnabled();
  await picker(page).selectOption('/host-settings');
  await expect(budget(page)).toHaveValue('');
  expect(state.writes).toEqual([]);
});
test('offline and removed selections cannot fall back to a local write', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  await selectRemote(page);
  await budget(page).fill('20');
  state.hosts[1].connected = false;
  await page.clock.fastForward(6000);
  await expect(budget(page)).toBeDisabled();
  await expect(picker(page)).toHaveValue('/hosts/' + remote + '/host-settings');
  await expect(page.locator('#host-summary')).toBeEmpty();
  state.hosts.pop();
  await page.clock.fastForward(6000);
  await expect(picker(page)).toHaveValue('/hosts/' + remote + '/host-settings');
  await expect(budget(page)).toBeDisabled();
  expect(state.writes).toEqual([]);
  state.hosts.push({id: remote, name: 'Weekend host', connected: true});
  await page.clock.fastForward(6000);
  await expect(budget(page)).toBeEnabled();
  await expect(budget(page)).toHaveValue('20');
  await save(page).click();
  await expect(page.locator('#host-saved')).toBeVisible();
  expect(state.writes[0].path).toBe(remotePath);
});
test('an uncertain save is inspected before another submission and never automatically replayed', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  await selectRemote(page);
  await budget(page).fill('20');
  state.abortSave = true;
  await save(page).click();
  await expect(page.locator('#host-uncertain')).toContainText(
    'outcome is unknown',
  );
  await expect(save(page)).toBeDisabled();
  await expect(budget(page)).toHaveValue('20');
  await page.clock.fastForward(6000);
  await expect(page.locator('#host-conflict')).toBeVisible();
  expect(state.writes).toHaveLength(1);
  state.abortSave = false;
  await reload(page).click();
  await expect(page.locator('#host-uncertain')).toBeHidden();
  await expect(save(page)).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  await budget(page).fill('21');
  await save(page).click();
  await expect(page.locator('#host-saved')).toBeVisible();
  expect(state.writes[1]).toEqual({
    path: remotePath,
    body: {memoryBudgetGiB: 21, revision: 8},
  });
});
test('pending saves lock selection and navigation requires inspection before another save', async ({
  page,
}) => {
  const state = await fixture(page);
  await selectRemote(page);
  let release;
  state.holdSave = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await budget(page).fill('20');
    await save(page).click();
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(picker(page)).toBeDisabled();
    await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
    release();
    await nav(page)
      .getByRole('link', {name: 'Host settings', exact: true})
      .click();
    await expect(picker(page)).toHaveValue(
      '/hosts/' + remote + '/host-settings',
    );
    await expect(page.locator('#host-uncertain')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await reload(page).click();
    await expect(budget(page)).toHaveValue('20');
    await expect(save(page)).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  } finally {
    release();
  }
});
test('unknown capacity disables editing and viewer and member permissions stay intact', async ({
  page,
}) => {
  const state = await fixture(page, 'Viewer');
  await expect(picker(page).locator('option')).toHaveCount(2);
  await expect(budget(page)).toBeDisabled();
  await picker(page).selectOption('/hosts/' + remote + '/host-settings');
  await expect(page.locator('#host-allocations')).toContainText(
    'Remote factory',
  );
  await expect(save(page)).toBeDisabled();
  expect(state.writes).toEqual([]);
});
test('an admin cannot edit while Docker capacity is unknown', async ({
  page,
}) => {
  const state = await fixture(page);
  state.remote.dockerMemoryGiB = null;
  state.remote.maxMemoryBudgetGiB = null;
  await picker(page).selectOption('/hosts/' + remote + '/host-settings');
  await expect(page.locator('#host-budget-help')).toContainText(
    'capacity is unavailable',
  );
  await expect(budget(page)).toBeDisabled();
  await expect(save(page)).toBeDisabled();
  expect(state.writes).toEqual([]);
});
test('assigned accounts cannot read host settings from a direct hash', async ({
  page,
}) => {
  const state = await fixture(page, 'Assigned');
  await expect(
    nav(page).getByRole('link', {name: 'Host settings', exact: true}),
  ).toHaveCount(0);
  await expect(page.locator('#host-settings-host')).not.toBeVisible();
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('a late read for a previous selection never replaces the visible host', async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(budget(page)).toBeEnabled();
  let release;
  state.holdRead = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await picker(page).selectOption('/hosts/' + remote + '/host-settings');
    await expect.poll(() => state.reads.includes(remotePath)).toBe(true);
    state.holdRead = null;
    await picker(page).selectOption('/host-settings');
    await expect(budget(page)).toHaveValue('24');
    await expect(budget(page)).toBeEnabled();
    release();
    await expect(page.locator('#host-title')).toHaveText(
      'Settings for This host',
    );
    await expect(page.locator('#host-allocations')).toContainText(
      'Local factory',
    );
    expect(state.writes).toEqual([]);
  } finally {
    release();
  }
});

test('compare hosts, review and adjust the intended budget, then refresh the capacity comparison', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await nav(page).getByRole('link', {name: 'Hosts', exact: true}).click();
  const cards = page.locator('#hosts-list article');
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('.capacity-summary dd')).toHaveText([
    '24 GiB',
    '17 GiB',
    '7 GiB',
    '32.0 GiB',
  ]);
  await expect(cards.nth(1).locator('.capacity-summary dd')).toHaveText([
    '16 GiB',
    '3 GiB',
    '13 GiB',
    '24.0 GiB',
  ]);
  await nav(page)
    .getByRole('link', {name: 'Host settings', exact: true})
    .click();
  await selectRemote(page);
  await expect(page.locator('#host-allocations')).toContainText(
    'Remote factory',
  );
  await budget(page).fill('20');
  await save(page).click();
  await expect(page.locator('#host-saved')).toContainText('Weekend host');
  await reload(page).click();
  await expect(budget(page)).toHaveValue('20');
  await nav(page).getByRole('link', {name: 'Hosts', exact: true}).click();
  await page
    .getByRole('button', {name: 'Refresh capacity', exact: true})
    .click();
  await expect(cards.nth(1).locator('.capacity-summary dd')).toHaveText([
    '20 GiB',
    '3 GiB',
    '17 GiB',
    '24.0 GiB',
  ]);
  await expect(cards.first().locator('.capacity-summary dd')).toHaveText([
    '24 GiB',
    '17 GiB',
    '7 GiB',
    '32.0 GiB',
  ]);
  expect(state.writes).toEqual([
    {path: remotePath, body: {memoryBudgetGiB: 20, revision: 7}},
  ]);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('capacity-milestone-combined.png'),
    fullPage: true,
  });
});
