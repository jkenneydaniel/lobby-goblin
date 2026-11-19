import {createHostCapacity, hostCapacityView} from './host-capacity.js';
import {createEventScope} from '../shared/events.js';
import {escapeHTML as esc, formatDate} from '../shared/view.js';
import {icon} from '../icons.js';
const $ = (selector) => document.querySelector(selector);
const staleCpuMs = 30_000;

function timestamp(at, now) {
  if (!Number.isFinite(at) || at <= 0 || at > 8.64e15) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const age =
    seconds < 5
      ? 'just now'
      : seconds < 60
        ? `${seconds}s ago`
        : seconds < 3600
          ? `${Math.floor(seconds / 60)}m ago`
          : seconds < 86400
            ? `${Math.floor(seconds / 3600)}h ago`
            : `${Math.floor(seconds / 86400)}d ago`;
  const date = new Date(at).toISOString();
  return `<time datetime="${date}" title="${esc(formatDate(date))}">${age}</time>`;
}

function connectionView(host, now) {
  const {connected} = host;
  const description = !connected
    ? host.local
      ? 'Manager unavailable'
      : 'Agent unavailable'
    : host.local
      ? 'Local manager'
      : host.connection === 'persistent'
        ? 'Encrypted link'
        : 'Paired host';
  return `<span class="status ${connected ? 'host-connected' : 'host-unavailable'}">${connected ? 'Connected' : 'Unavailable'}</span>
    <small class="host-muted">${description}</small>${!connected ? `<small class="host-muted">Last seen ${timestamp(host.lastSeenAt, now)}</small>` : ''}`;
}

function cpuView(host, now) {
  const sample = host.cpuSample;
  if (
    !host.connected ||
    !Number.isFinite(sample?.percent) ||
    sample.percent < 0 ||
    sample.percent > 100 ||
    !Number.isFinite(sample.sampledAt) ||
    sample.sampledAt <= 0
  )
    return '<span class="host-muted" aria-label="CPU sample unavailable">—</span>';
  const stale = now - sample.sampledAt >= staleCpuMs;
  const percent = Math.round(sample.percent);
  return `<strong>${percent}%</strong>
    <meter class="host-meter ${stale ? 'host-stale' : ''}" min="0" max="100" value="${percent}" aria-hidden="true"></meter>
    <small class="host-muted host-sample-age">${stale ? '<strong class="host-unavailable">Stale</strong>' : '<span class="fleet-visually-hidden">Sampled</span>'} ${timestamp(sample.sampledAt, now)}</small>`;
}

