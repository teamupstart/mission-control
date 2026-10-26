# Phase 5: Mission-owned runtimes and honest Setup

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md) and the completed phase handoffs first. Treat this as the proposed implementation route; preserve the outcome, use judgment where code differs, and document deviations in the PR. Repository: mission-control only.

## Approved forward rollout, 2026-10-26

Phase 5 depends on the Phase 4 merge, while R2 qualifies the combined signed update and owned-runtime journey. See the [forward-rollout contract](forward-rollout.md) for that release gate.

## Outcome and entry criteria

Installed Mission Control and its owned integrations work without host Node, while Setup describes the actual running runtime and keeps external prerequisites scoped to the feature that requires them. Users with old or missing system Node no longer receive a universal app-runtime warning.

Direct phase prerequisite: Phase 4 merged, plus the planning publication dependency. Verify the merged no-Node bootstrap/updater code and applicable regression evidence. The actual signed combined journey is R2 rollout qualification after new releases exist; it is not a prerequisite for starting or merging this phase. Runtime-origin and prerequisite labels must describe implemented capabilities honestly, without claiming unexecuted release qualification. Read Setup's catalog/probes/banner dismissal behavior and all owned satellite launch sites before editing.

## Scope and non-goals

Own C7: runtime selection for shipped Mission-owned scripts, existing-registration repair and truthful Setup. Complete the user documentation and combined acceptance journey. Do not replace third-party Node interpreters, change users' global/project Node selections, weaken publisher/receipt validation, rewrite custom shell commands or remove supported source development. Optional Conductor remains subject to its separate external prerequisites; do not use Conductor skills.

## Repository findings and runtime inventory

The initial inventory is grounded in these owners and must be completed by a repository-wide consumer search before claiming coverage:

| Surface | Existing owner | Required behavior |
| --- | --- | --- |
| App-owned daemon and Foreman | `src/main/daemon.ts`, `foreman.ts`, `utility-supervisor.ts` | Keep bundled utility processes; distinguish an adopted standalone daemon |
| Dispatched MCP | `src/server/mission-mcp.ts` | Preserve the daemon's absolute executable and Node-mode environment; consume the Phase 1 pure resolver |
| Packaged Claude hooks/MCP installer | `src/main/integrations.ts` | Prefer verified app-owned runtime for owned satellites even when an old external Node exists |
| Legacy hook and statusline registrations | `hooks/install.mjs`, `hooks/harness-statusline.mjs` | Keep explicit source-install behavior; add a packaged owned-wrapper repair path where necessary, preserving the user's wrapped command |
| Pi installer/extension | `scripts/install-pi-extension.ts`, `src/server/setup/pi-extension.ts`, `src/server/environment/pi-extension.ts` | Run Mission installation helpers with owned runtime; independent Pi CLI requirements stay external |
| Codex hook and resume/check helpers | `hooks/codex-hook.mjs`, `src/server/terminal/resume-guard.ts`, `src/server/mission-mcp.ts` | Pin owned bundle launches; do not substitute bundled Node for user-authored workflow commands |
| Relocated config and login paths | `src/main/migration-integrations.ts`, `migration-integration-config.ts`, `migration-integration-file.ts`, `migration-integration-ports.ts` | Reuse existing surgical config ownership and retry logic |

Setup's `nodeRuntimeStatus` probes external Node against the installer floor, and the catalog marks `node-runtime` required. `setupRowNeedsAttention` therefore makes it an app-wide gap. Do not delete/reuse that persisted identifier or reset unrelated acknowledgments just to hide the warning.

## Runtime flow

Actual runtime origin -> Owned runtime resolver -> Owned registrations -> Shipped helpers execute -> Feature-scoped Setup.

<!-- flow-diagram -->

## Implementation order

1. Add a failing Playwright regression for the packaged-capability case with old/missing host Node and a healthy app-owned runtime, plus fixtures for source and adopted daemons. Add focused runtime/config tests showing the external-first packaged installer selects the wrong executable. Record the complete consumer inventory in maintained technical documentation, including any source-only exceptions.
2. Route every shipped Mission-owned helper through Phase 1's pure resolver and explicit runtime context. Do not rely solely on an executable basename to decide product ownership when accurate Electron/daemon-origin facts are available. Preserve source-daemon `process.execPath` behavior and standalone launch requirements. Share pure descriptors/quoting without importing daemon state or SQLite into Electron main or browser shared modules.
3. Change packaged integration installation to use the current verified app executable in Node mode even when a version-manager shim is present. Set the environment only on the specific owned invocation. Verify real bundled script startup in a checkout pinned to old Node. Update hook, MCP, Pi installation and resume/check consumers together as the inventory requires; preserve agent registry/capability ownership rather than adding per-agent branches.
4. Provide idempotent repair for existing owned registrations, including configurations originally written by source installers when ownership is provable. Reuse `isMissionHookCommand`, normalized harness adapters and migration config publication. Preserve JSONC comments, unrelated hooks, user environment, permissions, disabled registrations and custom command syntax. Detect concurrent edits, keep recovery originals and report manual reconciliation rather than overwriting. Repair absolute paths after relocation without moving the app again.
5. Audit the statusline wrapper separately: it currently lives in source, not the packaged satellite inventory. If it is part of the owned packaged repair, bundle the wrapper with a build entry, package allowlist and smoke coverage, preserving the saved inner user command and reversible uninstall. Do not silently install or execute a third-party statusline through `npx` as a universal prerequisite. Third-party inner commands keep their own interpreters and feature-level diagnostics.
6. Project the actual daemon runtime/origin and relevant installed update capability through existing Setup owners. Use an additive browser-safe field/row shape only where needed; update server schemas, settings comparison, snapshot/SSE handling and client types together. Avoid a second runtime discovery service. Do not claim an adopted standalone daemon is bundled just because an Electron window is connected.
7. Make system Node informational or feature-scoped for the completed packaged lifecycle. Preserve selected path/version/source and useful remedies for genuine source/third-party use. Keep the append-only `node-runtime` id and older dismissal records readable; the shared attention predicate should still work for every genuinely required row. A missing external runtime must not hide another required Setup problem or suppress first-launch guidance. Unknown probe results must remain unknown rather than falsely ready.
8. Update Setup panel/banner copy, tour content source, update guidance and user documentation to explain that Electron still contains Node, while operators do not need their own Node for app installation/updates/owned tools. Source development, user projects and optional external tools retain their prerequisites. Regenerate generated tour/guide assets through their owners, never edit generated output. Include the correct source and retained HTML policy for any docs artifacts.
9. Supply this phase's integration inventory and checks to R2, which runs the complete signed no-Node journey after newly produced targets include this phase, in an isolated account/VM: first install, launch, owned hook/MCP/statusline/Pi-helper/resume execution, stable update, exact-SHA alpha update, failure/rollback or forward recovery, relocation and registration repair. Use both absent commands and invocation-recording traps. Confirm no owned app path invokes host Node/npm/npx and independently exercise the preserved source path with supported Node.

