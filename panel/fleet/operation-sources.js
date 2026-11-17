import path from 'node:path';
import {assert} from '../common.js';
import {describeOperation, recordOperation} from '../core/operation-record.js';
import {workflowJournal} from '../core/workflow-journal.js';
import {needsOperationAttention} from '../public/shared/operation-progress.js';

export function setupDescriptor(job) {
  const required =
    ['interrupted', 'failed'].includes(job.state) &&
    !job.recoveryReview?.acknowledged;
  return {
    source: 'host-setup',
    kind: 'host-setup',
    action: 'install-host',
    state: job.state,
    phase: job.state === 'running' ? job.phase || 'connecting' : job.state,
    recovery: {
      required,
      message:
        'Inspect the retained installation on the target host before retrying setup. An acknowledgement records your review; it does not change the original outcome.',
      actions: required
        ? [
            {id: 'inspect', label: 'Review setup outcome'},
            ...(job.recoveryReview?.checkedAt
              ? [{id: 'acknowledge', label: 'Acknowledge host review'}]
              : []),
            {id: 'open', label: 'Open hosts', href: '#hosts'},
          ]
        : [],
    },
  };
}
export function recordSetupJobs(jobs) {
  for (const job of jobs) recordOperation(job, setupDescriptor(job));
}
export function setupOperationSource(setup) {
  return {
    id: 'host-setup',
    label: 'Host setup',
    read: async () =>
      setup.jobs.map((job) => describeOperation(job, setupDescriptor(job))),
    readProgress: async () =>
      setup.jobs.flatMap((job) => {
        const view = setupDescriptor(job);
        return needsOperationAttention(view) ? [describeOperation(job, view)] : [];
      }),
    async recover({id, operation, confirm}, actor) {
      const job = setup.jobs.find((job) => job.id === id);
      assert(
        job && setupDescriptor(job).recovery.required,
        'This setup no longer needs review.',
        409,
      );
      assert(
        setup.active?.id !== id,
        'Wait for this setup operation to settle.',
        409,
      );
      const previous = structuredClone(job);
      try {
        if (operation === 'inspect')
          job.recoveryReview = {
            ...job.recoveryReview,
            checkedAt: new Date().toISOString(),
            checkedBy: actor,
          };
        else {
          assert(
            operation === 'acknowledge' &&
              confirm === true &&
              job.recoveryReview?.checkedAt,
            'Review the retained host installation before acknowledging.',
            409,
          );
          job.recoveryReview = {
            ...job.recoveryReview,
            acknowledged: true,
            reviewedAt: new Date().toISOString(),
            reviewedBy: actor,
          };
        }
        await setup.record?.({action:'recovery.host-setup.'+operation,actor,requestId:id,operationId:id,outcome:operation==='inspect'?'review-required':'reviewed'});
        await setup.persist();
        return describeOperation(job, setupDescriptor(job));
      } catch (error) {
        for (const key of Object.keys(job)) delete job[key];
        Object.assign(job, previous);
        throw error;
      }
    },
  };
}
export function agentDescriptor(job) {
  const required = job.state === 'attention';
  return {
    source: 'agent-updates',
    kind: 'update',
    action: 'agent-update',
    state:
      job.state === 'complete'
        ? 'succeeded'
        : required
          ? 'interrupted'
          : job.state,
    phase: (job.recover ? 'recover-' : '') + job.state,
    recovery: {
      required,
      message: job.message,
      actions: required
        ? [
            {id: 'inspect', label: 'Check management recovery'},
            {id: 'open', label: 'Open host recovery', href: '#hosts'},
          ]
        : [],
    },
  };
}
export const agentOperationJournal = (file) => {
  const journal = workflowJournal({
    file,
    history: path.join(path.dirname(file), 'agent-update-history'),
    source: 'agent-updates',
    label: 'Host management updates',
    describe: agentDescriptor,
  });
  return {
    ...journal,
    write: (record) => {
      if (['complete', 'failed'].includes(record.state) && !record.finished)
        record.finished = new Date().toISOString();
      return journal.write(record);
    },
  };
};
export function agentOperationSource(agent) {
  return {
    ...agent.journal.operationSource,
    async read() {
      await agent.status();
      return agent.journal.operationSource.read();
    },
    async readProgress() {
      await agent.status();
      return agent.journal.operationSource.readProgress();
    },
    async recover({id}) {
      await agent.status();
      return (await agent.journal.operationSource.read()).find(
        (record) => record.sourceId === id,
      );
    },
  };
}
