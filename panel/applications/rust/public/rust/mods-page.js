import {mountModLibrary} from '../mod-library.js';
import {formatBytes as bytes} from '../shared/view.js';

export function createRustMods({
  root = document,
  api,
  job,
  getStatus,
  busy,
  canAction,
  confirm,
  guarded,
  manageAccount = () => true,
}) {
  const $ = (selector) => root.querySelector(selector),
    all = (selector) => [...root.querySelectorAll(selector)];
  const events = new AbortController();
  let library = null;
  let modStatus = null,
    frameworkPlan = null,
    pluginConfig = null;
  function setBusy() {
    const status = getStatus();
    const stopped =
      busy() || !status || status.running || !modStatus?.available;
    const pending = !!modStatus?.pairedPending;
    $('#plugin-upload button').disabled =
      stopped || pending || !canAction('plugin');
    $('#plugin-upload input').disabled = !canAction('plugin');
    $('#plugin-config button[type=submit]').disabled =
      stopped || pending || !canAction('plugin-config');
    $('#plugin-config [name=source]').disabled = !canAction('plugin-config');
    $('#load-plugin-config').disabled = busy() || !canAction('plugin-config');
    $('#plugin-config-name').disabled = !canAction('plugin-config');
    $('#recover-framework').disabled =
      stopped || !canAction('recover-framework');
    $('#framework select').disabled = !canAction('install-framework');
    $('#framework button[type=submit]').disabled =
      busy() ||
      pending ||
      !modStatus?.imageCapable ||
      !canAction('install-framework');
    all('[data-plugin-operation]').forEach(
      (button) =>
        (button.disabled =
          busy() ||
          pending ||
          !canAction('plugin') ||
          !status ||
          (button.dataset.pluginOperation === 'reload'
            ? !status.ready
            : status.running)),
    );
  }
  async function load() {
    modStatus = await api('mods');
    $('#mod-tools').open = modStatus.framework === 'none';
    library?.dispose();
    library = null;
    $('#mod-library').hidden = !canAction('mod-library-install');
    if (canAction('mod-library-install'))
      library = mountModLibrary($('#mod-library'), {
        api: (route, body) => api(route.slice(1), body),
        job,
        busy: () => busy(),
        manageAccount: manageAccount(),
      });
    $('#mods-note').textContent = modStatus.message;
    $('#framework-current').textContent =
      'Current framework: ' +
      ({carbon: 'Carbon', oxide: 'Oxide / uMod', none: 'Vanilla'}[
        modStatus.framework
      ] || modStatus.framework) +
      (modStatus.version ? ' · ' + modStatus.version : '');
    $('#framework [name=framework]').value = modStatus.framework;
    $('#recover-framework').hidden = !modStatus.recoveryRequired;
    const plugins = $('#plugins');
    plugins.replaceChildren();
    for (const plugin of modStatus.plugins) {
      const row = $('#rust-plugin-row').content.cloneNode(true);
      row.querySelector('[data-plugin-name]').textContent = plugin.name;
      row.querySelector('[data-plugin-state]').textContent =
        (plugin.disabled ? 'Disabled' : 'Enabled') + ' · ' + bytes(plugin.size);
      const toggle = row.querySelector('[data-plugin-toggle]');
      toggle.dataset.pluginOperation = plugin.disabled ? 'enable' : 'disable';
      toggle.textContent = plugin.disabled ? 'Enable' : 'Disable';
      for (const button of row.querySelectorAll('[data-plugin-operation]'))
        button.dataset.plugin = plugin.name;
      if (plugin.disabled)
        row.querySelector('[data-plugin-operation=reload]').remove();
      plugins.append(row);
    }
    if (!modStatus.plugins.length)
      plugins.textContent = 'No plugins installed.';
    const configurations = $('#plugin-config-name');
    configurations.replaceChildren(new Option('Choose a configuration', ''));
    for (const file of modStatus.configs)
      configurations.append(new Option(file.name, file.name));
    setBusy();
  }
  $('#refresh-mods').addEventListener('click', () => guarded(load), {
    signal: events.signal,
  });
  $('#framework').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void guarded(async () => {
        frameworkPlan = await api('mods-plan', {
          framework: event.target.elements.framework.value,
        });
        const description =
          frameworkPlan.name +
          ' ' +
          frameworkPlan.version +
          (frameworkPlan.sha256 ? ' · SHA-256 ' + frameworkPlan.sha256 : '') +
          '. ' +
          frameworkPlan.message;
        if (await confirm('Install ' + frameworkPlan.name + '?', description))
          await job('install-framework', {
            planId: frameworkPlan.id,
            confirm: true,
          });
      });
    },
    {signal: events.signal},
  );
  $('#recover-framework').addEventListener(
    'click',
    () =>
      guarded(async () => {
        const review = modStatus.pairedRecovery
          ? await api('framework-change')
          : null;
        if (
          await confirm(
            'Recover framework?',
            review
              ? 'Restore the previous software, settings, plugins and world together. Any newer world data is retained privately. Rust stays stopped.'
              : 'Restore the framework files from the interrupted installation. Rust stays stopped. Worlds and plugin data are preserved.',
          )
        )
          await job('recover-framework', {
            confirm: true,
            ...(review ? {review: review.review} : {}),
          });
      }),
    {signal: events.signal},
  );
  $('#plugin-upload').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void guarded(async () => {
        const file = event.target.elements.plugin.files[0];
        if (!file || file.size > 512 * 1024)
          throw Error('Choose a .cs plugin file of at most 512 KiB.');
        if (
          await confirm(
            'Install ' + file.name + '?',
            'This installs server code. Use a plugin from an author you trust. Existing plugin source is kept in recovery history; configuration and data are preserved.',
          )
        )
          await job('plugin', {
            operation: 'install',
            name: file.name,
            source: await file.text(),
            confirm: true,
          });
      });
    },
    {signal: events.signal},
  );
  $('#plugins').addEventListener(
    'click',
    (event) => {
      const button = event.target.closest('[data-plugin-operation]');
      if (!button) return;
      void guarded(async () => {
        if (
          await confirm(
            button.textContent + ' ' + button.dataset.plugin + '?',
            button.dataset.pluginOperation === 'reload'
              ? 'Reload this plugin on the running server.'
              : 'Change this plugin file. Its configuration and data are kept; changes apply at the next start.',
          )
        )
          await job('plugin', {
            operation: button.dataset.pluginOperation,
            name: button.dataset.plugin,
            confirm: true,
          });
      });
    },
    {signal: events.signal},
  );
  $('#load-plugin-config').addEventListener(
    'click',
    () =>
      guarded(async () => {
        const name = $('#plugin-config-name').value;
        if (!name) throw Error('Choose a configuration first.');
        pluginConfig = await api(
          'plugin-config?name=' + encodeURIComponent(name),
        );
        $('#plugin-config [name=source]').value = pluginConfig.source;
      }),
    {signal: events.signal},
  );
  $('#plugin-config').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void guarded(async () => {
        if (
          !pluginConfig ||
          pluginConfig.name !== event.target.elements.name.value
        )
          throw Error('Load this configuration before saving.');
        await job('plugin-config', {
          name: pluginConfig.name,
          revision: pluginConfig.revision,
          source: event.target.elements.source.value,
        });
      });
    },
    {signal: events.signal},
  );

  return {
    load,
    setBusy,
    dispose() {
      events.abort();
      library?.dispose();
    },
    get current() {
      return modStatus;
    },
  };
}
