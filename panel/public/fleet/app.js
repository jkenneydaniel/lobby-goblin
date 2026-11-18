import {navigationAllowed} from '../shared/access.js';
import {createSessionController} from '../shared/session.js';
import {createScreenRouter} from '../shared/screens.js';
import {escapeHTML as esc} from '../shared/view.js';
import {mountProductShell} from '../shell.js';
import {createApi, pollEvery} from '../client.js';
import {createServerDialog} from './creation.js';
import {createFleetModel} from './model.js';
import {createFleetScreens} from './screen-controllers.js';
import {createFleetAuth} from './auth.js';

const $ = (selector) => document.querySelector(selector);
let session = null;
const navigation = [
  {id: 'servers', label: 'Servers', icon: 'server'},
  {id: 'library', label: 'Snapshot library', icon: 'folder', ownerOnly: true},
  {id: 'storage', label: 'Server storage', icon: 'database', adminOnly: true},
  {
    id: 'hosts',
    label: 'Hosts',
    icon: 'device-desktop',
    ownerOnly: true,
    group: 'Administration',
  },
  {
    id: 'host',
    label: 'Host settings',
    icon: 'settings',
    ownerOnly: true,
    group: 'Administration',
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: 'refresh',
    adminOnly: true,
    group: 'Administration',
  },
  {
    id: 'operations',
    label: 'Operations',
    icon: 'clock',
    ownerOnly: true,
    group: 'Administration',
  },
  {
    id: 'access',
    label: 'Accounts',
    icon: 'users',
    group: 'Administration',
    adminOnly: true,
    permission: 'account.self',
  },
];
const shell = mountProductShell({
  area: 'fleet',
  onboarding: true,
  navigation,
  onLogout: () => $('#logout').click(),
});
const request = createApi({
  getSession: () => session,
  onUnauthorized: () => {
    sessionController.set(null);
    auth.showSignIn();
    authenticated();
  },
});
const api = async (route, body) => {
  const user = session;
  const result = await request(
    route,
    body === undefined ? {} : {method: 'POST', body},
  );
  if (session !== user)
    throw new DOMException('This dialog has closed.', 'AbortError');
  return result;
};
const sessionController = createSessionController({
  request,
  onChange(value) {
    const servers = value.servers.length,
      hosts = new Set(value.servers.map((server) => server.hostId)).size;
    $('#server-fleet-count').textContent = value.assigned
      ? `${servers} assigned ${servers === 1 ? 'server' : 'servers'}`
      : `${servers} ${servers === 1 ? 'server' : 'servers'}${hosts ? ` across ${hosts} ${hosts === 1 ? 'host' : 'hosts'}` : ''}`;
    if (!value || session?.username !== value.username) {
      model.reset();
      screenRouter.reset();
      creation.cancel();
    }
    session = value;
    shell.session(value);
  },
});
function error(message, target = '#error') {
  const node = $(target);
  node.textContent = message;
  node.hidden = !message;
  if (target === '#error') shell.notify(message, {error: true, source: target});
}
function notice(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
  shell.notify(message);
}
const model = createFleetModel({
  includeWorkflows: true,
  request,
  getSession: () => session,
  onSettled: (job) =>
    shell.notify(job.message, {error: job.state !== 'succeeded'}),
  onChange(value) {
    $('#new-server').disabled = !value.hosts.some(
      (host) =>
        host.connected && host.aligned !== false && !model.busy(host.id),
    );
    shell.status({
      ready: value.assigned || value.hosts.some((host) => host.connected),
    });
    shell.operation(value.active);
    shell.attention(
      'operations',
      value.workflowUnavailable ? 'Workflow progress unavailable' : '',
    );
    const principal = session;
    shell.recovery(
      value.jobs,
      async (job, operation) => {
        if (session !== principal || session?.role !== 'admin') return;
        if (job.source) {
          if (!job.sourceId)
            throw Error(
              'The workflow identity is unavailable. Reload before reviewing it.',
            );
          await api(model.route(job.hostId, '/operations/recovery'), {
            source: job.source,
            id: job.sourceId,
            operation,
            confirm: true,
          });
        } else
          await api(model.route(job.hostId, '/jobs/recovery'), {
            id: job.id,
            operation,
            confirm: true,
          });
        await refresh();
      },
      {admin: session?.role === 'admin'},
    );
    $('#jobs').innerHTML =
      value.jobs
        .slice()
        .sort((a, b) => String(b.started).localeCompare(String(a.started)))
        .slice(0, 12)
        .map(
          (job) =>
            `<div class="job"><div><strong>${esc(job.hostName)} · ${esc(job.action)}</strong><small>${esc(job.message)}</small></div><span>${esc(job.state)}</span></div>`,
        )
        .join('') ||
      '<p class="hint">Creation and snapshot progress will appear here.</p>';
    void screenRouter.refresh({reason: 'model'});
  },
});
const creation = createServerDialog({
  api,
  getHosts: () => model.snapshot.hosts,
  getSnapshots: () => model.snapshot.snapshots,
  hostBusy: (id) => model.busy(id),
  routeFor: (id, route) => model.route(id, route),
  error,
  notice,
  selectView,
  onCreated(hostId, job) {
    model.trackJob(hostId, job.id);
    return refresh();
  },
  onCatalog: (games) => model.setGames(games),
});
const screenRouter = createScreenRouter({
  factories: createFleetScreens({
    model,
    getSession: () => session,
    sessionController,
    creation,
    error,
    notice,
    onReady: async () => {
      authenticated();
      if (session) await load();
      else auth.showSignIn();
    },
  }),
  root: (id) =>
    document.getElementById(
      {
        servers: 'servers',
        library: 'snapshots',
        storage: 'storage-view',
        access: 'access-view',
        host: 'host-view',
        operations: 'operations-view',
        updates: 'updates-view',
        hosts: 'hosts-view',
        welcome: 'onboarding',
      }[id],
    ),
  request,
  confirm: (...args) => shell.confirm(...args),
  onError: (problem) => error(problem.message),
});
function needsWelcome() {
  return session?.role === 'admin' && session.onboarding?.completed === false;
}
function authenticated() {
  shell.session(session);
  $('#session-loading').hidden = true;
  const signed = !!session;
  $('#auth').hidden = signed;
  $('#dashboard').hidden = !signed || needsWelcome();
  $('#onboarding').hidden = !needsWelcome();
  $('#account').hidden = !signed;
  $('#username').textContent = session?.username || '';
  document
    .querySelectorAll('[data-admin]')
    .forEach((node) => (node.hidden = session?.role !== 'admin'));
}
function selectView(next) {
  next = navigation.some(
    (item) => item.id === next && navigationAllowed(item, session),
  )
    ? next
    : 'servers';
  $('.fleet-servers-heading > div').hidden = next !== 'servers';
  $('.fleet-servers-heading').hidden = [
    'access',
    'operations',
    'updates',
    'storage',
  ].includes(next);
  $('#dashboard > .operations').hidden =
    ['servers', 'access', 'operations', 'updates', 'storage'].includes(next) ||
    session?.role === 'member';
  shell.active(next);
  history.replaceState(null, '', '/#' + next);
  for (const item of navigation) {
    document.getElementById(item.id + '-view').hidden = item.id !== next;
    document
      .getElementById('show-' + item.id)
      .setAttribute('aria-current', item.id === next ? 'page' : 'false');
  }
  return screenRouter.open(next);
}
async function refresh() {
  if (!session || needsWelcome()) return;
  try {
    await model.refresh();
    await screenRouter.refresh({reason: 'poll'});
    if (session) error('');
  } catch (problem) {
    if (session) error(problem.message);
  }
}
async function load() {
  if (needsWelcome()) return screenRouter.open('welcome');
  return selectView(location.hash.slice(1) || 'servers');
}
for (const item of navigation)
  $('#show-' + item.id).onclick = () => selectView(item.id);
addEventListener('hashchange', () => {
  if (session) void selectView(location.hash.slice(1));
});
const auth = createFleetAuth({
  sessionController,
  request,
  error,
  authenticated,
  load,
  onSignedOut() {
    model.reset();
    screenRouter.reset();
    creation.cancel();
  },
});
await auth.bootstrap();
pollEvery(refresh, 5000);
