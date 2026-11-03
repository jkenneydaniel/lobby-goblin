import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import fs from 'node:fs/promises';

const test = base.extend({page: async ({page}, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => Object.values(origins).includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await use(page); expect(errors).toEqual([]);
}});

test('cleanup drafts survive unrelated backup completion and stale save until explicit reload', async ({page}) => {
  const state = {reads: 0, revision: 4, policy: {enabled: false, days: 30, includeManual: false, includeSafety: false}, saves: [], jobs: []};
  await page.route('**/api/backups', async route => {
    state.reads++;
    const response = await route.fetch(), value = await response.json();
    await route.fulfill({json: {...value, retention: {policy: state.policy, revision: state.revision, lastRun: null}}});
  });
  await page.route('**/api/backup-retention', route => {
    const body = route.request().postDataJSON();
    if (body.operation === 'preview') return route.fulfill({json: {id: 'synthetic-review', candidates: [{relative: 'synthetic-old.zip', size: 4}], protected: [], bytes: 4, cutoff: new Date().toISOString()}});
    expect(body.operation).toBe('save'); state.saves.push(body);
    if (body.revision !== state.revision) return route.fulfill({status: 409, json: {error: 'Synthetic cleanup policy changed'}});
    state.policy = body.policy; state.revision++;
    return route.fulfill({json: {policy: state.policy, revision: state.revision, lastRun: null}});
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, route => {
    if (route.request().method() !== 'POST') return route.fulfill({json: {jobs: state.jobs, active: null}});
    const body = route.request().postDataJSON(); expect(body.action).toBe('backup');
    const job = {id: 'draft-backup', action: 'backup', state: 'succeeded', message: 'Synthetic backup completed', started: new Date().toISOString()};
    state.jobs.push(job); return route.fulfill({status: 202, json: job});
  });
  await page.goto(origins.rust);
  await page.getByLabel('Username', {exact: true}).fill('admin');
  await page.getByLabel('Password', {exact: true}).fill('rust-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('navigation', {name: /navigation/}).getByRole('link', {name: 'Backups', exact: true}).click();
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('7');
  await page.getByText('Include other backup types', {exact: true}).click();
  await page.getByLabel('Include manual backups', {exact: true}).check();
  await page.getByLabel('Include backups taken before changes', {exact: true}).check();
  await page.getByLabel('Every (hours)', {exact: true}).fill('17');
  await page.getByRole('button', {name: 'Review cleanup', exact: true}).click();
  await expect(page.locator('#delete-old-backups')).toBeVisible();
  state.revision++;
  const before = state.reads;
  await page.getByRole('button', {name: 'Create backup', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Continue', exact: true}).click();
  await expect.poll(() => state.reads).toBeGreaterThan(before);
  await expect(days).toHaveValue('7');
  await expect(page.getByLabel('Include manual backups', {exact: true})).toBeChecked();
  await expect(page.getByLabel('Include backups taken before changes', {exact: true})).toBeChecked();
  await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue('17');
  await expect(page.locator('#retention-review')).toBeHidden();
  await expect(page.locator('#delete-old-backups')).toHaveCount(0);
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '4');
  expect(state.saves).toEqual([]);
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect(page.locator('#retention-status')).toHaveText('Synthetic cleanup policy changed');
  expect(state.saves).toHaveLength(1); expect(state.saves[0].revision).toBe(4);
  await expect(days).toHaveValue('7');
  const reload = page.getByRole('button', {name: 'Reload saved cleanup settings', exact: true});
  await reload.click();
  await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(days).toHaveValue('7');
  await reload.click();
  await page.getByRole('dialog').getByRole('button', {name: 'Continue', exact: true}).click();
  await expect(days).toHaveValue('30');
  await expect(page.getByLabel('Include manual backups', {exact: true})).not.toBeChecked();
  await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue('17');
  await days.fill('14');
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => state.saves.length).toBe(2);
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', String(state.revision));
  await expect(days).toHaveValue('14');
  expect(state.policy.days).toBe(14); expect(state.jobs).toHaveLength(1);
});

async function moduleFixture(page) {
  const files = ['shared/backups.js', 'backup-retention.js', 'scope.js', 'shared/view.js'];
  await page.route('**/fixture-assets/**', async route => {
    const relative = new URL(route.request().url()).pathname.slice('/fixture-assets/'.length);
    if (!files.includes(relative)) return route.abort();
    await route.fulfill({contentType: 'text/javascript', body: await fs.readFile(new URL('../../public/' + relative, import.meta.url), 'utf8')});
  });
  await page.route('**/retention-module', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><body></body>'}));
  await page.goto(origins.rust + '/retention-module');
  await page.evaluate(async () => {
    const {mountBackups} = await import('/fixture-assets/shared/backups.js');
    const root = globalThis.document.createElement('div'); globalThis.document.body.append(root);
    const h = {root, reads: 0, plans: 0, confirms: [], jobs: [], saves: [], toasts: [], busy: false, holdPreview: false, failRead: false};
    const record = {backups: [], schedule: {enabled: false, hours: 24, keep: 12}, retention: {policy: {enabled: true, days: 30, includeManual: false, includeSafety: false}, revision: 4, lastRun: null}};
    h.record = record;
    h.controls = mountBackups(root, {
      request: async (url, options) => {
        if (url === '/backups') {
          h.reads++;
          if (h.failRead) {h.failRead = false; throw Error('Synthetic reload failure');}
          if (h.holdRead) {
            const snapshot = structuredClone(record);
            return new Promise(resolve => {h.releaseRead = () => resolve(snapshot); (h.readReleases ??= []).push(h.releaseRead);});
          }
          return structuredClone(record);
        }
        if (url !== '/backup-retention') throw Error('Unexpected synthetic request');
        if (options.body.operation === 'preview') {
          const plan = {id: 'plan-' + ++h.plans, candidates: [{relative: 'synthetic.zip', size: 4}], protected: [], bytes: 4, cutoff: new Date().toISOString()};
          return h.holdPreview ? new Promise(resolve => {h.releasePreview = () => resolve(plan);}) : plan;
        }
        if (options.body.operation !== 'save') throw Error('Unexpected synthetic policy operation');
        h.saves.push(options.body);
        const commit = () => {
          if (h.failSave) throw Error('Synthetic save failure');
          if (options.body.revision !== record.retention.revision) throw Error('Synthetic revision conflict');
          record.retention.policy = structuredClone(options.body.policy); record.retention.revision++;
          return structuredClone(record.retention);
        };
        return h.holdSave ? new Promise((resolve, reject) => {h.releaseSave = () => {try {resolve(commit());} catch (error) {reject(error);}};}) : commit();
      },
      startJob: async (action, params) => {h.jobs.push({action, params}); return {};},
      isAdmin: () => true, busy: () => h.busy,
      confirm: (title) => new Promise(resolve => {h.confirms.push({title, resolve});}),
      notify: (...args) => h.toasts.push(args),
    });
    globalThis.retentionFixture = h;
    await h.controls.load();
  });
}
const refreshModule = page => page.evaluate(() => globalThis.retentionFixture.controls.load({preserveSchedule: true}));
const settleConfirmation = (page, index, accepted) => page.evaluate(async ({index, accepted}) => {
  globalThis.retentionFixture.confirms[index].resolve(accepted);
  await new Promise(resolve => setTimeout(resolve, 0));
}, {index, accepted});

test('a late cleanup preview cannot restore a review or open confirmation after refresh', async ({page}) => {
  await moduleFixture(page);
  await page.getByLabel('Keep backups for (days)', {exact: true}).fill('7');
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await refreshModule(page);
  await expect(page.getByText('Daily cleanup on', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Clean up automatically each day', {exact: true})).not.toBeChecked();
  await page.getByLabel('Clean up automatically each day', {exact: true}).check();
  await page.evaluate(() => {globalThis.retentionFixture.holdPreview = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.plans)).toBe(1);
  await page.evaluate(() => {
    const h = globalThis.retentionFixture; h.holdRead = true;
    h.pendingRead = h.controls.load({preserveSchedule: true});
  });
  await page.evaluate(async () => {globalThis.retentionFixture.releasePreview(); await new Promise(resolve => setTimeout(resolve, 0));});
  expect(await page.evaluate(() => ({confirms: globalThis.retentionFixture.confirms.length, saves: globalThis.retentionFixture.saves.length, jobs: globalThis.retentionFixture.jobs.length}))).toEqual({confirms: 0, saves: 0, jobs: 0});
  await page.evaluate(async () => {const h = globalThis.retentionFixture; h.holdRead = false; h.releaseRead(); await h.pendingRead;});
  await expect(page.locator('#retention-review')).toBeHidden();
  await expect(page.getByLabel('Keep backups for (days)', {exact: true})).toHaveValue('7');
});

test('refresh invalidates a pending delete confirmation and requires a fresh review', async ({page}) => {
  await moduleFixture(page);
  await page.getByLabel('Keep backups for (days)', {exact: true}).fill('7');
  await page.getByRole('button', {name: 'Review cleanup', exact: true}).click();
  await page.locator('#delete-old-backups').click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.confirms.length)).toBe(1);
  await page.evaluate(() => {
    const h = globalThis.retentionFixture; h.holdRead = true;
    h.pendingRead = h.controls.load({preserveSchedule: true});
  });
  await expect.poll(() => page.evaluate(() => typeof globalThis.retentionFixture.releaseRead)).toBe('function');
  await settleConfirmation(page, 0, true);
  expect(await page.evaluate(() => globalThis.retentionFixture.jobs)).toEqual([]);
  await page.evaluate(async () => {const h = globalThis.retentionFixture; h.holdRead = false; h.releaseRead(); await h.pendingRead;});
  await expect(page.locator('#delete-old-backups')).toHaveCount(0);
  await page.getByRole('button', {name: 'Review cleanup', exact: true}).click();
  await page.locator('#delete-old-backups').click();
  await settleConfirmation(page, 1, true);
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.jobs.length)).toBe(1);
  expect(await page.evaluate(() => globalThis.retentionFixture.jobs[0])).toEqual({action: 'cleanup-backups', params: {planId: 'plan-2', confirm: true}});
});

test('changed inputs and newly busy state invalidate pending cleanup confirmation', async ({page}) => {
  await moduleFixture(page);
  for (const change of ['input', 'busy']) {
    await page.getByRole('button', {name: 'Review cleanup', exact: true}).click();
    await page.locator('#delete-old-backups').click();
    const index = change === 'input' ? 0 : 1;
    await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.confirms.length)).toBe(index + 1);
    if (change === 'input') await page.getByLabel('Keep backups for (days)', {exact: true}).fill('9');
    else await page.evaluate(() => {globalThis.retentionFixture.busy = true;});
    await settleConfirmation(page, index, true);
    expect(await page.evaluate(() => globalThis.retentionFixture.jobs)).toEqual([]);
    await page.evaluate(() => {globalThis.retentionFixture.busy = false;});
  }
});

