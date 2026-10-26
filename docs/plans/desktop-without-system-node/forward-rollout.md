# Forward rollout: first binary release and subsequent updates

Approved by the operator on 2026-10-26 after clarifying that binary app installations should begin with the next newly produced release. No historical signed releases or backfill are required. Repository: mission-control only. This supersedes the earlier assumption that signed old/new releases must exist before implementation completion.

## Implementation acceptance

Keep the five implementation phases and their merge order. Phase 4 completes after its applicable focused, typecheck, lint, build, smoke, Playwright and detached Electron regression checks. Phase 5 proceeds after Phase 4 merges and completes with its corresponding runtime, integration and UI checks. Existing evidence remains valid within its stated fixture/runtime limits; do not recast it as signed publication or Gatekeeper proof.

Neither implementation phase waits for R1 or R2. Actual consumers still refuse missing or incomplete binaries. The normal implementation review and merge process remains required. This planning update does not authorize this session to commit, push, create a PR, merge, alter production protections, publish assets or touch the operator's live app/state.

## Release flow and task dependencies

Phase 4 merge -> next eligible signed release -> R1 first-install and legacy migration -> retained exact baseline -> subsequent eligible stable and alpha targets -> R2 signed update/recovery qualification.

Phase 4 merge -> Phase 5 implementation/merge -> R2 combined owned-runtime qualification.

R1 and R2 are release verification follow-ups, not new implementation phases. R1 depends on the current Phase 4 task merging. R2 depends on R1 and Phase 5 merging. Keep both release checks off backlog autopilot while their signed inputs are unavailable; an operator can enable the relevant task when the normal protected release process supplies its inputs. No dependency points from either release check back into Phases 4 or 5.

<!-- rollout-diagram -->

## R1: first signed binary and migration

Use the next complete signed release containing the binary bootstrap and updater. Do not ask the operator to locate old releases. The existing protected producer owns signing, notarization, canonical CI eligibility and publication of matching ZIP/DMG bytes followed by the ready manifest. The regular unsigned CI DMG is not a distribution substitute.

The release owner must satisfy the existing desktop-distribution approval policy. Do not self-approve contrary to policy, change reviewers/protections, replace release credentials, use a personal publication token or bypass publisher verification. If approval or credentials are unavailable, keep this release follow-up pending with the exact missing prerequisite; do not block unrelated implementation work or claim success.

Before calling the first binary installation qualified, verify its approved signer, notarization, quarantine/Gatekeeper behavior, metadata, manifest/asset identity and embedded-runtime helper behavior. In an isolated account/VM with synthetic state and fake agents, exercise fresh installation, launch, rerun, manual enrollment and replacement of an existing canonical schema-1 source installation. That source installation supplies the migration baseline; it need not be a historical signed distribution. Test personal, explicit system and custom destinations, state/receipt preservation, readiness failure and pre-commit recovery. Run once with host Node/npm/npx/build tools absent and once with invocation-recording traps. Preserve quarantine and never use the operator's live installation/state.

Record exact source commit, release identity, asset IDs, hashes, signer, installed receipt, state ownership and native verification results. Retain the original qualified baseline bytes and their metadata privately for R2, without rebuilding or mutating an advertised identity. Evidence belongs in the workflow and PR attachments, not Git. Update docs/release-verification.md with the observed status and evidence locations.

R1 completion requires actual first-install/legacy-migration evidence. It does not require a second release or claim stable/alpha in-app update qualification. The first binary can be installed through the standalone installer even if the existing installed app has no binary updater.

## R2: subsequent stable/alpha updates and recovery

Use the R1 binary as the installed baseline and subsequent newly produced stable and exact-SHA alpha targets. More than one later target may be needed to cover both channels; no old-release backfill is necessary. A target used for the combined integration journey must include Phase 5. Preserve the baseline outside any normal latest-alpha retirement policy without recreating retired publication identities.

Run the Phase 4 signed matrix: stable and exact-SHA alpha selection; personal/system/custom destinations; legacy relocation and Keep system installation; accurate progress; cancellation before shutdown; corrupt, truncated, substituted and unavailable assets; wrong signer/architecture/protocol; helper and receipt-write failure; target readiness failure; and interrupted replacement/recovery. Run with host runtimes absent and then recording traps, fake agents and isolated state. Verify exact installed commit/provenance, no host-runtime hits and unchanged state ownership. Before commitment retain or restore the prior app and exact receipt; after commitment preserve forward/manual recovery across unknown state compatibility.

After Phase 5, also execute shipped Mission-owned hook/MCP/statusline/Pi/resume helpers and registration repair, with source/custom/third-party prerequisites independently checked. Retain the NC-1 through NC-6 acceptance matrix and register actual command output, synthetic identity/receipt comparisons and inspected UI evidence. Never mark signed qualification passed from browser fixtures, API inventory checks or mocked native verification.

R2 completion requires recorded real signed stable/alpha update and recovery results plus the combined owned-runtime journey. Until it passes, documentation distinguishes implemented binary capabilities from outstanding complete lifecycle qualification. This is a release verification obligation, not a gate requiring historical assets before implementation can merge.
