import {createEventScope} from '../shared/events.js';
import {escapeHTML as esc} from '../shared/view.js';
import {hostRoute} from './host-paths.js';

function checkedSettings(value) {
  const fields = [
    'memoryBudgetGiB',
    'allocatedMemoryGiB',
    'availableMemoryGiB',
    'minMemoryBudgetGiB',
    'hostHeadroomGiB',
  ];
  if (
    !value ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !fields.every((key) => Number.isFinite(value[key]) && value[key] >= 0) ||
    ![value.maxMemoryBudgetGiB, value.dockerMemoryGiB].every(
      (item) => item === null || (Number.isFinite(item) && item >= 0),
    ) ||
    !Array.isArray(value.allocations) ||
    !value.allocations.every(
      (item) =>
        typeof item.name === 'string' &&
        typeof item.game === 'string' &&
        ['gameGiB', 'controllerGiB', 'totalGiB'].every(
          (key) => Number.isFinite(item[key]) && item[key] >= 0,
        ),
    )
  )
    throw Error(
      'This host returned unsupported memory settings. Reload before editing.',
    );
  return value;
}

export function createHostSettings({request, getSession, error}) {
  const events = createEventScope((problem) =>
    error(problem.message, '#host-error'),
  );
  const $ = (selector) => document.querySelector(selector),
    keyFor = (host) => hostRoute(host, '/host-settings');
  const states = new Map();
  let hosts = [],
    selected = '',
    shown = '',
    generation = 0,
    reading = null,
    active = true;
  const fresh = () => ({
    data: null,
    draft: '',
    draftRevision: 0,
    dirty: false,
    ready: false,
    loading: false,
    saving: false,
    needsReload: false,
    uncertain: false,
    saved: false,
    error: '',
    name: '',
  });
  const stateFor = (key) => {
    if (!states.has(key)) states.set(key, fresh());
    return states.get(key);
  };
  const hostFor = () => hosts.find((host) => keyFor(host) === selected);
  const state = () => stateFor(selected);
  const saving = () => [...states.values()].some((item) => item.saving);
  function invalidateRead() {
    generation++;
    if (reading) {
      reading.abort.abort();
      reading.record.loading = false;
      reading = null;
    }
  }
  function renderHostSettings() {
    if (!active) return;
    const host = hostFor(),
      item = state(),
      data = item.data,
      online = !!host?.connected,
      available = online && item.ready && !!data,
      admin = getSession()?.role === 'admin',
      busy = saving(),
      capacityKnown = available && data.maxMemoryBudgetGiB !== null,
      conflict =
        available && item.dirty && item.draftRevision !== data.revision;
    const picker = $('#host-settings-host');
    picker.innerHTML = hosts
      .map(
        (value) =>
          `<option value="${esc(keyFor(value))}">${esc(value.name)}${value.connected ? '' : ' · unavailable'}</option>`,
      )
      .join('');
    if (selected && !host)
      picker.insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(selected)}">${esc(item.name || 'Selected host')} · unavailable</option>`,
      );
    picker.value = selected;
    picker.disabled = busy || !hosts.length;
    $('#host-title').textContent = host
      ? 'Settings for ' + host.name
      : 'Host settings';
    $('#host-target').textContent = host
      ? (admin
          ? 'Budget changes apply only to '
          : 'Viewing memory settings for ') +
        host.name +
        '.'
      : 'Choose a connected host to review its memory settings.';
    $('#reload-host').disabled = !online || busy || item.loading;
    $('#host-saved').hidden = !item.saved || !available;
    if (item.saved)
      $('#host-saved').textContent =
        'Memory budget saved for ' +
        item.name +
        '. Existing servers stayed running.';
    $('#host-readonly').hidden = admin;
    $('#host-conflict').hidden = !conflict;
    $('#host-uncertain').hidden = !item.needsReload;
    $('#host-uncertain').textContent = item.uncertain
      ? 'The previous save outcome is unknown. Reload current settings and inspect the budget before submitting again.'
      : 'Reload current settings before submitting another change.';
    error(item.error, '#host-error');
    const input = $('#host-budget');
    if (shown !== selected || !item.dirty)
      input.value = item.dirty ? item.draft : (data?.memoryBudgetGiB ?? '');
    shown = selected;
    input.min = available ? data.minMemoryBudgetGiB : 2;
    input.max = available ? (data.maxMemoryBudgetGiB ?? 128) : 128;
    input.disabled =
      !admin ||
      busy ||
      !available ||
      !capacityKnown ||
      data.maxMemoryBudgetGiB < data.minMemoryBudgetGiB;
    $('#save-host-settings').disabled =
      input.disabled || item.loading || conflict || item.needsReload;
    if (!available) {
      $('#host-summary').replaceChildren();
      $('#host-allocation-meter').max = 1;
      $('#host-allocation-meter').value = 0;
      $('#host-allocations').innerHTML =
        '<tr><td colspan="4">Current allocations are unavailable.</td></tr>';
      $('#host-allocated-total').textContent = '—';
      $('#host-budget-help').textContent = online
        ? item.loading
          ? 'Checking this host’s current memory settings…'
          : 'Current memory settings are unavailable. Reload before editing.'
        : 'This host is unavailable. Connect it before reviewing or changing its budget.';
      return;
    }
    $('#host-summary').innerHTML = [
      ['Host budget', data.memoryBudgetGiB + ' GiB'],
      ['Allocated', data.allocatedMemoryGiB + ' GiB'],
      ['Available to allocate', data.availableMemoryGiB + ' GiB'],
      [
        'Docker memory',
        data.dockerMemoryGiB === null
          ? 'Unavailable'
          : data.dockerMemoryGiB.toFixed(1) + ' GiB',
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="card"><strong>${esc(value)}</strong><p>${esc(label)}</p></div>`,
      )
      .join('');
    const meter = $('#host-allocation-meter');
    meter.max = Math.max(1, data.memoryBudgetGiB);
    meter.value = data.allocatedMemoryGiB;
    meter.textContent = `${data.allocatedMemoryGiB} of ${data.memoryBudgetGiB} GiB allocated`;
    $('#host-allocations').innerHTML = data.allocations.length
      ? data.allocations
          .map(
            (row) =>
              `<tr><th scope="row">${esc(row.name)}<small>${esc(row.game.charAt(0).toUpperCase() + row.game.slice(1))}</small></th><td>${esc(row.gameGiB)} GiB</td><td>${esc(row.controllerGiB)} GiB</td><td>${esc(row.totalGiB)} GiB</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="4">No managed servers have memory allocated yet.</td></tr>';
    $('#host-allocated-total').textContent = data.allocatedMemoryGiB + ' GiB';
    $('#host-budget-help').textContent =
      capacityKnown && data.maxMemoryBudgetGiB < data.minMemoryBudgetGiB
        ? 'Docker cannot currently accommodate existing allocations with management headroom. Increase Docker’s memory limit or remove a server before changing the budget.'
        : capacityKnown
          ? `Choose ${data.minMemoryBudgetGiB}–${data.maxMemoryBudgetGiB} GiB. Keep at least ${data.hostHeadroomGiB} GiB of Docker memory outside the budget, plus room for other workloads.`
          : 'Docker memory capacity is unavailable. Budget changes are temporarily unavailable.';
  }
  async function loadHostSettings({resetDraft = false} = {}) {
    const host = hostFor(),
      record = state(),
      target = selected;
    if (!active || !host?.connected || record.saving) {
      renderHostSettings();
      return;
    }
    if (reading) return reading.promise;
    const version = generation,
      call = {record, abort: new AbortController(), promise: null};
    reading = call;
    record.loading = true;
    if (resetDraft) record.ready = false;
    renderHostSettings();
    call.promise = (async () => {
      try {
        const data = checkedSettings(
          await request(target, {
            signal: AbortSignal.any([
              call.abort.signal,
              AbortSignal.timeout(10000),
            ]),
          }),
        );
        if (
          !active ||
          version !== generation ||
          target !== selected ||
          !hostFor()?.connected
        )
          return;
        if (record.data && data.revision < record.data.revision)
          throw Error(
            'This host returned older settings. Reload before editing.',
          );
        record.data = data;
        record.ready = true;
        if (resetDraft || !record.dirty) {
          record.draft = String(data.memoryBudgetGiB);
          record.draftRevision = data.revision;
          record.dirty = false;
          record.needsReload = false;
          record.uncertain = false;
        }
        record.error = record.needsReload ? record.error : '';
      } catch (problem) {
        if (active && version === generation && target === selected) {
          record.ready = false;
          record.error = problem.message;
        }
      } finally {
        if (reading === call) {
          reading = null;
          record.loading = false;
          renderHostSettings();
        }
      }
    })();
    return call.promise;
  }
  function setHosts(value) {
    const before = hostFor()?.connected,
      previous = selected;
    hosts = ['admin', 'viewer'].includes(getSession()?.role) ? value : [];
    if (!selected)
      selected = hosts.find((host) => host.local)?.id
        ? keyFor(hosts.find((host) => host.local))
        : hosts[0]
          ? keyFor(hosts[0])
          : '';
    for (const host of hosts) stateFor(keyFor(host)).name = host.name;
    const changed =
      previous !== selected || !!before !== !!hostFor()?.connected;
    if (changed) {
      invalidateRead();
      state().ready = false;
      state().saved = false;
      if (state().saving) {
        state().dirty = true;
        state().needsReload = true;
        state().uncertain = true;
      }
    }
    renderHostSettings();
    return (
      changed ||
      (!!hostFor()?.connected &&
        !state().ready &&
        !state().loading &&
        !state().saving)
    );
  }
  function bind() {
    active = true;
    shown = '';
    events.clear();
    events.set($('#host-settings-host'), 'change', async () => {
      if (saving()) {
        renderHostSettings();
        return;
      }
      const next = $('#host-settings-host').value;
      if (!hosts.some((host) => keyFor(host) === next) || next === selected)
        return;
      invalidateRead();
      state().ready = false;
      selected = next;
      state().ready = false;
      state().saved = false;
      renderHostSettings();
      await loadHostSettings();
    });
    events.set($('#host-budget'), 'input', () => {
      const record = state();
      record.draft = $('#host-budget').value;
      record.dirty = true;
      record.saved = false;
      $('#host-saved').hidden = true;
    });
    events.set($('#reload-host'), 'click', () =>
      loadHostSettings({resetDraft: true}),
    );
    events.set($('#host-settings-form'), 'submit', async (event) => {
      event.preventDefault();
      const record = state(),
        host = hostFor(),
        target = selected;
      if (
        !active ||
        getSession()?.role !== 'admin' ||
        saving() ||
        !host?.connected ||
        !record.ready ||
        record.loading ||
        record.needsReload ||
        (record.dirty && record.draftRevision !== record.data.revision) ||
        record.data.maxMemoryBudgetGiB === null
      )
        return;
      const raw = $('#host-budget').value,
        budget = Number(raw),
        revision = record.draftRevision;
      if (
        !raw.trim() ||
        !Number.isInteger(budget) ||
        budget < record.data.minMemoryBudgetGiB ||
        budget > record.data.maxMemoryBudgetGiB
      )
        return;
      record.draft = raw;
      record.saving = true;
      record.saved = false;
      record.error = '';
      const version = generation;
      renderHostSettings();
      try {
        const data = checkedSettings(
          await request(target, {
            method: 'POST',
            body: {memoryBudgetGiB: budget, revision},
          }),
        );
        if (
          !active ||
          version !== generation ||
          target !== selected ||
          !hostFor()?.connected
        ) {
          record.dirty = true;
          record.needsReload = true;
          record.uncertain = true;
          return;
        }
        record.data = data;
        record.draft = String(data.memoryBudgetGiB);
        record.draftRevision = data.revision;
        record.dirty = false;
        record.ready = true;
        record.needsReload = false;
        record.uncertain = false;
        record.saved = true;
      } catch (problem) {
        record.dirty = true;
        record.needsReload = true;
        record.uncertain = !problem.status || problem.status >= 500;
        if (active && version === generation && target === selected)
          record.error = problem.message;
      } finally {
        record.saving = false;
        if (active) renderHostSettings();
      }
    });
    renderHostSettings();
  }
  bind();
  return {
    load: loadHostSettings,
    render: renderHostSettings,
    bind,
    setHosts,
    dispose() {
      active = false;
      invalidateRead();
      shown = '';
      for (const record of states.values()) {
        record.ready = false;
        if (record.saving) {
          record.dirty = true;
          record.needsReload = true;
          record.uncertain = true;
        }
      }
      events.clear();
    },
  };
}
