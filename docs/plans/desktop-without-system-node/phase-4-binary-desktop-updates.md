# Phase 4: Binary desktop updates with visible progress and recovery

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md) and the earlier phase contracts first. This is the proposed implementation route; use judgment when current code differs and explain deviations in the PR. Repository: mission-control only.

## Outcome and entry criteria

A packaged Mission Control app on a supported Mac can accept stable or exact-SHA alpha updates without system Node, npm, a source clone or local compilation. It remains usable while downloading and verifying, reports unavailable binaries accurately, and preserves the shared transaction's recovery guarantees.

Direct phase prerequisite: Phase 3 merged. The planning publication edge must also be satisfied. Inherited prerequisites include the C1-C4 signed artifact, receipt and helper contracts. Verify that the published binary installer can repair an old install with no Node before switching updater consumers. Read the current updater state machine, preload contract, both UI surfaces and existing update E2E fixtures.

## Scope and non-goals

Own C6: binary discovery/availability, bounded transport and staging, accepted-target identity, progress/cancellation, handoff and updater UX. Support both canonical legacy schema-1 installations and schema-2 binary installs. Keep explicit source installation/development paths available. Do not remove Setup's universal row yet, broaden supported platforms, change third-party runtimes or fork Phase 1 recovery logic.

## Repository findings and inherited contracts

`src/main/updater.ts` currently queries the newest stable release or main commit, probes Node/npm through `update-runtime.ts`, stages with `update-build.ts`, and hands off the prepared bundle. A legacy unsupported stage can fall back to source build after quit. That fallback must not remain in the new binary desktop path.

`src/shared/update.ts` and `update-stages.mjs` define the shared snapshot/progress vocabulary. `src/main/update-dialog.ts`, `src/web/components/UpdateBanner.tsx`, `src/web/useDesktopUpdates.ts`, main IPC, preload and `mission-desktop.d.ts` consume it. Keep these as one vertical feature. The existing receipt/bundle identity snapshot is atomic; do not split it into unrelated reads while choosing a destination.

## Runtime flow

Pinned stable / alpha offer -> Bounded binary download -> Identity and signature checks -> Independent helper -> Ready app or recovery.

<!-- flow-diagram -->

## Implementation order

1. Add failing controller/transport and browser tests for old/missing external Node, stable/alpha identity, pending alpha assets, download cancellation and restart into the accepted bundle. Use fake canonical release transport in deterministic tests and real signed artifacts in the packaged exercise.
2. Extend the existing release/GitHub runner to query C1/C4 manifests and complete asset availability with bounded pagination. Stable selects the newest eligible complete stable release; a release object alone is insufficient. Alpha selects the exact main SHA observed for the offer and reports pending/unavailable if that identity has no ready binary. Never silently substitute an older alpha or compile it. Preserve manual/background cadence, authentication/rate-limit handling, sanitized release notes and the current channel preference owner.
3. Implement binary download/staging in a focused module under `src/main/`, using the canonical asset identity and approved transport. Stream to a private attempt directory with size/time bounds, digest validation, cancellation and cleanup. Do not buffer an unbounded archive or expose token-bearing URLs. Handle authorized redirects explicitly. Caches, if used, key on immutable identity plus digest and reverify bytes before reuse.
4. Inspect archives before and during extraction using a suitable bounded ZIP reader/extractor. Reject absolute/traversal paths, conflicting entries, unexpected app roots, escaping symlinks and size bombs while preserving legitimate Electron framework symlinks and executable modes. Validate the resulting signature/notarization, bundle id, architecture, minimum OS, signed build identity and helper compatibility. Revalidate at handoff; a valid digest alone does not prove the publisher.
5. Adapt `UpdaterPort`, accepted-offer state and handoff to Phase 1's binary descriptor without calling runtime probes, clone creation or `stageUpdateBuild` on the packaged binary route. Legacy canonical source receipts upgrade to binary receipts through the shared transaction. Noncanonical/source-development cases retain their explicit source commands and remain clearly unsupported by canonical automatic updates. Remove dead packaged fallback branches and their exclusive helpers only after a consumer search; do not delete APIs still used by source installers.
6. Add binary-specific progress and unavailable/error states to the existing snapshot owners and render them consistently in native dialog and dashboard banner. Preserve persisted identifiers and the legacy source progress vocabulary where needed; use explicit strategy/stage data rather than labelling a download as a build. Ensure cancellation kills/settles owned work before retry is offered. Manual retry refreshes discovery; changing channel invalidates an unaccepted offer without silently changing an accepted attempt's identity.
7. Pass the accepted immutable descriptor, staged revision and exact installation snapshot into Phase 1 handoff. Keep the current app open until preparation is verified and helper startup is acknowledged. On new startup, display the shared durable outcome and repair guidance. Preserve relocation, Keep system installation, explicit scope, ready-to-restart confirmation and old-daemon conflict handling. Unknown post-commit state compatibility follows forward/manual recovery, never guessed rollback.
8. Publish only sanitized diagnostics and useful errors: unavailable binary, wrong signer/protocol, incompatible OS, expired asset, low disk, cancellation, auth/rate limit, handoff failure and recovery-required. Preserve bounded log rotation. Do not include credentials or arbitrary private URLs/paths in renderer text.
9. Update the update sections of desktop packaging, configuration, troubleshooting, the setup guide source and release-verification runbook. Explain stable completeness, exact alpha identity, manual recovery and the continued independent requirements of source development/third-party tools. Do not claim the complete app-owned no-Node experience until Phase 5.

