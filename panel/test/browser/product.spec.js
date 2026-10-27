import {test as base, expect} from '@playwright/test';
import {scope, origins} from './playwright.config.js';
import {
  emptySetups,
  changeSetups,
} from '../../applications/factorio/world-setups.js';

// Every browser starts with a new cookie/storage context. Block external traffic
// so a fixture regression cannot turn a test into a real host operation.
const test = base.extend({
  page: async ({page}, use) => {
    const errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (Object.values(origins).includes(url.origin)) return route.continue();
      external.push(url.origin);
      return route.abort();
    });
    await use(page);
    expect(errors, 'Uncaught browser errors').toEqual([]);
    expect(external, 'Unexpected external requests').toEqual([]);
  },
});
const nav = (page) => page.getByRole('navigation', {name: /navigation/});

async function softwareFixture(page, {phase = 'ready', framework = 'none', expired = false, running = false} = {}) {
  const selection = build => ({format: 1, provider: 'steamcmd', application: 'rust', softwareVersion: build, channel: 'public', platform: 'linux/amd64', artifacts: [{id: '258551', version: '12345678901234567890'}]});
  const state = {
    managed: true, source: 'Valve SteamCMD · public branch · exact recorded build', framework,
    installation: {version: phase === 'initial' ? null : '123', phase: phase === 'initial' ? 'uninstalled' : 'complete', recoveryRequired: false},
    change: {pending: phase === 'recovery', kind: 'software', phase: 'activating-software', previousFramework: framework},
    updates: {available: false, pending: false}, activeJob: null,
  };
  const jobs = [], submissions = [];
  await page.route('**/api/status', async route => {const response = await route.fetch(); await route.fulfill({json: {...await response.json(), running, activeJob: null}});});
  await page.route('**/api/software-setup', route => route.fulfill({json: state}));
  await page.route('**/api/software-change', route => route.fulfill({json: {phase: state.change.phase, review: 'a'.repeat(64)}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/, async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); submissions.push(body);
      if (body.action.startsWith('software-check')) {
        state.updates = {available: true, phase: 'reviewed', id: '12345678-1234-1234-1234-123456789012', current: selection('123'), target: selection('124'), framework, frameworkVersion: 'reviewed-framework', updateAvailable: true, expires: new Date(Date.now() + (expired ? -60000 : 900000)).toISOString()};
      } else if (body.action.startsWith('software-recover')) state.change.pending = false;
      else if (body.action.startsWith('software-update')) {state.installation.version = '124'; state.updates.phase = 'complete'; state.updates.updateAvailable = false;}
      const job = {id: 'software-fixture-' + jobs.length, action: body.action, state: 'succeeded', message: 'Fixture completed', started: new Date().toISOString(), actor: 'admin'};
      jobs.unshift(job); return route.fulfill({status: 202, json: job});
    }
    return route.fulfill({json: {jobs, active: null, recoveryRequired: !!state.blocked}});
  });
  return {state, submissions};
}

