# Phase 1: Managed repository plans and HTML policy

## Implementation baseline

This task owns its full scope below. Start from the merged planning PR; this planning
PR contains no settings, storage, prompt, skill, or test implementation. Earlier uncommitted
prototype work was excluded from delivery and must not be treated as a merged foundation.
Recheck the repository findings and adapt the proposed route while preserving the outcomes.

## Outcome and entry criteria

Deliver repository plans whose Markdown is committed by default while generated HTML remains reviewable without entering Git. The operator can explicitly include HTML. A daemon-managed artifact path preserves previews, identity, and complete saved revisions independently of a disposable checkout.

Read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) first. This phase starts after this planning session's artifact publication. It has no implementation-phase prerequisite and touches only `mission-control`.

This file is the proposed route, not an immutable implementation specification. Preserve the approved outcomes and cross-phase contracts; use current repository evidence to improve the route and record material deviations in the PR.

## Scope and non-goals

Own PS-01 through PS-05, the namespace and durable-preview foundation of PS-07, and the relevant PS-12 coverage. Include schema, persistence, tools, settings UI, preview, capture, skills, documentation, and tests in this PR.

Do not enable the entire-plan local option yet. Do not change ordinary dependency satisfaction, make a local-only plan task complete without a PR, add remote sync, migrate historical tracked plans, or modify CI/release infrastructure. Do not ship a disabled or ineffective local-storage setting as a placeholder.

## Repository findings

- `SkillsConfigSchema` and `SkillsConfigPatchSchema` in `src/shared/protocol.ts` own saved skills preferences. The latter explicitly picks writable fields. `SkillsView` in `src/shared/types.ts`, `skillsView` in `src/server/routes.ts`, and `optimistic` in `src/web/useSkills.ts` project fields explicitly.
- `src/shared/app-config-entries.ts` classifies every skills field for snapshots. `src/server/skills/config.ts` already distinguishes missing from corrupt saved data and owns the reload watermark. A policy-only write must not change that watermark.
- `src/server/plans/prompt.ts`, `src/shared/plans.ts`, and both planning skills currently assume adjacent checkout Markdown and HTML. `src/shared/task-completion.ts` currently describes all referenced artifacts as committed and pushed.
- `src/server/plans/capture-plan.ts` excludes ignored HTML as its primary page. `src/server/plans/capture-scopes.ts` discovers only Git changes. Artifact relocation and capture integration must ship together.
- `src/server/session-files.ts` rejects paths escaping the checkout. Archive readers in `src/server/routes.ts` and the browser archive view use opaque identifiers and restricted content serving. Do not broaden the session-file endpoint.
- `src/server/config.ts` owns state-home paths, and `src/server/repos.ts` resolves linked worktree ownership. Reuse those sources of truth.

## Implementation route

### 1. Define the policy and persistence owner

Add `commitPlanHtml`, default false, to the existing skills configuration owner and patch schema. Include it in the backup field classification, restore coverage, returned view, optimistic update, and settings search anchor. Validate old settings without that key. Keep the control usable as a saved preference even when skill links are disabled; the master switch controls installation, not whether a preference can be configured.

Introduce browser-safe plan policy/revision schemas by extending `src/shared/plans.ts` or a focused adjacent module. A managed plan records stable id, canonical repository identity, originating task/session and work episode where available, pinned repository-mode policy, and its revision references. Reserve room in the discriminated contract for Phase 2 without accepting an unsupported local mode through the Phase 1 API.

Add focused daemon plan persistence next to `src/server/plans/`, with schema/migration ownership in `src/server/db.ts`. Operational rows track attribution, policy, revision pointers, and write intents. Immutable on-disk manifests hold file inventories and digests. Do not store a second editable copy of repository Markdown or use the settings blob as a plan database. Foreign-key/retention decisions must keep published revisions alive when task rows or sessions disappear.

For every persistent change, update fresh-create and upgrade paths together, create indexes only after required columns exist, and test upgrading an old database. Default a missing key; refuse managed writes on a corrupt stored configuration instead of using the fallback returned for a disabled skills catalog.

### 2. Implement the managed writer and exact revision reader

Derive the store from `STATE_DIR` and the canonical owning repository. Use a sanitized display name, a collision-safe repository key, opaque plan id, and immutable revision directory. Keep authorization based on registered session repository scope, not possession of a display name or caller-supplied absolute directory.

