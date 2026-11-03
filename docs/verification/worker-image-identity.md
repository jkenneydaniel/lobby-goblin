# Published worker identity across Docker image stores

The Docker engine is trusted host software. Worker admission still binds the
exact published reference, platform, user, entrypoint, command, provider/revision
labels and repository digest. Container inspection additionally binds the engine's
validated image identity, exact create reference, scope, environment, privileges,
network and private mounts. This compatibility rule grants no new image or tool.

Docker's classic image store reports the configuration digest as image `Id`.
The Docker 29 containerd implementation reports its image target descriptor's
digest as `Id`, while projecting configuration from the selected platform.
Container identity uses that same inspected runtime identity. See Docker's
[inspection implementation](https://github.com/moby/moby/blob/docker-v29.0.0/daemon/containerd/image_inspect.go)
and [image resolution](https://github.com/moby/moby/blob/docker-v29.0.0/daemon/containerd/image.go).
Do not infer image-store behavior from an engine version alone.

Registry inspection on 2026-11-03 verified these immutable relationships:

| Artifact | Published target | Selected manifest | Configuration |
| --- | --- | --- | --- |
| Steam worker `1-lg.2` | OCI index `sha256:241b5e8fc43fee5ac5ce439bc8155ab723f9c8ecc9dbf0fbe97fcc0fac42fd3b` | Sole linux/amd64 child `sha256:f818e4895b650cd8697fbc88db7f1e74a3533176dcd1389d1e01621abb3a3fc2` | `sha256:985baadcfcaaf77e27bf4e9cc23f1c7c98b1dd4c45a4240197dad75a29280c3d` |
| Rust `managed-lg.2` acceptance baseline | Docker v2 manifest `sha256:138cf1e76d6dcd5b88eb172dd2b3264f2abc508eb2b29d568851682a2b0cf802` | Same manifest, not a platform index | `sha256:372dc5104189728730e7efacc3dea7d649203957718b702fee52a53d390bbe29` |

The worker index also contains an unknown-platform attestation descriptor; it has
no second eligible linux/amd64 image. Changing the index or supported platform
requires rechecking this relationship, not accepting arbitrary child manifests.
The deployment record retains its configuration pin. Only that pin and the digest
already present in its exact published reference are recognized. An index-shaped
worker identity must carry the matching OCI index descriptor. Contradictory
descriptors, missing index descriptors and unknown identities fail closed.

Internal ownership checks inspect the full pinned reference because configuration
ID lookup is not portable between stores. Container validation requires equality
with the identity actually returned by that validated inspection; it does not
mix identities from different inspections. Resource accounting recognizes the two
bounded identities while retaining its exact reference/name/scope predicates.
Synthetic pre-create admission retains its trusted configuration identity.

Tests must cover both representations, configuration-ID lookup unavailable in the
multi-platform store, metadata and cross-scope rejection, replay/cleanup fencing,
memory reservations and application-start exclusion. Existing retained-worker
management-upgrade refusal remains unchanged. Private preparation and managed Rust
install/save/clone require separate disposable-engine acceptance; fixture success
alone does not prove either native journey. No existing installation is upgraded
by this source change.