test('Rust software reviews an exact modded build, confirms downtime and applies only its plan', async ({page}, info) => {
  const fixture = await softwareFixture(page, {framework: 'carbon'});
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await expect(page.getByRole('heading', {name: 'Rust software', exact: true})).toBeVisible();
  expect(fixture.submissions.map(({action, params}) => ({action, params}))).toEqual([]);
  await page.getByRole('button', {name: 'Check Steam updates', exact: true}).click();
  await expect(page.locator('[data-selection]')).toContainText('124');
  await page.getByRole('button', {name: 'Apply reviewed update', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('earlier world');
  await expect(page.getByRole('dialog')).toContainText('124');
  await page.getByRole('dialog').getByRole('button', {name: 'Apply update', exact: true}).click();
  await expect(page.locator('[data-version]')).toHaveText('124');
  expect(fixture.submissions.map(({action, params}) => ({action, params}))).toEqual([{action: 'software-check-modded', params: {}}, {action: 'software-update-modded', params: {planId: '12345678-1234-1234-1234-123456789012', confirm: true}}]);
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({path: info.outputPath('rust-software-updated.png'), fullPage: true});
});

test('Rust software expires reviews and never replays work after session expiry', async ({page}) => {
  const fixture = await softwareFixture(page, {expired: true});
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await page.getByRole('button', {name: 'Check Steam updates', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Apply reviewed update', exact: true})).toBeDisabled();
  await expect(page.locator('[data-expiry]')).toContainText('expired');
  await page.context().clearCookies();
  // Metadata fixtures must allow the real auth endpoint to expire the session.
  await page.unroute('**/api/software-setup');
  await page.getByRole('button', {name: 'Refresh status', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Sign in', exact: true})).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
});

test('Rust software recovery requires an inspection and confirms paired world restoration', async ({page}, info) => {
  const fixture = await softwareFixture(page, {phase: 'recovery', framework: 'oxide'});
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  const recover = page.getByRole('button', {name: 'Recover inspected state', exact: true});
  await expect(recover).toBeDisabled();
  await page.getByRole('button', {name: 'Inspect recovery', exact: true}).click();
  await expect(recover).toBeEnabled();
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({path: info.outputPath('rust-software-recovery.png'), fullPage: true});
  await recover.click();
  await expect(page.getByRole('dialog')).toContainText('matching earlier world');
  await page.getByRole('dialog').getByRole('button', {name: 'Recover state', exact: true}).click();
  await expect(page.locator('[data-recovery]')).toBeHidden();
  expect(fixture.submissions.map(({action, params}) => ({action, params}))).toEqual([{action: 'software-recover-modded', params: {review: 'a'.repeat(64), confirm: true}}]);
});

test('Rust legacy software is explained and remains inaccessible to viewers', async ({page}) => {
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await expect(page.locator('[data-source]')).toContainText('not converted automatically');
  await expect(page.getByRole('button', {name: 'Check Steam updates', exact: true})).toBeHidden();
  await page.context().clearCookies(); await login(page, 'rust', 'viewer');
  await expect(nav(page).getByRole('link', {name: 'Software', exact: true})).toBeHidden();
  expect((await page.request.get(origins.rust + '/api/software-setup')).status()).toBe(403);
});

test('Rust initial setup is explicit and image-only access cannot operate or recover modded servers', async ({page}) => {
  const fixture = await softwareFixture(page, {phase: 'initial'});
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await expect(page.locator('[data-version]')).toHaveText('Not installed yet');
  expect(fixture.submissions).toHaveLength(0);
  await expect(page.getByRole('button', {name: 'Check Steam updates', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Prepare and start Rust', exact: true}).click();
  await expect.poll(() => fixture.submissions.length).toBe(1);
  expect(fixture.submissions[0]).toMatchObject({action: 'start', params: {}});
  fixture.state.installation.version = '123'; fixture.state.framework = 'carbon'; fixture.state.change.pending = true;
  await page.context().clearCookies(); await login(page, 'rust', 'software'); await page.goto(origins.rust + '/#software');
  await expect(page.getByRole('heading', {name: 'Rust software', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Start Rust', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Check Steam updates', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Inspect recovery', exact: true})).toBeDisabled();
});

test('Rust changed recovery observations require another inspection and are never automatically retried', async ({page}) => {
  const fixture = await softwareFixture(page, {phase: 'recovery'});
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await page.getByRole('button', {name: 'Inspect recovery', exact: true}).click();
  await page.route('**/api/jobs', route => route.request().method() === 'POST' ? route.fulfill({status: 409, json: {error: 'Rust recovery observations changed. Inspect again.'}}) : route.fallback());
  await page.getByRole('button', {name: 'Recover inspected state', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Recover state', exact: true}).click();
  await expect(page.locator('[data-error]')).toContainText('Inspect again');
  await expect(page.getByRole('button', {name: 'Recover inspected state', exact: true})).toBeDisabled();
  expect(fixture.submissions).toHaveLength(0);
});

test('running Rust recovery follows the backend metadata-only decision', async ({page}) => {
  const fixture = await softwareFixture(page, {phase: 'recovery', running: true});
  fixture.state.change.phase = 'checking-software'; fixture.state.change.metadataOnlyRecovery = true;
  await login(page, 'rust'); await page.goto(origins.rust + '/#software');
  await page.getByRole('button', {name: 'Inspect recovery', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Recover inspected state', exact: true})).toBeEnabled();
  await expect(page.locator('[data-recovery-note]')).toContainText('does not stop Rust');
  await expect(page.getByRole('button', {name: 'Check Steam updates', exact: true})).toBeDisabled();
  fixture.state.change.metadataOnlyRecovery = false;
  await page.getByRole('button', {name: 'Refresh status', exact: true}).click();
  await page.getByRole('button', {name: 'Inspect recovery', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Recover inspected state', exact: true})).toBeDisabled();
  await expect(page.locator('[data-recovery-note]')).not.toContainText('does not stop Rust');
  fixture.state.change.phase = 'reviewed';
  await page.getByRole('button', {name: 'Refresh status', exact: true}).click();
  await page.getByRole('button', {name: 'Inspect recovery', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Recover inspected state', exact: true})).toBeDisabled();
  expect(fixture.submissions).toHaveLength(0);
});

test('software metadata access alone loads without fetching forbidden server status or offering unmonitored jobs', async ({page}) => {
  const fixture = await softwareFixture(page);
  let statusReads = 0;
  page.on('request', request => {if (request.url().endsWith('/api/status')) statusReads++;});
  await login(page, 'rust', 'software-only'); await page.goto(origins.rust + '/#software');
  await expect(page.locator('[data-version]')).toHaveText('123');
  await expect(page.locator('[data-access-note]')).toContainText('Server status access is required');
  await expect(page.getByRole('button', {name: 'Check Steam updates', exact: true})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Start Rust', exact: true})).toBeDisabled();
  expect(statusReads).toBe(0); expect(fixture.submissions).toHaveLength(0);
  fixture.state.blocked = true; fixture.state.change.pending = true;
  await page.context().clearCookies(); await login(page, 'rust', 'software'); await page.goto(origins.rust + '/#software');
  await expect(page.locator('[data-operation-access]')).toContainText('An administrator must review');
  await expect(page.locator('[data-operations]')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Recover inspected state', exact: true})).toBeDisabled();
});

test('runtime snapshot creation preserves its disabled installation selector in preflight and submission', async ({page}) => {
  await page.route('**/api/snapshots', async route => {const response = await route.fetch(), data = await response.json(); data.snapshots = data.snapshots.map(item => ({...item, image: 'ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1'})); await route.fulfill({json: data});});
  const checked = [], created = [];
  await page.route('**/api/creation-preflight', async route => {checked.push(route.request().postDataJSON()); await route.fulfill({json: {ready: true, checks: []}});});
  await page.route('**/api/servers', async route => {if (route.request().method() !== 'POST') return route.continue(); created.push(route.request().postDataJSON()); return route.fulfill({status: 202, json: {id: 'copied-runtime', state: 'queued'}});});
  await login(page, 'fleet', 'Preview');
  await expect(page.getByRole('heading', {name: 'Friday factory', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  const form = page.locator('#create'); await form.locator('[name=name]').fill('Runtime copy');
  await form.locator('[name=snapshotId]').selectOption('f'.repeat(32));
  await expect(form.locator('[name=softwareMode]')).toBeDisabled();
  await expect(form.locator('[name=softwareMode]')).toHaveValue('runtime');
  await page.locator('#create-submit').click(); await expect.poll(() => created.length).toBe(1);
  expect(checked[0]).toMatchObject({softwareMode: 'runtime', snapshotId: 'f'.repeat(32)});
  expect(created[0]).toMatchObject({softwareMode: 'runtime', snapshotId: 'f'.repeat(32)});
});

test('creation checks block failures and discard a late result after input changes', async ({page}) => {
  await login(page, 'fleet', 'Preview');
  await expect(page.getByRole('heading', {name: 'Friday factory', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  const form = page.locator('#create'); await form.locator('[name=name]').fill('Disposable setup');
  let release, requests = 0, creates = 0;
  await page.route('**/api/creation-preflight', async route => {requests++; await new Promise(resolve => {release = resolve;}); await route.fulfill({json: {ready: false, checks: [{label: 'Memory', status: 'fail', message: 'Insufficient host capacity.'}]}});});
  await page.route('**/api/servers', async route => {if (route.request().method() === 'POST') creates++; await route.continue();});
  await page.locator('#create-submit').click(); await expect.poll(() => requests).toBe(1);
  await form.locator('[name=name]').fill('Changed setup'); release();
  await expect(page.locator('#create-submit')).toBeEnabled();
  expect(creates).toBe(0); await expect(page.locator('#creation-checks')).toBeEmpty();
  await page.unroute('**/api/creation-preflight');
  await page.route('**/api/creation-preflight', route => route.fulfill({json: {ready: false, checks: [{label: 'Memory', status: 'fail', message: 'Insufficient host capacity.'}]}}));
  await page.locator('#create-submit').click();
  await expect(page.locator('#creation-checks')).toContainText('Insufficient host capacity');
  expect(creates).toBe(0);
});
for(const recovery of [false,true])test('Factorio runtime software '+(recovery?'recovery restores the paired backup':'selection reviews an explicit version') ,async({page},testInfo)=>{
  let recoveryState=recovery;
  await page.route('**/api/status',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),software:{mode:'runtime',provider:'factorio-headless'},softwareRecovery:recoveryState?{required:true,backup:'before-software-update.zip'}:null,image:'ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1'}});});
  await page.route('**/api/application-releases',route=>route.fulfill({json:{game:'factorio',software:{mode:'runtime'},stable:'2.0.78',choices:[{kind:'software',version:'2.0.78',channel:'stable',notesUrl:'https://wiki.factorio.com/Version_history/2.0.0#2.0.78'}]}}));
  const submissions=[];await page.route('**/api/jobs',async route=>{if(route.request().method()!=='POST')return route.continue();submissions.push(route.request().postDataJSON());recoveryState=!recovery;await route.fulfill({status:202,json:{id:'synthetic-runtime-job',state:'queued'}});});
  await factorio(page,'#settings/updates');
  await expect(page.getByRole('heading',{name:'Factorio software',exact:true})).toBeVisible();
  if(recovery){
    await expect(page.getByRole('combobox',{name:'Factorio version',exact:true})).toBeHidden();
    await page.getByRole('button',{name:'Recover software update',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('pre-update world, settings, mods and previous Factorio release');
    await page.getByRole('dialog').getByRole('button',{name:'Restore previous release',exact:true}).click();
  }else{
    await expect(page.getByRole('combobox',{name:'Factorio version',exact:true})).toHaveValue('2.0.78');
    await page.getByRole('button',{name:'Review software update',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('2.0.78');
    await expect(page.getByRole('dialog')).toContainText('backup');
    await page.getByRole('dialog').getByRole('button',{name:'Install software',exact:true}).click();
  }
  await expect.poll(()=>submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({action:recovery?'software-recover':'software-update',params:{confirm:true,...(recovery?{}:{version:'2.0.78'})}});
  if(recovery)await expect(page.getByRole('combobox',{name:'Factorio version',exact:true})).toBeVisible({timeout:10000});
  else await expect(page.getByRole('button',{name:'Recover software update',exact:true})).toBeVisible({timeout:10000});
  await page.screenshot({path:testInfo.outputPath('factorio-runtime.png'),fullPage:true});
});
test('Factorio preview dialogs belong to their capability activation and close after rendering', async ({
  page,
}) => {
  await page.route('**/api/worlds', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.worlds[0].hasPreview = true;
    await route.fulfill({json: value});
  });
  await page.route('**/api/preview?*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await factorio(page, '#worlds');
  await page
    .getByRole('button', {name: 'Preview', exact: true})
    .first()
    .click();
  await expect(page.locator('#preview-dialog')).toBeVisible();
  await page.getByRole('button', {name: /Close preview/}).click();
  await expect(page.locator('#preview-dialog')).toBeHidden();
  await nav(page).getByRole('link', {name: 'Map', exact: true}).click();
  await expect(page.locator('#preview-dialog')).toHaveCount(0);
  await nav(page).getByRole('link', {name: 'Worlds', exact: true}).click();
  await expect(page.locator('#preview-dialog')).toHaveCount(1);
});
test('Factorio retries an unavailable capability template without replacing its session or duplicating controls', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/factorio/worlds.html', (route) =>
    fail ? route.fulfill({status: 503, body: 'Unavailable'}) : route.continue(),
  );
  await factorio(page, '#worlds');
  await expect(
    page.getByRole('heading', {
      name: 'This screen could not be loaded.',
      exact: true,
    }),
  ).toBeVisible();
  await expect(nav(page)).toBeVisible();
  fail = false;
  await page.getByRole('button', {name: 'Try again', exact: true}).click();
  await expect(page.locator('#world-search')).toBeVisible();
  await expect(page.locator('#preview-dialog')).toHaveCount(1);
  await expect(page).toHaveURL(origins.factorio + scope + '/#worlds');
});
test('Factorio renders markup-shaped world names as text in its capability template', async ({
  page,
}) => {
  const name = '<img data-untrusted-name src=x onerror=alert(1)>.zip';
  await page.route('**/api/worlds', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.worlds[0].name = name;
    await route.fulfill({json: value});
  });
  await factorio(page, '#worlds');
  await expect(page.locator('#world-results')).toContainText(
    '<img data untrusted name src=x onerror=alert(1)>',
  );
  await expect(page.locator('img[data-untrusted-name]')).toHaveCount(0);
});
test('Factorio discards a saved draft and mounts a working fresh editor from its template', async ({
  page,
}, testInfo) => {
  // This journey mutates its own disposable account store, including real
  // revision validation, so leaving at step 2 cannot affect another browser.
  let setups = emptySetups();
  await page.route('**/api/world-setups', async (route) => {
    try {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.operation === 'draft')
          await new Promise((resolve) => setTimeout(resolve, 40));
        setups = changeSetups(setups, body);
      }
      await route.fulfill({json: setups});
    } catch (error) {
      await route.fulfill({
        status: error.status || 400,
        json: {error: error.message},
      });
    }
  });
  await factorio(page, '#worlds/create');
  await page
    .getByRole('textbox', {name: /^World name/})
    .fill('Discard this draft');
  await expect(page.locator('#draft-save-state')).toContainText(
    'Draft saved to your account',
  );
  await page.getByText('Saved presets & draft options', {exact: true}).click();
  await page.getByRole('button', {name: 'Start fresh', exact: true}).click();
  await page
    .getByRole('dialog', {name: 'Start a fresh draft?'})
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.getByRole('textbox', {name: /^World name/})).toHaveValue(
    '',
  );
  await page
    .getByRole('textbox', {name: /^World name/})
    .fill('Fresh editor draft');
  await page
    .getByRole('button', {name: 'Customize world', exact: true})
    .click();
  await expect(
    page.getByRole('tab', {name: 'Resources', exact: true}),
  ).toBeVisible();
  await expect(page.locator('#draft-save-state')).toContainText(
    'Draft saved to your account',
  );
  await page.evaluate(() => {
    globalThis.document.activeElement?.blur();
    globalThis.window.scrollTo({top: 0, behavior: 'instant'});
  });
  await page.screenshot({
    path: testInfo.outputPath('world-editor.png'),
    fullPage: true,
  });
});
test('Factorio keeps an unsaved world draft and its route when storage fails, then permits navigation after retry', async ({
  page,
}) => {
  const blocked = (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          json: {error: 'Draft storage unavailable.'},
        })
      : route.continue();
  await page.route('**/api/world-setups', blocked);
  await factorio(page, '#worlds/create');
  await page
    .getByRole('textbox', {name: /^World name/})
    .fill('Protected draft');
  await expect(page.locator('#draft-save-state')).toContainText(
    'Draft storage unavailable',
  );
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await expect(page).toHaveURL(new RegExp(scope + '/#worlds/create$'));
  await expect(page.getByRole('textbox', {name: /^World name/})).toHaveValue(
    'Protected draft',
  );
  await page.unroute('**/api/world-setups', blocked);
  await page
    .getByRole('textbox', {name: /^World name/})
    .fill('Protected draft retry');
  await expect(page.locator('#draft-save-state')).toContainText(
    'Draft saved to your account',
  );
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await expect(page).toHaveURL(new RegExp(scope + '/#overview$'));
});
test('Factorio shared action forms submit only their declared parameters inside the server scope', async ({
  page,
}) => {
  let job = null;
  const submissions = [];
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      submissions.push(body);
      expect(route.request().url()).toBe(
        origins.factorio + scope + '/api/jobs',
      );
      job = {
        id: 'shared-form-' + submissions.length,
        action: body.action,
        state: 'succeeded',
        message: 'Synthetic command completed.',
        result: 'Synthetic command output',
        started: new Date().toISOString(),
        actor: 'Preview',
      };
      return route.fulfill({status: 202, json: job});
    }
    return route.fulfill({json: {jobs: job ? [job] : [], active: null}});
  });
  await factorio(page, '#logs');
  await page
    .getByLabel('Administrative command', {exact: true})
    .selectOption('/seed');
  await page.getByRole('button', {name: 'Run command', exact: true}).click();
  await expect(page.locator('#console-output')).toHaveText(
    'Synthetic command output',
  );
  expect(submissions[0].action).toBe('console');
  expect(submissions[0].params).toEqual({command: '/seed'});
});
test('Factorio shared registration confirms passwords before submitting an invitation', async ({
  page,
}) => {
  let registrations = 0;
  await page.route('**/api/register', (route) => {
    registrations++;
    return route.fulfill({
      status: 400,
      json: {error: 'No registration expected.'},
    });
  });
  await page.goto(origins.factorio + scope + '/#register=' + 'a'.repeat(43));
  await page.getByLabel('Username', {exact: true}).fill('InvitedUser');
  await page
    .getByLabel('Password', {exact: true})
    .fill('registration-preview-password');
  await page
    .getByLabel('Confirm password', {exact: true})
    .fill('different-preview-password');
  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(page.locator('#auth-error')).toContainText('do not match');
  expect(registrations).toBe(0);
});
test('shared configuration retains a draft across navigation and a rejected stale save until explicit reload', async ({
  page,
}, testInfo) => {
  const externalName = 'Changed elsewhere ' + testInfo.project.name;
  await page.goto(origins.application);
  await page.getByLabel('Username', {exact: true}).fill('Owner');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await nav(page)
    .getByRole('link', {name: 'Configuration', exact: true})
    .click();
  await page
    .getByLabel('Application name', {exact: true})
    .fill('Unsaved draft');
  await nav(page).getByRole('link', {name: 'Services', exact: true}).click();
  await nav(page)
    .getByRole('link', {name: 'Configuration', exact: true})
    .click();
  await expect(page.getByLabel('Application name', {exact: true})).toHaveValue(
    'Unsaved draft',
  );
  const session = await (
      await page.request.get(origins.application + '/api/session')
    ).json(),
    configuration = await (
      await page.request.get(origins.application + '/api/settings')
    ).json();
  const accepted = await page.request.post(origins.application + '/api/jobs', {
    headers: {origin: origins.application, 'x-csrf-token': session.csrf},
    data: {
      action: 'save-settings',
      params: {
        values: {...configuration.values, applicationName: externalName},
        revision: configuration.revision,
      },
    },
  });
  expect(accepted.status()).toBe(202);
  const job = await accepted.json();
  await expect
    .poll(async () => {
      const snapshot = await (
        await page.request.get(origins.application + '/api/jobs')
      ).json();
      return (
        !snapshot.active &&
        snapshot.jobs.find((item) => item.id === job.id)?.state
      );
    })
    .toBe('succeeded');
  await nav(page).getByRole('link', {name: 'Services', exact: true}).click();
  await nav(page)
    .getByRole('link', {name: 'Configuration', exact: true})
    .click();
  await expect(page.locator('#settings-note')).toContainText(
    'draft is retained',
  );
  await page
    .getByRole('button', {name: 'Save configuration', exact: true})
    .click();
  await expect(page.locator('.product-feedback')).toContainText(
    'Configuration changed',
  );
  await expect(page.getByLabel('Application name', {exact: true})).toHaveValue(
    'Unsaved draft',
  );
  await page
    .getByRole('button', {name: 'Reload saved configuration', exact: true})
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'discard this local draft',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.getByLabel('Application name', {exact: true})).toHaveValue(
    externalName,
  );
});
test('first administrator registration validates confirmation and requires an explicit welcome completion', async ({
  page,
}) => {
  const login = await page.request.post(origins.fleet + '/api/login', {
    headers: {origin: origins.fleet},
    data: {username: 'Preview', password: 'isolated-panel-preview-password'},
  });
  expect(login.ok()).toBe(true);
  const user = await login.json();
  let registrations = 0,
    completed = 0,
    serverWrites = 0;
  await page.route('**/api/registration', (route) =>
    route.fulfill({json: {owner: true, role: 'admin'}}),
  );
  await page.route('**/api/register', (route) => {
    registrations++;
    return route.fulfill({json: {...user, onboarding: {completed: false}}});
  });
  await page.route('**/api/onboarding', (route) => {
    completed++;
    return route.fulfill({json: {completed: true}});
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/servers'))
      serverWrites++;
  });
  await page.goto(origins.fleet + '/#register=' + 'a'.repeat(43));
  await page.getByLabel('Choose a username', {exact: true}).fill('NewOwner');
  await page
    .getByLabel('Choose a password', {exact: true})
    .fill('registration-preview-password');
  await page
    .getByLabel('Confirm your password', {exact: true})
    .fill('wrong-preview-password');
  await page
    .getByRole('button', {name: 'Create administrator account', exact: true})
    .click();
  await expect(page.locator('#error')).toContainText('do not match');
  expect(registrations).toBe(0);
  await page
    .getByLabel('Confirm your password', {exact: true})
    .fill('registration-preview-password');
  await page
    .getByRole('button', {name: 'Create administrator account', exact: true})
    .click();
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  expect(registrations).toBe(1);
  expect(completed).toBe(0);
  await page.getByRole('button', {name: 'Open my panel', exact: true}).click();
  await expect(page.locator('#onboarding')).toBeHidden();
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(completed).toBe(1);
  expect(serverWrites).toBe(0);
});
test('a declaration-only deployment screen owns refresh, confirmation and delegated actions without duplicate submissions', async ({
  page,
}) => {
  const submissions = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/jobs'
    )
      submissions.push(request.postDataJSON());
  });
  await page.goto(origins.application);
  await page.getByLabel('Username', {exact: true}).fill('Deployer');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Deployment', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Application deployment', exact: true}),
  ).toBeVisible();
  const deploy = page.getByRole('button', {
    name: 'Deploy application',
    exact: true,
  });
  await expect(deploy).toHaveCount(1);
  await expect(deploy).toBeEnabled();
  await expect(
    page.getByRole('cell', {name: 'complete', exact: true}),
  ).toHaveCount(3);
  for (let index = 0; index < 2; index++)
    await page
      .getByRole('button', {name: 'Refresh deployment', exact: true})
      .click();
  await deploy.click();
  await expect(page.getByRole('dialog')).toContainText('database migration');
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Cancel', exact: true})
    .click();
  expect(submissions).toEqual([]);
  await nav(page).getByRole('link', {name: 'Services', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Deployment', exact: true}).click();
  await expect(deploy).toHaveCount(1);
  await deploy.click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.locator('.product-feedback')).toContainText(
    'Application deployment verified',
  );
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    action: 'deploy',
    params: {confirm: true},
  });
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Start', exact: true}),
  ).toHaveCount(0);
  const metadata = await (
    await page.request.get(origins.application + '/application-definition.json')
  ).json();
  expect(JSON.stringify(metadata)).not.toMatch(
    /fixture-private-application-key|secretRefs|fixture-key/,
  );
  expect(await page.locator('body').innerText()).not.toContain(
    'fixture-private-application-key',
  );
});
test('a non-game definition shares configuration, services, logs, accounts and operation workflows without application browser code', async ({
  page,
}, testInfo) => {
  const assets = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script')
      assets.push(new URL(request.url()).pathname);
  });
  await page.goto(origins.application);
  await page.getByLabel('Username', {exact: true}).fill('Owner');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(
    nav(page).getByRole('link', {name: 'Services', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: /Players|Worlds|Map/}),
  ).toHaveCount(0);
  await nav(page)
    .getByRole('link', {name: 'Configuration', exact: true})
    .click();
  await page
    .getByLabel('Application name', {exact: true})
    .fill('Browser application');
  await page.getByLabel('Queue concurrency', {exact: true}).fill('3');
  await page
    .getByRole('button', {name: 'Save configuration', exact: true})
    .click();
  await expect(page.locator('.product-feedback')).toContainText(
    'Configuration saved',
  );
  await page.reload();
  await expect(page.getByLabel('Application name', {exact: true})).toHaveValue(
    'Browser application',
  );
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole('button', {name: 'Start', exact: true}).click();
  await expect(page.locator('#connection-state')).toHaveText('Ready');
  await page.screenshot({
    path: testInfo.outputPath('shared-application.png'),
    fullPage: true,
  });
  await nav(page).getByRole('link', {name: 'Services', exact: true}).click();
  await expect(page.getByRole('cell', {name: 'web', exact: true})).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('cell', {name: 'worker', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', {name: 'scheduler', exact: true}),
  ).toHaveCount(2);
  await nav(page)
    .getByRole('link', {name: 'Configuration', exact: true})
    .click();
  await expect(
    page.getByLabel('Application name', {exact: true}),
  ).toBeDisabled();
  await nav(page).getByRole('link', {name: 'Logs', exact: true}).click();
  await expect(page.locator('#logs')).toContainText(
    'Browser application / concurrency 3',
  );
  await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole('button', {name: 'Stop', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText(
    'queue workers and scheduler',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.locator('#connection-state')).toHaveText('Stopped');
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Signed-in sessions', exact: true}),
  ).toBeVisible();
  expect(
    assets.some((path) => /\/(rust|factorio|web-stack)\//.test(path)),
  ).toBe(false);
});
test('the shared application host filters delegated tools and the backend enforces the same permissions', async ({
  page,
}) => {
  await page.goto(origins.application);
  await page.getByLabel('Username', {exact: true}).fill('Read');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(
    nav(page).getByRole('link', {name: 'Services', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: 'Configuration', exact: true}),
  ).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Start', exact: true}),
  ).toHaveCount(0);
  await page.goto(origins.application + '/#settings');
  await expect(
    page.getByRole('heading', {name: 'Overview', exact: true}),
  ).toBeVisible();
  expect(
    (await page.request.get(origins.application + '/api/settings')).status(),
  ).toBe(403);
});
test('Rust navigation cancels a delayed players load before another screen renders', async ({
  page,
}) => {
  let release, entered;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      entered = resolve;
    });
  await page.route('**/api/players', async (route) => {
    entered();
    await held;
    await route
      .fulfill({
        json: {
          available: true,
          players: [
            {name: 'Late old player', id: 'old', ping: 1, connectedSeconds: 60},
          ],
        },
      })
      .catch(() => {});
  });
  await login(page, 'rust');
  await nav(page).getByRole('link', {name: 'Players', exact: true}).click();
  await started;
  await nav(page).getByRole('link', {name: 'Settings', exact: true}).click();
  await expect(page.locator('[data-view=settings]')).toBeVisible();
  release();
  await expect(page.locator('#settings input').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Late old player');
});
test('fleet sign-out cancels pending host reads before an assigned account signs in', async ({
  page,
}) => {
  let release, entered;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      entered = resolve;
    });
  await page.route('**/api/hosts', async (route) => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({response}).catch(() => {});
  });
  await login(page, 'fleet', 'Preview');
  await started;
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Sign in', exact: true}),
  ).toBeVisible();
  release();
  await page.getByLabel('Username', {exact: true}).fill('Assigned');
  await page
    .getByLabel('Password', {exact: true})
    .fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('#servers')).toContainText('Friday factory');
  await expect(page.locator('#servers')).not.toContainText('Island crew');
  await expect(
    nav(page).getByRole('link', {name: 'Hosts', exact: true}),
  ).toBeHidden();
});
test('a third game contributes delegated tools through the shared shell and operation lifecycle', async ({
  page,
}) => {
  await page.goto(origins.arena);
  await page.getByLabel('Username', {exact: true}).fill('Assigned');
  await page
    .getByLabel('Password', {exact: true})
    .fill('arena-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Arena', exact: true}).click();
  const before = Number(await page.locator('#arena-score').textContent());
  await page.getByRole('button', {name: 'Rotate arena', exact: true}).click();
  // Completion can first be observed on the shell's next five-second poll.
  await expect(page.locator('#arena-score')).toHaveText(String(before + 1), {
    timeout: 15_000,
  });
  await expect(
    nav(page).getByRole('link', {name: 'Arena', exact: true}),
  ).toHaveAttribute('aria-current', 'page');
});
test('a third game cannot expose or authorize its custom action without its explicit grant', async ({
  page,
}) => {
  await page.goto(origins.arena);
  await page.getByLabel('Username', {exact: true}).fill('Read');
  await page
    .getByLabel('Password', {exact: true})
    .fill('arena-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(
    nav(page).getByRole('link', {name: 'Overview', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: 'Arena', exact: true}),
  ).toBeHidden();
  await page.goto(origins.arena + '/#arena');
  await expect(page.locator('#arena-score')).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Rotate arena', exact: true}),
  ).toHaveCount(0);
  const session = await (
    await page.request.get(origins.arena + '/api/session')
  ).json();
  const denied = await page.request.post(origins.arena + '/api/jobs', {
    headers: {origin: origins.arena, 'x-csrf-token': session.csrf},
    data: {action: 'rotate'},
  });
  expect(denied.status()).toBe(403);
});
async function factorio(page, hash = '#overview', {onboarding = false} = {}) {
  await page.route('**/api/session', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({
      json: {...user, onboarding: {completed: !onboarding}},
    });
  });
  await page.goto(origins.factorio + scope + '/' + hash);
}
async function login(page, game, username = 'admin') {
  await page.goto(origins[game]);
  await page.getByLabel('Username', {exact: true}).fill(username);
  await page
    .getByLabel('Password', {exact: true})
    .fill(
      game === 'fleet'
        ? 'isolated-panel-preview-password'
        : 'rust-preview-password',
    );
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.product-shell')).toBeVisible();
}

