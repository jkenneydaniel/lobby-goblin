import {hostRoute, serverKey} from './host-paths.js';

// One shared, session-scoped resource model; no DOM, dialogs or form state.
// Screens decide when to load/render it. A reset cancels every outstanding read.
/** @param {import('./contracts.js').FleetModelOptions} options */
export function createFleetModel({
  request,
  getSession,
  includeWorkflows = false,
  onChange = () => {},
  fetchStatus = async (url, signal) => {
    const response = await fetch(url, {signal, credentials: 'same-origin'});
    return response.ok ? response.json() : null;
  },
}) {
  /** @returns {import('./contracts.js').FleetSnapshot} */
  const empty = () => ({
    hosts: [],
    servers: [],
    snapshots: [],
    jobs: [],
    live: new Map(),
    hostJobs: new Map(),
    active: null,
    games: [],
    assigned: false,
    workflowUnavailable: false,
  });
  let snapshot = empty(),
    generation = 0,
    abort = new AbortController();
  /** @type {Promise<import('./contracts.js').FleetSnapshot>|null} */
  let reading = null;
  /** @param {number} version @param {import('./contracts.js').Session} user */
  const current = (version, user) =>
    generation === version && getSession() === user && !abort.signal.aborted;
  /** @param {number} version @param {import('./contracts.js').Session} user @param {AbortSignal} signal */
  async function load(version, user, signal) {
    /** @param {string} route */
    const api = (route) => request(route, {signal});
    if (user.role === 'member') {
      const result =
        /** @type {{servers:import('./contracts.js').FleetServer[]}} */ (
          await api('/assigned-servers')
        );
      if (!current(version, user)) return snapshot;
      snapshot = {...empty(), servers: result.servers, assigned: true};
      onChange(snapshot);
      return snapshot;
    }
    const {hosts} =
      /** @type {{hosts:import('./contracts.js').FleetHost[]}} */ (
        await api('/hosts')
      );
    /** @type {import('./contracts.js').FleetServer[]} */ const servers = [];
    /** @type {import('./contracts.js').FleetSnapshotRecord[]} */ const snapshots =
      [];
    /** @type {import('./contracts.js').FleetJob[]} */ const jobs = [];
    /** @type {Map<string,import('./contracts.js').OperationJob|undefined>} */ const hostJobs =
      new Map();
    const live = new Map(snapshot.live);
    let workflowUnavailable = false;
    /** @param {import('./contracts.js').FleetHost} host */
    async function requestServers(host) {
      return /** @type {{servers:import('./contracts.js').FleetServer[]}} */ (
        await api(hostRoute(host, '/servers'))
      );
    }
    /** @param {import('./contracts.js').FleetHost} host */
    async function requestSnapshots(host) {
      return /** @type {{snapshots:import('./contracts.js').FleetSnapshotRecord[]}} */ (
        await api(hostRoute(host, '/snapshots'))
      );
    }
    /** @param {import('./contracts.js').FleetHost} host */
    async function requestJobs(host) {
      return /** @type {import('../shared/contracts.js').OperationSnapshot} */ (
        await api(
          hostRoute(
            host,
            includeWorkflows && user.role === 'admin'
              ? '/jobs?workflows=1'
              : '/jobs',
          ),
        )
      );
    }
    await Promise.all(
      hosts.map(async (host) => {
        if (host.connected)
          try {
            const [result, library, operations] = await Promise.all([
              requestServers(host),
              requestSnapshots(host),
              requestJobs(host),
            ]);
            const native =
              operations.workflow?.operations.filter(
                (job) => job.source !== 'jobs',
              ) || [];
            if (
              operations.workflow?.sources.some((source) => !source.available)
            )
              workflowUnavailable = true;
            const allJobs = [...operations.jobs, ...native];
            hostJobs.set(
              host.id,
              operations.active ||
                allJobs.find(
                  (job) =>
                    job.source !== 'host-setup' &&
                    (['queued', 'running'].includes(job.state) ||
                      job.recovery?.required),
                ),
            );
            servers.push(
              ...result.servers
                .filter((server) => server.state !== 'removed')
                .map((server) => ({
                  ...server,
                  hostId: host.id,
                  hostName: host.name,
                  manageUrl: hostRoute(host, '/servers/' + server.id + '/'),
                })),
            );
            snapshots.push(
              ...library.snapshots.map((item) => ({
                ...item,
                hostId: host.id,
                hostName: host.name,
              })),
            );
            jobs.push(
              ...allJobs.map((job) => ({
                ...job,
                hostId: host.id,
                hostName: host.name,
              })),
            );
            return;
          } catch (error) {
            if (signal.aborted) throw error;
            host.connected = false;
            host.error =
              error instanceof Error ? error.message : 'Host unavailable';
          }
        servers.push(
          ...snapshot.servers
            .filter((item) => item.hostId === host.id)
            .map((item) => ({...item, unavailable: true})),
        );
        snapshots.push(
          ...snapshot.snapshots
            .filter((item) => item.hostId === host.id)
            .map((item) => ({...item, unavailable: true})),
        );
      }),
    );
    if (!current(version, user)) return snapshot;
    /** @param {{hostId?:string}} item */
    const order = (item) => hosts.findIndex((host) => host.id === item.hostId);
    servers.sort((a, b) => order(a) - order(b));
    snapshots.sort((a, b) => order(a) - order(b));
    const keys = new Set(servers.map(serverKey));
    for (const key of live.keys()) if (!keys.has(key)) live.delete(key);
    const next = {
      ...snapshot,
      hosts,
      servers,
      snapshots,
      jobs,
      hostJobs,
      workflowUnavailable,
      live,
      active:
        jobs.find(
          (job) =>
            hosts.find((host) => host.local)?.id === job.hostId &&
            ['queued', 'running'].includes(job.state),
        ) ||
        jobs.find((job) => ['queued', 'running'].includes(job.state)) ||
        null,
      assigned: false,
    };
    snapshot = next;
    onChange(snapshot);
    for (let index = 0; index < servers.length; index += 4)
      await Promise.all(
        servers
          .slice(index, index + 4)
          .filter(
            (server) =>
              !server.unavailable &&
              ['installed', 'starting', 'attention'].includes(server.state),
          )
          .map(async (server) => {
            try {
              const value = await fetchStatus(
                server.manageUrl + 'api/status',
                AbortSignal.any([signal, AbortSignal.timeout(10000)]),
              );
              if (!current(version, user)) return;
              if (value) live.set(serverKey(server), value);
              else live.delete(serverKey(server));
            } catch {
              if (current(version, user)) live.delete(serverKey(server));
            }
          }),
      );
    if (current(version, user)) {
      snapshot = {...snapshot, live};
      onChange(snapshot);
    }
    return snapshot;
  }
  return {
    get snapshot() {
      return snapshot;
    },
    /** @param {string} hostId @param {string} route */
    route(hostId, route) {
      const host = snapshot.hosts.find((host) => host.id === hostId);
      if (!host) throw Error('This host is no longer connected.');
      return hostRoute(host, route);
    },
    /** @param {string} hostId */
    busy(hostId) {
      return !!snapshot.hostJobs.get(hostId);
    },
    /** @param {import('./contracts.js').FleetGame[]} games */
    setGames(games) {
      snapshot = {...snapshot, games};
    },
    refresh() {
      if (reading) return reading;
      const user = getSession();
      if (!user) return Promise.resolve(snapshot);
      const version = generation,
        signal = abort.signal;
      const pending = load(version, user, signal);
      reading = pending;
      void pending
        .finally(() => {
          if (reading === pending) reading = null;
        })
        .catch(() => {});
      return pending;
    },
    reset() {
      generation++;
      abort.abort();
      abort = new AbortController();
      reading = null;
      snapshot = empty();
    },
  };
}
