# Desktop without system Node: implementation phases

Ordering correction: the rename and compatible binary consumer must land together before any binary installation or upgrade. PR #1214 stays draft and DO NOT MERGE independently. The sole R1/R2 qualification and dependency contract is [forward-rollout.md](forward-rollout.md).

Source: [plan.md](plan.md). Repository: mission-control only. Status: implementation phases retain their merge dependencies; the approved forward rollout separates first-release and subsequent-update qualification from implementation acceptance.

## Approved forward rollout, 2026-10-26

The five-phase implementation merge chain is unchanged. The [forward-rollout contract](forward-rollout.md) schedules R1 and R2 release qualification separately from that chain.

## Adopted decisions and publication

The operator explicitly requested full phased planning and scheduling on 2026-10-13. Preserve the source plan's macOS Apple Silicon scope, stable and exact-main-SHA alpha channels, Release Please ownership, copied complete Electron runtime, existing install transaction owners, native GitHub CLI authentication and feature-scoped third-party prerequisites. No new model, agent or workflow overrides are requested for implementation tasks.

All five tasks must depend on this planning session as well as their direct phase predecessor. They remain backlogged until the planning artifacts merge to main. Completion of this planning turn, a successful review, or an open PR does not satisfy that dependency. Required task pointers are Markdown; HTML is retained in the managed plan revision under its pinned Markdown-only Git policy.

## Investigation and reconciliations

Verified source baseline: b8d3260e, with main compared through 4b9ea92e. The two newer main commits change managed plans and task-kind UI, not the installation/updater runtime owners. Refresh main before each implementation phase.

| Finding | Evidence owner | Consequence and phase owner |
| --- | --- | --- |
| The app embeds Node; Setup probes an external executable | `src/main/utility-supervisor.ts`, `src/server/setup/index.ts` | Do not replace Electron or globally alter PATH; Phase 5 changes the meaning of the Setup prerequisite |
| Even staged apply invokes `sourceClone/scripts/install-app.mjs` | `scripts/apply-update.mjs`, `scripts/install-app.mjs` | Phase 1 must extract a callable staged install operation and ship its complete import closure, not merely change the spawned executable |
| Receipt schema 1 and migration validation require `sourceClone` | `src/shared/install-receipt-schema.mjs`, `scripts/install-migration.mjs` | Phase 1 introduces explicit source/binary receipt handling across readers before binary consumers write it |
| Bootstrap receipts can reference a retained compiled installer rather than a Git clone | `scripts/install-app.mjs`, `docs/desktop-and-packaging.md` | Migration accepts both legacy source forms; never delete a previous installer while rollback can restore its receipt |
| In-place apply records success around OS launch; relocation has a nonce/PID/start-identity readiness protocol | `scripts/apply-update.mjs`, `scripts/migration-runtime.mjs` | Reuse readiness and transaction ownership, and add real acknowledgment for in-place binary apply in Phase 1 |
| Relocation refuses backward recovery after receipt commitment | `scripts/install-migration.mjs`, `docs/desktop-and-packaging.md` | The root plan now states pre-state rollback versus post-commit forward recovery explicitly; no helper opens SQLite or guesses database compatibility |
| Packaging is ad-hoc; DMGs are Actions artifacts, not release assets | `electron-builder.yml`, `.github/workflows/ci.yml`, `release.yml` | Phase 2 owns signing/notarization and durable publication; no downstream phase treats today's artifacts as trusted distribution |
| A clean machine has no runtime with which to run an installer | `scripts/install.sh` | Phase 3 first verifies a DMG and its app with native tools, then uses a private copy of that verified app's runtime |
| App integration installation prefers external Node, dispatched MCP pins the daemon executable | `src/main/integrations.ts`, `src/server/mission-mcp.ts` | Phase 5 unifies only Mission-owned runtimes, preserves source-daemon behavior and repairs old registrations |
| Runtime flag must not leak into a GUI relaunch | `scripts/migration-runtime.mjs`, `src/main/migration-integration-ports.ts` | Phase 1 scopes `ELECTRON_RUN_AS_NODE` to helper children and removes it when launching the desktop app |

## Size and phase-count rationale

Estimated gross production additions or material changes: **3,500 to 5,800 lines**, excluding tests, generated output and these plans. Assumptions for this planning estimate: reuse existing bundle swap, locks, relocation, UI and release owners; no native helper port; macOS arm64 only. This is an effort estimate, not a correctness assumption or a diff-size target. A failed signed-runtime experiment requires re-planning rather than silently adding a native implementation.

