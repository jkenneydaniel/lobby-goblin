import {followPanelLink} from './fleet-navigation.js';
import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
import {catalog} from '../../fleet/catalog.js';
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
  remote = 'd'.repeat(32);
const nav = (page) => page.getByRole('navigation', {name: /navigation/});
const rows = (page) => page.locator('#hosts-list tr');
const memory = (budget, allocated, docker) => ({
  memoryBudgetGiB: budget,
  allocatedMemoryGiB: allocated,
  availableMemoryGiB: budget - allocated,
  dockerMemoryGiB: docker,
  minimumCreationMemoryGiB: 2,
  maxMemoryBudgetGiB: docker - 2,
  revision: 1,
  minMemoryBudgetGiB: allocated,
  hostHeadroomGiB: 2,
  allocations: [],
});
const now = Date.UTC(2026, 0, 1);
async function fixture(page, username = 'Preview') {
  const state = {
    hosts: [
      {
        id: local,
        name: 'This host',
        local: true,
        connected: true,
        cpuSample: {percent: 24, sampledAt: now - 12_000},
      },
      {
        id: remote,
        name: 'Weekend host',
        local: false,
        connected: true,
        aligned: true,
        origin: 'https://workshop.example.test',
        lastSeenAt: now - 14 * 60_000,
        cpuSample: {percent: 67, sampledAt: now - 6 * 60_000},
      },
    ],
    observedAt: now,
    capacityReads: [],
    catalogReads: [],
    mutations: [],
    failRemote: false,
    failHosts: false,
    servers: {},
    local: memory(24, 17, 32),
    remote: memory(64, 30, 96),
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      if (!path.endsWith('/login')) state.mutations.push(path);
      return route.fallback();
    }
    if (path === '/api/hosts') {
      if (state.failHosts)
        return route.fulfill({
          status: 503,
          json: {error: 'Synthetic inventory failure'},
        });
      return route.fulfill({
        json: {hosts: state.hosts, observedAt: state.observedAt},
      });
    }
    if (
      path === '/api/host-settings' ||
      path === '/api/hosts/' + remote + '/host-settings'
    ) {
      const target = path === '/api/host-settings' ? 'local' : 'remote';
      state.capacityReads.push(path);
      return route.fulfill({
        status: target === 'remote' && state.failRemote ? 503 : 200,
        json:
          target === 'remote' && state.failRemote
            ? {error: 'Synthetic unavailable'}
            : state[target],
      });
    }
    if (path.endsWith('/servers'))
      return route.fulfill({
        json: {
          servers:
            state.servers[path.includes('/hosts/') ? remote : local] ?? [],
        },
      });
    if (path.endsWith('/snapshots'))
      return route.fulfill({json: {snapshots: []}});
    if (/\/jobs$/.test(path))
      return route.fulfill({json: {jobs: [], active: null}});
    if (/\/catalog$/.test(path)) {
      state.catalogReads.push(path);
      return route.fulfill({json: {games: Object.values(catalog)}});
    }
    return route.fallback();
  });
  await page.goto(origins.fleet);
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page
    .getByLabel('Password', {exact: true})
    .fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
  return state;
}
for (const username of ['Preview', 'Viewer'])
  test(
    'compare authoritative host allocations without mutations for ' + username,
    async ({page}, info) => {
      await page.clock.install();
      const state = await fixture(page, username);
      expect(state.capacityReads).toEqual([]);
      await followPanelLink(page, 'Hosts');
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).first()).toContainText('7 GiB available');
      await expect(rows(page).nth(1)).toContainText('34 GiB available');
      await rows(page)
        .nth(1)
        .getByRole('button', {name: 'Host details for Weekend host'})
        .click();
      const details = page.getByRole('dialog', {
        name: 'Host details for Weekend host',
      });
      await expect(details.locator('.capacity-summary dd')).toHaveText([
        '64 GiB',
        '30 GiB',
        '34 GiB',
        '96.0 GiB',
      ]);
      await details.getByRole('button', {name: 'Close host details'}).click();
      const reads = state.capacityReads.length;
      await page.clock.fastForward(6000);
      expect(state.capacityReads.length).toBe(reads);
      state.remote = memory(64, 50, 96);
      await page
        .getByRole('button', {name: 'Refresh metrics', exact: true})
        .click();
      await expect(rows(page).nth(1)).toContainText('14 GiB available');
      if (username === 'Preview') {
        await rows(page)
          .nth(1)
          .getByRole('button', {
            name: 'Create server on Weekend host',
            exact: true,
          })
          .click();
        await expect(
          page
            .getByRole('dialog')
            .getByRole('combobox', {name: 'Host', exact: true}),
        ).toHaveValue(remote);
        expect(state.catalogReads.at(-1)).toBe(
          '/api/hosts/' + remote + '/catalog',
        );
        await page
          .getByRole('dialog')
          .getByRole('button', {name: 'Close', exact: true})
          .click();
      } else
        await expect(
          page.getByRole('button', {name: /Create server on/}),
        ).toHaveCount(0);
      expect(state.mutations).toEqual([]);
      expect(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath('host-capacity-' + username + '.png'),
        fullPage: true,
      });
    },
  );
