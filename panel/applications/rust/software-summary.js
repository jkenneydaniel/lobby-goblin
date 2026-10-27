// Retained metadata only. Opening the screen never resolves Steam metadata,
// downloads files, starts a worker or walks application/world contents.
export async function rustSoftwareSummary({
  software,
  changes,
  framework,
  activeJob,
}) {
  if (!software)
    return {
      managed: false,
      message:
        'This installation uses the existing Rust installer. Managed Steam updates require a new managed installation; existing servers are not converted automatically.',
    };
  const installation = await software.status(),
    change = await changes.inspect(),
    updates = await changes.softwareStatus();
  return {
    managed: true,
    source: 'Valve SteamCMD · public branch · exact recorded build',
    installation,
    framework: change.pending ? change.previousFramework : await framework(),
    change: {
      pending: change.pending,
      kind: change.kind,
      phase: change.phase,
      framework: change.framework,
      previousFramework: change.previousFramework,
      metadataOnlyRecovery:
        change.pending === true &&
        change.kind === 'software' &&
        change.phase === 'checking-software' &&
        !!change.observation?.record &&
        !change.observation.record.prepareId &&
        !change.observation.record.world,
    },
    updates,
    activeJob: activeJob
      ? {
          state: activeJob.state,
          phase: activeJob.phase,
          message: activeJob.message,
        }
      : null,
  };
}