## Data, API and compatibility

Consume C1's manifest and signed metadata, C2 receipts, C3 transaction and C4 trusted identity unchanged. An offer pins channel, tag/commit, platform, asset identity and manifest digest. A retry may produce a new offer but must not mutate an active accepted identity. Before receipt commitment, cancellation or verification failure changes neither installed bundle nor receipt.

Keep old receipts/journals readable and older preload contracts safe. A new optional IPC field must have a backward-compatible absence behavior. If an added snapshot discriminant is necessary, handle it exhaustively in native dialog, browser hook/components, preload types and fixtures in the same PR. Use push subscriptions for progress; do not add dashboard polling or a parallel update store. Any new server projection follows the shared schema, settings comparator and SSE exhaustiveness rules.

After this phase, canonical packaged updates never require system Node, including apps installed through the older source route. The standalone developer path remains explicit. A missing asset, older binary protocol or unsupported OS never selects the legacy build fallback behind the user's back.

## Tests and verification

Use AGENTS.md's isolated test invocation for `test/updater.test.ts`, `test/updater-electron.test.ts`, `test/update-source.test.ts`, `test/update-version.test.ts`, `test/update-outcome.test.ts`, `test/update-log.test.ts`, `test/update-dialog.test.ts`, `test/update-desktop-contract.test.ts`, `test/update-banner.test.ts`, `test/desktop-updates.test.ts`, `test/apply-update.test.ts` and focused new binary transport/extraction tests. Keep source-runtime/build tests where source consumers remain.

Test stable selection across incomplete/newer releases; exact-SHA alpha pending/expiry; old receipt migration; wrong signer/OS/arch/protocol; corrupt, truncated or substituted bytes; archive traversal/symlinks/size limits; network/auth failures; cancellation/retry/channel changes; same-version new alpha commit; wrong running bundle; concurrent update; low disk; state ownership; helper and receipt failures. Preserve legacy source install coverage without accepting source fallback in packaged consumers.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`. Add/update and run `e2e/specs/alpha-updates.spec.ts`, `update-banner.spec.ts`, `update-preload.spec.ts`, `update-node-preflight.spec.ts`, `update-install-identity.spec.ts`, `user-install-migration.spec.ts` and `update-dialog-theme.spec.ts` as applicable, plus a dedicated binary download/cancel flow. Verify visible states and actions, not just request payloads; measure inset for new modals. Keep agents faked and capture inspected screenshots in both themes.

Mandatory packaged proof: signed old/new apps from Phase 2 in isolated state with no host runtime, plus traps in a second run. Exercise stable and exact-SHA alpha, user/system/custom destinations, legacy relocation, cancel before shutdown, wrong/corrupt asset, target readiness failure and interrupted recovery. Verify exact installed identity/receipt and unchanged state ownership. This establishes NC-2, update failure portions of NC-3/NC-4 and progress portions of NC-6. Browser fixtures cannot substitute for detached signature/Gatekeeper behavior.

## Merge and exit criteria

- A real supported packaged app updates to the pinned signed stable/alpha target with no host runtime invocation or source build.
- Both UI surfaces show accurate download/verify progress, cancellation, availability, restart and recovery outcomes.
- Every failure before commitment preserves the current installation; recovery after commitment respects database compatibility and existing journal ownership.
- Explicit developer/source commands remain usable; binary consumers have no silent compilation fallback.
- Focused, build, browser and packaged checks pass with durable evidence.

## Downstream handoff

Phase 5 can classify packaged updates as independent of host Node. It must not alter C6 transport/trust or transaction rules while changing Setup and integration runtimes. It receives an actual no-Node updater for the final combined sentinel journey, not a mock capability flag.

## Cross-phase audit record

- Re-read root/index and Phases 1-3: kept accepted descriptor identity, signature policy and receipt transaction with their existing owners.
- Kept Phase 3 first-install recovery ahead of updater transition; no source-build fallback is used to compensate for incomplete binary publication.
- UI, IPC and transport are one merge unit; Phase 5 changes only the remaining integration/prerequisite meaning.
- Final audit: source receipt compatibility does not imply source compilation. Old canonical installations can move directly to binary distribution using the shared transaction.