| Phase | Production estimate | Why it is a separate merge unit |
| --- | --- | --- |
| 1 | 1,000-1,600 | Receipt compatibility, process lifetime and interrupted replacement are one transaction slice. Combining release infrastructure would obscure the highest-risk local invariant. |
| 2 | 600-1,000 | Signing and immutable publication have separate credentials, infrastructure and OS verification. Combining bootstrap would make its input untestable until both were complete. |
| 3 | 600-1,000 | First install and upgrading an old app must work before the new updater exists. It has a different trust bootstrap and destination/enrollment journey. |
| 4 | 800-1,300 | In-app discovery, download, cancellation and both progress surfaces form one user-visible feature, with the recovery installer implemented and first-release qualification tracked in R1. |
| 5 | 500-900 | Removing the universal warning is valid only once every app-owned runtime path works. Integration repair and the honest Setup claim ship together. |

Five implementation phases remain sufficient. Two release qualification follow-ups, R1 and R2 in forward-rollout.md, track real packaged checks that require newly produced binaries. They are operational follow-ups, not additional implementation phases or prerequisites for merging Phases 4 and 5.

## Phase table and dependency graph

| Phase | Plan | Direct phase prerequisites | Mergeable intermediate behavior |
| --- | --- | --- | --- |
| 1: Detached installation | [phase-1-bundled-install-transaction.md](phase-1-bundled-install-transaction.md) | None | Staged installs use a durable bundled helper and compatible receipt readers; source build preparation still works |
| 2: Signed distribution | [phase-2-signed-binary-distribution.md](phase-2-signed-binary-distribution.md) | 1 | Trusted producer and publication contracts are implemented; R1 qualifies the first actual release |
| 3: Binary bootstrap | [phase-3-node-free-installation.md](phase-3-node-free-installation.md) | 2 | Fresh/legacy/manual installs can become managed without Node; installed binary receipts can later update through Phase 4 |
| 4: Binary updater | [phase-4-binary-desktop-updates.md](phase-4-binary-desktop-updates.md) | 3 | Packaged apps update without source checkout/npm; unavailable assets never fall back to compilation |
| 5: Integrations and Setup | [phase-5-owned-runtimes-and-setup.md](phase-5-owned-runtimes-and-setup.md) | 4 | Mission-owned tools also work without host Node; Setup accurately reports feature prerequisites |

Graph: Planning publication -> every phase. Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5.

Phases 1 through 3 retain their established order. The Phase 4 consumer and app-name migration are now one coordinated implementation prerequisite for Phase 5. The held #1214 PR is not an independent merge path. The sole R1/R2 dependency and qualification contract is [forward-rollout.md](forward-rollout.md); do not duplicate its release gates here.

## Cross-phase contracts

Phase files contain the implementation detail; this index names their owners and the invariants consumers inherit.

| Contract | Owner | Consumers and invariant |
| --- | --- | --- |
| C1: versioned binary manifest and signed build metadata | Phase 1 | Phases 2-4 use the same pure `.mjs` validator and `.d.mts` declarations; archive digests are external, never self-referential signed metadata |
| C2: source/binary receipt compatibility | Phase 1 | Phases 3-5 read schema 1 and schema 2; a binary receipt has real artifact provenance, no fake source clone |
| C3: staged install, independent runtime and recovery boundary | Phase 1 | Phases 3-4 reuse existing swap/lock/journal owners, keep exact prior receipt bytes and never roll back across unproven database compatibility |
| C4: publisher identity and complete asset availability | Phase 2 | Phases 3-4 pin publisher identity outside the downloaded manifest; manifest-last is the ready signal; incomplete assets are not executable input |
| C5: first/legacy install and enrollment | Phase 3 | Phase 4 may refer users to the published binary recovery route; installation policy and state ownership remain unchanged |
| C6: binary updater state and progress | Phase 4 | Phase 5 can truthfully remove the universal host Node prerequisite; source-only tooling remains explicit |
| C7: Mission-owned runtime and integration repair inventory | Phase 5 | Final lifecycle uses app runtime only for owned code, never user commands or arbitrary third-party tools |

## Requirements and proof ownership

Every source-plan requirement has one primary implementation owner below. Other phases consume and regression-test it without redefining it.

