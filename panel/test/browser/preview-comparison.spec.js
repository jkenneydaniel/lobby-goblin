import {test as base, expect} from '@playwright/test';
import {origins, scope} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
import {
  emptySetups,
  changeSetups,
} from '../../applications/factorio/world-setups.js';
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
const keep = (page) => page.locator('#keep-draft-preview'),
  kept = (page) => page.locator('#kept-preview'),
  seed = (page) => page.getByRole('spinbutton', {name: 'Seed', exact: true});
async function fixture(page, {samePreviewId = false} = {}) {
  const state = {
    previews: [],
    jobs: [],
    binaryReads: 0,
    binaryMode: 'ok',
    sessionExpired: false,
    revoked: [],
    hold: null,
  };
  let setups = emptySetups();
  page.on('console', (message) => {
    const value = message.text();
    if (value.startsWith('c52-revoked:'))
      state.revoked.push(value.slice('c52-revoked:'.length));
  });
  await page.addInitScript(() => {
    globalThis.comparisonCreated = [];
    globalThis.comparisonRevoked = [];
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const url = create(value);
      globalThis.comparisonCreated.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      globalThis.comparisonRevoked.push(url);
      console.debug('c52-revoked:' + url);
      revoke(url);
    };
  });
  await page.route('**/api/session', async (route) => {
    if (state.sessionExpired)
      return route.fulfill({status: 401, json: {error: 'Session expired.'}});
    const response = await route.fetch();
    await route.fulfill({
      json: {...(await response.json()), onboarding: {completed: true}},
    });
  });
  await page.route('**/api/world-options', async (route) => {
    const response = await route.fetch();
    await route.fulfill({json: {...(await response.json()), setups}});
  });
  await page.route('**/api/world-setups', (route) => {
    if (route.request().method() === 'POST')
      setups = changeSetups(setups, route.request().postDataJSON());
    return route.fulfill({json: setups});
  });
  await page.route('**/api/world-preview', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      state.previews.push(body);
      if (samePreviewId)
        return route.fulfill({
          json: {id: 'same-terrain-preview', state: 'ready', seed: body.seed},
        });
    }
    return route.fallback();
  });
  await page.route('**/api/world-preview-image?*', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    state.binaryReads++;
    if (state.binaryMode === 'expired')
      return route.fulfill({
        status: 404,
        json: {error: 'Preview no longer current.'},
      });
    if (state.binaryMode === 'unauthorized') {
      state.sessionExpired = true;
      return route.fulfill({status: 401, json: {error: 'Sign in again.'}});
    }
    if (state.binaryMode === 'bad')
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('not a preview'),
      });
    if (state.binaryMode === 'corrupt')
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.alloc(24),
        ]),
      });
    if (state.hold) {
      const response = await route.fetch();
      await state.hold;
      return route.fulfill({response});
    }
    return route.fallback();
  });
  await page.route('**/api/jobs', (route) => {
    if (route.request().method() === 'POST')
      state.jobs.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto(origins.factorio + scope + '/#worlds/create');
  await expect(page.locator('#create-form')).toBeVisible();
  await seed(page).fill('1001');
  await expect(keep(page)).toBeEnabled();
  return state;
}
async function pin(page) {
  await keep(page).click();
  await expect(kept(page)).toBeVisible();
  await expect(page.locator('#kept-preview-image')).toHaveJSProperty(
    'naturalWidth',
    64,
  );
  return page.locator('#kept-preview-image').getAttribute('src');
}
test('keep a completed preview while comparing another seed without creating a world', async ({
  page,
}, info) => {
  const state = await fixture(page),
    requestsBeforeKeep = state.previews.length,
    url = await pin(page);
  expect(state.previews).toHaveLength(requestsBeforeKeep);
  await expect(page.locator('#kept-preview-caption')).toHaveText(
    'Kept preview · Seed 1001',
  );
  await seed(page).fill('2002');
  await expect(keep(page)).toBeDisabled();
  await expect(keep(page)).toBeEnabled();
  await expect(page.locator('#draft-preview-state')).toContainText('Seed 2002');
  await expect(page.locator('#kept-preview-image')).toHaveAttribute('src', url);
  await expect(page.locator('#kept-preview-settings')).toContainText(
    'different seed or settings',
  );
  expect(state.binaryReads).toBe(1);
  expect(state.jobs).toEqual([]);
  expect(state.previews.at(-1).seed).toBe(2002);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('seed-comparison.png'),
    fullPage: true,
  });
});
test('gameplay settings differ even when seed and terrain preview ID are unchanged', async ({
  page,
}) => {
  const state = await fixture(page, {samePreviewId: true});
  await pin(page);
  const configuration = structuredClone(state.previews.at(-1).configuration);
  configuration.map_settings.pollution.enabled =
    !configuration.map_settings.pollution.enabled;
  await page
    .getByRole('button', {name: 'Customize world', exact: true})
    .click();
  await page.locator('#world-settings-json').evaluate((node) => {
    node.closest('details').open = true;
  });
  await page
    .locator('#world-settings-json')
    .fill(JSON.stringify(configuration));
  await page.locator('#apply-world-json').click();
  await expect(keep(page)).toBeEnabled();
  await expect(page.locator('#kept-preview-settings')).toContainText(
    'different seed or settings',
  );
  expect(state.previews.at(-1).seed).toBe(1001);
  expect(state.jobs).toEqual([]);
});
test('stale and unapplied invalid edits cannot be kept', async ({page}) => {
  const state = await fixture(page);
  await page.locator('#auto-draft-preview').uncheck();
  await seed(page).fill('3003');
  await expect(keep(page)).toBeDisabled();
  await page.locator('#refresh-draft-preview').click();
  await expect(keep(page)).toBeEnabled();
  await page
    .getByRole('button', {name: 'Customize world', exact: true})
    .click();
  await page.locator('#world-settings-json').evaluate((node) => {
    node.closest('details').open = true;
  });
  await page.locator('#world-settings-json').fill('{');
  await expect(keep(page)).toBeDisabled();
  await page.locator('#apply-world-json').click();
  await expect(keep(page)).toBeDisabled();
  await expect(kept(page)).toBeHidden();
  expect(state.binaryReads).toBe(0);
  expect(state.jobs).toEqual([]);
});
test('expired and invalid captures preserve the prior kept reference until a valid replacement', async ({
  page,
}) => {
  const state = await fixture(page),
    first = await pin(page);
  await seed(page).fill('4004');
  await expect(keep(page)).toBeEnabled();
  for (const mode of ['expired', 'bad', 'corrupt']) {
    state.binaryMode = mode;
    await keep(page).click();
    await expect(page.locator('#preview-comparison-state')).toContainText(
      'Could not keep',
    );
    await expect(page.locator('#kept-preview-image')).toHaveAttribute(
      'src',
      first,
    );
  }
  state.binaryMode = 'ok';
  await keep(page).click();
  await expect(page.locator('#kept-preview-caption')).toContainText('4004');
  await expect
    .poll(() => page.locator('#kept-preview-image').getAttribute('src'))
    .not.toBe(first);
  expect(
    await page.evaluate(
      (url) => globalThis.comparisonRevoked.includes(url),
      first,
    ),
  ).toBe(true);
  expect(state.jobs).toEqual([]);
});
test('a late capture cannot pin an image after the candidate changes', async ({
  page,
}) => {
  const state = await fixture(page);
  let release;
  state.hold = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await keep(page).click();
    await expect.poll(() => state.binaryReads).toBe(1);
    await seed(page).fill('5005');
    state.hold = null;
    release();
    await expect(keep(page)).toBeEnabled();
    await expect(kept(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.comparisonCreated.length)).toBe(
      0,
    );
    expect(state.jobs).toEqual([]);
  } finally {
    release();
  }
});
test('keyboard expansion and remove/navigation release owned images without saving a collection', async ({
  page,
}) => {
  const state = await fixture(page),
    first = await pin(page);
  await page.locator('#kept-preview-image').focus();
  await page.locator('#kept-preview-image').press('Enter');
  await expect(page.locator('#preview-dialog')).toBeVisible();
  await page.getByRole('button', {name: /Close preview/}).click();
  await page.locator('#remove-kept-preview').click();
  await expect(kept(page)).toBeHidden();
  expect(
    await page.evaluate(
      (url) => globalThis.comparisonRevoked.includes(url),
      first,
    ),
  ).toBe(true);
  const second = await pin(page);
  await expect(page.locator('#draft-save-state')).toContainText('Draft saved');
  await page
    .getByRole('navigation', {name: /navigation/})
    .getByRole('link', {name: 'Overview', exact: true})
    .click();
  await expect(page).toHaveURL(/#overview$/);
  await expect.poll(() => state.revoked.includes(second)).toBe(true);
  await page.evaluate(() => {
    globalThis.location.hash = '#worlds/create';
  });
  await expect(kept(page)).toBeHidden();
  expect(state.jobs).toEqual([]);
});
test('an expired session clears the kept image and cannot revive it from an old capture', async ({
  page,
}) => {
  const state = await fixture(page),
    first = await pin(page);
  state.binaryMode = 'unauthorized';
  await keep(page).click();
  await expect(page.locator('#create-form')).toHaveCount(0);
  await expect.poll(() => state.revoked.includes(first)).toBe(true);
  expect(state.jobs).toEqual([]);
});

test('a later change-only edit is not confused with an already consumed blur event', async ({
  page,
}) => {
  const state = await fixture(page);
  await pin(page);
  await page.getByRole('button', {name: 'New seed', exact: true}).click();
  await expect(keep(page)).toBeEnabled();
  await seed(page).evaluate((node) => {
    node.value = '1001';
    node.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await expect(keep(page)).toBeDisabled();
  await expect(keep(page)).toBeEnabled();
  await expect(page.locator('#draft-preview-state')).toContainText('Seed 1001');
  expect(state.previews.at(-1).seed).toBe(1001);
  expect(state.jobs).toEqual([]);
});
