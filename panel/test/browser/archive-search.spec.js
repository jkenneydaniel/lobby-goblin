import {test as base, expect} from '@playwright/test';
import {origins, scope} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const test = base.extend({
  page: async ({page}, use) => {
    const routes = trackPageRoutes(page),
      errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
const nav = (page) => page.getByRole('navigation', {name: /navigation/});
const query = (page) =>
  page.getByRole('searchbox', {name: 'Find archives', exact: true});
const show = (page) =>
  page.getByRole('combobox', {name: 'Show archives', exact: true});
const count = (page) => page.locator('[data-archive-count]');
const rows = (page) => page.locator('[data-archive-rows] tbody tr');
const clear = (page) => page.locator('[data-archive-clear]');
const exactName = 'Zulu .* [before]&+.zip';
async function fixture(page, game, role = 'admin') {
  await page.clock.install();
  const state = {
    reads: 0,
    jobs: [],
    submitted: [],
    policyWrites: [],
    scheduleWrites: [],
    empty: false,
  };
  await page.route('**/api/backups', async (route) => {
    state.reads++;
    const response = await route.fetch(),
      value = await response.json();
    await route.fulfill({
      json: {
        ...value,
        backups: state.empty
          ? []
          : [
              {
                relative: exactName,
                modified: '2026-01-04T12:00:00Z',
                size: 1024,
                validation: {ok: true},
              },
              {
                relative: 'alpha-failed.zip',
                modified: '2026-01-03T12:00:00Z',
                size: 512,
                validation: {ok: false},
              },
              {
                relative: 'ALPHA-unverified.zip',
                modified: '2026-01-02T12:00:00Z',
                size: 128,
                validation: null,
              },
              {
                relative: '<other>.zip',
                modified: '2026-01-01T12:00:00Z',
                size: 0,
              },
            ],
        health: {
          alerts: ['Synthetic archive warning'],
          verifiedCount: 1,
          latestAt: '2026-01-04T12:00:00Z',
        },
      },
    });
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      state.submitted.push({url: route.request().url(), body});
      const job = {
        id: 'archive-job-' + state.submitted.length,
        action: body.action,
        state: 'succeeded',
        message: 'Synthetic archive checked',
        started: new Date().toISOString(),
      };
      state.jobs.unshift(job);
      return route.fulfill({status: 202, json: job});
    }
    return route.fulfill({json: {jobs: state.jobs, active: null}});
  });
  await page.route('**/api/backup-retention', async (route) => {
    const body = route.request().postDataJSON();
    state.policyWrites.push(body);
    if (body.operation === 'preview')
      return route.fulfill({
        json: {
          id: 'archive-review',
          candidates: [{relative: 'synthetic-old.zip', size: 4}],
          protected: [],
          bytes: 4,
          cutoff: '2026-01-01T00:00:00Z',
        },
      });
    if (state.holdPolicy) {
      await new Promise((resolve) => {
        state.releasePolicy = resolve;
      });
      return route.fulfill({
        status: 503,
        json: {error: 'Synthetic pending policy rejection'},
      });
    }
    return route.fulfill({
      status: 409,
      json: {error: 'No policy save expected'},
    });
  });
  await page.route('**/api/schedule', async (route) => {
    state.scheduleWrites.push(route.request().postDataJSON());
    if (state.holdSchedule)
      await new Promise((resolve) => {
        state.releaseSchedule = resolve;
      });
    return route.fulfill({
      status: 503,
      json: {error: 'Synthetic pending schedule rejection'},
    });
  });
  if (game === 'factorio') {
    await page.route('**/api/session', async (route) => {
      const response = await route.fetch(),
        value = await response.json();
      await route.fulfill({
        json:
          role === 'delegated'
            ? {
                username: 'Assigned',
                role: 'member',
                csrf: 'fixture',
                permissions: ['server.view', 'backups.read'],
                allowedActions: [],
                onboarding: {completed: true},
              }
            : {...value, onboarding: {completed: true}},
      });
    });
    await page.goto(origins.factorio + scope + '/#backups');
  } else {
    await page.goto(origins.rust);
    await page
      .getByLabel('Username', {exact: true})
      .fill(role === 'viewer' ? 'viewer' : 'admin');
    await page
      .getByLabel('Password', {exact: true})
      .fill('rust-preview-password');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    if (role === 'viewer') {
      await expect(page.locator('.product-shell')).toBeVisible();
      return state;
    }
    await nav(page).getByRole('link', {name: 'Backups', exact: true}).click();
  }
  await expect(count(page)).toHaveText('4 matching of 4 loaded archives.');
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  return state;
}

for (const game of ['factorio', 'rust'])
  test(
    game +
      ' finds loaded archive names and states locally while preserving drafts, review and scoped actions',
    async ({page}, info) => {
      const state = await fixture(page, game);
      await page.getByLabel('Every (hours)', {exact: true}).fill('17');
      await page.getByLabel('Keep backups for (days)', {exact: true}).fill('7');
      await page
        .getByRole('button', {name: 'Review cleanup', exact: true})
        .click();
      await expect(page.locator('#delete-old-backups')).toBeVisible();
      await page.evaluate(() => {
        globalThis.savedArchiveNodes = {
          query: globalThis.document.querySelector('[data-archive-query]'),
          schedule: globalThis.document.querySelector('#schedule-form'),
          retention: globalThis.document.querySelector('#retention-form'),
          review: globalThis.document.querySelector('#retention-review'),
        };
      });
      const requests = [],
        downloads = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/'))
          requests.push(
            request.method() + ' ' + new URL(request.url()).pathname,
          );
      });
      page.on('download', (download) =>
        downloads.push(download.suggestedFilename()),
      );
      for (const [value, amount] of [
        [' ALPHA ', 2],
        ['.* [BEFORE]&+', 1],
        ['^Zulu', 0],
        ['manual|scheduled', 0],
      ]) {
        await query(page).fill(value);
        await expect(rows(page)).toHaveCount(amount);
      }
      await expect(page.locator('.product-backup-health')).toContainText(
        'Synthetic archive warning',
      );
      await expect(page.locator('[data-archive-rows]')).toContainText(
        'No matching loaded archives',
      );
      await query(page).fill('alpha');
      await show(page).selectOption('failed');
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page)).toContainText('alpha-failed.zip');
      await show(page).selectOption('unverified');
      await expect(rows(page)).toHaveCount(1);
      await show(page).selectOption('verified');
      await expect(count(page)).toHaveText('0 matching of 4 loaded archives.');
      await query(page).press('Escape');
      await expect(show(page)).toHaveValue('verified');
      await expect(rows(page)).toHaveCount(1);
      await clear(page).focus();
      await page.keyboard.press('Enter');
      await expect(query(page)).toBeFocused();
      await expect(show(page)).toHaveValue('all');
      await expect(query(page)).toHaveValue('');
      await expect(rows(page).locator('td:first-child')).toHaveText([
        exactName + 'Archive integrity verified',
        'alpha-failed.zipVerification failed',
        'ALPHA-unverified.zipNot verified',
        '<other>.zipNot verified',
      ]);
      // Native composition keeps the input/neighboring forms mounted and defers row filtering.
      await query(page).evaluate((input) => {
        input.dispatchEvent(
          new globalThis.CompositionEvent('compositionstart', {bubbles: true}),
        );
        input.value = 'alpha';
        input.dispatchEvent(
          new globalThis.InputEvent('input', {
            bubbles: true,
            isComposing: true,
          }),
        );
      });
      await expect(rows(page)).toHaveCount(4);
      await query(page).evaluate((input) =>
        input.dispatchEvent(
          new globalThis.CompositionEvent('compositionend', {bubbles: true}),
        ),
      );
      await expect(rows(page)).toHaveCount(2);
      expect(
        await page.evaluate(() =>
          Object.entries(globalThis.savedArchiveNodes).every(
            ([key, value]) =>
              value ===
              globalThis.document.querySelector(
                {
                  query: '[data-archive-query]',
                  schedule: '#schedule-form',
                  retention: '#retention-form',
                  review: '#retention-review',
                }[key],
              ),
          ),
        ),
      ).toBe(true);
      await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue(
        '17',
      );
      await expect(
        page.getByLabel('Keep backups for (days)', {exact: true}),
      ).toHaveValue('7');
      await expect(page.locator('#delete-old-backups')).toBeVisible();
      expect(requests).toEqual([]);
      expect(downloads).toEqual([]);
      expect(state.submitted).toEqual([]);
      await query(page).fill('.* [BEFORE]&+');
      await show(page).selectOption('verified');
      const download = rows(page).getByRole('link', {
        name: 'Download',
        exact: true,
      });
      await expect(download).toHaveAttribute(
        'href',
        (game === 'factorio' ? scope : '') +
          '/api/download?kind=backup&name=' +
          encodeURIComponent(exactName),
      );
      await expect(
        rows(page).getByRole('button', {name: 'Verify', exact: true}),
      ).toHaveAttribute('data-backup-verify', exactName);
      await query(page).focus();
      await query(page).evaluate((input) => input.setSelectionRange(2, 7));
      const before = state.reads;
      await rows(page)
        .getByRole('button', {name: 'Verify', exact: true})
        .evaluate((button) => button.click());
      await expect.poll(() => state.reads).toBeGreaterThan(before);
      await expect(query(page)).toBeFocused();
      await expect(query(page)).toHaveValue('.* [BEFORE]&+');
      expect(
        await query(page).evaluate((input) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([2, 7]);
      await expect(show(page)).toHaveValue('verified');
      expect(
        await query(page).evaluate(
          (input) => input === globalThis.savedArchiveNodes.query,
        ),
      ).toBe(true);
      expect(state.submitted[0].body).toMatchObject({
        action: 'verify-backup',
        params: {name: exactName},
      });
      expect(state.submitted[0].url).toBe(
        origins[game] + (game === 'factorio' ? scope : '') + '/api/jobs',
      );
      if (game === 'factorio') {
        await expect(
          rows(page).getByRole('button', {name: 'Restore', exact: true}),
        ).toHaveAttribute('data-backup-restore', exactName);
        await rows(page)
          .getByRole('button', {name: 'Restore', exact: true})
          .click();
        await expect(page.getByRole('dialog')).toContainText(
          'Restore this backup',
        );
        await page
          .getByRole('dialog')
          .getByRole('button', {name: 'Cancel', exact: true})
          .click();
        expect(state.submitted).toHaveLength(1);
      }
      expect(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth <=
            globalThis.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(game + '-archive-find.png'),
        fullPage: true,
      });
      state.empty = true;
      await rows(page)
        .getByRole('button', {name: 'Verify', exact: true})
        .evaluate((button) => button.click());
      await expect(count(page)).toHaveText('0 matching of 0 loaded archives.');
      await expect(page.locator('[data-archive-rows]')).not.toContainText(
        'No matching loaded archives',
      );
      await expect(page.locator('.product-backup-health')).toContainText(
        'Synthetic archive warning',
      );
    },
  );