A proposed interface has three operations: `get_plan_context` resolves authorized repository locations and policy; `save_plan` creates or updates a plan with an expected revision and a bounded artifact inventory; `read_plan` resolves an exact id/revision/file or returns a bounded catalog for discovery. Naming may change; retain those responsibilities and avoid one tool per filesystem primitive.

Prefer bounded content payloads for Markdown and self-contained HTML. Use existing artifact/path validation for imported companion files if needed. Reject absolute paths, traversal, symlink components, unknown roots, invalid encodings, duplicate destinations, case-insensitive filename collisions, excessive file counts/bytes, and unauthorized repositories. Reuse applicable archive limits and HTML validation instead of inventing a weaker parallel policy. An artifact rejected by the format must be reported, never silently dropped from the complete bundle.

Create the plan's pinned policy once. Subsequent saves use it and compare the expected revision, rather than consulting a newly changed setting. Stage and verify all local bytes before exposing a new manifest. Repository output contains `.md` files and, only when enabled, `.html` files. Other review companions remain in the local revision. Never write excluded HTML to a normal checkout path as an intermediate step.

Repository writes are conflict-aware and restart-safe: compare expected file digests before replacing daemon-owned output, persist a recoverable intent, and finish only matching in-flight writes. Do not overwrite an operator edit, reset the index, delete a legacy file, or claim that an atomic rename makes writes across Git/SQLite/filesystems atomic. A failure has an explicit incomplete result and no publication receipt.

On a request to edit an unmanaged legacy plan, preserve its established tracked layout. Do not infer that a newly defaulted preference authorizes removing its HTML. Provide an explicit refusal for an unsupported migration rather than silently applying new-plan placement to tracked files.

### 3. Expose attributed tools and required launch capabilities

Add schemas and `parseBody` routes in the normal daemon boundary; add the mirrored MCP argument schemas in `src/mcp/server.ts`. The bridge attaches its own launch identity, and the daemon resolves task/repository scope using the existing attribution pattern. Do not let an agent nominate the session owner or change the resolved storage policy through a save request.

Update `src/server/plans/tools.ts`, the `MISSION_MCP_TOOLS` registry and relevant required-tool declarations in `src/server/mission-mcp.ts`, plus smoke/handshake expectations. A plan task must refuse before launch if the built MCP server cannot provide the managed writer. Registered non-plan sessions invoking a planning skill can use the same tools; missing registration produces an actionable error rather than a fallback that writes excluded HTML into Git.

### 4. Keep previews and archives complete

Return exact source references and a scoped preview locator after each saved revision. Add a guarded read/preview route using opaque plan/revision/file identifiers and existing HTML sandbox/CSP behavior. Integrate with the current file/archive UI affordances in `src/web/components/FileWorkspace.tsx`, `src/web/components/scouts/ScoutReader.tsx`, and `src/web/lib/htmlPreview.ts`; do not invent a new general filesystem browser.

Render the root HTML and phased index even when HTML commits are off. Resolve relative Markdown/phase links through the virtual bundle inventory so splitting physical locations does not break navigation. Clearly identify the revision being viewed and refuse mismatched digests. This phase needs a usable preview before a plan has merged, not only an archive available after cleanup.

Extend plan capture through registered, verified revision inputs in `src/server/archives/manager.ts` and the plan capture adapter. Keep `ArchiveLibrary` and existing archive publication as the sole owners of archive bundles. Legacy unregistered plans continue using diff discovery. Do not globally allow ignored files or arbitrary external roots in the archive walker. An HTML omission required by policy is not a missing-artifact error; an actually missing registered preview is.

### 5. Update the static skill and completion contracts

Update `skills/html-plans/SKILL.md` and `skills/phased-plan/SKILL.md` once to resolve the daemon context before writing, save through the managed path, review the returned HTML, and cite Markdown sources. Do not rewrite symlink targets or generate skill variants when a preference changes.

Update `src/server/plans/prompt.ts`, `src/shared/plans.ts` comments/contracts, and `src/shared/task-completion.ts` so repository publication verifies Markdown and policy-included HTML, while policy-excluded HTML is verified in local retention. Preserve current commit/push and planning-PR merge prerequisites for repository-mode phase scheduling. The existing `create_task` calls can still use repository-relative Markdown pointers in this phase.

Include current saved plan text and applicable phase context in workflow evidence. Personas cannot open local paths, so a preview URL or file path alone is not evidence. Use the existing registration mechanism rather than weakening judges or assuming they can read the new store.

### 6. Deliver the UI and documentation

