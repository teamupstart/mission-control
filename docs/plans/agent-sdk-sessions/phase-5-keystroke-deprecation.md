# Phase 5: deprecation of the dispatched-session keystroke surfaces

## Outcome

The SDK runtime is the documented, fully-gated path for dispatched Claude and Codex
sessions; the machinery that only existed to make keystroke dispatch survivable is
retired where SDK dispatch makes it unreachable; and the enduring terminal surface
(operator-started sessions, terminal-runtime dispatches, pi until phase 6) is documented
as deliberate, not residue. Defaults are NOT flipped - cut-over remains the operator
flipping each harness's toggle (resolved decision).

## Entry criteria and dependencies

- Direct prerequisites: phases 3 and 4 merged.
- Runs concurrently with phase 6 (different files; README edits in different sections -
  either merge order, trivial adjacency resolution).

## Scope

In: the combined E2E gate (both harnesses, full automation cycle on the SDK runtime),
dead-code retirement, documentation (README + AGENTS.md), and an audit pass over
interim scaffolding.

Non-goals: flipping any stored or schema default; removing ANY keystroke machinery that
operator-started sessions or terminal-runtime dispatches still exercise (the pane stack
is a permanent surface, smaller, not gone); pi (phase 6).

## Repository findings and inherited contracts

Inherits C1-C10. What is actually retire-able is narrow, because the terminal runtime
remains selectable per harness and operator sessions keep the whole pane stack:

- `waitForSessionAtCwd`, plus `awaitReady` / `deliverIntent` where a terminal launch still
  needs them, remain live and are NOT removable; verify the sdk branch never reaches
  them and mark them terminal-branch-only in comments. Pi's terminal launch now carries
  turn one natively; the current contract is owned by the
  [README](../../../README.md#dispatch-an-agent).
- The ask-channel AskUserQuestion redirect (`askChannelArgs`): still live for
  terminal-runtime Claude dispatches - NOT removable; phase 2 already scoped it.
- Phase 2's interim SDK-queue refusal: removed by phase 3 - verify no trace remains.
- What IS retire-able: any scaffolding this plan itself introduced that the final shape
  obsoleted (grep the phase diffs), plus stale claims in comments/docs that say
  delivery is keystroke-only (e.g. the `ControlSpec` doc's "declared, unimplemented"
  framing - the stream-json variant is now either implemented via the SDK path or
  superseded by `Harness.sdk`; reconcile that comment and
  `docs/plans/pluggable-integrations/plan.md`'s note with a pointer here).

## Implementation steps

1. **Combined E2E gate** (the real deliverable): with both toggles on, for each of
   Claude and Codex - dispatch → structured permission ask answered from the card →
   AskUserQuestion / approval answered by Foreman → two queue items picked up, verified,
   wrap-up (`no-mistakes` line delivered over `send()`) → PR opened → Inspector adopts →
   daemon restart mid-run resumes both sessions → handoff to terminal continues one of
   them. With both toggles off: dispatch each and confirm the terminal path end to end.
   Record the transcript of this gate in the PR description.
2. **`ControlSpec` reconciliation**: decide the final spelling - either the sdk path
   registers as the `{ kind: "stream-json" }` variant's implementation via
   `controlFor(session)` returning it for SDK-runtime sessions (and the two refusal
   sites become unreachable-by-construction for SDK sessions because delivery routes
   through the supervisor before `controlFor` is consulted), or the variant is retired
   in favor of `Harness.sdk` with the doc comment updated. Preference: make
   `controlFor(session)` return `{ kind: "stream-json" }` for `runtime === "sdk"` so the
   type finally tells the truth; keep the refusal sites as the backstop they were built
   to be. Update `harness-control.test.ts` accordingly.
3. **Dead-scaffolding sweep**: grep phases 1-4's diffs for interim constructs (temporary
   guards, TODO-phase markers) and retire them; confirm `applyDiscovery`, locks, capture
   tolerance, dialog walks, mode walks are untouched (operator surface).
4. **README**: the Session runtimes section gains the deprecation statement - the SDK
   runtime is the recommended path for dispatched sessions; the terminal runtime remains
   for operator-started sessions and by choice per harness; defaults unchanged. Note
   which affordances are runtime-specific (Focus vs Continue in terminal).
5. **AGENTS.md**: add the supervisor to the architecture table (in-daemon, why);
   extend "A session going away" with the SDK arm (driver `exited` → same
   `session_remove`; restore-before-first-sweep as the restart twin); extend the
   layout-parity notes with the runtime chip; record the `canMessage` / `canWriteTo`
   split under shared predicates.
6. **Pluggable-integrations plan**: append the pointer note (its `stream-json` seam is
   now occupied; link here).

## Data and compatibility

No schema changes. No default changes (assert in a test: a fresh
`HarnessesConfigSchema.parse({})` yields `"terminal"` for every agent - pinning the
resolved decision against a future well-meaning flip).

## Verification

Step 1 is the verification. Plus CI, plus a docs read-through against the shipped
behavior (stale docs are a rejected change).

## Merge / exit criteria

CI green; the E2E gate transcript recorded; the default-pinning test exists; README /
AGENTS.md / pluggable-integrations updates landed in this PR; no keystroke machinery
that terminal sessions exercise was removed.

## Downstream handoff

Phase 6 may rely on: the documented final shape and the default-pinning test. Nothing
here constrains phase 6 beyond C1-C9 (it does not touch Codex or the deprecation docs'
harness-specific rows, which are computed from capabilities).

## Cross-phase audit record

- 2026-07-24: initial version. Step 2's `ControlSpec` decision is recorded here rather
  than phase 1 because it is a truth-telling cleanup over the finished system, not a
  contract earlier phases consume; nothing in phases 1-4 reads
  `controlFor` for SDK sessions (delivery routes through the supervisor), so either
  outcome is compatible with everything already merged.
- 2026-07-24 (phase 6 audit): runs concurrently with phase 6; the only shared file is
  README (different sections - this phase's deprecation statement vs phase 6's pi row).
  Merge in either order; whichever lands second resolves the trivial adjacency.