for (const [game, role] of [['factorio', 'delegated']])
  test(
    role + ' archive find adds no tools and resets after disposal',
    async ({page}) => {
      const state = await fixture(page, game, role),
        requests = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/')) requests.push(request.method());
      });
      await query(page).fill('alpha');
      await show(page).selectOption('failed');
      await expect(count(page)).toHaveText('1 matching of 4 loaded archives.');
      await expect(
        page.locator(
          '[data-backup-create],[data-backup-verify],[data-backup-restore],a[href*="kind=backup"],#schedule-form,#retention-form',
        ),
      ).toHaveCount(0);
      expect(requests).toEqual([]);
      expect(state.submitted).toEqual([]);
      await nav(page)
        .getByRole('link', {name: 'Overview', exact: true})
        .click();
      await nav(page).getByRole('link', {name: 'Backups', exact: true}).click();
      await expect(query(page)).toHaveValue('');
      await expect(show(page)).toHaveValue('all');
      await expect(count(page)).toHaveText('4 matching of 4 loaded archives.');
    },
  );

test('Rust Viewer keeps its existing restricted navigation and receives no archive controls', async ({
  page,
}) => {
  const state = await fixture(page, 'rust', 'viewer');
  await expect(
    nav(page).getByRole('link', {name: 'Backups', exact: true}),
  ).toBeHidden();
  await page.goto(origins.rust + '/#backups');
  await expect(query(page)).toHaveCount(0);
  await expect(
    page.locator(
      '[data-backup-create],[data-backup-verify],[data-backup-restore]',
    ),
  ).toHaveCount(0);
  expect(state.reads).toBe(0);
  expect(state.submitted).toEqual([]);
});

