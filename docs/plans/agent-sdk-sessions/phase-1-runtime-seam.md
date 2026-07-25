# Phase 1: the runtime seam

## Outcome

The codebase can represent, register, evict, and reason about a session that is not a
terminal pane - with zero behavior change. Every contract later phases build on (C1-C5 in
`phased-plan.md`) exists, is typed, and is pinned by tests. No SDK is installed, no
dispatch path changes, no operator-visible surface changes.

## Entry criteria and dependencies

- Direct prerequisites: none (first phase). The planning session's PR (these plan
  documents) must be merged so this phase can read them from the default branch.

## Scope

In: shared types (`SessionRuntime`, `PaneDialog` extensions, `runtimes` capability),
`canMessage` + the call-site sweep, registry registration/eviction seam +
`applyDriverEvent`, `SdkSpec` interface family + null declarations, supervisor skeleton +
`sdk_sessions` table, startup ordering, contract tests.

Non-goals: any driver implementation, any config/toggle, any dispatch change, any UI
affordance beyond compiling against the new field, any behavior difference observable by
an operator or by Foreman.

## Repository findings and inherited contracts

- `Session` (`src/shared/types.ts:234-457`); id today is always
  `proc:<tty>:<pid>:<startMs>` minted in `discovery/correlate.ts`.
- `SESSION_FIELD_COMPARATORS` at `src/server/registry.ts:4798`; a new `Session` field
  fails typecheck until it has a comparator (AGENTS.md contract).
- `applyDiscovery` (`registry.ts:770-830`) is the registry's only session source;
  eviction at `:803-812` marks anything a completed sweep did not see as `exited`, then
  `remove(id)` (`:3257-3273`) emits `session_remove`. Two subscribers (WorkflowManager,
  TaskManager) depend on that exact sequence - reuse it, never a parallel teardown.
- `canWriteTo` / `paneToken` / `innermostPane` (`@shared/pane.ts:73-106`) operate on
  `PaneHandles`, implemented by `Session` AND `DiscoveredSession`.
- `PaneDialog` / `PaneOption` (`@shared/types.ts`), comparator `byJson`
  (`registry.ts:4880`), stickiness fallback at `:929-934` (keyed on
  `canWriteTo(d)` over the *discovered* record - stays `canWriteTo`).
- Startup: `src/server/index.ts:140` `startPoller(registry)`; the comment at `:135`
  records the resume-after-first-sweep pattern this phase's ordering guarantee protects.
- Test doctrine: `node:test`, flat in `test/`, `HARNESS_HOME` preamble before imports for
  anything touching the DB (`db-isolation.test.ts` enforcement).

## Implementation steps

1. **`src/shared/types.ts`**: add `SessionRuntime = "terminal" | "sdk"`; add
   `Session.runtime: SessionRuntime` with a doc comment stating it is fixed for the life
   of an entry; extend `NameSource` with `"sdk"`. Add
   `SessionRequestQuestion { question: string; header?: string; options: PaneOption[];
   multiSelect?: boolean }` and extend `PaneDialog` with optional
   `source?: "pane" | "driver"`, `requestId?: string`,
   `kind?: "permission" | "question" | "plan" | "approval" | "trust"`,
   `questions?: SessionRequestQuestion[]`. Absent fields mean a pane dialog; the pane
   parser is not modified.
2. **`src/shared/pane.ts`**: add
   `canMessage(s: PaneHandles & { runtime: SessionRuntime }): boolean` returning
   `canWriteTo(s) || s.runtime === "sdk"`, with a doc comment separating the two
   questions (deliver a turn vs drive a pane).
3. **Call-site sweep** (behavior-preserving: no session has runtime `"sdk"` yet, so
   `canMessage === canWriteTo` everywhere today). Move to `canMessage` (delivery
   intent): `ActionBar.tsx:99`, `SessionCard.tsx:162`, `ConsoleDetail.tsx:171`,
   `App.tsx:1467`, `lib/format.ts:308`, `ForemanNote.tsx:44`, `ForemanStrip.tsx:47`,
   `ModePicker.tsx:49`, `EffortPicker.tsx:56`, `foreman/queue-machine.ts:145`
   (`hasPane`), `foreman/pending.ts` (`canSend` sites), `tasks.ts:1414`
   (`clearsContext`). Keep `canWriteTo` (pane mechanics): `registry.ts:929`
   (DiscoveredSession stickiness), focus/rename/kill paths in `actions.ts`, pane locks,
   `skills/reload.ts` gates, capture tolerance. Record the final table in the PR
   description; a new `test/pane-predicates.test.ts` pins `canMessage`'s truth table.
4. **`src/server/harness/types.ts`**: add the C4 interface family exactly as specified in
   the source plan's Architecture section (`SdkSpec`, `SdkLaunchOptions`,
   `SdkSessionHandle`, `SdkEvent`, `SdkUsage`, `SessionRequestAnswer`), with doc comments
   carrying the null doctrine (nullable `setPermissionMode` / `setModel` /
   `clearContext` are capability answers, not stubs). Add `sdk: SdkSpec | null` to
   `Harness`.
