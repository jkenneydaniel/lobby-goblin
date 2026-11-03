import {test, expect} from '@playwright/test';
import {origins, scope} from './playwright.config.js';

// Exercise the real workflow and template with explicit awaited refreshes, so
// request scheduling cannot hide replacement of a ready version picker.
test('Factorio software keeps ready controls on unchanged status and defers changed status while focused', async ({page}) => {
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origins.factorio) return route.continue();
    external.push(url.origin); return route.abort();
  });
  await page.route('**/update-workflow-fixture', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body></body></html>'}));
  await page.goto(origins.factorio + scope + '/update-workflow-fixture#settings/updates');
  const result = await page.evaluate(async ({scope}) => {
    const {document, DOMParser} = globalThis;
    const {createUpdateWorkflow} = await import(scope + '/factorio/updates.js');
    const templates = new DOMParser().parseFromString(await (await fetch(scope + '/factorio/updates.html')).text(), 'text/html');
    let catalogueReads = 0, replacements = 0, updateState = {supported: true, jobs: []};
    const state = {currentPage: 'settings', can: () => true, user: {}, status: {software: {mode: 'runtime'}, version: 'Version: 2.1.23'}};
    const catalogue = {stable: '2.1.23', choices: [{kind: 'software', version: '2.1.23', channel: 'stable'}, {kind: 'software', version: '2.0.77', channel: 'archived'}]};
    const releaseView = () => {
      const view = templates.querySelector('#software-updates').content.cloneNode(true).firstElementChild;
      view.querySelector('[data-part=software-version]').textContent = state.status.version;
      return view;
    };
    const workflow = createUpdateWorkflow({getState: () => state, request: async () => structuredClone(updateState), shell: {}, notify() {}, releaseView: () => {replacements++; return releaseView();}});
    const lifetime = new AbortController();
    const ctx = {signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, request: async route => {
      if (route !== '/application-releases') throw Error('Unexpected workflow request');
      catalogueReads++; return catalogue;
    }};
    const picker = () => document.querySelector('input[role=combobox]');
    const snapshot = () => ({catalogueReads, replacements, value: picker()?.value, enabled: picker()?.disabled === false});
    try {
      // Match the production mount order: update data precedes the first bind.
      await workflow.refreshUpdates();
      document.body.replaceChildren(releaseView()); workflow.bindUpdates(ctx);
      await Promise.resolve();
      const original = picker();
      await workflow.refreshUpdates();
      const unchanged = {...snapshot(), sameControl: picker() === original};

      // A genuine status change must still render the current installed release.
      state.status = {...state.status, version: 'Version: 2.0.77'};
      await workflow.refreshUpdates();
      const changed = {...snapshot(), sameControl: picker() === original};

      const focused = picker(); focused.focus();
      state.status = {...state.status, version: 'Version: 2.1.23'};
      await workflow.refreshUpdates();
      const deferred = {...snapshot(), sameControl: picker() === focused};
      focused.blur(); await workflow.refreshUpdates();
      const resumed = {...snapshot(), sameControl: picker() === focused};

      // Changes in update data, rather than status, must also remain visible.
      updateState = {...updateState, busy: true};
      await workflow.refreshUpdates();
      const dataChanged = snapshot();
      return {unchanged, changed, deferred, resumed, dataChanged};
    } finally {
      workflow.detach(); lifetime.abort();
    }
  }, {scope});
  expect(result).toEqual({
    unchanged: {catalogueReads: 1, replacements: 0, value: '2.1.23', enabled: true, sameControl: true},
    changed: {catalogueReads: 2, replacements: 1, value: '2.0.77', enabled: true, sameControl: false},
    deferred: {catalogueReads: 2, replacements: 1, value: '2.0.77', enabled: true, sameControl: true},
    resumed: {catalogueReads: 3, replacements: 2, value: '2.1.23', enabled: true, sameControl: false},
    dataChanged: {catalogueReads: 4, replacements: 3, value: '2.1.23', enabled: true},
  });
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
