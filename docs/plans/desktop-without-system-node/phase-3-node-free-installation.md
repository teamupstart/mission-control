# Phase 3: Node-free first install, legacy replacement and DMG enrollment

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md) and the prior phase handoffs before implementing. This phase document is a proposed route; adapt to verified repository facts and explain deviations in the PR. Repository: mission-control only.

## Approved forward rollout, 2026-10-26

R1 qualifies fresh installation and legacy source-install replacement through the standalone binary installer. See the [forward-rollout contract](forward-rollout.md) for its baseline and evidence requirements.

## Outcome and entry criteria

A macOS Apple Silicon user can install or replace Mission Control without system Node, npm, npx, git or Xcode build tools, including when the old app's updater cannot run. A manually copied app can enroll in managed installation at a verified destination.

Direct phase prerequisite: Phase 2 merged; Phase 1 is inherited through it. Also wait for the planning publication edge. Confirm the merged trusted publisher policy and C1-C4 APIs. A real signed DMG/manifest is required for R1 rollout qualification, not for completing implementation against those contracts. Use an isolated test account/VM and fixture state for installation experiments. This phase must not replace the operator's live app or use its live state for verification.

## Scope and non-goals

Own C5: native bootstrap, binary staged-installer entry, first-launch/manual enrollment, legacy replacement and scope-preserving receipts. Keep source/developer commands explicit. Do not implement background update discovery/download UI or remove the universal Setup warning; Phases 4 and 5 own them. Do not publish a second artifact format or write a second install transaction.

## Repository findings and inherited contracts

`scripts/install.sh` currently downloads a Git checkout and invokes Node. `install-app.mjs --temporary-source` leaves a compiled installer as the schema-1 source entry. Existing destination policy is in `install-destination.mjs`; an absent scope is legacy, not consent to system installation. Custom paths must already exist, and only the canonical personal Applications directory may be created automatically. The narrow elevation owner is `app-bundle-swap.mjs`.

DMGs are currently unmanaged; the Read Me describes this. `src/main/install-identity.ts` classifies matching, mismatched and redirect installations. `src/main/index.ts` and existing migration startup code own launch decisions. Phase 1 supplies the actual staged-install and compatible receipt APIs; Phase 2 supplies the signed DMG, canonical asset lookup and trusted publisher identity.

## Runtime flow

Canonical signed DMG -> Native identity verification -> Private verified runtime -> Shared installation -> Managed app and receipt.

<!-- flow-diagram -->

## Implementation order

1. Add failing bootstrap fixtures proving host Node/npm/npx/git/Xcode are unused. Test argument forwarding and errors before changing `scripts/install.sh`. Preserve a separate documented source installer entry for developers and forks rather than hiding a source fallback in the binary path.
2. Replace the standard Bash bootstrap's clone/build sequence with bounded canonical metadata/DMG retrieval. Use the native GitHub CLI for authenticated access where required; report missing `gh`/authentication accurately. A public/manual DMG route must still be documented, but this phase does not promise to remove all external tools. Never embed credentials in URLs, print them or forward them to arbitrary redirected hosts.
3. Establish the no-runtime trust bootstrap using fixed native macOS utilities. Bound metadata/download size, match the accepted immutable identity and digest, mount the verified DMG read-only without launching its contents, then verify expected bundle, architecture, publisher signature and notarization against shipped trust policy. Validate exactly one expected app root and reject unexpected paths/symlink escapes. Copy the complete verified app into a private staging directory and recheck it before executing any code from it. Native-tool availability and behavior must be proven on the minimum supported macOS version; do not assume Python, jq, developer tools or an external Node parser.
4. Add a packaged binary-installer entry, proposed `scripts/install-binary.mjs`, which runs through the verified candidate's bundled runtime and calls Phase 1's staged operation. Ship it through the existing packaging/helper inventories and build/smoke contracts. Retain the entire runtime app until all attempt-owned processes have exited. The installer must not run from the mounted image or destination being replaced.
5. Preserve flags and destination meaning through `install-destination.mjs`: fresh personal default, existing receipt destination unless explicitly changed, explicit system scope, custom path refusal/permissions, canonical repo selection and stable/full-SHA identity. Reject unsupported historical source-only flags with actionable guidance rather than silently ignoring them. A legacy receipt may reference either a source clone or retained compiled installer; both migrate without executing that source. Keep old support directories while any recovery record references them.
6. For an old running app, verify and stop only the intended installation/process through the existing ownership boundary. Refuse an unrelated daemon/state owner, an occupied relocation target, ambiguous process identity or conflicting receipt. Preserve the existing system-to-personal consent and migration protocol. Newer helper code may support the older source receipt, but it must not assume an old GUI supports a new handshake. Use the legacy replacement/recovery path with explicit state boundaries rather than spoofing readiness.
7. Add manual DMG enrollment through the existing Electron startup/identity bridge. A mounted image or translocated temporary copy must lead to an explicit install action, never an updater write into that location. At an already copied destination, verify app identity, trust and receipt before enrolling. Preserve explicit user/system/custom scope and show actionable conflict handling for a different managed install. Propagate any new capability through `src/main/index.ts`, preload, `mission-desktop.d.ts` and guarded browser callers together.
8. Write schema-2 binary receipts atomically through the shared writer after successful installation. Preserve exact old receipt bytes for rollback. Retarget existing owned absolute integration paths through the existing migration integration owner where necessary; do not perform Phase 5's broader external-runtime replacement here. Preserve JSONC, disabled entries, custom runtimes, login preferences and retained old sessions.
9. Update `build/dmg/readme.txt`, the first-install sections of `README.md`, `docs/setup.md`, `docs/desktop-and-packaging.md`, configuration and release-verification instructions. Explain that the new binary install is usable now, with the same signed installer available for manual replacement; Phase 4 enables automatic binary updates. A binary receipt must not enter the old source updater and fail looking for `sourceClone`: until Phase 4, provide an honest update-unavailable reason and recovery link.