test('local archive filtering preserves pending saves, cleanup review and confirmation state', async ({
  page,
}) => {
  const state = await fixture(page, 'rust');
  try {
    await page.getByLabel('Every (hours)', {exact: true}).fill('17');
    await page.getByLabel('Keep backups for (days)', {exact: true}).fill('7');
    await page
      .getByRole('button', {name: 'Review cleanup', exact: true})
      .click();
    state.holdSchedule = true;
    await page
      .getByLabel('Create backups on a schedule', {exact: true})
      .uncheck();
    const schedule = page.getByRole('button', {
      name: 'Save schedule',
      exact: true,
    });
    await schedule.click();
    await expect.poll(() => state.scheduleWrites.length).toBe(1);
    const requests = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) requests.push(request.method());
    });
    await query(page).fill('alpha');
    await show(page).selectOption('failed');
    await clear(page).click();
    await expect(schedule).toBeDisabled();
    await expect(page.locator('#delete-old-backups')).toBeVisible();
    await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue(
      '17',
    );
    expect(requests).toEqual([]);
    state.releaseSchedule();
    await expect(schedule).toBeEnabled();
    state.holdPolicy = true;
    await page
      .getByRole('button', {name: 'Save cleanup settings', exact: true})
      .click();
    await expect.poll(() => !!state.releasePolicy).toBe(true);
    requests.length = 0;
    await query(page).fill('alpha');
    await show(page).selectOption('unverified');
    await expect(
      page.getByLabel('Keep backups for (days)', {exact: true}),
    ).toBeDisabled();
    await expect(page.locator('#delete-old-backups')).toBeVisible();
    expect(requests).toEqual([]);
    state.releasePolicy();
    await expect(
      page.getByLabel('Keep backups for (days)', {exact: true}),
    ).toBeEnabled();
    await page.locator('#delete-old-backups').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await query(page).evaluate((input) => {
      input.value = 'Zulu';
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await expect(page.getByRole('dialog')).toContainText(
      'Delete 1 old backups',
    );
    await expect(page.locator('#delete-old-backups')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Cancel', exact: true})
      .click();
    expect(state.submitted).toEqual([]);
  } finally {
    state.releaseSchedule?.();
    state.releasePolicy?.();
  }
});