test('scoped world creation keeps the server pathname through completion and reload', async ({
  page,
}) => {
  await factorio(page, '#worlds/create');
  await page
    .getByRole('textbox', {name: /^World name/})
    .fill('Browser regression world');
  await page.getByRole('button', {name: 'Customize world'}).click();
  await page.getByRole('button', {name: 'Review world'}).click();
  await page.getByRole('button', {name: /Create world/}).click();
  await expect(page).toHaveURL(origins.factorio + scope + '/#worlds/created');
  await page.reload();
  await expect(
    nav(page).getByRole('link', {name: 'Worlds', exact: true}),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main')).toContainText('Browser regression world');
  await expect(
    page.getByRole('link', {name: 'All servers', exact: true}),
  ).toHaveAttribute('href', '/');
});

test('Factorio setup can be deferred without hiding server navigation', async ({
  page,
}) => {
  await factorio(page, '#setup', {onboarding: true});
  await expect(nav(page)).toBeHidden();
  await page.getByRole('link', {name: 'Do this later', exact: true}).click();
  await expect(nav(page)).toBeVisible();
  await nav(page).getByRole('link', {name: 'Worlds', exact: true}).click();
  await expect(page).toHaveURL(origins.factorio + scope + '/#worlds');
});

test('completing Factorio setup reveals navigation immediately', async ({
  page,
}) => {
  await factorio(page, '#setup', {onboarding: true});
  await page.locator('#finish-setup').click();
  await expect(nav(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(scope + '/#overview$'));
});

test('a delayed session never flashes the sign-in form', async ({page}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/session', async (route) => {
    await held;
    await route.fulfill({
      json: {
        username: 'Preview',
        role: 'admin',
        csrf: 'fixture',
        onboarding: {completed: true},
      },
    });
  });
  await page.goto(origins.factorio + scope + '/');
  await expect(page.locator('#session-loading')).toBeVisible();
  await expect(page.locator('#auth')).toBeHidden();
  release();
  await expect(nav(page)).toBeVisible();
});