## Data, API and compatibility

Reuse Phase 1 runtime descriptors and Phase 4 binary-update capability. Existing external Node discovery remains owned by `ExecutableLocator`; it is still useful for independent tools. Do not delete the external Node executable id or remove the installer's source-runtime validation.

Any additive runtime-origin projection must describe the process actually serving the request. Unknown/old-daemon capability falls back to honest unknown/source wording, not a packaged assertion. Keep settings status comparators exhaustive and all UI update paths current. No new persistent global runtime preference is needed.

Config migration changes only confirmed Mission-owned script/executable fields, never arbitrary argv/env values or opaque user commands. Preserve legacy path and runtime ownership proofs together. A conflicting source registration may need an explicit repair action; a new resolver alone does not repair settings already on disk. Feature prerequisites must still represent third-party agent/Conductor requirements without implying they block the desktop engine.

## Tests and verification

Run the isolated test invocation from AGENTS.md for `test/mission-mcp-runtime-electron.test.ts`, `test/install-hooks.test.ts`, `test/electron-install-repair.test.ts`, `test/migration-integrations.test.ts`, `test/migration-integration-file.test.ts`, `test/migration-integration-ports.test.ts`, `test/setup-probes.test.ts`, `test/setup-catalog.test.ts`, `test/setup-snapshots.test.ts`, `test/setup-banner-condition.test.ts`, `test/setup-banner-render.test.ts` and affected helper/contract tests. Add missing-runtime, old shim, adopted-daemon, source-install, quoting/spaces, config race, custom command and repeat-repair cases.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`. Add/update and run `e2e/specs/setup-node-runtime.spec.ts`, `setup-banner-and-tour.spec.ts`, `setup-panel.spec.ts`, `pi-extension-setup.spec.ts`, `user-install-migration.spec.ts` and the changed integration repair flows. Assert readable runtime labels, no false universal banner, persistent unrelated required gaps, correct feature warnings and real action feedback. Measure border insets on any new modal, keep agents faked and capture inspected light/dark screenshots.

R2 final rollout proof covers NC-1 through NC-6 using the actual signed bundles and independent helper, not only fixture responses. Implementation acceptance uses the applicable focused, build, browser and real bundled-runtime regressions available in this phase; unavailable signed releases are tracked in R2 and do not block implementation completion. Register exact command outputs, synthetic receipt/identity comparisons and relevant screenshots. Do not put test credentials, personal config, live state or evidence files into Git. Document any third-party invocation separately so the no-host-Node claim is limited to the app and its owned code.

## Implementation completion and merge criteria

- All inventoried Mission-owned packaged helpers use a suitable app runtime, including repaired old registrations; source and custom commands retain their intended behavior.
- Old/missing system Node does not create a universal packaged Setup gap, and runtime origin is accurate for packaged, standalone and adopted daemons.
- Third-party and source requirements remain visible where relevant; no global PATH/version-manager configuration is changed.
- Applicable focused, typecheck, lint, build, smoke, browser and bundled-runtime checks pass, and user-facing docs describe delivered capabilities and outstanding release qualification accurately.
- Implementation of the host-Node-free lifecycle is complete. R1/R2 remain explicit release qualification follow-ups rather than an undocumented cleanup phase or an implementation dependency cycle.

## Downstream handoff

This is the final implementation phase. Maintain the runtime inventory, manifest/receipt protocols, publisher identity and pre-/post-commit recovery distinction in later changes. Any new app-owned satellite must use the same resolver and ship with execution coverage. Independent agent/project prerequisites remain outside this promise.

## Cross-phase audit record

- Re-read source/index and Phases 1-4: Setup follows the merged binary runtime implementation; the operator-approved forward rollout tracks real signed qualification in R1/R2 without waiving trust or recovery checks.
- Retained Phase 1 pure runtime ownership and Phase 3 config path migration. Added repair of previously persisted commands rather than relying on future installations alone.
- Explicitly distinguished source-only statusline installation from packaged wrapper support and third-party inner commands; the inventory must prove its scope.
- Final audit: NC-5 and Setup's NC-6 retain their implementation owner; R2 records the combined signed proof without redefining those contracts.