Add the "Commit generated HTML plan files" checkbox to Settings > Skills, unchecked by default. Explain that HTML is still generated for review and that preferences apply to new managed plans. Use the existing settings row conventions and accessible selectors. Add search indexing and browser persistence/error-state coverage.

Update `README.md`, `docs/skills-and-settings.md`, `docs/archives.md`, and affected architecture/change-contract paragraphs so they no longer promise that all HTML accompanies Markdown in Git. Explain which source is authoritative, the local preview path, and the absence of automatic migration or backup. Preserve the root instruction's test-preload documentation ownership; link to it instead of restating its rationale elsewhere.

## Data, API, and compatibility details

- Existing installations get false for the missing HTML setting. A corrupt config is refused for managed writes, not treated as consent to a default destination.
- Additive plan tables/fields are upgraded in the existing migration flow. Manifests and publication records are versioned; unknown versions refuse, not reinterpret.
- Repeated identical saves with the same idempotency identity return the same revision. A stale expected revision with different bytes conflicts. No overwrite-by-filename behavior.
- Local state roots and repository identity come from existing owners. Plan ids are opaque; the root cannot be chosen by the MCP caller.
- Preserve strict `PlanPublicationContextSchema` ownership semantics. Storage context belongs in a distinct contract, not an extra field an older strict client cannot parse.
- Excluded HTML is a local preview; it is not a second Markdown authority. Legacy plans and existing archive bundles remain readable.

## Verification and evidence

Add focused unit/integration tests for settings defaults, upgrade/restore, unchanged reload generation, attributed writes, all repository-mode file eligibility, same-name repositories, linked worktrees, revision conflicts, corruption, path escapes, symlink swaps, interrupted writes, and recovery without overwriting user edits. Use isolated Git repositories to run ordinary staging and inspect exactly which plan paths enter the index.

Extend relevant coverage in `test/skills-config.test.ts`, `test/settings-backup-coverage.test.ts`, `test/plan-prompt.test.ts`, `test/plan-capture.test.ts`, `test/plan-publication.test.ts`, and `test/mission-mcp.test.ts`. Add focused new plan-store tests as needed. Existing named tests are regression starting points, not a request to mechanically mirror implementation.

Add `e2e/specs/plan-storage.spec.ts` for the new checkbox, its persistence, repository Markdown-only output, HTML opt-in, and rendered previews with working phase links. Use fake agents and real daemon routes; no model calls or `data-testid`. A new modal must use `expectContentClearsBorder` as required by the repository.

Use the repository's single-file test command from AGENTS.md for focused tests. Then run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and the relevant E2E spec, followed by the repository-required initial validation appropriate to the completed change. CI/workflow repair rounds use issue-specific checks instead of rerunning the full suite.

Register focused command output and screenshots proving the setting and preview. Evidence remains gitignored. Demonstrate that a saved preview still resolves after its disposable authoring checkout is removed; merely asserting a manifest field is insufficient.

## Merge and exit criteria

All phase-owned acceptance criteria pass. Repository mode produces a human-reviewable plan through the managed tools, with the new default and HTML opt-in working from Settings to Git eligibility, preview, and archive. Both terminal and SDK launch paths enforce required tool availability through shared capabilities. Legacy plans still work. No visible whole-plan local option exists until Phase 2.

Open the scoped PR according to the assigned task's handoff and workflow. Resolve valid review feedback and conflicts, and complete required CI follow-through when that later workflow authorizes it. The merge is Phase 2's implementation prerequisite.

## Downstream handoff

Phase 2 may rely on the tested namespace, immutable revision identity, pinned policy, daemon writer, scoped preview/reader, capture adapter, and configuration owner. It adds a storage enum and publication readiness; it must not fork these mechanisms. Record final exported types, tool names, table/manifest versions, and their test coverage in the PR so Phase 2 can follow the actual merged implementation.

## Cross-phase audit record

2026-10-06: Compared this phase with the source and implementation index. Kept local mode out of Phase 1 to avoid a setting that strands tasks. Included archive and preview changes with HTML relocation because the current capture rejects ignored/missing checkout HTML. Clarified that saves are not publication and that future tasks still use repository Markdown and the existing merge condition. Re-read the completed Phase 2: it consumes these exact artifact contracts and keeps local task readiness and workflow changes out of this phase.

2026-10-08: Restored this phase's full implementation scope for the operator-requested plans-only PR. Removed the prototype-baseline exception; the original task brief and direct dependencies remain unchanged.
