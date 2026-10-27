// Workers receive only their request directory, one owned instance and the
// snapshot library. Game-owned private files need the same DAC access as the
// instance controller; no ownership changes or additional mounts are needed.
export const storageWorkerCapabilities = ['DAC_OVERRIDE'];
const failures = {
  EACCES: 'Storage access was denied. Check permissions on this server’s backup and snapshot library.',
  EPERM: 'Storage access was denied. Check permissions on this server’s backup and snapshot library.',
  ENOSPC: 'Storage is full. Free space for the snapshot before retrying.',
  EDQUOT: 'The storage quota was reached. Free space for the snapshot before retrying.',
  EROFS: 'Required snapshot storage is read-only. Check the host storage configuration.',
  ENOENT: 'A required backup or snapshot file is missing. Create a fresh backup before retrying.',
};
export function storageWorkerFailure(error) {
  return {version: 1, error: failures[error?.code] ||
    (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error.message === 'string'
      ? error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)
      : 'The isolated storage operation failed. Review the backup and host storage before retrying.')};
}
export function storageWorkerMessage(failure, {oomKilled = false, exitCode} = {}) {
  if (oomKilled) return 'The snapshot worker ran out of memory. The requested removal was not completed; server storage was kept.';
  if (failure?.version === 1 && typeof failure.error === 'string' && failure.error.length <= 300 && !/[\x00-\x1f\x7f]/.test(failure.error)) return failure.error;
  return `The isolated storage worker stopped${Number.isInteger(exitCode) ? ' (exit ' + exitCode + ')' : ''} before completing. Server storage was kept. Review host storage and retry.`;
}
