import {hostRoute} from './hosts.js';
import {sameImageReference} from '../client.js';
import {escapeHTML as esc} from '../shared/view.js';
export function createServerDialog({
  api,
  getHosts,
  getSnapshots,
  hostBusy,
  routeFor,
  error,
  notice,
  selectView,
  onCreated,
  onCatalog,
}) {
  const $ = (selector) => document.querySelector(selector);
  let creationGames = [],
    creationRevision = 0;
  function configureCreation(keepSnapshot = '') {
    const snapshots = getSnapshots();
    const f = $('#create'),
      game = creationGames.find((game) => game.id === f.elements.game.value);
    if (!game) return;
    const policy = game.creation;
    const isGame = !game.kind || game.kind === 'game';
    $('#starting-data-label').textContent = isGame
      ? 'Starting world'
      : 'Starting data';
    f.elements.maxPlayers.closest('label').hidden = !isGame;
    f.elements.maxPlayers.disabled = !isGame;
    f.elements.seed.closest('label').hidden = !isGame;
    if (!policy)
      throw Error('Update this host to provide its game creation options.');
    $('#software-mode-field').hidden = !game.softwareModes?.includes('runtime');
    f.elements.softwareMode.disabled = !game.softwareModes?.includes('runtime');
    f.elements.softwareMode.value = 'image';
    f.elements.cpu.value = game.cpu;
    f.elements.memoryGiB.value = game.memoryGiB;
    f.elements.memoryGiB.min = policy.minMemoryGiB;
    f.elements.memoryGiB.max = policy.maxMemoryGiB;
    f.elements.maxPlayers.value = policy.defaultPlayers;
    f.elements.maxPlayers.max = policy.maxPlayers;
    $('#creation-fields').innerHTML = policy.fields
      .map(
        (field) =>
          `<label>${esc(field.label)}<input name="${esc(field.key)}" type="${field.control === 'range' ? 'range' : 'number'}" min="${esc(field.min)}" max="${esc(field.max)}" step="${esc(field.step)}" value="${esc(field.default)}" required>${field.control === 'range' ? `<output>${esc(field.default)}</output>` : ''}</label>`,
      )
      .join('');
    f.elements.snapshotId.innerHTML =
      `<option value="">${isGame ? 'New world' : 'New application data'}</option>` +
      snapshots
        .filter(
          (snapshot) =>
            snapshot.hostId === f.elements.hostId.value &&
            snapshot.game === game.id &&
            (sameImageReference(snapshot.image, game.image) ||
              (game.runtimeImage &&
                sameImageReference(snapshot.image, game.runtimeImage))) &&
            !snapshot.unavailable,
        )
        .map(
          (snapshot) =>
            `<option value="${snapshot.id}">${esc(snapshot.title)}</option>`,
        )
        .join('');
    f.elements.snapshotId.value = keepSnapshot;
    cloneChanged();
    $('#creation-help').textContent =
      `${game.name} ${game.version}. Ports are allocated automatically. ${policy.help || ''} Memory reservations include a separate controller.`;
  }
  function cloneChanged() {
    const f = $('#create'),
      clone = !!f.elements.snapshotId.value,
      game = creationGames.find((game) => game.id === f.elements.game.value);
    $('#clone-note').hidden = !clone;
    if (clone && game?.runtimeImage) {
      const snapshot = getSnapshots().find(
        (item) => item.id === f.elements.snapshotId.value,
      );
      f.elements.softwareMode.value =
        snapshot && sameImageReference(snapshot.image, game.runtimeImage)
          ? 'runtime'
          : 'image';
    }
    f.elements.softwareMode.disabled =
      clone || !game?.softwareModes?.includes('runtime');
    f.elements.seed.disabled = clone || (!!game?.kind && game.kind !== 'game');
    for (const field of game?.creation?.fields || [])
      f.elements[field.key].disabled = clone && field.lockOnClone === true;
  }
  async function creationHostChanged(snapshotId = '') {
    const hosts = getHosts();
    const revision = ++creationRevision,
      f = $('#create'),
      host = hosts.find((h) => h.id === f.elements.hostId.value);
    $('#create-submit').disabled = true;
    error('', '#creation-error');
    $('#creation-host-help').textContent = 'Checking the selected host…';
    try {
      if (!host?.connected || host.aligned === false)
        throw Error('Connect and update this host before creating a server.');
      const data = await api(hostRoute(host, '/catalog'));
      if (revision !== creationRevision) return;
      creationGames = data.games;
      onCatalog(data.games);
      f.elements.game.innerHTML = creationGames
        .map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`)
        .join('');
      configureCreation(snapshotId);
      $('#creation-host-help').textContent =
        'This application and its data will be created on ' + host.name + '.';
      $('#create-submit').textContent = 'Create on ' + host.name;
      $('#create-submit').disabled = hostBusy(host.id);
    } catch (e) {
      if (revision === creationRevision) {
        error(e.message, '#creation-error');
        $('#creation-host-help').textContent = 'Choose an available host.';
      }
    }
  }
  async function openCreate(snapshot, host) {
    const hosts = getHosts();
    const f = $('#create');
    f.reset();
    f.elements.hostId.innerHTML = hosts
      .map(
        (h) =>
          `<option value="${h.id}" ${h.connected && h.aligned !== false && !hostBusy(h.id) ? '' : 'disabled'}>${esc(h.name)}${!h.connected ? ' · unavailable' : h.aligned === false ? ' · update needed' : ''}</option>`,
      )
      .join('');
    f.elements.hostId.value =
      snapshot?.hostId ||
      host?.id ||
      hosts.find((h) => h.connected && h.aligned !== false && !hostBusy(h.id))
        ?.id ||
      '';
    $('#create-dialog').showModal();
    await creationHostChanged(snapshot?.id || '');
    if (snapshot) {
      f.elements.game.value = snapshot.game;
      configureCreation(snapshot.id);
      f.elements.name.value = snapshot.title + ' copy';
    }
  }
  $('#new-server').onclick = () => openCreate();
  $('#close-create').onclick = () => $('#create-dialog').close();
  $('#create').elements.hostId.onchange = () => creationHostChanged();
  $('#create').elements.game.onchange = () => configureCreation();
  $('#create').elements.snapshotId.onchange = cloneChanged;
  $('#creation-fields').oninput = (e) => {
    if (e.target.nextElementSibling?.tagName === 'OUTPUT')
      e.target.nextElementSibling.value = e.target.value;
  };
  $('#create').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('#create-submit').disabled = true;
    try {
      const body = Object.fromEntries(new FormData(f));
      body.autoStart = f.elements.autoStart.checked;
      await api(routeFor(f.elements.hostId.value, '/servers'), body);
      $('#create-dialog').close();
      notice(
        'Creating your server. Progress appears below; existing servers stay available.',
      );
      selectView('servers');
      await onCreated();
    } catch (e) {
      error(e.message, '#creation-error');
    } finally {
      if ($('#create-dialog').open)
        $('#create-submit').disabled = hostBusy(f.elements.hostId.value);
    }
  };

  return {
    open: openCreate,
    cancel() {
      creationRevision++;
      $('#create-dialog').close();
    },
  };
}
