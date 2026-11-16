import {operationFinished} from './view.js';
import {
  needsOperationAttention,
  operationProgressRoute,
} from './operation-progress.js';

// The tracker coordinates browser state only. It never replays server work.
/**
 * @param {import('./contracts.js').OperationControllerOptions} options
 * @returns {import('./contracts.js').OperationController}
 */
export function createOperationController({
  request,
  shell,
  isAdmin,
  includeWorkflows = false,
  onChange = () => {},
  onSettled = async () => {},
  onRecovery = async () => {},
  notify = () => {},
  pollMs = 1000,
}) {
  /** @type {import('./contracts.js').OperationSnapshot} */
  let snapshot = {jobs: [], active: null, recoveryRequired: false};
  /** @type {{id:string,result?:import('./contracts.js').OperationJob}|null} */
  let watched = null;
  /** @type {{route:`/jobs?progress=1${string}`,pending:Promise<import('./contracts.js').OperationSnapshot>}|null} */
  let reading = null;
  let sending = false,
    generation = 0;
  const emit = () => {
    const version = generation;
    shell.operation(controller.active);
    shell.recovery(
      controller.jobs,
      async (job, operation) => {
        if (version !== generation || !isAdmin()) return;
        if (job.source) {
          if (!job.sourceId)
            throw Error(
              'The workflow identity is unavailable. Reload before reviewing it.',
            );
          await request('/operations/recovery', {
            method: 'POST',
            body: {
              source: job.source,
              id: job.sourceId,
              operation,
              confirm: true,
            },
          });
        } else
          await request('/jobs/recovery', {
            method: 'POST',
            body: {id: job.id, operation, confirm: true},
          });
        await controller.refresh();
        await onRecovery();
      },
      {admin: isAdmin()},
    );
    onChange(controller);
  };
  /** @type {import('./contracts.js').OperationController} */
  const controller = {
    get active() {
      return (
        snapshot.active ||
        snapshot.workflow?.operations.find((job) =>
          ['queued', 'running'].includes(job.state),
        ) ||
        null
      );
    },
    get jobs() {
      return [
        ...snapshot.jobs,
        ...(snapshot.workflow?.operations || []).filter(
          (job) => job.source !== 'jobs',
        ),
      ].filter(needsOperationAttention);
    },
    get recoveryRequired() {
      return (
        !!snapshot.recoveryRequired ||
        snapshot.jobs.some((job) => job.recovery?.required)
      );
    },
    get workflowUnavailable() {
      return !!snapshot.workflow?.sources.some((source) => !source.available);
    },
    get sending() {
      return sending;
    },
    get busy() {
      return sending || !!controller.active || controller.recoveryRequired;
    },
    reset() {
      generation++;
      snapshot = {jobs: [], active: null, recoveryRequired: false};
      watched = null;
      sending = false;
      reading = null;
    },
    async update(value) {
      snapshot = value;
      emit();
      const job = watched
        ? value.jobs.find((item) => item.id === watched?.id)
        : undefined;
      if (watched && operationFinished(job, value.active)) {
        watched.result = job;
        watched = null;
        notify(job.message, job.state !== 'succeeded');
        await onSettled(job);
      }
      return value;
    },
    async refresh() {
      const version = generation;
      const tracking = watched;
      const route = operationProgressRoute(
        includeWorkflows && isAdmin(),
        tracking ? [tracking.id] : [],
      );
      if (reading?.route === route) return reading.pending;
      const entry = {route, pending: request(route)};
      reading = entry;
      let value;
      try {
        value = await entry.pending;
        if (
          reading === entry &&
          version === generation &&
          watched === tracking
        ) {
          reading = null;
          return controller.update(value);
        }
      } finally {
        if (reading === entry) reading = null;
      }
      return value;
    },
    async start(
      action,
      params = {},
      {wait = true, onAccepted = async () => {}} = {},
    ) {
      if (controller.recoveryRequired)
        throw Error(
          'Review interrupted operations before running another operation.',
        );
      if (sending || controller.active)
        throw Error('An operation is already running.');
      const version = generation;
      sending = true;
      emit();
      try {
        const job = await request('/jobs', {
          method: 'POST',
          body: {action, params},
        });
        if (version !== generation) return job;
        /** @type {{id:string,result?:import('./contracts.js').OperationJob}} */
        const tracking = {id: job.id};
        watched = tracking;
        snapshot = {
          ...snapshot,
          jobs: [job, ...snapshot.jobs.filter((item) => item.id !== job.id)],
          active: job,
        };
        notify('Operation started. Follow its progress here.');
        emit();
        await onAccepted(job);
        if (!wait) return job;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          if (version !== generation) return job;
          if (tracking.result) return tracking.result;
          const value = await controller.refresh(),
            completed = value.jobs.find((item) => item.id === job.id);
          if (tracking.result) return tracking.result;
          if (!completed)
            throw Error(
              'The operation is no longer in retained history. Check server status before submitting it again.',
            );
          if (operationFinished(completed, value.active)) return completed;
        }
      } finally {
        if (version === generation) {
          sending = false;
          emit();
        }
      }
    },
  };
  return controller;
}
