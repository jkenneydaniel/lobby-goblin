# Foundation verification — 2026-11-03

Prepared from `a3adf8e261b57a624258238fce49d1c13298c1ea` in isolated branch
`codex/autonomous-lead-foundation`. The original source checkout was preserved.
This changes development guidance, checkpoint templates, restricted feedback
intake and its read-only CI. No product runtime or installation data changed.

## Local evidence

- Node `v24.19.0`: `node --test tools/autonomy/guard.test.mjs` — seven tests passed,
  including hostile issues/reviews/logs, forged metadata/authority, encoded and
  quoted instructions, redaction, bounded CLI errors and the restricted launcher.
- Real subprocess probes under Node permissions denied outside filesystem reads,
  filesystem writes and child execution with `ERR_ACCESS_DENIED`; the subprocess
  inherited no environment. This is API-level evidence, not an OS sandbox or
  proof of tool-isolated semantic AI interpretation.
- ESLint recommended checks with the repository configuration and zero warnings
  passed for the new developer modules.
- Python `jsonschema` Draft 2020-12 checked the checkpoint schema and validated its
  example; three negative probes rejected a wrong repository, excess specialist
  concurrency and a deploy permission. The example timestamp was parsed explicitly.
  JSON Schema `format` needs a supporting format checker in a real controller.
- `node --test panel/test/source-layout.test.js panel/test/module-release.test.js`
  — all three tests passed, including packaging, importability, release-document
  links and 41 nested extracted-bundle tests. The ambient restrictive umask made
  the existing Rust fixture create mode 0600 where it expects 0640. The run passed
  with invocation-local `umask 022`; no runtime or test source was changed.
- `node tools/release.mjs` prepared source bundles/checksums/manifests locally.
  Local autonomy documentation links and `git diff --check` passed.

## Capability limitations

- GitHub Issues/PR and Actions reads succeeded. The foundation issue is
  [#51](https://github.com/jkenneydaniel/lobby-goblin/issues/51). Public planning
  and reviewable source publication are owner-authorized.
- Projects v2 listing was denied by the integration. Branch-protection read also
  returned HTTP 403; the accessible rulesets endpoint returned an empty list,
  which does not establish absence of branch protections. Recheck effective
  required gates before any merge; no bypass is permitted.
- Native event discovery supports PR events and optional human review/comment
  events, not ordinary issue/comment events or CI completion. Bot review wake-ups
  cannot be assumed. Bounded scheduled reconciliation remains needed.
- A standalone no-write Codex CLI probe failed app-server initialization on a
  read-only filesystem. The namespace-isolation probe failed UID-map setup on a
  read-only filesystem. Neither was bypassed or retried with credentials copied.
- Native subagent read-only review works, but its interface does not restrict
  the tool inventory. It is not a verified no-tools semantic feedback interpreter.

No unattended scheduler, subscription, credential, access setting or paid resource
was created. Nothing was merged, released, deployed or operated on a live server
as part of this foundation verification. CI and Codex PR review are separate
remote evidence; pending results are not a clean review or successful check.