## Data, API and compatibility

Use C1's manifest, C2's binary receipt and C3's staged transaction without redefining fields. The candidate's verified bundled runtime is bootstrap capability, not evidence that every arbitrary CLI can run without Node. Never use the candidate to perform its own first authenticity check.

Keep source-build installer commands and legacy receipt reads available. Do not redefine `/Applications` privilege policy, silently relocate explicit system/custom installs, follow a receipt into an arbitrary destination, or treat an unreadable receipt as permission to overwrite an existing app. An untrusted or newer receipt is an actionable stop.

Lock acquisition, target identity, attempt journal, target readiness, receipt commit and recovery all use Phase 1 ownership. A manual rerun after interruption must resume or refuse coherently, not start an independent writer. Preserve state-directory lock semantics and never restore SQLite from the helper. Mounted-image cleanup occurs only after owned children finish; failure may retain private recovery material with an actionable location in protected logs.

## Tests and verification

Use the isolated single-file invocation from AGENTS.md for `test/install-shell.test.ts`, `test/install-app.test.ts`, `test/install-destination.test.ts`, `test/install-receipt.test.ts`, `test/install-identity.test.ts`, `test/install-support-cleanup.test.ts`, `test/install-migration.test.ts`, `test/migration-runtime.test.ts`, `test/migration-integrations.test.ts` and new binary-bootstrap/enrollment tests. Test missing/old host runtimes, malformed manifest, wrong signer/digest/architecture, incomplete DMG, occupied destination, symlink escape, custom permissions, concurrent install, receipt write failure and interrupted legacy replacement.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`. Add behavior specs for enrollment and mounted-DMG refusal, extending `e2e/specs/update-install-identity.spec.ts` and `e2e/specs/user-install-migration.spec.ts` or a focused new spec. Run them with `npm run test:e2e -- <spec paths>` after build. Any new modal must use the border-inset measurement helper. Keep all agent binaries faked.

R1 requires the first newly produced signed release in a fresh macOS account/VM with Node/npm/npx/git build tools absent. It needs no historical signed release: the previous installation can be an isolated existing canonical source installation. Verify signed first install, managed launch, rerun, explicit system/custom paths, copied-DMG enrollment, mounted-DMG refusal and replacement of an old schema-1 app whose host Node is absent. Repeat with sentinel commands that record unexpected invocations. Capture receipt identity, state preservation, old/new process identity and failure recovery without secrets or operator data. This is NC-1 and the install portion of NC-4; unit/browser fixtures alone do not satisfy it.

## Implementation merge and rollout qualification

- Standard binary bootstrap and manual enrollment install a trusted usable app without a host runtime or build toolchain.
- Existing users can bypass their old updater without changing state home or silently changing install scope.
- Source commands remain explicit and functional; binary receipts never enter a source-build path.
- Scope, identity, interruption and receipt rollback regression cases pass; missing real inputs are identified without claiming signed execution.
- R1 qualifies the first published recovery installer and legacy replacement. Phase 4 implementation may merge before that publication; actual downloads continue to require a complete trusted artifact.

## Downstream handoff

Phase 4 can direct every canonical legacy or binary installation to a durable no-Node recovery route and can consume binary receipts safely. It must preserve these destination and enrollment decisions. Phase 5 may replace the runtime in owned integrations while preserving the path-migration and configuration protections exercised here.

## Cross-phase audit record

- Re-read root/index and Phases 1-2: selected the signed DMG for native bootstrap, avoiding a new native ZIP extraction implementation before a trusted runtime exists.
- Bootstrap invokes the common staged installer after verification, so it does not duplicate receipt or swap ownership. Native OS verification precedes executing the candidate's Node engine.
- Kept automatic binary updates and universal Setup removal outside this phase. The intermediate binary receipt has a deliberate, truthful manual-update route.
- Final audit: a source receipt may name a retained compiled installer; the migration preserves its bytes and cleanup obligations rather than assuming it is a Git clone.
