# Phase 6: Dispatch, Inspector, and Foreman weave

## Outcome

Pipelines join MC's own loops: the dispatch modal offers a `pipeline` kind that launches
`engineer --idea` as a terminal session in an enabled repo; pull requests that conductor
pipelines open are adopted by the Inspector under a `pipeline` source and appear in Shipped; and
the Foreman can (opt-in) triage `mechanical`-class halts through the phase 4 action routes,
always escalating `needs-human` to the operator.

## Entry criteria and dependencies

- Direct prerequisite: Phase 4 (the action routes Foreman triage drives; the operable run
  detail a dispatched pipeline lands on).
- Transitively phases 1-3 (contracts, Pipelines tab, correlation and halts).

## Scope

- **Dispatch kind** (append-only): `pipeline` joins `TASK_KINDS` in `src/shared/types.ts` with
  its info record. The guided pass (`src/web/lib/guided-dispatch-steps.ts`, `GuidedDispatch.tsx`,
  `DispatchModal.tsx`) picks the kind up mechanically from the registry; do not branch on the
  concrete kind in components beyond what the registry describes. The kind is offered only for
  repos with conductor enabled. Constraints the engine imposes, surfaced as a note in the
  modal: terminal runtime only (conductor's `engineer` refuses to nest under a `CLAUDECODE`
  environment and reads a real stdin), so the SDK runtime and autopilot paths are excluded for
  this kind.
- **Launch path**: dispatching a `pipeline` task launches `engineer --idea "<intent>"` in the
  target repo as a terminal session through the existing session launchers, with a scrubbed
  environment (no inherited `CLAUDECODE`). The resulting agent sessions correlate through the
  phase 3 rule with no special-casing; the dispatch surfaces link to the run via the phase 2
  hash helper once the slug exists in the projection.
- **Inspector adoption**: extend `InspectorSource` (`"hook" | "legacy"` at
  `src/shared/types.ts:2041` at `dc2d99a`) with `"pipeline"`, and call the existing
  `adoptPr(url, ctx, source, ts)` (`src/server/foreman/worker.ts` adoption path) when a
  projected run first reports a `prUrl`. Zero DDL; the source string is recorded as-is.
  Adopted pipeline PRs flow through the standard Inspector lifecycle and Shipped page.
- **Foreman triage** (opt-in, default off, a switch on the Conductor settings panel): when a
  `pipeline_halt` item has class `mechanical`, the Foreman may drive the phase 4 action routes
  (unpark, retry-shaped verbs) through the daemon's HTTP surface. It never touches SQLite (the
  standing boundary) and never acts on `needs-human`, `protected-artifact`, `legacy`, or
  `unclassified` classes: those always surface to the operator. Every Foreman action on a
  pipeline is recorded in its episode log like its other actions.

## Non-goals

- No ensemble-powered DECIDE, memory unification, or intake bridging (deferred by decision 8
  in [plan.md](plan.md)). No new control verbs. No SDK-runtime pipeline dispatch.

## Repository findings

Verified at `dc2d99a`:

- `TASK_KINDS = ["ship", "scout", "plan"]` at `src/shared/types.ts:1459`, append-only with
  Record-exhaustive info surfaces; adding a kind fans out compile errors that enumerate the
  touch points (dispatch UI, task storage, guided steps).
- `GUIDED_STEP_IDS = ["repo", "kind", "harness", "afterWork"]` (order is data) in
  `src/web/lib/guided-dispatch-steps.ts`; the kind step reads the registry.
- The Inspector's `adoptPr` takes a source string; `InspectorSource` is a two-member union
  today. Adoption is additive (no DDL).
- The Foreman worker's no-SQLite boundary is a standing project rule; its existing actions go
  through daemon routes.
- Conductor facts (at `8b51392d`): `engineer` refuses nesting via the `CLAUDECODE` env guard;
  it reads a real stdin; `conduct-state.json` carries `pr_url` when SHIP opens the PR.

## Implementation steps

1. Append the kind and info record; chase the compile errors to every registry surface.
2. Gate the kind's availability on per-repo conductor enablement; add the runtime constraint
   note and exclusion in dispatch surfaces.
3. Launch path through the existing terminal session launchers with env scrubbing; unit tests
   for the argv and env.
4. `InspectorSource` extension and the `prUrl`-observed adoption call, idempotent per run
   (adopt once, on first sight).
5. Foreman triage behind the opt-in switch: class filter, route-driven actions, episode
   logging; unit tests for the class gate (every non-mechanical class escalates).
6. E2E specs.

## Data and compatibility

- `TASK_KINDS` and `InspectorSource` are append-only extensions recorded in the change
  contracts in the same commit.
- Tasks of kind `pipeline` persist like other tasks; no schema change beyond what the kind
  registry already implies. A pre-phase database opens cleanly.

## Tests and verification

- Unit: kind registry surfaces, launch argv/env, adoption idempotency, Foreman class gate.
- E2E: the guided pass shows `pipeline` for an enabled repo and not for a disabled one;
  selecting it refuses the SDK runtime with the stated reason; dispatch drives the fake
  `conduct-ts` and the session cards with the badge (phase 3 rule, no special-casing); a
  fixture run reporting a PR URL appears in Shipped under the pipeline source; with triage
  enabled, a mechanical fixture halt is acted on by the fake route flow while a needs-human
  halt stays in the inbox.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- Definition of done per AGENTS.md; `docs/dispatch-and-backlog.md` and README updated.
- Foreman triage ships default-off; needs-human halts provably never auto-acted.
- One reviewable PR; nothing downstream depends on it in this repository.

## Downstream handoff

- The `pipeline` task kind and `"pipeline"` inspector source (append-only).
- The triage class gate: only `mechanical` is ever automatable; any future class joins the
  escalate set by default.

## Cross-phase audit record

- 2026-08-14: initial version. Direct dependency reduced to phase 4 alone (phases 1-3 are
  transitive through it); dispatch could technically ship after phase 1, but splitting the
  weave would leave a dispatched pipeline with no operable surface, so the slice stays
  together per the merge-unit rule.