test('Factorio recovery review restores the scoped page controls immediately', async ({
  page,
}) => {
  let reviewed = false,
    checked = false;
  const job = {
    id: 'factorio-interrupted',
    action: 'restart',
    state: 'interrupted',
    message: 'Review the interrupted restart.',
    started: new Date().toISOString(),
  };
  const record = () => ({
    ...job,
    recovery: {
      required: !reviewed,
      retryable: false,
      ...(checked && {
        checkedAt: new Date().toISOString(),
        message:
          'Review the current server and logs. No operation was replayed.',
      }),
    },
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {jobs: [record()], active: null, recoveryRequired: !reviewed},
    }),
  );
  await page.route('**/api/jobs/recovery', (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === 'inspect') checked = true;
    if (body.operation === 'acknowledge' && checked && body.confirm)
      reviewed = true;
    return route.fulfill({json: record()});
  });
  await factorio(page);
  const recovery = page.getByRole('region', {name: 'Operation recovery'}),
    save = page.getByRole('button', {name: 'Save now', exact: true});
  await expect(save).toBeDisabled();
  await recovery
    .getByRole('button', {name: 'Check outcome', exact: true})
    .click();
  await recovery
    .getByRole('button', {name: 'I’ve reviewed this operation', exact: true})
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(recovery).toBeHidden();
  await expect(save).toBeEnabled();
  await expect(page).toHaveURL(origins.factorio + scope + '/#overview');
});

test('Rust confirms interruption and cancellation sends no operation', async ({
  page,
}) => {
  await login(page, 'rust');
  await expect(nav(page)).toBeVisible();
  await expect(page.locator('#server-name')).toHaveText('North Coast · Rust');
  const writes = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/jobs'))
      writes.push(req.url());
  });
  await page.getByRole('button', {name: 'Restart', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Connected players');
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes).toEqual([]);
});

test('fleet creation fields follow the selected game policy', async ({
  page,
}) => {
  await login(page, 'fleet', 'Preview');
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  const form = page.locator('#create');
  await expect(page.locator('#create-submit')).toBeEnabled();
  await expect(form.locator('[name=memoryGiB]')).toHaveValue('2');
  await expect(form.locator('[name=softwareMode]')).toHaveValue('image');
  await form.locator('[name=softwareMode]').selectOption('runtime');
  await expect(form.locator('[name=softwareMode]')).toHaveValue('runtime');
  await form.locator('[name=game]').selectOption('rust');
  await expect(form.locator('[name=memoryGiB]')).toHaveValue('12');
  await expect(form.locator('[name=softwareMode]')).toBeEnabled();
  await expect(form.locator('[name=softwareMode]')).toHaveValue('runtime');
  await form.locator('[name=softwareMode]').selectOption('managed');
  await expect(form.locator('[name=worldSize]')).toHaveValue('2000');
  await expect(form.locator('[name=worldSize]')).toHaveAttribute(
    'type',
    'range',
  );
  await page.locator('#close-create').click();
});

test('fleet creation submits a named provider choice while keeping the legacy default', async ({page}) => {
  await page.route(/\/api\/(?:hosts\/[^/]+\/)?catalog$/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.games = data.games.map(game => game.id === 'rust' ? {...game, softwareModes: ['runtime', 'managed'], defaultSoftwareMode: 'runtime', runtimeKey: 'managed', runtimeLabel: 'Prepare verified software', runtimeImage: 'ghcr.io/jkenneydaniel/rust-server:managed-lg.1'} : game);
    await route.fulfill({json: data});
  });
  const submitted = [];
  await page.route(/\/api\/(?:hosts\/[^/]+\/)?servers$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted.push(route.request().postDataJSON());
    await route.fulfill({status: 202, json: {id: 'new-fixture', state: 'queued'}});
  });
  await login(page, 'fleet', 'Preview');
  await page.getByRole('button', {name: 'Create server', exact: true}).click();
  const form = page.locator('#create');
  await expect(page.locator('#create-submit')).toBeEnabled();
  await form.locator('[name=game]').selectOption('rust');
  await expect(form.locator('[name=softwareMode]')).toHaveValue('runtime');
  await expect(form.locator('[name=softwareMode]')).toBeVisible();
  await form.locator('[name=softwareMode]').selectOption({label: 'Prepare verified software'});
  await form.locator('[name=name]').fill('New isolated fixture');
  await page.locator('#create-submit').click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({game: 'rust', softwareMode: 'managed', name: 'New isolated fixture'});
});