test('cancelled or failed explicit reload preserves an invalid cleanup draft', async ({page}) => {
  await moduleFixture(page);
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('');
  const reload = page.getByRole('button', {name: 'Reload saved cleanup settings', exact: true});
  await reload.click(); await settleConfirmation(page, 0, false);
  await expect(days).toHaveValue('');
  await reload.click();
  await page.evaluate(() => {globalThis.retentionFixture.failRead = true;});
  await settleConfirmation(page, 1, true);
  await expect(page.locator('#retention-status')).toHaveText('Synthetic reload failure');
  await refreshModule(page); await expect(days).toHaveValue('');
  await reload.click(); await settleConfirmation(page, 2, true);
  await expect(days).toHaveValue('30');
  expect(await page.evaluate(() => globalThis.retentionFixture.saves)).toEqual([]);
});

test('a successful pending cleanup save reconciles replaced controls without conflicting with itself', async ({page}) => {
  await moduleFixture(page);
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('7');
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  await refreshModule(page);
  await page.evaluate(() => globalThis.retentionFixture.releaseSave());
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '5');
  await expect(days).toHaveValue('7');
  await expect(page.locator('#retention-draft-note')).toHaveCount(0);
  await expect(page.getByText('Manual cleanup', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => globalThis.retentionFixture.toasts)).toEqual([['Backup cleanup settings saved.']]);
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = false;});
  await days.fill('8');
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '6');
  expect(await page.evaluate(() => globalThis.retentionFixture.saves.map(save => save.revision))).toEqual([4, 5]);
});

