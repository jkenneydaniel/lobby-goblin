import path from 'node:path';
import fs from 'node:fs/promises';
import {assert, redact} from '../common.js';
import {
  saveManagementJSON,
  readManagementJSON,
  privateManagementDirectory,
} from './management-installation.js';
import {operationDiagnostic} from './operation-errors.js';

const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const clean = (value) => {
  try {
    return redact(String(value ?? ''))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 2000);
  } catch {
    return '[unavailable]';
  }
};

// Only the fixed public diagnostic is returned. Bounded exception details stay
// in controller-owned 0700/0600 storage, outside public routes and worker output.
export function privateOperationCauses(error) {
  const causes = [],
    seen = new Set();
  for (
    let cause = error;
    cause && !seen.has(cause) && causes.length < 4;
    cause = cause.cause
  ) {
    seen.add(cause);
    causes.push({
      name: clean(cause.name).slice(0, 100),
      message: clean(typeof cause === 'string' ? cause : cause.message),
      code: clean(cause.code).slice(0, 64),
      status: Number.isInteger(cause.status) ? cause.status : null,
    });
  }
  return causes;
}
export async function retainOperationDiagnostic(
  root,
  error,
  {id, source, phase = 'unknown', fallback = 'operation-failed'} = {},
) {
  assert(
    identifier(id) && identifier(source) && identifier(phase),
    'Choose a scoped operation diagnostic reference.',
  );
  const diagnostic = {
    ...operationDiagnostic(error, {fallback}),
    reference: id,
    phase,
  };
  const causes = privateOperationCauses(error);
  try {
    const directory = path.join(root, 'operation-diagnostics');
    assert(
      (await fs.realpath(root)) === root,
      'Diagnostic storage must remain canonical.',
    );
    await fs.mkdir(directory, {mode: 0o700, recursive: true});
    await privateManagementDirectory(directory);
    const file = path.join(directory, source + '-' + id + '.json');
    const previous = await readManagementJSON(file, {optional: true});
    assert(
      !previous ||
        (previous.version === 1 &&
          previous.source === source &&
          previous.id === id &&
          Array.isArray(previous.events) &&
          previous.events.length <= 8),
      'Private operation diagnostic scope changed.',
    );
    const event = {phase, at: new Date().toISOString(), diagnostic, causes};
    const events = [...(previous?.events || []), event];
    await saveManagementJSON(file, {
      version: 1,
      source,
      id,
      events:
        events.length <= 8
          ? events
          : [...events.slice(0, 4), ...events.slice(-4)],
    });
    return {...diagnostic, retained: true};
  } catch {
    return {...diagnostic, retained: false};
  }
}
