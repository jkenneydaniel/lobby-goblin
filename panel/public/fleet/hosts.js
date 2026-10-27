import {createEventScope} from '../shared/events.js';
const $ = (selector) => document.querySelector(selector),
  esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          c
        ],
    );
export {hostRoute, serverKey} from './host-paths.js';
export function mountHosts({
  api,
  error,
  notice,
  getSession,
  onChange,
  onCreate,
}) {
  const events = createEventScope((problem) => error(problem.message)),
    rows = createEventScope((problem) => error(problem.message));
  let panelVersion = null,
    hosts = [],
    expires = null,
    setupPlan = null,
    updatePlan = null,
    setupReviewing = false;
  function render() {
    rows.clear();
    const admin = getSession()?.role === 'admin';
    $('#hosts-list').innerHTML = hosts
      .map(
        (host) =>
          `<article class="card host-card"><span class="game">${host.local ? 'PANEL HOST' : 'GAME HOST'}</span><h3>${esc(host.name)}</h3><span class="status ${host.connected ? '' : 'attention'}">${host.connected ? 'Connected' : 'Unavailable'}</span><p class="host-address">${esc(host.origin || 'Game servers on this machine')}</p>${host.connection === 'persistent' ? '<p class="hint">Persistent encrypted connection</p>' : ''}${host.version ? `<p class="hint">Agent ${esc(host.version)}${host.aligned ? ' · Matches panel' : ' · Panel ' + esc(host.panelVersion)}</p>` : ''}${host.agentUpdateSupported === false && host.aligned === false ? '<p class="hint">An operator must update this host’s broker and management services together.</p>' : ''}${host.agentUpdate ? `<p class="hint">${esc(host.agentUpdate.message)}</p>` : ''}${host.error ? `<p class="hint">${esc(host.error)}</p>` : ''}<div class="actions">${admin ? `<button data-create-on-host="${host.id}" ${host.connected && host.aligned !== false && host.agentUpdate?.state !== 'running' ? '' : 'disabled'}>Create server here</button>${host.local ? '' : `${host.connected && host.aligned === false && host.agentOnly && host.agentUpdateSupported !== false ? `<button data-update-agent="${host.id}">Update agent</button>` : ''}${host.connected && host.agentUpdateSupported !== false && host.agentUpdate?.state === 'attention' ? `<button data-recover-agent="${host.id}">Recover agent update</button>` : ''}<button class="quiet" data-disconnect-host="${host.id}">Disconnect</button>`}` : ''}</div></article>`,
      )
      .join('');
    document
      .querySelectorAll('[data-create-on-host]')
      .forEach((button) =>
        rows.set(button, 'click', () =>
          onCreate(hosts.find((h) => h.id === button.dataset.createOnHost)),
        ),
      );
    document.querySelectorAll('[data-disconnect-host]').forEach((button) =>
      rows.set(button, 'click', () => {
        const host = hosts.find((h) => h.id === button.dataset.disconnectHost),
          form = $('#disconnect-host-form');
        form.reset();
        form.elements.hostId.value = host.id;
        $('#disconnect-host-help').textContent =
          'Disconnect “' + host.name + '” from this panel?';
        error('', '#disconnect-host-error');
        $('#disconnect-host-dialog').showModal();
      }),
    );
    document.querySelectorAll('[data-update-agent]').forEach((button) =>
      rows.set(button, 'click', async () => {
        button.disabled = true;
        try {
          const host = hosts.find((h) => h.id === button.dataset.updateAgent),
            plan = await api('/hosts/' + host.id + '/agent-update-plan', {});
          updatePlan = {...plan, hostId: host.id};
          $('#agent-update-form').reset();
          $('#agent-update-summary').textContent =
            host.name + ': ' + plan.current + ' → ' + plan.version + '.';
          error('', '#agent-update-error');
          $('#agent-update-dialog').showModal();
        } catch (e) {
          error(e.message, '#hosts-error');
        } finally {
          button.disabled = false;
        }
      }),
    );
    document.querySelectorAll('[data-recover-agent]').forEach((button) =>
      rows.set(button, 'click', () => {
        updatePlan = {hostId: button.dataset.recoverAgent, recover: true};
        $('#agent-update-form').reset();
        $('#agent-update-summary').textContent =
          'Restore the previous management containers from this host’s interrupted update.';
        $('#agent-update-dialog').showModal();
      }),
    );
    const secure = location.protocol === 'https:';
    $('#pairing-https').hidden = secure;
    $('#create-pairing').disabled = !secure;
  }
  async function refresh() {
    const [result, status] = await Promise.all([api('/hosts'), api('/status')]);
    panelVersion = status.version;
    hosts = result.hosts;
    installCommand();
    render();
    return hosts;
  }
  function installCommand() {
    const version = String(panelVersion || '');
    const valid = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version);
    const url =
      'https://raw.githubusercontent.com/jkenneydaniel/lobby-goblin/main/Install.sh';
    const download =
      $('#manual-download-tool').value === 'wget'
        ? `wget -qO- ${url}`
        : `curl -fsSL ${url}`;
    $('#manual-host-command').value = valid
      ? `${download} | bash -s -- --version ${version} --host-agent${$('#manual-install-docker').checked ? ' --install-docker' : ''} --start --host host.example.com --agent-port 24443 --address host.example.com --memory 16`
      : 'Cannot read this panel’s release. Reload before copying an install command.';
    $('#copy-host-command').disabled = !valid;
  }
  async function pairing() {
    if (getSession()?.role !== 'admin') return;
    try {
      const result = await api('/host-pairing');
      expires = result.expires;
      $('#cancel-pairing').hidden = !expires;
      if (!expires) {
        $('#pairing-result').hidden = true;
        $('#pairing-code').value = '';
      }
      $('#paired-panels').innerHTML =
        '<h3>Panels allowed to manage this host</h3>' +
        (result.panels.length
          ? result.panels
              .map(
                (peer) =>
                  `<div class="job"><div><strong>${esc(peer.name)}</strong><small>Paired ${esc(new Date(peer.created).toLocaleDateString())}</small></div><button data-revoke-panel="${peer.id}" class="quiet">Revoke access</button></div>`,
              )
              .join('')
          : '<p class="hint">No other panels have access to this host.</p>');
      document.querySelectorAll('[data-revoke-panel]').forEach((button) =>
        events.set(button, 'click', async () => {
          button.disabled = true;
          try {
            await api('/host-pairing', {
              operation: 'revoke',
              id: button.dataset.revokePanel,
            });
            notice(
              'Panel access revoked. Games and worlds were left unchanged.',
            );
            await pairing();
          } catch (e) {
            error(e.message, '#hosts-error');
          } finally {
            button.disabled = false;
          }
        }),
      );
    } catch (e) {
      error(e.message, '#hosts-error');
    }
  }
  function method(ssh) {
    $('#host-setup-form').hidden = !ssh;
    $('#add-host-form').hidden = ssh;
    $('#choose-ssh').setAttribute('aria-pressed', String(ssh));
    $('#choose-manual').setAttribute('aria-pressed', String(!ssh));
  }
  events.set($('#choose-ssh'), 'click', () => method(true));
  events.set($('#choose-manual'), 'click', () => method(false));
  events.set($('#add-host'), 'click', () => {
    $('#add-host-form').reset();
    $('#host-setup-form').reset();
    $('#ssh-key-fields').hidden = true;
    $('#ssh-password-field').hidden = false;
    setupPlan = null;
    method(true);
    installCommand();
    error('', '#add-host-error');
    error('', '#host-setup-error');
    $('#add-host-dialog').showModal();
  });
  $('#add-host-dialog').addEventListener('close', () => {
    $('#host-setup-form').elements.password.value = '';
    $('#host-setup-form').elements.privateKey.value = '';
    $('#host-setup-form').elements.passphrase.value = '';
    $('#ssh-key-file').value = '';
    $('#add-host-form').elements.code.value = '';
  });
  events.set($('#close-add-host'), 'click', () => {
    $('#host-setup-form').reset();
    $('#add-host-form').reset();
    $('#add-host-dialog').close();
  });
  events.set($('#cancel-add-host'), 'click', () => {
    $('#add-host-form').reset();
    $('#add-host-dialog').close();
  });
  events.set($('#add-host-form'), 'submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = $('#pair-host-submit');
    button.disabled = true;
    error('', '#add-host-error');
    try {
      await api('/hosts', {
        ...Object.fromEntries(new FormData(form)),
        confirm: form.elements.confirm.checked,
      });
      form.reset();
      $('#add-host-dialog').close();
      notice(
        'Host paired. Choose it when creating a server. Existing games were left unchanged.',
      );
      await onChange();
    } catch (e) {
      error(e.message, '#add-host-error');
    } finally {
      button.disabled = false;
    }
  });
  events.set($('#cancel-disconnect-host'), 'click', () =>
    $('#disconnect-host-dialog').close(),
  );
  events.set($('#disconnect-host-form'), 'submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector('button.danger');
    button.disabled = true;
    try {
      const result = await api(
        '/hosts/' + form.elements.hostId.value + '/disconnect',
        {name: form.elements.name.value, confirm: true},
      );
      $('#disconnect-host-dialog').close();
      notice(result.message);
      await onChange();
    } catch (e) {
      error(e.message, '#disconnect-host-error');
    } finally {
      button.disabled = false;
    }
  });
  events.set($('#create-pairing'), 'click', async () => {
    const button = $('#create-pairing');
    button.disabled = true;
    error('', '#hosts-error');
    try {
      const result = await api('/host-pairing', {operation: 'create'});
      expires = result.expires;
      $('#pairing-code').value = result.code;
      $('#pairing-expiry').textContent =
        'Expires ' +
        new Date(expires).toLocaleTimeString() +
        '. This code can be used once. Keep it private.';
      $('#pairing-result').hidden = false;
      $('#cancel-pairing').hidden = false;
    } catch (e) {
      error(e.message, '#hosts-error');
    } finally {
      button.disabled = false;
    }
  });
  events.set($('#cancel-pairing'), 'click', async () => {
    try {
      await api('/host-pairing', {operation: 'cancel'});
      await pairing();
    } catch (e) {
      error(e.message, '#hosts-error');
    }
  });
  const setupForm = $('#host-setup-form');
  events.set(setupForm.elements.authMethod, 'change', () => {
    const key = setupForm.elements.authMethod.value === 'key';
    $('#ssh-key-fields').hidden = !key;
    $('#ssh-password-field').hidden = key;
  });
  events.set(
    setupForm.elements.username,
    'change',
    () =>
      (setupForm.elements.useSudo.checked =
        setupForm.elements.username.value !== 'root'),
  );
  events.set($('#ssh-key-file'), 'change', async (event) => {
    const file = event.target.files[0];
    if (file && file.size <= 65536)
      setupForm.elements.privateKey.value = await file.text();
    else if (file)
      error('Choose a private key smaller than 64 KiB.', '#host-setup-error');
  });
  events.set($('#manual-download-tool'), 'change', installCommand);
  events.set($('#manual-install-docker'), 'change', installCommand);
  events.set($('#copy-host-command'), 'click', async () => {
    try {
      await navigator.clipboard.writeText($('#manual-host-command').value);
      $('#copy-host-command').textContent = 'Copied';
    } catch {
      $('#manual-host-command').select();
    }
  });
  events.set(setupForm, 'submit', async (event) => {
    event.preventDefault();
    if (setupReviewing) return;
    setupReviewing = true;
    $('#review-host-setup').disabled = true;
    error('', '#host-setup-error');
    try {
      const values = Object.fromEntries(new FormData(setupForm)),
        key = values.authMethod === 'key';
      if (!(key ? values.privateKey : values.password))
        throw Error(
          'Enter your SSH ' + (key ? 'private key' : 'password') + '.',
        );
      const {name, host, port, username, domain, address, memory, agentPort} =
        values;
      setupPlan = await api('/host-setup-plan', {
        name,
        host,
        port,
        username,
        domain,
        address,
        memory,
        agentPort,
        useSudo: setupForm.elements.useSudo.checked,
        installDocker: setupForm.elements.installDocker.checked,
      });
      $('#confirm-host-setup').reset();
      $('#host-setup-summary').innerHTML = [
        ['Host', setupPlan.name],
        [
          'SSH',
          setupPlan.username + '@' + setupPlan.host + ':' + setupPlan.port,
        ],
        ['SSH fingerprint', setupPlan.fingerprint],
        ['Agent address', setupPlan.options.origin],
        ['Game memory budget', setupPlan.options.memory + ' GiB'],
        [
          'Docker',
          setupPlan.installDocker
            ? 'Install only if missing'
            : 'Use existing Docker',
        ],
        ['Installation', setupPlan.directory],
      ]
        .map(
          ([label, value]) =>
            `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
        )
        .join('');
      error('', '#host-setup-confirm-error');
      $('#host-setup-review').showModal();
    } catch (e) {
      error(e.message, '#host-setup-error');
    } finally {
      setupReviewing = false;
      $('#review-host-setup').disabled = false;
    }
  });
  events.set($('#cancel-host-setup-review'), 'click', () =>
    $('#host-setup-review').close(),
  );
  events.set($('#confirm-host-setup'), 'submit', async (event) => {
    event.preventDefault();
    const button = $('#install-connect-host');
    button.disabled = true;
    try {
      const f = setupForm,
        key = f.elements.authMethod.value === 'key',
        auth = key
          ? {
              privateKey: f.elements.privateKey.value,
              passphrase: f.elements.passphrase.value,
            }
          : {password: f.elements.password.value};
      await api('/host-setup', {
        planId: setupPlan.id,
        confirm: event.currentTarget.elements.confirm.checked,
        auth,
      });
      f.reset();
      $('#ssh-key-file').value = '';
      $('#host-setup-review').close();
      $('#add-host-dialog').close();
      notice('Setting up your game host. Progress appears under Hosts.');
      await progress();
    } catch (e) {
      error(e.message, '#host-setup-confirm-error');
    } finally {
      button.disabled = false;
    }
  });
  async function progress() {
    if (getSession()?.role !== 'admin') return;
    try {
      const value = await api('/host-setup');
      $('#host-setup-progress').innerHTML = value.jobs
        .slice(0, 5)
        .map(
          (job) =>
            `<div class="job"><div><strong>${esc(job.name)} · ${esc(job.state)}</strong><small>${esc(job.message)}</small>${['failed', 'interrupted'].includes(job.state) ? `<small>Installation retained at ${esc(job.directory)} on ${esc(job.host)}. Inspect it or use manual pairing if the agent is already installed.</small>` : ''}</div></div>`,
        )
        .join('');
    } catch (e) {
      error(e.message, '#hosts-error');
    }
  }
  events.set($('#cancel-agent-update'), 'click', () =>
    $('#agent-update-dialog').close(),
  );
  events.set($('#agent-update-form'), 'submit', async (event) => {
    event.preventDefault();
    const button = $('#apply-agent-update');
    button.disabled = true;
    try {
      await api('/hosts/' + updatePlan.hostId + '/agent-update', {
        planId: updatePlan.id,
        recover: updatePlan.recover === true,
        confirm: event.currentTarget.elements.confirm.checked,
      });
      $('#agent-update-dialog').close();
      notice(
        'Agent management services are updating. The host will reconnect shortly; games stay in place.',
      );
      await onChange();
    } catch (e) {
      error(e.message, '#agent-update-error');
    } finally {
      button.disabled = false;
    }
  });
  void api('/status')
    .then((status) => {
      panelVersion = status.version;
      installCommand();
    })
    .catch(() => {
      panelVersion = null;
      installCommand();
    });
  return {
    refresh,
    pairing,
    render,
    progress,
    setHosts(value) {
      hosts = value;
      render();
    },
    dispose() {
      events.clear();
      rows.clear();
      for (const id of [
        'add-host-dialog',
        'host-setup-review',
        'agent-update-dialog',
        'disconnect-host-dialog',
      ])
        $('#' + id)?.close();
      setupPlan = null;
      updatePlan = null;
    },
  };
}