test('fleet viewers cannot access administrative controls or write endpoints', async ({
  page,
}) => {
  await login(page, 'fleet', 'Viewer');
  await expect(
    page.getByRole('button', {name: 'Create server', exact: true}),
  ).toBeHidden();
  await expect(
    nav(page).getByRole('link', {name: 'Accounts', exact: true}),
  ).toBeHidden();
  await expect(page.locator('[data-publish],[data-remove]')).toHaveCount(0);
  const session = await (
    await page.request.get(origins.fleet + '/api/session')
  ).json();
  const response = await page.request.post(origins.fleet + '/api/servers', {
    headers: {'x-csrf-token': session.csrf, origin: origins.fleet},
    data: {game: 'factorio', name: 'Denied'},
  });
  expect(response.status()).toBe(403);
});

test('expired fleet sessions clear the shell and return to sign-in', async ({
  page,
}) => {
  await login(page, 'fleet', 'Preview');
  // A real logout invalidates the persisted fixture session. The next UI request
  // receives 401 just as it would after session expiry/revocation.
  const session = await (
    await page.request.get(origins.fleet + '/api/session')
  ).json();
  const logout = await page.request.post(origins.fleet + '/api/logout', {
    headers: {'x-csrf-token': session.csrf, origin: origins.fleet},
    data: {},
  });
  expect(logout.ok()).toBe(true);
  await nav(page)
    .getByRole('link', {name: 'Host settings', exact: true})
    .click();
  await expect(page.locator('.product-shell')).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Sign in', exact: true}),
  ).toBeVisible();
  await expect(page.locator('#login [name=password]')).toHaveValue('');
});

for (const remote of [false, true])
  test(`expired ${remote ? 'remote' : 'local'} server sessions can sign in and resume with server permissions`, async ({
    page,
  }) => {
    const username = remote ? 'Preview' : 'Assigned';
    await login(page, 'fleet', username);
    const previous = await (
      await page.request.get(origins.fleet + '/api/session')
    ).json();
    if (remote) {
      const host = await page.request.post(origins.fleet + '/api/hosts', {
        headers: {'x-csrf-token': previous.csrf, origin: origins.fleet},
        data: {},
      });
      expect(host.ok()).toBe(true);
    }
    const prefix = remote
      ? '/hosts/' + 'd'.repeat(32) + '/servers/' + 'e'.repeat(32)
      : '/servers/' + 'b'.repeat(32);
    await page.goto(origins.fleet + prefix + '/#overview');
    await expect(
      page.getByRole('button', {name: 'Save now', exact: true}),
    ).toBeEnabled();
    const writes = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/jobs'))
        writes.push(request.url());
    });
    const expired = await page.request.post(origins.fleet + '/api/logout', {
      headers: {'x-csrf-token': previous.csrf, origin: origins.fleet},
      data: {},
    });
    expect(expired.ok()).toBe(true);
    await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
    await expect(page.locator('#shell')).toBeHidden();
    await expect(page.locator('#auth')).toBeVisible();
    await page.getByLabel('Username', {exact: true}).fill(username);
    await page.getByLabel('Password', {exact: true}).fill('wrong-password');
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/login'),
    );
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    const failure = await rejected;
    expect(failure.url()).toBe(origins.fleet + '/api/login');
    expect(failure.status()).toBe(401);
    await expect(page.locator('#auth-error')).toContainText(
      'password is incorrect',
    );
    await page
      .getByLabel('Password', {exact: true})
      .fill('isolated-panel-preview-password');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page.locator('#shell')).toBeVisible();
    await expect(page).toHaveURL(origins.fleet + prefix + '/#accounts');
    await expect(
      page.getByRole('heading', {name: 'Signed-in sessions', exact: true}),
    ).toBeVisible();
    const renewed = await (
      await page.request.get(origins.fleet + prefix + '/api/session')
    ).json();
    expect(renewed.csrf).not.toBe(previous.csrf);
    expect(renewed.username).toBe(username);
    if (!remote) {
      expect([...renewed.permissions].sort()).toEqual([
        'server.operate',
        'server.view',
      ]);
      await expect(
        nav(page).getByRole('link', {name: 'Mods', exact: true}),
      ).toBeHidden();
    }
    await nav(page).getByRole('link', {name: 'Overview', exact: true}).click();
    await expect(
      page.getByRole('button', {name: 'Save now', exact: true}),
    ).toBeEnabled();
    expect(writes).toEqual([]);
  });

test('signing in as an account without the current server returns to its server list', async ({
  page,
}) => {
  await login(page, 'fleet', 'Preview');
  const previous = await (
    await page.request.get(origins.fleet + '/api/session')
  ).json();
  await page.goto(origins.fleet + '/servers/' + 'c'.repeat(32) + '/#overview');
  await expect(page.locator('#shell')).toBeVisible();
  await page.request.post(origins.fleet + '/api/logout', {
    headers: {'x-csrf-token': previous.csrf, origin: origins.fleet},
    data: {},
  });
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await expect(page.locator('#auth')).toBeVisible();
  await page.getByLabel('Username', {exact: true}).fill('Assigned');
  await page
    .getByLabel('Password', {exact: true})
    .fill('isolated-panel-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page).toHaveURL(origins.fleet + '/');
  await expect(page.locator('#servers')).toContainText('Friday factory');
  await expect(page.locator('#servers')).not.toContainText('Island crew');
});

test('interrupted operations can be inspected and acknowledged without replaying them', async ({
  page,
}, testInfo) => {
  const game =
      testInfo.project.name === 'mobile' ? 'recoveryMobile' : 'recoveryDesktop',
    writes = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/jobs'))
      writes.push(req.url());
  });
  await login(page, game);
  const recovery = page.getByRole('region', {name: 'Operation recovery'});
  await expect(recovery).toContainText('Review interrupted operations');
  await expect(
    page.getByRole('button', {name: 'Restart', exact: true}),
  ).toBeDisabled();
  await expect(
    recovery.getByRole('button', {name: 'Retry operation', exact: true}),
  ).toHaveCount(0);
  await recovery
    .getByRole('button', {name: 'Check outcome', exact: true})
    .click();
  await expect(recovery).toContainText('No operation was replayed');
  await page.screenshot({
    path: testInfo.outputPath('operation-recovery.png'),
    fullPage: true,
  });
  await recovery
    .getByRole('button', {name: 'I’ve reviewed this operation', exact: true})
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(recovery).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Restart', exact: true}),
  ).toBeEnabled();
  await page.reload();
  await expect(page.locator('#server-name')).toHaveText('North Coast · Rust');
  await expect(recovery).toBeHidden();
  expect(writes).toEqual([]);
});

for (const game of ['factorio', 'rust', 'fleet']) {
  test(
    game + ' uses the shared account and invitation workflow',
    async ({page}, testInfo) => {
      if (game === 'factorio') {
        await page.route('**/api/invitations', (route) =>
          route.fulfill({json: {token: 'synthetic-invitation'}}),
        );
        await factorio(page, '#accounts');
      } else {
        await login(page, game, game === 'fleet' ? 'Preview' : 'admin');
        await nav(page)
          .getByRole('link', {name: 'Accounts', exact: true})
          .click();
      }
      await expect(
        page.getByRole('heading', {
          name: game === 'rust' ? 'Accounts' : 'Account and access',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText('This session', {exact: false}),
      ).toBeVisible();
      await expect(
        page.getByLabel('Current password', {exact: true}),
      ).toBeVisible();
      await page
        .getByRole('button', {name: 'Create invitation', exact: true})
        .click();
      const link = page.getByLabel('Private invitation link');
      await expect(link).toBeVisible();
      await expect(link).toHaveValue(
        new RegExp(
          '^' +
            origins[game].replaceAll('.', '\\.') +
            (game === 'factorio' ? scope : '') +
            '/#register=',
        ),
      );
      await page.evaluate(() => globalThis.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(game + '-accounts.png'),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        ),
      ).toBe(false);
    },
  );
}

test('password confirmation and renewed CSRF are shared by the scoped account page', async ({
  page,
}) => {
  const writes = [];
  await page.route('**/api/password', (route) => {
    writes.push({
      path: 'password',
      body: route.request().postDataJSON(),
      csrf: route.request().headers()['x-csrf-token'],
    });
    return route.fulfill({
      json: {
        username: 'Preview',
        role: 'admin',
        csrf: 'renewed-fixture-csrf',
        onboarding: {completed: true},
      },
    });
  });
  await page.route('**/api/invitations', (route) => {
    writes.push({
      path: 'invitation',
      csrf: route.request().headers()['x-csrf-token'],
    });
    return route.fulfill({json: {token: 'synthetic-renewed-invitation'}});
  });
  await factorio(page, '#accounts');
  await page
    .getByLabel('Current password', {exact: true})
    .fill('old-fixture-password');
  await page
    .getByLabel('New password', {exact: true})
    .fill('new-fixture-password');
  await page
    .getByLabel('Confirm new password', {exact: true})
    .fill('does-not-match');
  await page
    .getByRole('button', {name: 'Change password', exact: true})
    .click();
  await expect(page.locator('.product-feedback')).toContainText('do not match');
  expect(writes).toEqual([]);
  await page
    .getByLabel('Confirm new password', {exact: true})
    .fill('new-fixture-password');
  await page
    .getByRole('button', {name: 'Change password', exact: true})
    .click();
  await expect(page.getByLabel('Current password', {exact: true})).toHaveValue(
    '',
  );
  await page
    .getByRole('button', {name: 'Create invitation', exact: true})
    .click();
  await expect(page.getByLabel('Private invitation link')).toBeVisible();
  expect(writes.map((write) => [write.path, write.csrf])).toEqual([
    ['password', 'isolated-preview'],
    ['invitation', 'renewed-fixture-csrf'],
  ]);
});

for (const game of ['factorio', 'rust']) {
  test(
    game +
      ' shares archive and retention controls while preserving schedule confirmation',
    async ({page}, testInfo) => {
      const writes = [];
      await page.route('**/api/schedule', (route) => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({json: {ok: true}});
      });
      if (game === 'factorio') await factorio(page, '#backups');
      else {
        await login(page, 'rust');
        await nav(page)
          .getByRole('link', {name: 'Backups', exact: true})
          .click();
      }
      await expect(
        page.getByRole('heading', {name: 'Saved archives', exact: true}),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {name: 'Review cleanup', exact: true}),
      ).toBeVisible();
      await expect(page.locator('#schedule-form .check-label')).toHaveCSS(
        'flex-direction',
        'row',
      );
      await page.getByLabel('Every (hours)', {exact: true}).fill('11');
      await page
        .getByLabel('Create backups on a schedule', {exact: true})
        .check();
      await page
        .getByRole('button', {name: 'Save schedule', exact: true})
        .click();
      if (game === 'rust') {
        await expect(page.getByRole('dialog')).toContainText(
          'save, stop and resume',
        );
        await page.getByRole('button', {name: 'Cancel', exact: true}).click();
        expect(writes).toEqual([]);
        await page
          .getByRole('button', {name: 'Save schedule', exact: true})
          .click();
        await page
          .getByRole('dialog')
          .getByRole('button', {name: 'Continue', exact: true})
          .click();
      }
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toEqual({
        enabled: true,
        hours: 11,
        keep: 12,
        ...(game === 'rust' ? {confirmDowntime: true} : {}),
      });
      await page.evaluate(() => globalThis.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(game + '-backups.png'),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        ),
      ).toBe(false);
    },
  );
}

