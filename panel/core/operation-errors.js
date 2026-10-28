import {HttpError, redact} from '../common.js';
import {DockerTransportError} from './docker-transport-error.js';

// Public diagnostics are selected from code, never from Docker output, saved
// container configuration, exception text or worker logs.
const reasons = Object.freeze({
  'docker-request-failed': [
    'Docker could not complete the requested operation.',
    'Use the operation reference to inspect its private diagnostic before retrying or recovering.',
  ],
  'storage-worker-out-of-memory': [
    'The isolated storage worker ran out of memory. Server storage was kept.',
    'Review available host memory before retrying this operation.',
  ],
  'operation-history-invalid': [
    'Operation history has an invalid identity.',
    'Preserve the history and inspect its recorded IDs before retrying.',
  ],
  'operation-rejected': [
    'The operation could not proceed.',
    'Resolve the recorded reason before retrying this operation.',
  ],
  'operation-failed': [
    'The operation could not complete.',
    'Use the operation reference to inspect its private diagnostic and review its outcome before retrying.',
  ],
  'image-migration-failed': [
    'The image migration could not complete.',
    'Use the operation reference to inspect the retained diagnostic and migration journal. Existing backups and storage were preserved.',
  ],
  'storage-full': [
    'Storage is full or its quota was reached.',
    'Free space in the affected storage before retrying.',
  ],
  'storage-access-denied': [
    'Storage access was denied.',
    'Check ownership and permissions on the affected storage before retrying.',
  ],
  'storage-read-only': [
    'Required storage is read-only.',
    'Review the host storage configuration before retrying.',
  ],
  'storage-file-missing': [
    'A required file is missing.',
    'Inspect the recorded operation and its retained files before retrying.',
  ],
  'duplicate-operation-identity': [
    'Workflow history contains duplicate operation IDs.',
    'Inspect the affected operation history. Use the documented repair for legacy migration attempts; other collisions need operator review.',
  ],
  'workflow-history-unavailable': [
    'A workflow history could not be read.',
    'Open the affected host or server operation history and resolve its recorded problem before updating.',
  ],
  'workflow-not-idle': [
    'An operation is active or still needs review.',
    'Wait for active work or review interrupted operations before updating.',
  ],
  'docker-socket-unverified': [
    'The management Docker socket could not be verified.',
    'Use the original local Docker Desktop connection and check that the controller reaches the same engine. Custom socket mounts require operator review.',
  ],
  'management-mounts-changed': [
    'The management service mounts changed after review.',
    'Cancel this review and review the current management configuration before updating. Retain existing recovery records.',
  ],
  'management-service-custom': [
    'A management service has custom mounts, privileges or is unavailable.',
    'Restore the supported management configuration before updating. Game servers do not need to be recreated.',
  ],
  'management-inspection-failed': [
    'A management inspection or publication failed.',
    'Open Updates to review the saved result and available recovery actions. If the panel is unavailable, use the host recovery guide.',
  ],
  'docker-unavailable': [
    'The local Docker connection is unavailable.',
    'Check Docker Desktop or the local Docker service and retry using the same engine.',
  ],
  'management-update-failed': [
    'The management coordinator could not complete this step.',
    'Recovery details are saved automatically. Open Updates for the safe recovery actions, or use the host recovery guide if the panel is unavailable.',
  ],
});
export function operationReason(code) {
  const known =
    typeof code === 'string' && Object.hasOwn(reasons, code)
      ? code
      : 'management-update-failed';
  const [message, action] = reasons[known];
  return {code: known, message, action};
}
export class OperationFailure extends Error {
  constructor(code, options) {
    const diagnostic = operationReason(code);
    super(
      diagnostic.message +
        ' ' +
        diagnostic.action +
        ' [' +
        diagnostic.code +
        ']',
      options,
    );
    this.diagnostic = operationReason(code);
    this.status = 409;
  }
  static fromDiagnostic(value) {
    const error = new OperationFailure(value?.code);
    error.diagnostic = publicOperationDiagnostic(value);
    error.message = error.diagnostic.message + ' ' + error.diagnostic.action;
    return error;
  }
}
export function publicOperationDiagnostic(value) {
  const diagnostic = operationReason(value?.code);
  // Legacy HttpError client messages are an explicitly public API contract.
  // Other errors always use the fixed reason catalog, including forged codes.
  if (
    diagnostic.code === 'operation-rejected' &&
    typeof value?.message === 'string'
  )
    diagnostic.message = redact(value.message)
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 600);
  if (
    typeof value?.reference === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value.reference)
  )
    diagnostic.reference = value.reference;
  if (
    typeof value?.phase === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value.phase)
  )
    diagnostic.phase = value.phase;
  if (typeof value?.retained === 'boolean')
    diagnostic.retained = value.retained;
  return diagnostic;
}
export function operationDiagnostic(
  error,
  {fallback = 'operation-failed', clientMessages = true} = {},
) {
  const seen = new Set();
  let client, resource;
  for (
    let cause = error;
    cause && !seen.has(cause) && seen.size < 8;
    cause = cause.cause
  ) {
    seen.add(cause);
    if (
      clientMessages &&
      !client &&
      cause instanceof HttpError &&
      !(cause instanceof DockerTransportError) &&
      cause.status >= 400 &&
      cause.status < 500
    )
      client = {
        ...operationReason('operation-rejected'),
        message:
          typeof cause.message === 'string'
            ? redact(cause.message)
                .replace(/[\x00-\x1f\x7f]/g, ' ')
                .slice(0, 600)
            : operationReason('operation-rejected').message,
      };
    if (cause instanceof DockerTransportError)
      resource ||= operationReason('docker-request-failed');
    if (cause instanceof OperationFailure)
      return publicOperationDiagnostic(cause.diagnostic);
    const codes = {
      ENOSPC: 'storage-full',
      EDQUOT: 'storage-full',
      EACCES: 'storage-access-denied',
      EPERM: 'storage-access-denied',
      EROFS: 'storage-read-only',
    };
    const storage =
      typeof cause.code === 'string' && Object.hasOwn(codes, cause.code)
        ? codes[cause.code]
        : null;
    if (storage && !resource) resource = operationReason(storage);
    if (
      cause.code === 'ENOENT' &&
      !(
        typeof cause.syscall === 'string' && cause.syscall.startsWith('connect')
      ) &&
      !resource
    )
      resource = operationReason('storage-file-missing');
    if (
      ['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT'].includes(cause.code) &&
      typeof cause.syscall === 'string' &&
      cause.syscall.startsWith('connect')
    )
      resource ||= operationReason('docker-unavailable');
  }
  return client || resource || operationReason(fallback);
}

// Sanitize at public controller boundaries before an HTTP hop can erase the
// transport error type and a downstream client wraps the response again.
export function publicTransportMessage(error) {
  if (!(error instanceof DockerTransportError)) return null;
  const diagnostic = operationDiagnostic(error);
  return diagnostic.message + ' ' + diagnostic.action;
}