test('replacement controls remain disabled during a save and show its rejection without replay', async ({page}) => {
  await moduleFixture(page);
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('7');
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await page.evaluate(() => {const h = globalThis.retentionFixture; h.holdSave = true; h.failSave = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  await refreshModule(page);
  await expect(days).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Save cleanup settings', exact: true})).toBeDisabled();
  await page.evaluate(() => globalThis.retentionFixture.releaseSave());
  await expect(page.locator('#retention-status')).toHaveText('Synthetic save failure');
  await expect(days).toBeEnabled(); await expect(days).toHaveValue('7');
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '4');
  expect(await page.evaluate(() => ({saves: globalThis.retentionFixture.saves.length, revision: globalThis.retentionFixture.record.retention.revision, toasts: globalThis.retentionFixture.toasts}))).toEqual({saves: 1, revision: 4, toasts: [['Synthetic save failure', true]]});
});

test('leaving the Backups workflow suppresses a pending saves late feedback and reload', async ({page}) => {
  await moduleFixture(page);
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  const before = await page.evaluate(() => {const h = globalThis.retentionFixture; h.controls.dispose(); return h.root.innerHTML;});
  await page.evaluate(async () => {globalThis.retentionFixture.releaseSave(); await new Promise(resolve => setTimeout(resolve, 0));});
  expect(await page.evaluate(() => ({reads: globalThis.retentionFixture.reads, toasts: globalThis.retentionFixture.toasts, html: globalThis.retentionFixture.root.innerHTML}))).toEqual({reads: 1, toasts: [], html: before});
});

test('a successful policy response reconciles revision before a superseding refresh finishes', async ({page}) => {
  await moduleFixture(page);
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('7');
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  await page.evaluate(() => {const h = globalThis.retentionFixture; h.holdRead = true; h.releaseSave();});
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.readReleases?.length)).toBe(1);
  await page.evaluate(() => {const h = globalThis.retentionFixture; h.pendingRead = h.controls.load({preserveSchedule: true});});
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.readReleases.length)).toBe(2);
  await page.evaluate(() => globalThis.retentionFixture.readReleases[0]());
  await expect(days).toBeEnabled();
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '5');
  await days.fill('8');
  await page.evaluate(async () => {const h = globalThis.retentionFixture; h.holdRead = false; h.readReleases[1](); await h.pendingRead;});
  await expect(days).toHaveValue('8');
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '5');
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = false;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '6');
});

