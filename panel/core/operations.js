import crypto from 'node:crypto';
import {operationDiagnostic} from './operation-errors.js';
import {assertJobIdentities} from './operation-identity.js';
import {assert} from '../common.js';
import {recordOperation, operationKind} from './operation-record.js';

const now = () => new Date().toISOString();
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const fingerprint = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const unfinished = (job) =>
  ['queued', 'running'].includes(job.state) ||
  (job.phase && !['settled', 'interrupted'].includes(job.phase));

// Repositories retain existing JSON shapes until an explicit storage migration.
// Reservations and checkpoints are written before side effects. Restart recovery
// inspects outcomes; it never replays an interrupted action during startup.
export class Operations {
  constructor({
    getJobs,
    setJobs,
    getActive,
    setActive,
    persist,
    id = () => crypto.randomUUID(),
    inspect,
    retryable = () => false,
    record = async () => {},
    failure = async error => operationDiagnostic(error),
  }) {
    Object.assign(this, {
      getJobs,
      setJobs,
      getActive,
      setActive,
      persist,
      id,
      inspector: inspect,
      retryable,record,failure,
    });
    this.storageError = false;
    this.recovering = false;
    this.reservations = new Map();
  }
  get pending() {
    return this.getJobs().filter((job) => job.recovery?.required);
  }
  get blocked() {
    return this.storageError || this.recovering || this.pending.length > 0;
  }
  status() {
    return {
      jobs: this.getJobs(),
      active: this.getActive(),
      recoveryRequired: this.blocked,
    };
  }
  assertAvailable({retryOf} = {}) {
    assert(
      !this.getActive() && !this.recovering,
      'Another operation is in progress. Please wait.',
      409,
    );
    assert(
      !this.storageError,
      'Operation history could not be saved. Check recovery before running another operation.',
      409,
    );
    assert(
      !this.pending.some((job) => job.id !== retryOf),
      'Review interrupted operations before running another operation.',
      409,
    );
  }
  async init() {
    for (const job of this.getJobs())
      if (unfinished(job)) {
        const interruptedPhase = job.phase || 'unknown';
        Object.assign(job, {
          state: 'interrupted',
          phase: 'interrupted',
          finished: now(),
          message:
            'Management restarted before this operation was fully recorded. Check its outcome before retrying.',
          recovery: {
            required: true,
            state: 'inspection-required',
            interruptedPhase,
            retryable: this.retryable(job),
          },
        });
        this.describe(job);
      }
    await this.persist();
  }
  describe(job,actor) {
    recordOperation(job, {source:'jobs', action:job.action, kind:operationKind(job.action)},{actor});
  }
  existing({action, actor, input, requestId, retryOf}) {
    if (requestId === undefined) return null;
    assert(
      typeof requestId === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(requestId),
      'Invalid operation request ID.',
    );
    const job = this.getJobs().find((value) => value.requestId === requestId);
    if (job)
      assert(
        job.action === action &&
          job.actor === actor &&
          job.retryOf === retryOf &&
          job.inputHash === fingerprint(input),
        'This operation request ID was already used for a different request.',
        409,
      );
    return job || null;
  }
  async accepted(job) {
    await this.reservations.get(job.id);
    return job;
  }
  async reserve({action, actor, input, requestId, retryOf}) {
    const previous = this.existing({action, actor, input, requestId, retryOf});
    if (previous) return {job: await this.accepted(previous), duplicate: true};
    this.assertAvailable({retryOf});
    const original =
      retryOf && this.getJobs().find((job) => job.id === retryOf);
    if (retryOf)
      assert(
        original?.recovery?.required &&
          original.recovery.checkedAt &&
          this.retryable(original) &&
          original.action === action,
        'Check the interrupted operation before retrying it.',
        409,
      );
    const job = {
      id: this.id(),
      action,
      actor,
      state: 'running',
      phase: 'reserved',
      operationVersion: 1,
      started: now(),
      message: 'Preparing…',
      ...(requestId && {requestId, inputHash: fingerprint(input)}),
      ...(retryOf && {retryOf}),
    };
    assertJobIdentities([job, ...this.getJobs()]);
    this.describe(job);
    const previousJobs = this.getJobs(),
      previousRecovery = original && structuredClone(original.recovery);
    // Keep unresolved recovery records even when normal history reaches its cap.
    this.setJobs(
      [job, ...previousJobs].filter(
        (value, index) => index < 100 || value.recovery?.required,
      ),
    );
    this.setActive(job);
    if (original)
      original.recovery = {
        ...original.recovery,
        required: false,
        state: 'retried',
        retryJobId: job.id,
        reviewedBy: actor,
        reviewedAt: now(),
      };
    try {
      const saving=(async()=>{await this.record({action:'operation.'+action,actor,requestId,operationId:job.id,outcome:'started'});await this.persist();})();
      this.reservations.set(job.id, saving);
      await saving;
    } catch (error) {
      if (original) original.recovery = previousRecovery;
      this.setJobs(previousJobs);
      this.setActive(null);
      throw error;
    } finally {
      this.reservations.delete(job.id);
    }
    return {job, duplicate: false};
  }
  async checkpoint(job, phase, message, target) {
    assert(this.getActive() === job, 'Operation is no longer active.', 409);
    assert(/^[a-z][a-z0-9-]{0,63}$/.test(phase), 'Invalid operation stage.');
    Object.assign(job, {
      phase,
      updated: now(),
      ...(message && {message}),
      ...(target && {target: {...job.target, ...target}}),
    });
    this.describe(job);
    try {
      await this.persist();
    } catch (error) {
      this.storageError = true;
      throw error;
    }
  }
  async execute(job, {before = async () => {}, run, after = async () => {}}) {
    try {
      await this.checkpoint(
        job,
        'preparing',
        'Checking operation prerequisites…',
      );
      try {
        await before(job);
        await this.checkpoint(job, 'executing', 'Running operation…');
        const result = await run(job);
        Object.assign(job, {
          state: 'succeeded',
          result,
          message:
            typeof result === 'string'
              ? result
              : result?.message || 'Completed.',
        });
      } catch (error) {
        const failure = await this.failure(error, job);
        Object.assign(job, {state: 'failed', failure, message: failure.message + ' ' + failure.action});
      }
      await this.checkpoint(job, 'cleanup');
      await after(job);
      if (this.storageError)
        throw Error('Operation progress could not be recorded reliably.');
      await this.record({action:'operation.'+job.action,actor:job.actor,requestId:job.requestId,operationId:job.id,outcome:job.state});
      await this.checkpoint(job, 'settled');
      job.finished = now();
      this.describe(job);
      await this.persist();
    } catch (error) {
      const interruptedPhase = job.phase;
      const failure = await this.failure(error, job);
      Object.assign(job, {
        state: 'interrupted',
        phase: 'interrupted',
        failure,
        finished: now(),
        message:
          'The operation needs review because its completion or cleanup could not be recorded. ' + failure.message + ' ' + failure.action,
        recovery: {
          required: true,
          state: 'inspection-required',
          interruptedPhase,
          detail: failure.message,
          retryable: this.retryable(job),
        },
      });
      this.describe(job);
      try {
        await this.record({action:'operation.'+job.action,actor:job.actor,requestId:job.requestId,operationId:job.id,outcome:'interrupted'});
        await this.persist();
      } catch {
        this.storageError = true;
      }
    } finally {
      this.setActive(null);
    }
  }
  // An inspection may establish a completed outcome, but must not change game
  // state. Unknown outcomes remain interrupted until explicitly reviewed.
  async recover({id, operation, confirm}, actor) {
    assert(
      !this.getActive() && !this.recovering,
      'Wait for the active operation to finish.',
      409,
    );
    const job = this.getJobs().find((value) => value.id === id);
    assert(
      job?.recovery?.required,
      'No interrupted operation requires review for this ID.',
      404,
    );
    assert(
      ['inspect', 'acknowledge'].includes(operation),
      'Choose a recovery operation.',
    );
    this.recovering = true;
    const previous = structuredClone(job);
    try {
      await this.record({action:'recovery.'+operation,actor,operationId:job.id,outcome:'started'});
      // Confirm storage has recovered before attempting an inspection.
      try {
        await this.persist();
        this.storageError = false;
      } catch (error) {
        this.storageError = true;
        throw error;
      }
      if (operation === 'inspect') {
        let observation;
        try {
          observation = await this.inspector?.(job);
        } catch {
          observation = {
            message:
              'The outcome could not be checked. Restore the management connection and check again. Review server status and logs before acknowledging.',
          };
        }
        observation ||= {
          message:
            'Completion cannot be proven automatically. Review server status, logs and backups before acknowledging this operation. No action was replayed.',
        };
        assert(
          typeof observation.message === 'string' &&
            (!observation.outcome || ['succeeded','failed'].includes(observation.outcome)),
          'Invalid recovery observation.',
          500,
        );
        job.recovery = {
          ...job.recovery,
          state: observation.outcome ? 'verified' : 'review-required',
          checkedAt: now(),
          checkedBy: actor,
          message: observation.message,
          retryable: this.retryable(job),
          required: !observation.outcome,
        };
        if (observation.outcome)
          Object.assign(job, {
            state: observation.outcome,
            phase: 'settled',
            message: observation.message,
            ...(observation.result !== undefined && {
              result: observation.result,
            }),
          });
      } else {
        assert(
          confirm === true && job.recovery.checkedAt,
          'Check the outcome and confirm you reviewed server status, logs and backups first.',
        );
        job.recovery = {
          ...job.recovery,
          required: false,
          state: 'acknowledged',
          reviewedBy: actor,
          reviewedAt: now(),
        };
        // Acknowledgement does not turn an uncertain outcome into a success.
      }
      this.describe(job,actor);
      await this.record({action:'recovery.'+operation,actor,operationId:job.id,outcome:job.recovery.state==='verified'?job.state:job.recovery.required?'review-required':'reviewed'});
      try {
        await this.persist();
      } catch (error) {
        this.storageError = true;
        throw error;
      }
      return job;
    } catch (error) {
      for (const key of Object.keys(job)) delete job[key];
      Object.assign(job, previous);
      throw error;
    } finally {
      this.recovering = false;
    }
  }
}