5. **`src/server/harness/index.ts`**: declare `sdk: null` on all three harnesses (with a
   one-line comment each naming the phase that fills it); add `sdkFor(agent)` accessor
   beside `hooksFor`.
6. **`src/shared/harness-capabilities.ts`**: add
   `runtimes: readonly SessionRuntime[]` to `HarnessCapabilities`; declare
   `["terminal"]` for all three agents (claude gains `"sdk"` in phase 2, codex in 4, pi
   in 6). New `test/harness-sdk.test.ts` pins
   `runtimes.includes("sdk") === (HARNESSES[a].sdk !== null)` for every agent.
7. **`src/server/registry.ts`**:
   - `SESSION_FIELD_COMPARATORS.runtime = byValue`.
   - `registerSdkSession(input: { id: "sdk:"-prefixed; agent; name; cwd; taskId?; ... })`
     creating a full `Session` (runtime `"sdk"`, `tty: null`, `terminals: []`,
     `nameSource: "sdk"`, `pid` of the subprocess once known, state `"starting"`) and
     emitting the normal session-new event.
   - `applyDriverEvent(id, evt: SdkEvent)`: `bound` fills `agentSessionId` /
     `transcriptPath` and sets `instrumented` / `stateConfirmed` / `hooksSeen` true
     (C5 - this is what keeps the read path and instrumentation gates working);
     `state` / `request` / `request_resolved` / `turn_done` / `exited` update state,
     activity, `paneDialog` (driver-sourced), and the exited path reuses the existing
     `exited` + linger + `remove` sequence so `session_remove` fires identically.
   - Scope `applyDiscovery` eviction (`:803-812`) to sessions with
     `runtime === "terminal"`; SDK sessions are never marked exited by a sweep.
   - `discoveredIdentity` is untouched: it is a claim about processes read via `lsof`,
     which SDK sessions do not need (the supervisor owns their identity).
8. **`src/server/db.ts`**: `CREATE TABLE IF NOT EXISTS sdk_sessions (id TEXT PRIMARY KEY
   NOT NULL, agent TEXT NOT NULL, agent_session_id TEXT, cwd TEXT NOT NULL, task_id
   TEXT, model TEXT, effort TEXT, permission_mode TEXT, status TEXT NOT NULL, created_at
   INTEGER NOT NULL, updated_at INTEGER NOT NULL)`. New table: no `migrate()` entry, no
   index outside the block, no REFERENCES, no backticks in the SQL block.
9. **`src/server/sdk/supervisor.ts`** (skeleton): the class, its persistence
   (read/write `sdk_sessions`), a `restore()` that loads rows and - with no drivers
   declared yet - marks any row `status = "running"` as `failed` (defensive; none can
   exist), and the event-pump plumbing typed against `SdkSessionHandle`. Construct it in
   `src/server/index.ts` and `await supervisor.restore()` BEFORE `startPoller(registry)`
   (`:140`), with a comment stating the C5 ordering contract next to the existing `:135`
   comment.
10. **Tests**: `session-runtime.test.ts` (register → snapshot shape → driver exited →
    `session_remove` observed; sweep does not evict an SDK session),
    `pane-predicates.test.ts`, `harness-sdk.test.ts`, `sdk-db.test.ts` (table exists on
    a pre-feature database file - seed like `schedule-db.test.ts`), plus
    `session-contracts.test.ts` updates for the new field. All DB tests use the
    `HARNESS_HOME` preamble.

## Data and compatibility

- Wire: `Session.runtime` is a new always-present field (browser tolerates unknown
  fields; `useEventStream` needs no new case - no new `ServerEvent` variant is added).
- `PaneDialog` extensions are optional fields; existing pane dialogs are byte-identical.
- DB: additive table only.

## Verification

`npm run typecheck && npm test && npm run build`, then `make start` and confirm the
dashboard is pixel-identical for existing terminal sessions (cards, console, board), a
dispatch still works, and Foreman still answers a pane menu (no regression in the
predicate sweep).

## Merge / exit criteria

CI green on Node 24/26; the new contract tests exist and pass; zero operator-visible
change; the PR description carries the final `canMessage`/`canWriteTo` call-site table.

## Downstream handoff

Later phases may rely on: C1-C5 exactly as written here (types, registry APIs, table
schema, startup ordering, predicate semantics). Later phases must not: add a second
registration path, key anything on the `sdk:` id prefix instead of `runtime`, or evict
SDK sessions from discovery code.

## Cross-phase audit record

- 2026-07-24: initial version. Claude's `runtimes` deliberately stays `["terminal"]`
  here so the phase is inert; phase 2 flips it with the driver (C4's contract test forces
  the two to move together).