test('a committed cleanup policy stays reconciled when the follow-up archive refresh fails', async ({page}) => {
  await moduleFixture(page);
  const days = page.getByLabel('Keep backups for (days)', {exact: true});
  await days.fill('7');
  await page.getByLabel('Clean up automatically each day', {exact: true}).uncheck();
  await page.evaluate(() => {const h = globalThis.retentionFixture; h.holdSave = true;});
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect.poll(() => page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  await page.evaluate(() => {const h = globalThis.retentionFixture; h.failRead = true; h.releaseSave();});
  await expect(days).toBeEnabled();
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '5');
  await expect(page.getByText('Manual cleanup', {exact: true})).toBeVisible();
  await expect(page.locator('#retention-draft-note')).toHaveCount(0);
  await expect(page.locator('#retention-status')).toContainText('saved');
  await expect(page.locator('#retention-status')).toContainText('Synthetic reload failure');
  expect(await page.evaluate(() => globalThis.retentionFixture.saves.length)).toBe(1);
  await page.evaluate(() => {globalThis.retentionFixture.holdSave = false;});
  await days.fill('8');
  await page.getByRole('button', {name: 'Save cleanup settings', exact: true}).click();
  await expect(page.locator('#retention-form')).toHaveAttribute('data-revision', '6');
});