test('Rust backup completion refreshes archives without erasing an unsaved schedule', async ({
  page,
}) => {
  let submitted = false,
    backupReads = 0;
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') submitted = true;
    const job = {
      id: 'synthetic-backup',
      action: 'backup',
      state: 'succeeded',
      message: 'Backup verified',
      started: new Date().toISOString(),
    };
    return route.fulfill({
      json:
        route.request().method() === 'POST'
          ? job
          : {jobs: submitted ? [job] : [], active: null},
    });
  });
  await page.route('**/api/backups', async (route) => {
    backupReads++;
    const response = await route.fetch();
    await route.fulfill({response});
  });
  await login(page, 'rust');
  await nav(page).getByRole('link', {name: 'Backups', exact: true}).click();
  await page.getByLabel('Every (hours)', {exact: true}).fill('17');
  const before = backupReads;
  await page.getByRole('button', {name: 'Create backup', exact: true}).click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect.poll(() => backupReads).toBeGreaterThan(before);
  await expect(page.getByLabel('Every (hours)', {exact: true})).toHaveValue(
    '17',
  );
  await expect(
    page.getByRole('button', {name: 'Create backup', exact: true}),
  ).toBeEnabled();
});

test('extracted Factorio views remain navigable inside a remote server scope', async ({
  page,
}, testInfo) => {
  await factorio(page);
  for (const [label, selector] of [
    ['Worlds', '#world-search'],
    ['Players', '#player-form'],
    ['Activity', '#console-form'],
    ['Settings', '#settings-form'],
    ['Map', '#world-map'],
  ]) {
    await nav(page).getByRole('link', {name: label, exact: true}).click();
    await expect(page.locator(selector)).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp('^' + origins.factorio + scope + '/'),
    );
  }
  await page.screenshot({
    path: testInfo.outputPath('world-map.png'),
    fullPage: true,
  });
});

for (const game of ['rust', 'fleet']) {
  for (const outcome of ['signed-in', 'signed-out', 'network-error']) {
    test(
      game + ' waits for delayed session resolution (' + outcome + ')',
      async ({page}) => {
        let signedUser;
        if (outcome === 'signed-in') {
          const response = await page.request.post(
            origins[game] + '/api/login',
            {
              headers: {origin: origins[game]},
              data: {
                username: game === 'fleet' ? 'Preview' : 'admin',
                password:
                  game === 'fleet'
                    ? 'isolated-panel-preview-password'
                    : 'rust-preview-password',
              },
            },
          );
          expect(response.ok()).toBe(true);
          signedUser = await response.json();
        }
        let release;
        const held = new Promise((resolve) => {
          release = resolve;
        });
        await page.route('**/api/session', async (route) => {
          await held;
          if (outcome === 'network-error') return route.abort('failed');
          return route.fulfill({
            status: outcome === 'signed-in' ? 200 : 401,
            json:
              outcome === 'signed-in' ? signedUser : {error: 'Please sign in.'},
          });
        });
        await page.goto(origins[game]);
        await expect(page.locator('#session-loading')).toBeVisible();
        await expect(page.locator('#auth')).toBeHidden();
        release();
        await expect(page.locator('#session-loading')).toBeHidden();
        if (outcome === 'signed-in')
          await expect(page.locator('.product-shell')).toBeVisible();
        else
          await expect(
            page.getByRole('button', {name: 'Sign in', exact: true}),
          ).toBeVisible();
      },
    );
  }
}

for (const game of ['factorio', 'rust', 'fleet']) {
  test(
    game + ' invitation opens registration without protected session bootstrap',
    async ({page}) => {
      let sessions = 0;
      await page.route('**/api/session', (route) => {
        sessions++;
        return route.abort();
      });
      await page.route('**/api/registration?*', (route) =>
        route.fulfill({json: {owner: false, role: 'viewer'}}),
      );
      await page.goto(
        origins[game] +
          (game === 'factorio' ? scope : '') +
          '/#register=' +
          'a'.repeat(43),
      );
      await expect(page.locator('#session-loading')).toBeHidden();
      await expect(
        page.getByRole('button', {name: 'Create account', exact: true}),
      ).toBeVisible();
      expect(sessions).toBe(0);
    },
  );
}

test('extracted Rust mod tools keep stopped-server restrictions', async ({
  page,
}) => {
  await login(page, 'rust');
  await nav(page).getByRole('link', {name: 'Mods', exact: true}).click();
  await expect(page.locator('#framework-current')).toContainText('Vanilla');
  await expect(
    page.getByRole('button', {name: 'Install / update plugin', exact: true}),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {name: 'Save configuration', exact: true}),
  ).toBeDisabled();
  await expect(page.locator('#mods-note')).not.toContainText('Loading');
});

test('extracted fleet host settings preserve a draft across navigation and explicit reload discards it', async ({
  page,
}) => {
  await login(page, 'fleet', 'Preview');
  await nav(page)
    .getByRole('link', {name: 'Host settings', exact: true})
    .click();
  await expect(page.locator('#host-budget')).toBeEnabled();
  const budget = await page.locator('#host-budget').inputValue();
  await page.locator('#host-budget').fill('15');
  await nav(page).getByRole('link', {name: 'Servers', exact: true}).click();
  await nav(page)
    .getByRole('link', {name: 'Host settings', exact: true})
    .click();
  await expect(page.locator('#host-budget')).toHaveValue('15');
  await page
    .getByRole('button', {name: 'Reload current settings', exact: true})
    .click();
  await expect(page.locator('#host-budget')).toHaveValue(budget);
});

test('assigned-server accounts see only assigned servers and permitted tools', async ({
  page,
}) => {
  await login(page, 'fleet', 'Assigned');
  await expect(page.locator('#servers')).toContainText('Friday factory');
  await expect(page.locator('#servers')).not.toContainText('Island crew');
  await expect(
    nav(page).getByRole('link', {name: 'Hosts', exact: true}),
  ).toBeHidden();
  await expect(
    nav(page).getByRole('link', {name: 'Host settings', exact: true}),
  ).toBeHidden();
  await expect(
    nav(page).getByRole('link', {name: 'Accounts', exact: true}),
  ).toBeVisible();
  await page.getByRole('link', {name: 'Open server', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Save now', exact: true}),
  ).toBeEnabled();
  await expect(
    nav(page).getByRole('link', {name: 'Mods', exact: true}),
  ).toBeHidden();
  await expect(
    nav(page).getByRole('link', {name: 'Settings', exact: true}),
  ).toBeHidden();
  const denied = await page.request.get(
    origins.fleet + '/servers/' + 'c'.repeat(32) + '/api/status',
  );
  expect(denied.status()).toBe(404);
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Signed-in sessions', exact: true}),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {name: 'Panel accounts', exact: true}),
  ).toBeHidden();
});

test('administrators can review assigned-server permissions and audit access changes', async ({
  page,
}, testInfo) => {
  await login(page, 'fleet', 'Preview');
  await nav(page).getByRole('link', {name: 'Accounts', exact: true}).click();
  const form = page.locator('[data-assignments]');
  await expect(form.locator('[name=username]')).toHaveValue('Assigned');
  await expect(form.locator('[name=scope]')).toHaveValue(
    '/servers/' + 'b'.repeat(32),
  );
  await expect(form.locator('[value="server.view"]')).toBeChecked();
  await expect(form.locator('[value="mods.manage"]')).toBeVisible();
  await expect(form.locator('[value="images.change"]')).toBeVisible();
  await expect(
    form.locator('[value="application.factorio.map.view"]'),
  ).toBeVisible();
  await expect(
    form.locator('[value="application.rust.framework.manage"]'),
  ).toBeVisible();
  await form.locator('[value="settings.read"]').check();
  await form.locator('[value="application.factorio.map.view"]').check();
  await form
    .getByRole('button', {name: 'Save server access', exact: true})
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.locator('.product-feedback')).toContainText(
    'Server access updated',
  );
  await page
    .getByRole('button', {name: 'Refresh audit history', exact: true})
    .click();
  await expect(page.locator('[data-audit-events]')).toContainText(
    'account.access',
  );
  await expect(page.locator('[data-audit-events]')).toContainText('Assigned');
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await page
    .locator('[data-server-access]')
    .screenshot({path: testInfo.outputPath('server-permissions.png')});
  await page
    .locator('[data-audit-history]')
    .screenshot({path: testInfo.outputPath('audit-history.png')});
  const session = await (
    await page.request.get(origins.fleet + '/api/session')
  ).json();
  const accounts = await (
      await page.request.get(origins.fleet + '/api/accounts')
    ).json(),
    assigned = accounts.users.find((user) => user.username === 'Assigned');
  expect(assigned.grants['/servers/' + 'b'.repeat(32)]).toContain(
    'settings.read',
  );
  expect(assigned.grants['/servers/' + 'b'.repeat(32)]).toContain(
    'application.factorio.map.view',
  );
  const restored = await page.request.post(origins.fleet + '/api/accounts', {
    headers: {origin: origins.fleet, 'x-csrf-token': session.csrf},
    data: {
      username: 'Assigned',
      operation: 'grants',
      grants: {
        ['/servers/' + 'b'.repeat(32)]: ['server.view', 'server.operate'],
      },
      revision: assigned.accessRevision,
      confirm: true,
    },
  });
  expect(restored.ok()).toBe(true);
  await page
    .locator('[data-audit-filter] [name=search]')
    .fill('nonexistent-actor-fixture');
  await page
    .getByRole('button', {name: 'Refresh audit history', exact: true})
    .click();
  await expect(page.locator('[data-audit-events]')).toContainText(
    'No matching recorded events',
  );
});