test('capacity failures and legacy hosts keep unavailable data explicit', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  state.failRemote = true;
  state.local.dockerMemoryGiB = null;
  delete state.hosts[0].cpuSample;
  await followPanelLink(page, 'Hosts');
  await expect(
    rows(page).first().getByLabel('CPU sample unavailable'),
  ).toBeVisible();
  await expect(rows(page).nth(1)).toContainText(
    'Capacity unavailable. Refresh metrics.',
  );
  await rows(page)
    .first()
    .getByRole('button', {name: 'Host details for This host'})
    .click();
  await expect(page.getByRole('dialog')).toContainText('Not reported');
  await page.getByRole('button', {name: 'Close host details'}).click();
  state.failRemote = false;
  await page
    .getByRole('button', {name: 'Refresh metrics', exact: true})
    .click();
  await expect(rows(page).nth(1)).toContainText('34 GiB available');
  state.hosts[1].connected = false;
  delete state.hosts[1].lastSeenAt;
  await page.clock.fastForward(6000);
  await expect(rows(page).nth(1)).toContainText('Last seen unknown');
  await expect(
    rows(page)
      .nth(1)
      .getByRole('button', {name: 'Create server on Weekend host'}),
  ).toBeDisabled();
  expect(state.mutations).toEqual([]);
});
test('creation guidance, sample freshness and last contact lead to the correct host actions', async ({
  page,
}, info) => {
  const state = await fixture(page);
  state.remote = memory(12, 11, 18);
  state.hosts.push({
    id: 'b'.repeat(32),
    name: 'Ridge Node',
    local: false,
    connected: false,
    origin: 'https://ridge.example.test',
    lastSeenAt: now - 14 * 60_000,
  });
  await followPanelLink(page, 'Hosts');
  const host = rows(page).nth(1),
    create = host.getByRole('button', {name: 'Create server on Weekend host'});
  await expect(host).toContainText('67%');
  await expect(host).toContainText('Stale');
  await expect(host).toContainText('6m ago');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(
    'A server and its controller need at least 2 GiB. Raise the budget to 13 GiB.',
  );
  await page.screenshot({
    path: info.outputPath('hosts-guidance.png'),
    fullPage: true,
  });
  await host
    .getByRole('link', {name: 'Memory settings for Weekend host'})
    .click();
  await expect(
    page.getByLabel('Memory budget (GiB)', {exact: true}),
  ).toHaveValue('12');
  await followPanelLink(page, 'Hosts');
  state.remote = memory(13, 11, 18);
  state.hosts[1].cpuSample.sampledAt = now;
  await page
    .getByRole('button', {name: 'Refresh metrics', exact: true})
    .click();
  await expect(create).toBeEnabled();
  await expect(host).toContainText('just now');
  await expect(host).not.toContainText('Stale');
  state.hosts[1].connected = false;
  await page
    .getByRole('button', {name: 'Refresh metrics', exact: true})
    .click();
  await expect(host).toContainText('Last seen 14m ago');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(
    'Restore the host connection to create servers.',
  );
  await page.getByRole('button', {name: 'Unavailable 2', exact: true}).click();
  await expect(rows(page)).toHaveCount(2);
  await page
    .getByRole('button', {name: 'Connection details for Weekend host'})
    .click();
  const details = page.getByRole('dialog', {
    name: 'Connection details for Weekend host',
  });
  await expect(details).toContainText('Last seen 14m ago');
  await expect(details).toContainText('the Lobby Goblin agent is running');
  await details.getByRole('button', {name: 'Close host details'}).click();
  await page.getByRole('button', {name: 'All 3', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Search hosts'}).fill('workshop');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Weekend host');
  expect(state.mutations).toEqual([]);
});
test('freshness ages through an inventory outage and a server count opens only its own host', async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  state.servers[local] = [
    {
      id: 'e'.repeat(32),
      name: 'Local factory',
      game: 'factorio',
      state: 'installed',
    },
  ];
  state.servers[remote] = [
    {
      id: 'f'.repeat(32),
      name: 'Remote factory',
      game: 'factorio',
      state: 'installed',
    },
  ];
  await followPanelLink(page, 'Hosts');
  const localRow = rows(page).first();
  await expect(localRow).toContainText('24%');
  await expect(localRow).not.toContainText('Stale');
  state.failHosts = true;
  await page.clock.fastForward(20_000);
  await expect(localRow).toContainText('Stale');
  state.failHosts = false;
  await rows(page)
    .nth(1)
    .getByRole('link', {name: 'View 1 server on Weekend host'})
    .click();
  await expect(page.getByText('Remote factory', {exact: true})).toBeVisible();
  await expect(page.getByText('Local factory', {exact: true})).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});

test('assigned accounts never read host capacity or see host inventory', async ({
  page,
}) => {
  const state = await fixture(page, 'Assigned');
  await page.goto(origins.fleet + '/#hosts');
  await expect(page.locator('#hosts-title')).not.toBeVisible();
  expect(state.capacityReads).toEqual([]);
  await expect(
    nav(page).getByRole('link', {name: 'Hosts', exact: true}),
  ).toHaveCount(0);
});
