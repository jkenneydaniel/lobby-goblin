// Public diagnostics are selected from code, never from Docker output, saved
// container configuration, exception text or worker logs.
const reasons = Object.freeze({
  'duplicate-operation-identity': [
    'Workflow history contains duplicate operation IDs.',
    'Repair the legacy migration history, then review each interrupted attempt before retrying.',
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
    'Check the affected management service and its operation history. Retain the update ID before retrying recovery.',
  ],
  'docker-unavailable': [
    'The local Docker connection is unavailable.',
    'Check Docker Desktop or the local Docker service and retry using the same engine.',
  ],
  'management-update-failed': [
    'The management coordinator could not complete this step.',
    'Retain the update ID and recovery records. Check the recorded phase before resuming or rolling back.',
  ],
});
export function managementDiagnostic(code) {
  const known = Object.hasOwn(reasons, code)
    ? code
    : 'management-update-failed';
  const [message, action] = reasons[known];
  return {code: known, message, action};
}
export class ManagementFailure extends Error {
  constructor(code, options) {
    const diagnostic = managementDiagnostic(code);
    super(
      diagnostic.message +
        ' ' +
        diagnostic.action +
        ' [' +
        diagnostic.code +
        ']',
      options,
    );
    this.diagnostic = managementDiagnostic(code);
    this.status = 409;
  }
}
export function managementFailure(error) {
  const seen = new Set();
  for (
    let cause = error;
    cause && !seen.has(cause) && seen.size < 8;
    cause = cause.cause
  ) {
    seen.add(cause);
    if (cause instanceof ManagementFailure)
      return managementDiagnostic(cause.diagnostic.code);
    if (
      ['ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT'].includes(cause.code) &&
      cause.syscall?.startsWith('connect')
    )
      return managementDiagnostic('docker-unavailable');
  }
  return managementDiagnostic('management-update-failed');
}
