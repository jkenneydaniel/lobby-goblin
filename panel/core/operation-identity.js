import {OperationFailure} from './operation-errors.js';

// Read paths remain permissive so historical records can be inspected/repaired.
// Every normal writer must enforce this before publishing new history.
export function assertJobIdentities(jobs) {
  const ids = new Set();
  if (!Array.isArray(jobs))
    throw new OperationFailure('operation-history-invalid');
  for (const job of jobs) {
    if (
      !job ||
      typeof job.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(job.id)
    )
      throw new OperationFailure('operation-history-invalid');
    if (ids.has(job.id))
      throw new OperationFailure('duplicate-operation-identity');
    ids.add(job.id);
  }
  return jobs;
}
