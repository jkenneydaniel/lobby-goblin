import {
  describeOperation,
  writeOperationRecord,
} from '../../core/operation-record.js';
import {needsOperationAttention} from '../../public/shared/operation-progress.js';

export function updateDescriptor(job) {
  const interrupted = !!job.recovery?.interrupted;
  const required =
    (interrupted && !job.recovery?.acknowledged) ||
    !!job.recovery?.requiresWorldRestore;
  return {
    source: 'updates',
    kind: 'update',
    action: job.kind === 'game' ? 'game-image-update' : 'panel-update',
    state: interrupted
      ? 'interrupted'
      : ['preparing', 'running', 'recovering'].includes(job.state)
        ? 'running'
        : job.state,
    phase: job.phase || job.state,
    recovery: {
      required,
      message: job.recovery?.action || job.message,
      actions: required
        ? [
            {id: 'inspect', label: 'Check update outcome'},
            ...(job.recovery?.checkedAt && !job.recovery?.requiresWorldRestore
              ? [{id: 'acknowledge', label: 'Acknowledge update review'}]
              : []),
            {
              id: 'open',
              label: job.recovery?.requiresWorldRestore
                ? 'Open backup recovery'
                : 'Open update recovery',
              href: job.recovery?.requiresWorldRestore
                ? '#backups'
                : '#settings/updates',
            },
          ]
        : [],
    },
  };
}
export const updateOperation = (job) =>
  describeOperation(job, updateDescriptor(job));
export const writeUpdateRecord = (file, job) =>
  writeOperationRecord(file, job, updateDescriptor(job));
export function updateOperationSource(updater) {
  return {
    id: 'updates',
    label: 'Panel and image updates',
    async read() {
      await updater.refresh();
      return updater.jobs.map(updateOperation);
    },
    async readProgress() {
      if (updater.refreshError) throw updater.refreshError;
      return updater.jobs.flatMap((job) => {
        const view = updateDescriptor(job);
        return needsOperationAttention(view) ? [describeOperation(job, view)] : [];
      });
    },
    async recover(input, actor) {
      return updateOperation(await updater.review(input, actor));
    },
  };
}