function memoryView(host, record) {
  if (!host.connected) return '<span class="host-muted">Unavailable</span>';
  if (!record || record.state === 'loading')
    return '<span class="host-muted">Checking…</span>';
  if (record.state !== 'ready')
    return '<span class="host-muted">Capacity unavailable. Refresh metrics.</span>';
  const data = record.data;
  const tight =
    data.minimumCreationMemoryGiB !== null &&
    data.availableMemoryGiB < data.minimumCreationMemoryGiB;
  return `<strong>${esc(data.allocatedMemoryGiB)} <span class="host-muted">/ ${esc(data.memoryBudgetGiB)} GiB</span></strong>
    <meter class="host-meter ${tight ? 'host-low-memory' : ''}" min="0" max="${Math.max(1, data.memoryBudgetGiB)}" value="${Math.min(data.allocatedMemoryGiB, data.memoryBudgetGiB)}" aria-hidden="true"></meter>
    <small class="host-muted">${esc(data.availableMemoryGiB)} GiB available</small>`;
}
export {hostRoute, serverKey} from './host-paths.js';
export function mountHosts({
  api,
  readCapacity,
  error,
  notice,
  getSession,
  onChange,
  onCreate,
  hostBusy,
}) {
  const events = createEventScope((problem) =>
    error(problem.message, '#hosts-error'),
  );
  const rendered = new Map();
  let panelVersion = null,
    hosts = [],
    serverCounts = new Map(),
    hostClockOffset = 0,
    loaded = false,
    disposed = false,
    refreshing = false,
    connectionFilter = 'all',
    detailsHost = null,
    expires = null,
    setupPlan = null,
    watchedSetup = null,
    setupResult = null,
    updatePlan = null,
    setupReviewing = false;
  const capacity = createHostCapacity({
    request: readCapacity,
    onChange: render,
  });

  function render() {
    if (disposed) return;
    const admin = getSession()?.role === 'admin';
    const search = $('#host-search').value.trim().toLowerCase();
    const counts = {
      all: hosts.length,
      connected: hosts.filter((host) => host.connected).length,
    };
    counts.unavailable = counts.all - counts.connected;
    $('#host-fleet-count').textContent = counts.all
      ? `${counts.all} ${counts.all === 1 ? 'host' : 'hosts'}`
      : '';
    const options = [
      ['all', 'All', ''],
      ['connected', 'Connected', 'host-connected'],
      ['unavailable', 'Unavailable', 'host-unavailable'],
    ];
    const filters = $('#host-status-filters');
    const filterMarkup = options
      .map(
        ([key, label, tone]) =>
          `<button type="button" aria-pressed="${connectionFilter === key}" data-host-filter="${key}">${tone ? `<span class="status-dot ${tone}" aria-hidden="true"></span>` : ''}${label} <strong>${counts[key]}</strong></button>`,
      )
      .join('');
    replaceInventory(filters, filterMarkup, 'data-host-filter');
    filters.hidden = !loaded;
    const list = $('#hosts-list');
    const matching = hosts.filter(
      (host) =>
        (connectionFilter === 'all' ||
          (connectionFilter === 'connected') === host.connected) &&
        [host.name, host.origin, host.local ? 'Panel host' : 'Game host'].some(
          (value) => value?.toLowerCase().includes(search),
        ),
    );
    replaceInventory(
      list,
      matching
        .map((host) => {
          const id = esc(host.id),
            name = esc(host.name);
          const record = capacity.get(host);
          const issue = creationIssue(host, record);
          const serverCount = serverCounts.get(host.id) || 0;
          const detailsLabel = host.connected
            ? 'Host details'
            : 'Connection details';
          const showSettings =
            host.connected && (issue?.target ?? 'settings') === 'settings';
          return `<tr role="row" data-host-row="${id}">
        <th scope="row" role="rowheader"><div class="host-identity">
          <span class="host-icon">${icon(host.local ? 'device-desktop' : 'server')}</span>
          <div>${showSettings ? `<button type="button" class="host-name" data-host-focus="name" data-host-details="${id}" aria-label="Host details for ${name}">${name}</button>` : `<strong>${name}</strong>`}
            <small>${host.local ? 'Panel host · This machine' : esc(host.origin || 'Game host')}</small>
          </div>
        </div></th>
        <td class="host-connection-cell" role="cell"></td>
        <td class="host-servers-cell" role="cell">${
          host.connected && serverCount
            ? `<a class="button host-server-link" data-host-focus="servers" href="/#servers?host=${id}" aria-label="View ${serverCount} ${serverCount === 1 ? 'server' : 'servers'} on ${name}">${serverCount}<span class="host-mobile-label">${serverCount === 1 ? ' server' : ' servers'}</span>${icon('arrow-up-right')}</a>`
            : host.connected
              ? '<span class="host-muted">0<span class="host-mobile-label"> servers</span></span>'
              : '<span class="host-muted" aria-label="Server inventory unavailable"><span class="host-mobile-label">Servers </span>—</span>'
        }</td>
        <td class="host-cpu-cell" role="cell"><span class="host-mobile-label host-muted" aria-hidden="true">CPU</span><div class="host-cpu-reading"></div></td>
        <td class="host-memory-cell" role="cell"><span class="host-mobile-label host-muted" aria-hidden="true">Memory allocation</span>${memoryView(host, record)}</td>
        <td class="host-actions-cell" role="cell">
          <div class="host-row-actions">
            ${
              showSettings
                ? `<a class="button" data-host-focus="primary" href="/#host?host=${id}" aria-label="Memory settings for ${name}">${icon('settings')}<span>${issue ? 'Memory<span class="host-create-long"> settings</span>' : 'Settings'}</span></a>`
                : `<button type="button" data-host-focus="primary" data-host-details="${id}" aria-label="${detailsLabel} for ${name}">${icon(host.connected ? 'settings' : 'link')}<span>${detailsLabel}</span></button>`
            }
            ${admin ? `<button type="button" class="host-create" data-host-focus="create" data-create-on-host="${id}" aria-label="Create server on ${name}" ${issue ? `disabled aria-describedby="host-create-reason-${id}"` : ''}>${icon('plus')}<span>Create<span class="host-create-long"> server</span></span></button>` : ''}
          </div>
          ${admin && issue ? `<small class="host-create-reason" id="host-create-reason-${id}">${esc(issue.text)}</small>` : ''}
        </td>
      </tr>`;
        })
        .join(''),
      'data-host-row',
    );
    $('#host-table-wrap').hidden = !matching.length;
    const empty = $('#hosts-empty');
    empty.hidden = !!matching.length;
    const message = !loaded
      ? 'Checking hosts…'
      : hosts.length
        ? 'No hosts match your filters.'
        : 'No hosts to show.';
    if (empty.textContent !== message) empty.textContent = message;
    const secure = location.protocol === 'https:';
    $('#pairing-https').hidden = secure;
    $('#create-pairing').disabled = !secure;
    $('#refresh-capacity').disabled = capacity.loading || refreshing;
    paintReadings();
    const details = $('#host-details-dialog');
    if (details.open) {
      const host = hosts.find((item) => item.id === detailsHost);
      if (host)
        details.querySelector('.host-capacity').innerHTML = hostCapacityView(
          host,
          capacity.get(host),
        );
    }
  }

  function paintReadings() {
    const now = Date.now() + hostClockOffset;
    for (const row of $('#hosts-list').rows) {
      const host = hosts.find((item) => item.id === row.dataset.hostRow);
      if (!host) continue;
      row.querySelector('.host-connection-cell').innerHTML = connectionView(
        host,
        now,
      );
      row.querySelector('.host-cpu-reading').innerHTML = cpuView(host, now);
    }
  }
  const ageTimer = setInterval(paintReadings, 5000);

  function replaceInventory(node, html, focusKey) {
    if (rendered.get(node) === html) return;
    const focused = document.activeElement;
    const owner = node.contains(focused) && focused.closest(`[${focusKey}]`);
    const key = owner ? owner.getAttribute(focusKey) : null;
    const action = key ? focused.getAttribute('data-host-focus') : null;
    rendered.set(node, html);
    node.innerHTML = html;
    if (!key) return;
    const replacement = [...node.querySelectorAll(`[${focusKey}]`)].find(
      (item) => item.getAttribute(focusKey) === key,
    );
    const target = action
      ? replacement?.querySelector(`[data-host-focus="${action}"]`)
      : replacement;
    const next =
      target && !target.disabled
        ? target
        : replacement?.querySelector('[data-host-focus="primary"]');
    if (next && !next.disabled) next.focus({preventScroll: true});
    else $('#host-search').focus({preventScroll: true});
  }

  function creationIssue(host, record) {
    if (!host.connected)
      return {
        target: 'details',
        text: 'Restore the host connection to create servers.',
      };
    if (host.agentUpdate?.state === 'attention')
      return {
        target: 'details',
        text: 'Recover the agent update before creating servers.',
      };
    if (host.agentUpdate?.state === 'running')
      return {
        target: 'details',
        text: 'Wait for the agent update to finish.',
      };
    if (host.aligned === false)
      return {
        target: 'details',
        text: 'Update the agent to match the panel.',
      };
    if (hostBusy(host.id))
      return {
        target: 'details',
        text: 'Review the current host operation before creating servers.',
      };
    if (!record?.data) return null;
    const data = record.data,
      minimum = data.minimumCreationMemoryGiB;
    if (minimum === null) return null;
    const requiredBudget = data.allocatedMemoryGiB + minimum;
    if (
      data.maxMemoryBudgetGiB !== null &&
      requiredBudget > data.maxMemoryBudgetGiB
    )
      return {
        target: 'settings',
        text: 'The host memory limit cannot fit another server. Review existing allocations.',
      };
    if (data.availableMemoryGiB < minimum)
      return {
        target: 'settings',
        text: `A server and its controller need at least ${minimum} GiB. Raise the budget to ${requiredBudget} GiB.`,
      };
    return null;
  }

  const searchLabel = $('.host-toolbar .server-search');
  if (!searchLabel.querySelector('.icon'))
    searchLabel.insertAdjacentHTML('afterbegin', icon('search'));
  $('#refresh-capacity').innerHTML =
    icon('refresh') +
    '<span>Refresh<span class="host-refresh-long"> metrics</span></span>';
  events.set($('#host-search'), 'input', render);
  events.set($('#host-status-filters'), 'click', (event) => {
    const button = event.target.closest('[data-host-filter]');
    if (!button) return;
    connectionFilter = button.dataset.hostFilter;
    render();
  });
  events.set($('#refresh-capacity'), 'click', async () => {
    refreshing = true;
    capacity.refresh();
    try {
      await onChange();
    } finally {
      refreshing = false;
      render();
    }
  });
  events.set($('#hosts-list'), 'click', (event) => {
    const button = event.target.closest(
      '[data-create-on-host], [data-host-details]',
    );
    if (!button) return;
    const host = hosts.find(
      (item) =>
        item.id === (button.dataset.createOnHost || button.dataset.hostDetails),
    );
    if (!host) return;
    if (button.hasAttribute('data-host-details')) showDetails(host);
    else if (
      getSession()?.role === 'admin' &&
      !creationIssue(host, capacity.get(host))
    )
      onCreate(host);
  });

  function showDetails(host) {
    detailsHost = host.id;
    const admin = getSession()?.role === 'admin';
    const offline = !host.connected;
    $('#host-details-title').textContent =
      (offline ? 'Connection details for ' : 'Host details for ') + host.name;
    error('', '#host-details-error');
    $('#host-details-content').innerHTML =
      `<div class="host-details-connection">${connectionView(host, Date.now() + hostClockOffset)}</div>
      <p class="host-address">${esc(host.origin || 'Game servers on this machine')}</p>
      ${offline ? `<p>${esc(host.error || 'The panel could not load this host.')}</p><p class="hint">${host.local ? 'Check that the local host manager and Docker are running.' : 'Check that the host is online, the Lobby Goblin agent is running, and the panel can reach its agent address. If pairing access was revoked, pair the host again.'}</p>` : ''}
      ${host.version ? `<p class="hint">Agent ${esc(host.version)}${host.aligned ? ' · Matches panel' : ' · Panel ' + esc(host.panelVersion)}</p>` : ''}
      ${host.agentUpdate ? `<p class="hint">${esc(host.agentUpdate.message)}</p>` : ''}
      ${host.agentUpdateSupported === false && host.aligned === false ? (host.managementUpdateSupported ? '<p class="hint"><a href="/#updates">Review coordinated management updates</a> and choose this host.</p>' : '<p class="hint">An operator must update this host’s broker and management services together.</p>') : ''}
      ${hostBusy(host.id) ? '<p class="hint"><a href="/#operations">Review host operations</a>.</p>' : ''}
      <div class="host-capacity" aria-label="Configured memory capacity">${hostCapacityView(host, capacity.get(host))}</div>
      ${
        admin && !host.local
          ? `<div class="actions">
        ${host.connected && host.aligned === false && host.agentOnly && host.agentUpdateSupported !== false ? '<button type="button" data-host-admin="update">Update agent</button>' : ''}
        ${host.connected && host.agentUpdateSupported !== false && host.agentUpdate?.state === 'attention' ? '<button type="button" data-host-admin="recover">Recover agent update</button>' : ''}
        <button type="button" class="quiet" data-host-admin="disconnect">Disconnect</button>
      </div>`
          : ''
      }`;
    $('#host-details-dialog').showModal();
  }

  events.set($('#host-details-dialog'), 'close', () => {
    if (document.querySelector('dialog[open]')) return;
    [...$('#hosts-list').rows]
      .find((row) => row.dataset.hostRow === detailsHost)
      ?.querySelector('[data-host-details]')
      ?.focus({preventScroll: true});
  });
  events.set($('#host-details-content'), 'click', async (event) => {
    const button = event.target.closest('[data-host-admin]');
    if (!button || getSession()?.role !== 'admin') return;
    const host = hosts.find((item) => item.id === detailsHost);
    if (!host || host.local) return;
    const dialog = $('#host-details-dialog');
    const action = button.dataset.hostAdmin;
    if (action === 'disconnect') {
      const form = $('#disconnect-host-form');
      form.reset();
      form.elements.hostId.value = host.id;
      $('#disconnect-host-help').textContent =
        'Disconnect “' + host.name + '” from this panel?';
      error('', '#disconnect-host-error');
      dialog.close();
      $('#disconnect-host-dialog').showModal();
      return;
    }
    button.disabled = true;
    try {
      if (action === 'update') {
        const plan = await api('/hosts/' + host.id + '/agent-update-plan', {});
        if (!button.isConnected || !dialog.open || detailsHost !== host.id)
          return;
        updatePlan = {...plan, hostId: host.id};
        $('#agent-update-summary').textContent =
          host.name + ': ' + plan.current + ' → ' + plan.version + '.';
      } else {
        updatePlan = {hostId: host.id, recover: true};
        $('#agent-update-summary').textContent =
          'Restore the previous management containers from this host’s interrupted update.';
      }
      $('#agent-update-form').reset();
      error('', '#agent-update-error');
      dialog.close();
      $('#agent-update-dialog').showModal();
    } catch (problem) {
      if (button.isConnected && dialog.open && detailsHost === host.id)
        error(problem.message, '#host-details-error');
    } finally {
      button.disabled = false;
    }
  });
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
      const accepted = await api('/host-setup', {
        planId: setupPlan.id,
        confirm: event.currentTarget.elements.confirm.checked,
        auth,
      });
      watchedSetup = accepted.id;
      setupResult = null;
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
      const watched = watchedSetup;
      const query = new URLSearchParams({progress: '1'});
      if (watched) query.set('job', watched);
      const value = await api('/host-setup?' + query);
      if (watched !== watchedSetup) return;
      const finished = value.jobs.find(
        (job) => job.id === watched && value.active?.id !== watched,
      );
      if (finished?.state === 'succeeded') setupResult = finished;
      watchedSetup = value.active?.id || null;
      const jobs = value.jobs.filter(
        (job) =>
          ['queued', 'running'].includes(job.state) ||
          (['interrupted', 'failed'].includes(job.state) &&
            !job.recoveryReview?.acknowledged),
      );
      if (setupResult && !jobs.some((job) => job.id === setupResult.id))
        jobs.push(setupResult);
      $('#host-setup-progress').innerHTML = jobs
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
    pairing,
    progress,
    setInventory(value) {
      hosts = value.hosts;
      hostClockOffset = value.hostClockOffset;
      serverCounts = new Map();
      for (const server of value.servers)
        serverCounts.set(
          server.hostId,
          (serverCounts.get(server.hostId) || 0) + 1,
        );
      loaded = true;
      capacity.sync(
        ['admin', 'viewer'].includes(getSession()?.role) ? hosts : [],
      );
    },
    dispose() {
      disposed = true;
      clearInterval(ageTimer);
      capacity.dispose();
      events.clear();
      for (const id of [
        'add-host-dialog',
        'host-setup-review',
        'agent-update-dialog',
        'disconnect-host-dialog',
        'host-details-dialog',
      ])
        $('#' + id)?.close();
      rendered.clear();
      $('#hosts-list').replaceChildren();
      $('#host-search').value = '';
      $('#host-table-wrap').hidden = true;
      $('#host-status-filters').hidden = true;
      $('#host-fleet-count').textContent = '';
      $('#hosts-empty').textContent = 'Checking hosts…';
      $('#hosts-empty').hidden = false;
      setupPlan = null;
      updatePlan = null;
    },
  };
}