| Source requirement group | Primary owner | Required proof |
| --- | --- | --- |
| Private complete helper runtime, dependency closure, locks, disk/cleanup, exact readiness, bounded rollback/retention | 1 | Real detached process survives parent exit and original-bundle replacement; failure injection and receipt-byte comparisons |
| Receipt schema 1 compatibility, schema 2 provenance, trust, identity, old journal reads and state boundary | 1 | Existing fixture upgrades plus new source/binary/unknown-schema and interruption cases |
| Signed/notarized ZIP/DMG, manifest-last publication, stable/alpha identity and retention, credentials and access | 2 | Controlled signed build, signer/fuse checks, publish retry and partial-set refusal; never PR-secrets exposure |
| No-Node first install, old-updater bypass, manual DMG enrollment, destinations and legacy relocation | 3 | NC-1 and NC-4 fresh-account/VM journeys, explicit scope and mounted-DMG cases |
| Authenticated retrieval, safe extraction, cancellation, update selection/progress, pinned target, no compile fallback | 4 | NC-2, update-specific NC-3, and progress portion of NC-6; real old/new signed app exercises |
| MCP/hooks/statusline/Pi/resume wrappers, safe existing-registration repair, standalone/adopted origins, Setup and source/third-party limits | 5 | NC-5, Setup portion of NC-6, complete no-Node sentinel journey across NC-1 through NC-6 |
| Release Please, disabled asar, skills location, daemon-only DB ownership, registry/process contracts | Each modifying phase | Existing contract gates and source/build scans; these are constraints, not separate work packages |

## Verification and rollout

Each phase runs the focused tests named in its file plus the repository's applicable typecheck/lint/build/smoke/E2E gates. UI changes receive real Playwright behavior coverage and inspected screenshots. Packaged tests run on an isolated macOS account/VM with synthetic state, fake agents and host `node`/`npm`/`npx` traps. Never exercise replacement against the operator's installed Mission Control or live state. Source-development checks remain separately exercised with supported external Node.

Phase 1 proves detached launch and transaction mechanics locally; Phase 2 repeats the lifetime test with the actual signed/notarized build and run-as-node fuse. Phase 3 supplies bootstrap/receipt regression coverage and R1 proves real first-release installation. Phase 4 supplies update, interruption and recovery regression coverage; R2 proves the signed update journey. Phase 5 verifies owned satellite paths locally, with the combined signed journey completed in R2. Passing a unit fixture is not Gatekeeper or update-journey evidence. Each phase registers its current evidence and carries durable PR proof; no evidence artifacts enter Git.

Do not advertise the universal Node-free experience before Phase 5. Phase 3 documents the temporary update limitation accurately: the binary installation is usable, and binary receipts show a clear update-unavailable state until Phase 4, with the same signed installer available for manual replacement. Phase 4 explicitly supports both legacy schema-1 canonical installs and schema-2 binary installs. Preserve the prior known-good signed release, and do not delete legacy source support until all ownership and rollback references are resolved.

## Verify-claims ledger

Verified: baseline owners, current receipt fields, compiled legacy installer path, helper spawn, migration commitment and integration behavior listed in the investigation table. Verified by earlier execution: copied complete app launches Node with host command traps; this does not prove signed replacement. The operator's scheduling request is the confirmed planning input.

Unresolved execution gates, not assumed facts: Apple team identity/credential availability; hardened signed runtime compatibility; release asset permissions; per-release state rollback compatibility. Phase 2 must resolve the first three before publication. Phase 1 fails closed across unknown state compatibility; later release tests establish any permitted backward recovery. No task may fill these gaps by fabricating identity, weakening signing, changing global Node, or assuming old code can read migrated state. A signing/publication failure blocks that artifact and its rollout qualification. Missing artifacts alone do not block implementation merge or Phase 5 work under the approved forward rollout. Runtime consumers still refuse unavailable binaries without a fallback build on the user's machine.

Verdict: CLEAR for conditional planning and scheduling. No unconfirmed prerequisite is claimed available, and no production action in this planning turn relies on it.

## Cross-phase audit

- Initial audit: separated the staged transaction from publisher and consumers; each extra phase has a risk-based merge boundary.
- Phase 1 audit: moved every schema/journal/helper decision into the earliest owner; source install and old journal compatibility remain required.
- Phase 2 audit: publication cannot change Phase 1 schema, and signed-runtime proof is mandatory before ready assets exist.
- Phase 3 audit: selected native DMG bootstrap to avoid assuming Node or an unverified ZIP extractor; same installer transaction, no duplicate receipt writer.
- Phase 4 audit: consumes the merged first/legacy installer; R1 qualifies it on the first new signed release. Source installation remains available only through explicit developer commands.
- Phase 5 audit: kept integration repair with Setup removal; no universal warning is removed ahead of its actual prerequisites.
- Final audit: each NC criterion has primary proof ownership; every consumer follows its provider; all five tasks carry the planning-publication edge. No concurrency or unpublished-file assumption remains.