test('delegated Factorio mod and game-image tools are explicit and keep panel controls private', async ({
  page,
}) => {
  await page.route('**/api/application-releases', route => route.fulfill({json:{game:'factorio',stable:'2.0.77',stale:false,choices:[{kind:'image',version:'2.0.77',imageRevision:3,image:'ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.3',channel:'stable',notesUrl:'https://wiki.factorio.com/Version_history/2.0.0#2.0.77'}]}}));
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        username: 'Assigned',
        role: 'member',
        csrf: 'fixture',
        permissions: ['server.view', 'mods.manage', 'images.change'],
        allowedActions: ['mod-library-install', 'mod-library-recover'],
        onboarding: {completed: true},
      },
    }),
  );
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        image: 'ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.2',
      },
    });
  });
  await page.route('**/api/mod-library?*', (route) =>
    route.fulfill({
      json: {
        game: 'factorio',
        source: 'Factorio Mod Portal',
        scope: 'fixture',
        items: [],
        page: 1,
        pages: 1,
        running: true,
        account: {connected: true},
      },
    }),
  );
  await page.goto(origins.factorio + scope + '/#settings');
  await expect(page).toHaveURL(origins.factorio + scope + '/#settings/updates');
  await expect(page.locator('#game-update-form')).toBeVisible();
  await expect(
    page.getByRole('button', {name: 'Review image change', exact: true}),
  ).toBeEnabled();
  await expect(page.locator('#check-panel-updates')).toBeHidden();
  await expect(
    page.getByRole('link', {name: 'General & connection', exact: true}),
  ).toBeHidden();
  await expect(
    page.getByRole('link', {name: 'Diagnostics', exact: true}),
  ).toBeHidden();
  await nav(page).getByRole('link', {name: 'Mods', exact: true}).click();
  await expect(page.locator('.ml-status')).toContainText('Factorio Mod Portal');
  await expect(page.locator('.ml-account')).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Save now', exact: true}),
  ).toBeHidden();
});

test('delegated Rust mod access leaves lifecycle and settings ungranted', async ({
  page,
}) => {
  await login(page, 'rust', 'member');
  await expect(
    nav(page).getByRole('link', {name: 'Mods', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: 'Settings', exact: true}),
  ).toBeHidden();
  await expect(page.locator('[data-action=start]')).toBeHidden();
  await nav(page).getByRole('link', {name: 'Mods', exact: true}).click();
  await expect(page.locator('#framework-current')).toContainText('Vanilla');
  await expect(page.locator('#plugin-upload button')).toBeDisabled();
  const denied = await page.request.get(origins.rust + '/api/settings');
  expect(denied.status()).toBe(403);
});

test('delegated backup listing exposes only granted tools', async ({page}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        username: 'Assigned',
        role: 'member',
        csrf: 'fixture',
        permissions: ['server.view', 'backups.read'],
        allowedActions: [],
        onboarding: {completed: true},
      },
    }),
  );
  await page.goto(origins.factorio + scope + '/#backups');
  await expect(
    page.getByRole('heading', {name: 'Saved archives', exact: true}),
  ).toBeVisible();
  await expect(page.locator('[data-backup-create]')).toHaveCount(0);
  await expect(page.locator('#schedule-form')).toHaveCount(0);
  await expect(page.locator('#retention-form')).toHaveCount(0);
});

test('accounts without assignments open their own account tools without server polling', async ({
  page,
}) => {
  const gameRequests = [];
  page.on('request', (request) => {
    if (/\/api\/(status|jobs)(?:$|\?)/.test(request.url()))
      gameRequests.push(request.url());
  });
  await page.route(origins.factorio + '/**/api/session', (route) =>
    route.fulfill({
      json: {
        username: 'Pending',
        role: 'member',
        csrf: 'fixture',
        permissions: [],
        allowedActions: [],
        onboarding: {completed: true},
      },
    }),
  );
  await page.goto(origins.factorio + scope + '/#overview');
  await expect(
    page.getByRole('heading', {name: 'Signed-in sessions', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: 'Overview', exact: true}),
  ).toBeHidden();
  await login(page, 'rust', 'pending');
  await expect(
    page.getByRole('heading', {name: 'Signed-in sessions', exact: true}),
  ).toBeVisible();
  await expect(
    nav(page).getByRole('link', {name: 'Overview', exact: true}),
  ).toBeHidden();
  expect(gameRequests).toEqual([]);
});

test('broker-isolated hosts require an operator update without offering the legacy privileged helper', async ({
  page,
}) => {
  await page.route('**/api/hosts', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            hosts: [
              {
                id: 'a'.repeat(32),
                name: 'This host',
                local: true,
                connected: true,
              },
              {
                id: 'd'.repeat(32),
                name: 'Isolated host',
                local: false,
                connected: true,
                agentOnly: true,
                aligned: false,
                version: '0.3.5-alpha',
                panelVersion: '0.3.6-alpha',
                agentUpdateSupported: false,
                isolation: 'broker-v1',
              },
            ],
          },
        })
      : route.continue(),
  );
  await login(page, 'fleet', 'Preview');
  await nav(page).getByRole('link', {name: 'Hosts', exact: true}).click();
  const host = page.locator('.host-card').filter({hasText: 'Isolated host'});
  await expect(host).toContainText(
    'An operator must update this host’s broker and management services together.',
  );
  await expect(
    host.getByRole('button', {name: 'Update agent', exact: true}),
  ).toHaveCount(0);
  await expect(
    host.getByRole('button', {name: 'Create server here', exact: true}),
  ).toBeDisabled();
});

function historyFixture(label = 'save', {required = true} = {}) {
  return {
    version: 1,
    scope: 'fixture',
    sources: [{id: 'jobs', label: 'Application operations', available: true}],
    operations: [
      {
        version: 1,
        id: 'jobs:history-fixture',
        source: 'jobs',
        sourceId: 'history-fixture',
        sourceLabel: 'Application operations',
        action: label,
        kind: 'application',
        state: required ? 'interrupted' : 'succeeded',
        phase: required ? 'interrupted' : 'settled',
        actor: 'Operator',
        started: '2026-10-23T12:00:00Z',
        updated: null,
        finished: null,
        message: 'Recorded workflow outcome.',
        recorded: true,
        events: [],
        recovery: {
          required,
          message: 'Review the current outcome.',
          actions: required ? [{id: 'inspect', label: 'Check outcome'}] : [],
        },
      },
    ],
  };
}
test('shared operation history filters workflows and reviews recovery inside the Factorio server scope', async ({
  page,
}, testInfo) => {
  const value = historyFixture();
  const requests = [];
  await page.route('**/api/operations', (route) =>
    route.fulfill({json: value}),
  );
  await page.route('**/api/operations/recovery', (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    const operation = requests.at(-1).body.operation;
    if (operation === 'inspect')
      value.operations[0].recovery.actions.push({
        id: 'acknowledge',
        label: 'Acknowledge review',
      });
    if (operation === 'acknowledge')
      value.operations[0].recovery.required = false;
    return route.fulfill({json: value.operations[0]});
  });
  await factorio(page);
  await nav(page).getByRole('link', {name: 'Operations', exact: true}).click();
  await page
    .getByLabel('Show operations', {exact: true})
    .selectOption('review');
  await page.locator('[data-operation-list] summary').click();
  await page.getByRole('button', {name: 'Check outcome', exact: true}).click();
  await expect(
    page.getByRole('button', {name: 'Acknowledge review', exact: true}),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('operation-history.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', {name: 'Acknowledge review', exact: true})
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.locator('[data-operation-list]')).toContainText(
    'No matching recorded operations',
  );
  expect(requests.map((request) => request.body.operation)).toEqual([
    'inspect',
    'acknowledge',
  ]);
  expect(
    requests.every(
      (request) =>
        request.url === origins.factorio + scope + '/api/operations/recovery',
    ),
  ).toBe(true);
  await page.getByLabel('Show operations', {exact: true}).selectOption('all');
  await expect(page.locator('[data-operation-list] [data-state]')).toHaveText(
    'interrupted',
  );
});
test('shared Rust operation history keeps an unavailable workflow explicit until a successful refresh', async ({
  page,
}) => {
  let unavailable = true;
  await page.route('**/api/operations', (route) =>
    route.fulfill({
      json: unavailable
        ? {
            version: 1,
            operations: [],
            sources: [
              {
                id: 'updates',
                label: 'Image updates',
                available: false,
                message: 'Outcome unavailable.',
              },
            ],
          }
        : historyFixture('backup', {required: false}),
    }),
  );
  await login(page, 'rust');
  await nav(page).getByRole('link', {name: 'Operations', exact: true}).click();
  await expect(page.locator('[data-operation-sources]')).toContainText(
    'Image updates: Outcome unavailable',
  );
  unavailable = false;
  await page
    .getByRole('button', {name: 'Refresh history', exact: true})
    .click();
  await expect(page.locator('[data-operation-list]')).toContainText('backup');
  await expect(page.locator('[data-operation-sources]')).toBeEmpty();
});
test('fleet operation history drops a delayed previous host result and keeps recovery on the selected host', async ({
  page,
}) => {
  const hostId = 'c'.repeat(32);
  let release, started;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    requested = new Promise((resolve) => {
      started = resolve;
    }),
    recoveries = [];
  await page.route('**/api/hosts', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.hosts.push({
      id: hostId,
      name: 'Other fixture host',
      local: false,
      connected: false,
    });
    return route.fulfill({json: value});
  });
  await page.route('**/api/operations', async (route) => {
    started();
    await held;
    return route.fulfill({json: historyFixture('stale-local-result')});
  });
  await page.route('**/api/hosts/' + hostId + '/operations', (route) =>
    route.fulfill({json: historyFixture('remote-backup')}),
  );
  await page.route(
    '**/api/hosts/' + hostId + '/operations/recovery',
    (route) => {
      recoveries.push(route.request().url());
      return route.fulfill({json: {ok: true}});
    },
  );
  await login(page, 'fleet', 'Preview');
  await nav(page).getByRole('link', {name: 'Operations', exact: true}).click();
  await requested;
  await page
    .locator('#operations-view')
    .getByLabel('Host', {exact: true})
    .selectOption('/hosts/' + hostId);
  await expect(page.locator('[data-operation-list]')).toContainText(
    'remote backup',
  );
  release();
  await expect(page.locator('[data-operation-list]')).not.toContainText(
    'stale local result',
  );
  await page.locator('[data-operation-list] summary').click();
  await page.getByRole('button', {name: 'Check outcome', exact: true}).click();
  await expect.poll(() => recoveries.length).toBe(1);
  expect(recoveries[0]).toBe(
    origins.fleet + '/api/hosts/' + hostId + '/operations/recovery',
  );
});

