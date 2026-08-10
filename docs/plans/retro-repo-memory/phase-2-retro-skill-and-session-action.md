# Phase 2: Retro skill, session action, and delivery route

## 1. Outcome

The retro is executable end to end, without any dashboard UI: a `retro` skill carries the
retrospective instructions, a built-in `retro` SessionAction delivers them into a
session, a new `repo_commit` completion adapter proves the memory commit landed, and a
new `POST /api/sessions/:id/retro` route delivers the action into a live session or
falls back to dispatching a dedicated retro task when the session is gone (the source
plan's R1-with-R3-fallback decision). After this phase an operator can trigger a retro
with curl; phase 3 adds the buttons.

## 2. Entry criteria and dependencies

- Phase 1 merged. This phase imports `MEMORY_DIR`, `MEMORY_INDEX_PATH`, and
  `MEMORY_REFERENCE_MARKER` from `src/shared/memory.ts` and writes skill instructions
  that assume the loading behavior phase 1 shipped.

## 3. Scope and non-goals

In scope:

- `skills/retro/SKILL.md` (new skill, filesystem-discovered).
- `src/shared/skills.ts`: `RETRO_SKILL` id constant.
- `docs/session-actions/retro.md` (new authored source) plus the regenerated
  `src/server/workflows/builtin-session-actions.generated.ts` via
  `npm run session-actions`.
- `src/server/workflows/builtin-session-actions.ts`: the `retro` contract entry.
- `src/shared/workflow.ts`: the `repo_commit` completion kind (append-only vocabulary).
- `src/server/workflows/session-action-adapters.ts`: the `repo_commit` adapter.
- `src/server/routes.ts`: `POST /api/sessions/:id/retro`.
- Tests and README.

Non-goals:

- No UI affordances, no retro-worthiness computation, no `Session.retro` field
  (phase 3).
- No workflow graph changes: the retro is not a graph stage (source plan, "Soliciting
  the retro").
- No daemon-side commits: the session's agent turn commits, always.

## 4. Repository findings and inherited contracts

- Builtin session actions are generated: `docs/session-actions/<slug>.md` is the source,
  `npm run session-actions` (scripts/builtin-session-actions.ts) regenerates
  `builtin-session-actions.generated.ts` (slug = filename, name = H1, description =
  summary line), and a test asserts the committed module equals a fresh render. The
  contract table `BUILTIN_SESSION_ACTION_CONTRACTS`
  (`src/server/workflows/builtin-session-actions.ts:39-47`) maps slug to
  `{ requiredSkillId, completion }`; an unlisted slug silently defaults to
  `{ requiredSkillId: null, completion: { kind: "session_turn" } }`, so the `retro`
  entry is mandatory, not optional.
- Skills are filesystem-discovered from `skills/<id>/SKILL.md` (id = directory name,
  `src/server/skills/catalog.ts:234-268`). Required frontmatter: `name`, `description`,
  `metadata.mission.category`, `metadata.mission.enforcement` (one of `opportunistic |
  triggered | intercepted | always-on`). A new skill defaults OFF in `SkillsConfig`
  (`src/shared/protocol.ts:1246-1276`); delivery of an action whose `requiredSkillId` is
  not enabled fails closed through `requiredSkillCommand`
  (`src/server/skills/invoke.ts:49`). Rollout therefore includes the operator enabling
  the `retro` skill in the skills panel; document this in README.
- `SESSION_ACTION_COMPLETION_KINDS` (`src/shared/workflow.ts:307-316`) is APPEND-ONLY
  per the change contracts. Adding `repo_commit` touches: the kinds array, the
  `SessionActionCompletion` union, a `SESSION_ACTION_COMPLETION_CAPABILITIES` entry, and
  the `SESSION_ACTION_ADAPTERS` record
  (`src/server/workflows/session-action-adapters.ts:396-403`), whose exhaustive
  `Record<Kind, Adapter>` type makes omission a compile error.
- The adapter context already carries what a commit-proof needs:
  `SessionActionRepositoryFacts.headOid` and `capturedHeadOid`
  (`session-action-adapters.ts:23-79`). "A commit landed after delivery" is head-OID
  advance; path-level inspection of what the commit touched is deliberately out of
  adapter scope (review owns content).
- **Discrepancy corrected from the source plan:** session actions today are delivered
  only by workflows to their bound session (`manager.prepareSessionAction`,
  `src/server/workflows/manager.ts:3401`). The plan implied reusing that path; it is
  workflow-coupled (run bindings, delivery ledger, run status transitions). The honest
  standalone shape for an on-demand retro is a route that composes the same primitives:
  `renderSessionAction` (`src/server/workflows/feedback.ts:383`, refuses rather than
  truncates), the `requiredSkillCommand` gate, injection via the actions layer, and
  `rememberInjection` so transcript attribution knows the turn was machine-typed.
- The R3 fallback creates a task through the existing `tasks.create`
  (`src/server/tasks.ts:1010`); the daemon stays out of git.

## 5. Implementation steps

1. `src/shared/skills.ts`: add `export const RETRO_SKILL = "retro";` beside
   `PULL_REQUEST_SKILL` (`skills.ts:51`).
2. `skills/retro/SKILL.md` with frontmatter (`name: retro`, one-line `description`,
   `metadata.mission.category: shipping`, `metadata.mission.enforcement: triggered`) and
   instructions that tell the session to:
   - re-read its own transcript through `GET /api/sessions/:id/transcript`, focusing on
     human turns and treating machine-injected turns as best-effort attribution;
   - identify user corrections, guidance, and avoidable issues;
   - propose AT MOST 3 memories (fewer is better than filler; proposing a deletion or a
     promotion into AGENTS.md counts as a proposal) via the Mission Control
     `request_plan_decisions` MCP tool, one decision per memory with approve / reject
     options and free-text edit;
   - on approval: write `.agents/memory/<slug>.md` topic files with front-matter
     (category, date, source session, times-confirmed) and update the
     `.agents/memory/MEMORY.md` index (one line per memory); validate
     index-matches-directory;
   - bootstrap the reference line: check the repo's real root doc (AGENTS.md, else
     CLAUDE.md, resolving symlinks) for `MEMORY_REFERENCE_MARKER`; add the line only if
     absent; create a minimal AGENTS.md when neither doc exists;
   - never store secrets, tokens, per-user paths, or machine state; never duplicate
     what AGENTS.md already says; keep each memory well under the 24KB standards cap;
   - commit the result on the current branch (never a new branch, never a push policy
     change) with a plain `docs(memory): ...` message.
3. `docs/session-actions/retro.md`: H1 `# Retro`, a one-line summary, and prompt
   markdown that instructs the session to run the retro now for the work it just
   completed. Keep it short; the skill carries the procedure
   (`renderSessionAction` puts the skill invocation line first).
4. Run `npm run session-actions`; commit the regenerated module.
5. `src/server/workflows/builtin-session-actions.ts`: add
   `"retro": { requiredSkillId: RETRO_SKILL, completion: { kind: "repo_commit" } }` to
   the contract table and export
   `RETRO_SESSION_ACTION_ID = builtinSessionActionId("retro")`.
6. `src/shared/workflow.ts`: append `"repo_commit"` to
   `SESSION_ACTION_COMPLETION_KINDS`; add the union arm
   `{ kind: "repo_commit" }` to `SessionActionCompletion`; add the capabilities entry
   (label along the lines of "Repository commit", available on harnesses that report
   repository facts).
7. `src/server/workflows/session-action-adapters.ts`: implement `repoCommit`:
   - `validateSnapshot`: null (any prompt is deliverable);
   - `decide`: `waiting` while `repository` facts are missing or
     `repository.headOid === capturedHeadOid`; `complete` with
     `continuationExpectation: { kind: "none" }` once the head OID has advanced;
     `blocked` when the session has exited without a commit;
   - `validateCapture`: accept only `kind: "none"` expectations (mirror
     `session_turn`).
   Register it in `SESSION_ACTION_ADAPTERS`.
8. `src/server/routes.ts`: `POST /api/sessions/:id/retro`:
   - session live and messageable: resolve the builtin retro action, run the
     `requiredSkillCommand` gate (404/409 with a clear error when the skill is not
     enabled), render via `renderSessionAction`, inject, `rememberInjection`, return
     the delivery record;
   - session gone (or not messageable): resolve the repo context from the session's
     task when one exists and create a backlog retro task via `tasks.create` whose
     intent names the branch or PR and instructs a retrospective per the retro skill;
     return the created task. This is the R3 fallback; transcript access for dead
     sessions is best-effort and the intent says so.
9. Tests in `test/`:
   - contract table: `retro` maps to `RETRO_SKILL` + `repo_commit`; generated parity
     test already enforces the regenerated module;
   - adapter: waiting before head advance, complete after, blocked on exit,
     capture validation;
   - route (in-process HTTP): live fake session receives the rendered action and the
     injection is attributed; dead session yields a created backlog task; skill-disabled
     yields the fail-closed error.
10. README: the retro feature, how to trigger it over HTTP, and the operator enablement
    step for the `retro` skill.

## 6. Data, API, and migration details

- `repo_commit` joins a persisted append-only vocabulary; per the change contracts it is
  appended, never reordered, and never renamed after merge. No SQLite migration.
- New API route `POST /api/sessions/:id/retro`; response is either a delivery record or
  a created `Task` (discriminate with an explicit `kind` field in the response body).

## 7. Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`
- `npm run session-actions` produces no diff after the commit
- `npm run build && npm run smoke` (runtime surface changed)
- No e2e spec: the route has no UI surface yet; phase 3 owns the browser path.

## 8. Merge and exit criteria

- Section 7 green locally and in CI.
- A curl against a live fake session delivers the retro action text into the session
  (proven by the in-process route test), and the adapter completes on a head-OID
  advance.
- README documents trigger and enablement.

## 9. Downstream handoff

Phase 3 may rely on:

- `POST /api/sessions/:id/retro` and its response contract.
- `RETRO_SESSION_ACTION_ID`, `RETRO_SKILL`, and the `repo_commit` kind name.

These are append-only or frozen after this phase merges: the completion kind and the
skill id are persisted vocabulary; the route shape may gain fields but not lose them.

## 10. Cross-phase audit record

- 2026-08-04: Initial version. Standalone delivery route chosen over reusing
  `manager.prepareSessionAction` after verifying the workflow coupling; recorded as a
  discrepancy against the source plan. Depends on phase 1's shared constants.
