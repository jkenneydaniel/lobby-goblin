import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const origin = origins.modLibrary;
const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page),
      errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin)
        return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => {
      globalThis.findingDownloads = [];
      const create = URL.createObjectURL.bind(URL),
        click = globalThis.HTMLAnchorElement.prototype.click;
      let current;
      URL.createObjectURL = (blob) => {
        current = blob;
        return create(blob);
      };
      globalThis.HTMLAnchorElement.prototype.click = function () {
        if (this.download === 'lobby-goblin-installed-mod-inventory.json') {
          globalThis.findingDownloads.push(current.text());
          return;
        }
        return click.call(this);
      };
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
const query = (page) =>
  page.getByRole('searchbox', {name: 'Find installed items', exact: true});
const show = (page) =>
  page.getByRole('combobox', {name: 'Show installed items', exact: true});
const count = (page) => page.locator('[data-installed-count]');
const clear = (page) => page.locator('[data-installed-clear]');
const names = (page) => page.locator('.ml-item h3');
const download = (page) =>
  page.getByRole('button', {name: 'Download installed inventory', exact: true});
const samples = [
  {
    id: 'last-ID',
    title: 'Zulu .* [世界]',
    name: 'PRIVATE-FILE',
    enabled: true,
    modified: false,
    source: 'fixture',
    version: '1.0',
    sha256: 'a'.repeat(64),
  },
  {
    id: 'target-ID',
    title: 'Alpha disabled',
    enabled: false,
    modified: true,
    source: null,
    version: null,
  },
  {
    id: 'manual-ID',
    title: '',
    name: 'Fallback name',
    enabled: true,
    modified: false,
    source: null,
    managed: true,
  },
  {
    id: 'other-ID',
    title: 'Visible name',
    name: 'PRIVATE-NAME',
    enabled: false,
    modified: false,
    source: 'fixture',
  },
];

for (const game of ['factorio', 'rust'])
  for (const delegated of [false, true])
    test(`${game} ${delegated ? 'delegated' : 'admin'} finds Installed items locally and keeps export and reviewed targets complete`, async ({
      page,
    }, info) => {
      await page.clock.install();
      const prefix = '/servers/' + (game === 'factorio' ? 'a' : 'b').repeat(32),
        ledger = [];
      let items = samples;
      page.on('request', (request) => {
        if (request.url().includes('/api/'))
          ledger.push({
            method: request.method(),
            url: request.url(),
            body: request.postDataJSON(),
          });
      });
      if (delegated)
        await page.route('**/api/session', (route) =>
          route.fulfill({
            json: {
              username: 'Assigned',
              role: 'member',
              csrf: 'fixture',
              permissions: [
                'server.view',
                'mods.manage',
                'application.rust.plugins.manage',
              ],
              allowedActions: ['mod-library-install', 'mod-library-recover'],
              onboarding: {completed: true},
            },
          }),
        );
      await page.route('**/api/mod-library?*', (route) => {
        const params = new URL(route.request().url()).searchParams,
          tab = params.get('tab');
        return route.fulfill({
          json: {
            game,
            scope: game === 'rust' ? 'oxide' : 'factorio',
            source: 'Synthetic catalogue',
            version: 'scope-version',
            tab,
            running: true,
            hotAvailable: game === 'rust',
            recoveryRequired: false,
            account: {connected: true},
            items: tab === 'installed' ? items : [],
            page: Number(params.get('page')),
            pages: tab === 'browse' ? 2 : 1,
          },
        });
      });
      await page.route('**/api/mod-library-plan', (route) =>
        route.fulfill({
          json: {
            id: 'synthetic-plan',
            mode: 'restart',
            message: 'Synthetic review only',
            releases: [],
            files: [],
          },
        }),
      );
      await page.goto(origin + prefix + '/#mods');
      await expect(page.locator('.ml-status')).toContainText(
        'Synthetic catalogue',
      );
      await page
        .getByRole('searchbox', {name: 'Find a mod', exact: true})
        .fill('catalogue query');
      await page.getByRole('button', {name: 'Search', exact: true}).click();
      await expect(page.locator('.ml-pagination')).toContainText('Page 1 of 2');
      await page.getByRole('tab', {name: 'Installed', exact: true}).click();
      await expect(count(page)).toHaveText(
        '4 matching of 4 loaded installed items.',
      );
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await expect(names(page)).toHaveText([
        'Zulu .* [世界]',
        'Alpha disabled',
        'Fallback name',
        'Visible name',
      ]);
      await expect(page.locator('.ml-item [data-mod]').first()).toBeDisabled();
      if (delegated) await expect(page.locator('.ml-account')).toBeHidden();
      const before = [...ledger];
      await query(page).fill('  .* [世界]  ');
      await expect(names(page)).toHaveText(['Zulu .* [世界]']);
      await expect(query(page)).toBeFocused();
      await query(page).evaluate((input) => input.setSelectionRange(2, 5));
      await show(page).selectOption('disabled');
      await expect(count(page)).toHaveText(
        '0 matching of 4 loaded installed items.',
      );
      await expect(page.locator('.ml-empty h3')).toHaveText(
        'No matching installed items',
      );
      await download(page).click();
      const report = JSON.parse(
        await page.evaluate(async () => await globalThis.findingDownloads[0]),
      );
      expect(report.items.map((item) => item.id)).toEqual(
        samples.map((item) => item.id),
      );
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
      await clear(page).focus();
      await page.keyboard.press('Enter');
      await expect(query(page)).toBeFocused();
      await expect(show(page)).toHaveValue('all');
      await expect(names(page)).toHaveCount(4);
      await query(page).fill('target-id');
      await show(page).selectOption('manual');
      await expect(names(page)).toHaveCount(0);
      await query(page).fill('');
      await expect(names(page)).toHaveText(['Fallback name']);
      await show(page).selectOption('modified');
      await expect(names(page)).toHaveText(['Alpha disabled']);
      await query(page).fill('PRIVATE');
      await show(page).selectOption('all');
      await expect(names(page)).toHaveCount(0);
      await query(page).fill('');
      await query(page).evaluate((input) => {
        input.dispatchEvent(
          new globalThis.CompositionEvent('compositionstart', {bubbles: true}),
        );
        input.value = 'Alpha';
        input.dispatchEvent(
          new globalThis.InputEvent('input', {
            bubbles: true,
            isComposing: true,
          }),
        );
      });
      await expect(names(page)).toHaveCount(4);
      await query(page).evaluate((input) =>
        input.dispatchEvent(
          new globalThis.CompositionEvent('compositionend', {bubbles: true}),
        ),
      );
      await expect(names(page)).toHaveText(['Alpha disabled']);
      await query(page).fill('target-id');
      await show(page).selectOption('modified');
      await page.locator('[data-mode]').selectOption('restart');
      await expect(page.locator('.ml-item [data-mod]').first()).toBeEnabled();
      expect(ledger).toEqual(before);
      await page
        .locator('.ml-item')
        .getByRole('button', {name: 'Enable', exact: true})
        .click();
      await expect(page.locator('.ml-review')).toBeVisible();
      const planned = ledger.filter((call) =>
        call.url.endsWith('/api/mod-library-plan'),
      );
      expect(planned).toHaveLength(1);
      expect(planned[0]).toMatchObject({
        method: 'POST',
        url: origin + prefix + '/api/mod-library-plan',
        body: {id: 'target-ID', operation: 'enable', mode: 'restart'},
      });
      await page
        .locator('.ml-review')
        .getByRole('button', {name: 'Cancel', exact: true})
        .click();
      await page.getByRole('tab', {name: 'Updates', exact: true}).click();
      await expect(query(page)).toBeHidden();
      await page.getByRole('tab', {name: 'Browse', exact: true}).click();
      await expect(
        page.getByRole('searchbox', {name: 'Find a mod', exact: true}),
      ).toHaveValue('catalogue query');
      await page.getByRole('tab', {name: 'Installed', exact: true}).click();
      await expect(query(page)).toHaveValue('target-id');
      await expect(show(page)).toHaveValue('modified');
      await expect(names(page)).toHaveText(['Alpha disabled']);
      await page
        .getByRole('button', {name: 'Refresh catalogue', exact: true})
        .click();
      await expect(query(page)).toBeEnabled();
      await expect(query(page)).toHaveValue('target-id');
      await expect(page.locator('[data-mode]')).toHaveValue('restart');
      items = [];
      await page
        .getByRole('button', {name: 'Refresh catalogue', exact: true})
        .click();
      await expect(count(page)).toHaveText(
        '0 matching of 0 loaded installed items.',
      );
      await expect(page.locator('.ml-empty h3')).toHaveText(
        'No mods installed yet',
      );
      await expect(download(page)).toBeEnabled();
      expect(
        ledger.some(
          (call) => call.method === 'POST' && call.url.includes('/api/jobs'),
        ),
      ).toBe(false);
      expect(
        ledger
          .filter((call) => call.url.includes('/api/mod-library?'))
          .every(
            (call) =>
              new URL(call.url).searchParams.get('query') ===
                'catalogue query' ||
              new URL(call.url).searchParams.get('query') === '',
          ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(game + '-installed-finding.png'),
        fullPage: true,
      });
    });

test('Installed projection rejects pending, failed, late and disposed owners without changing replacement controls', async ({
  page,
}) => {
  const prefix = '/servers/' + 'a'.repeat(32);
  await page.route('**/finding-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<main id="fixture"></main>',
    }),
  );
  await page.goto(origin + prefix + '/finding-harness');
  await page.evaluate(async (prefix) => {
    const {mountModLibrary} = await import(prefix + '/mod-library.js'),
      root = globalThis.document.querySelector('#fixture');
    globalThis.findingPending = [];
    globalThis.findingCalls = [];
    globalThis.makeFinding = (owner) =>
      mountModLibrary(root, {
        api: (route) => {
          globalThis.findingCalls.push(owner + ' ' + route);
          return new Promise((resolve, reject) =>
            globalThis.findingPending.push({resolve, reject}),
          );
        },
        job: () => {
          throw Error('Unexpected mutation');
        },
        manageAccount: false,
      });
    globalThis.respondFinding = (
      index,
      title,
      scope = 'oxide',
      tab = 'installed',
    ) =>
      globalThis.findingPending[index].resolve({
        game: 'rust',
        source: 'Synthetic catalogue',
        scope,
        tab,
        items: [{id: 'same', title, enabled: true, source: 'fixture'}],
        page: 1,
        pages: 1,
        running: false,
      });
    globalThis.oldFinding = globalThis.makeFinding('old');
  }, prefix);
  await page.getByRole('tab', {name: 'Installed', exact: true}).click();
  await expect(query(page)).toBeDisabled();
  await expect(names(page)).toHaveCount(0);
  await page.evaluate(() => globalThis.respondFinding(1, 'Current response'));
  await expect(query(page)).toBeEnabled();
  await query(page).fill('current');
  await page.evaluate(() => globalThis.respondFinding(0, 'Old Browse'));
  await expect(names(page)).toHaveText(['Current response']);
  await page.evaluate(() => {
    void globalThis.oldFinding.refresh();
  });
  await expect(query(page)).toBeDisabled();
  await expect(names(page)).toHaveCount(0);
  await page.evaluate(() =>
    globalThis.findingPending[2].reject(Error('Synthetic read failed')),
  );
  await expect(count(page)).toHaveText(
    'Installed list unavailable. Refresh to try again.',
  );
  await expect(download(page)).toBeDisabled();
  await expect(clear(page)).toBeDisabled();
  await page.evaluate(() => {
    void globalThis.oldFinding.refresh();
    globalThis.respondFinding(3, 'Current fresh');
  });
  await expect(names(page)).toHaveText(['Current fresh']);
  await page.evaluate(() => {
    void globalThis.oldFinding.refresh();
  });
  await page.getByRole('tab', {name: 'Updates', exact: true}).click();
  await page.evaluate(() =>
    globalThis.respondFinding(5, 'Updates response', 'oxide', 'updates'),
  );
  await page.evaluate(() => globalThis.respondFinding(4, 'Stale Installed'));
  await expect(query(page)).toBeHidden();
  await expect(count(page)).toBeHidden();
  await expect(names(page)).toHaveText(['Updates response']);
  await page.getByRole('tab', {name: 'Installed', exact: true}).click();
  await page.evaluate(() =>
    globalThis.respondFinding(6, 'Current Carbon', 'carbon'),
  );
  await expect(names(page)).toHaveText(['Current Carbon']);
  await page.evaluate(() => {
    globalThis.currentFinding = globalThis.makeFinding('new');
    globalThis.respondFinding(7, 'Current replacement');
  });
  await expect(query(page)).toBeEnabled();
  await page.evaluate(() => {
    globalThis.oldFinding.dispose();
    globalThis.oldFindingRefresh = globalThis.oldFinding.refresh();
  });
  await expect(query(page)).toBeEnabled();
  await page.evaluate(async () => {
    globalThis.respondFinding(8, 'Disposed old response');
    await globalThis.oldFindingRefresh;
  });
  await expect(names(page)).toHaveText(['Current replacement']);
  await expect(count(page)).toHaveText(
    '1 matching of 1 loaded installed items.',
  );
  const before = await page.evaluate(() => [...globalThis.findingCalls]);
  await query(page).fill('replacement');
  await show(page).selectOption('enabled');
  expect(await page.evaluate(() => globalThis.findingCalls)).toEqual(before);
  await page.evaluate(() => globalThis.currentFinding.dispose());
  await expect(query(page)).toBeDisabled();
  await expect(names(page)).toHaveCount(0);
  await expect(count(page)).toHaveText('Installed list unavailable.');
  await page.evaluate(() => {
    globalThis.history.pushState(
      {},
      '',
      '/hosts/' + 'c'.repeat(32) + '/servers/' + 'd'.repeat(32) + '/',
    );
    globalThis.remoteFinding = globalThis.makeFinding('remote');
  });
  await expect(query(page)).toBeHidden();
  await page.getByRole('tab', {name: 'Installed', exact: true}).click();
  await page.evaluate(() => globalThis.respondFinding(10, 'Remote current'));
  await expect(query(page)).toHaveValue('');
  await expect(show(page)).toHaveValue('all');
  await expect(names(page)).toHaveText(['Remote current']);
  await page.evaluate(() => {
    globalThis.respondFinding(9, 'Remote old Browse');
    globalThis.remoteFinding.dispose();
  });
});
