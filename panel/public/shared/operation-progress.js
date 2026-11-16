/** @param {{state:string,recovery?:{required?:boolean}}} job */
export const needsOperationAttention = (job) =>
  job.state === 'queued' || job.state === 'running' || !!job.recovery?.required;

/** @param {boolean} workflows @param {Iterable<string>} [watched] */
export function operationProgressRoute(workflows, watched = []) {
  const query = new URLSearchParams({progress: '1'});
  if (workflows) query.set('workflows', '1');
  for (const id of watched) query.append('job', id);
  return /** @type {`/jobs?progress=1${string}`} */ ('/jobs?' + query);
}