test('a non-game application receives the same operation history from its definition without custom browser code', async ({
  page,
}) => {
  await page.goto(origins.application);
  await page.getByLabel('Username', {exact: true}).fill('Owner');
  await page
    .getByLabel('Password', {exact: true})
    .fill('application-preview-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await nav(page).getByRole('link', {name: 'Operations', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Operation history', exact: true}),
  ).toBeVisible();
  await expect(page.locator('[data-operation-sources]')).toBeEmpty();
  const response = await page.request.get(
    origins.application + '/api/operations',
  );
  expect(response.status()).toBe(200);
  const feed = await response.json();
  expect(feed.version).toBe(1);
  expect(feed.sources).toContainEqual({
    id: 'jobs',
    label: 'Application operations',
    available: true,
  });
  expect(feed.operations.length).toBeGreaterThan(0);
});

test('native update progress and specialized recovery share the global shell without submitting a game operation', async ({
  page,
}) => {
  const native = {
    id: 'updates:independent-worker',
    source: 'updates',
    sourceId: 'independent-worker',
    action: 'game-image-update',
    state: 'running',
    message: 'Verifying the independent replacement',
  };
  const recovery = [];
  let jobs = 0;
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      jobs++;
      return route.fulfill({
        status: 409,
        json: {error: 'No game operation expected.'},
      });
    }
    expect(new URL(route.request().url()).searchParams.get('workflows')).toBe(
      '1',
    );
    return route.fulfill({
      json: {
        jobs: [],
        active: null,
        workflow: {
          operations: [native],
          sources: [{id: 'updates', available: true}],
        },
      },
    });
  });
  await page.route('**/api/operations/recovery', (route) => {
    recovery.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    return route.fulfill({json: native});
  });
  await factorio(page);
  await expect(page.locator('.product-operation')).toContainText(
    native.message,
  );
  await expect(page.locator('[data-action=start]')).toBeDisabled();
  native.state = 'interrupted';
  native.recovery = {
    required: true,
    message: 'Restore the recorded backup explicitly.',
    actions: [
      {id: 'inspect', label: 'Inspect update outcome'},
      {id: 'open', label: 'Open backup recovery', href: '#backups'},
    ],
  };
  await page.reload();
  await expect(page.locator('.product-operation')).toBeHidden();
  await page
    .getByRole('button', {name: 'Inspect update outcome', exact: true})
    .click();
  await expect.poll(() => recovery.length).toBe(1);
  expect(recovery[0].url).toBe(
    origins.factorio + scope + '/api/operations/recovery',
  );
  expect(recovery[0].body).toEqual({
    source: 'updates',
    id: 'independent-worker',
    operation: 'inspect',
    confirm: true,
  });
  await expect(
    page.getByRole('button', {
      name: 'I’ve reviewed this operation',
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole('link', {name: 'Open backup recovery', exact: true})
    .click();
  await expect(page).toHaveURL(origins.factorio + scope + '/#backups');
  expect(jobs).toBe(0);
});

for (const feature of [
  {name: 'view', permission: null, actions: []},
  {
    name: 'generate',
    permission: 'application.factorio.map.generate',
    actions: ['refresh-map'],
  },
  {name: 'pins', permission: 'application.factorio.map.pins', actions: []},
  {
    name: 'tracking',
    permission: 'application.factorio.map.tracking',
    actions: ['live-tracking'],
  },
]) {
  test(
    'Factorio package map access separates ' + feature.name + ' controls',
    async ({page}) => {
      await page.route('**/api/session', (route) =>
        route.fulfill({
          json: {
            username: 'Assigned',
            role: 'member',
            csrf: 'fixture',
            permissions: [
              'server.view',
              'application.factorio.map.view',
              ...(feature.permission ? [feature.permission] : []),
            ],
            allowedActions: feature.actions,
            onboarding: {completed: true},
          },
        }),
      );
      await page.goto(origins.factorio + scope + '/#map');
      await expect(page.locator('#world-map')).toBeVisible();
      await expect(page.locator('#pin-form')).toHaveCount(
        feature.name === 'pins' ? 1 : 0,
      );
      await expect(page.locator('#toggle-live-players')).toHaveCount(
        feature.name === 'tracking' ? 1 : 0,
      );
      await expect(page.locator('[data-action=refresh-map]')).toHaveCount(
        feature.name === 'generate' ? 1 : 0,
      );
      await expect(page.locator('[data-action=start]')).toHaveCount(0);
    },
  );
}

test('world management alone does not expose the Factorio map or fetch its data', async ({
  page,
}) => {
  const requests = [];
  page.on('request', (request) => {
    if (/\/api\/(map|map-status|live-players)(?:$|\?)/.test(request.url()))
      requests.push(request.url());
  });
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        username: 'Assigned',
        role: 'member',
        csrf: 'fixture',
        permissions: ['server.view', 'worlds.manage'],
        allowedActions: ['create', 'switch', 'world-options'],
        onboarding: {completed: true},
      },
    }),
  );
  await page.goto(origins.factorio + scope + '/#map');
  await expect(page).toHaveURL(origins.factorio + scope + '/#overview');
  await expect(
    nav(page).getByRole('link', {name: 'Map', exact: true}),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const username of ['framework', 'plugins', 'configuration']) {
  test(
    'Rust package controls expose only the assigned ' + username + ' tools',
    async ({page}) => {
      await page.route('**/api/status', async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: {...(await response.json()), running: false},
        });
      });
      await page.route('**/api/mods', async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: {
            ...(await response.json()),
            available: true,
            imageCapable: true,
          },
        });
      });
      await page.route('**/api/mod-library?*', (route) =>
        route.fulfill({
          json: {
            game: 'rust',
            source: 'Fixture catalogue',
            scope: 'fixture',
            items: [],
            page: 1,
            pages: 1,
            running: false,
          },
        }),
      );
      await login(page, 'rust', username);
      await nav(page).getByRole('link', {name: 'Mods', exact: true}).click();
      await expect(page.locator('#framework-current')).toContainText('Vanilla');
      await expect(page.locator('#framework button[type=submit]')).toBeEnabled({
        enabled: username === 'framework',
      });
      await expect(page.locator('#plugin-upload button')).toBeEnabled({
        enabled: username === 'plugins',
      });
      await expect(page.locator('#load-plugin-config')).toBeEnabled({
        enabled: username === 'configuration',
      });
      await expect(page.locator('#plugin-config [name=source]')).toBeEnabled({
        enabled: username === 'configuration',
      });
      await expect(page.locator('#mod-library')).toBeVisible({
        visible: username === 'plugins',
      });
      await expect(
        nav(page).getByRole('link', {name: 'Settings', exact: true}),
      ).toHaveCount(0);
      await expect(page.locator('[data-action=start]')).toHaveCount(0);
    },
  );
}

for (const allowed of [false, true]) {
  test(
    'Factorio saved terrain previews require map viewing: ' + allowed,
    async ({page}) => {
      const images = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/preview?')) images.push(request.url());
      });
      await page.route('**/api/session', (route) =>
        route.fulfill({
          json: {
            username: 'Assigned',
            role: 'member',
            csrf: 'fixture',
            permissions: [
              'server.view',
              ...(allowed ? ['application.factorio.map.view'] : []),
            ],
            allowedActions: [],
            onboarding: {completed: true},
          },
        }),
      );
      await page.route('**/api/worlds', async (route) => {
        const response = await route.fetch(),
          value = await response.json();
        value.worlds.forEach((world, index) => {
          world.hasPreview = index === 0;
        });
        await route.fulfill({json: value});
      });
      await page.route('**/api/preview?*', (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=',
            'base64',
          ),
        }),
      );
      await page.goto(origins.factorio + scope + '/#worlds');
      await expect(page.locator('#world-results tbody tr')).not.toHaveCount(0);
      await expect(page.locator('#world-results img')).toHaveCount(
        allowed ? 1 : 0,
      );
      await expect(page.locator('[data-preview]')).toHaveCount(allowed ? 1 : 0);
      if (allowed) {
        await page.locator('[data-preview]').click();
        await expect(page.locator('#preview-dialog')).toBeVisible();
        expect(images.length).toBeGreaterThan(0);
      } else expect(images).toEqual([]);
    },
  );
}
