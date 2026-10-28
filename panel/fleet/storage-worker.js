// Workers receive only their request directory, one owned instance and the
// snapshot library. Game-owned private files need the same DAC access as the
// instance controller; no ownership changes or additional mounts are needed.
export const storageWorkerCapabilities = ['DAC_OVERRIDE'];
import {HttpError} from '../common.js';
import {OperationFailure, operationDiagnostic, publicOperationDiagnostic} from '../core/operation-errors.js';
import {privateOperationCauses} from '../core/operation-diagnostics.js';

// failure.json is private worker-to-owner transport. Older owners continue to
// read version/error; only the owner may retain private causes after teardown.
export function storageWorkerFailure(error) {
  const diagnostic = operationDiagnostic(error);
  return {version: 1, error: diagnostic.message.slice(0,300), diagnostic,
    privateCauses: privateOperationCauses(error)};
}
export function storageWorkerError(failure, context = {}) {
  const diagnostic = context.oomKilled ? operationDiagnostic(new OperationFailure('storage-worker-out-of-memory')) :
    failure?.version === 1 && failure.diagnostic ? publicOperationDiagnostic(failure.diagnostic) :
      operationDiagnostic(new HttpError(409, storageWorkerMessage(failure,context)));
  const error = OperationFailure.fromDiagnostic(diagnostic);
  let cause;
  if (Array.isArray(failure?.privateCauses)) for (const item of failure.privateCauses.slice(0,4).reverse()) {
    if (typeof item?.message !== 'string' || item.message.length > 2000) continue;
    const next = new Error(item.message, {cause});
    if (typeof item.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(item.code)) next.code = item.code;
    cause = next;
  }
  error.cause = cause;
  return error;
}
export function storageWorkerMessage(failure, {oomKilled = false, exitCode} = {}) {
  if (oomKilled) return 'The isolated storage worker ran out of memory. Server storage was kept.';
  if (failure?.version === 1 && typeof failure.error === 'string' && failure.error.length <= 300 && !/[\x00-\x1f\x7f]/.test(failure.error)) return failure.error;
  return `The isolated storage worker stopped${Number.isInteger(exitCode) ? ' (exit ' + exitCode + ')' : ''} before completing. Server storage was kept. Review host storage and retry.`;
}
