# Phase 2: session-action sources under root `actions/`

## Outcome

The authored session-action documents live in a root `actions/` directory, symmetric with
`personas/` from phase 1, with the generator, tests, and docs following.

## Entry criteria and dependencies

- Direct prerequisite: phase 1 (personas move) has merged. The two phases edit adjacent
  lines in `docs/agent-guides/change-contracts.md` (370-372) and `README.md`
  (5815-5816), and this phase mirrors phase 1's generator exclusion decision.

## Scope

- `git mv docs/session-actions/pull-request.md actions/pull-request.md`, filename
  byte-identical - the slug keys the enforced contract table
  (`src/server/workflows/builtin-session-actions.ts:39-47`) and
  `PULL_REQUEST_SESSION_ACTION_ID` (`:77`).
- Add `actions/README.md`: states these are Mission Control session-action sources
  compiled in by `npm run session-actions` - not GitHub Actions - and that filenames are
  durable ids. This disambiguation is deliberate; a root `actions/` reads as GitHub
  Actions at first glance.

Non-goals: any content change to `pull-request.md` (phase 3 owns the evidence-policy
edit); the `pull-request` skill under `skills/` (also phase 3); `/api/session-actions/`
routes and ids (unchanged).

## Repository findings

- `scripts/builtin-session-actions.ts`: `sourceDir` (`:22`), `SPEC.sourceGlob` (`:27`),
  header comment (`:2-3`). Structural sibling of the personas generator; shares
  `scripts/builtin-markdown.ts`.
- The generated module `src/server/workflows/builtin-session-actions.generated.ts` bakes
  the glob into its header; regenerate in the same commit or
  `test/builtin-session-actions.test.ts` fails its drift assertion.
- `test/builtin-session-actions.test.ts:22` pins `join(root, "docs", "session-actions")`
  and `readdirSync`s it (`:51`).
- Prose: `README.md:5816` (`npm run session-actions` command line),
  `docs/agent-guides/change-contracts.md:371-372`.
- `actions/README.md` would be swallowed by the glob without the exclusion phase 1
  introduced for `personas/`; apply the same rule here (`README.md` excluded).

## Implementation steps

1. Move the file; add `actions/README.md`.
2. `scripts/builtin-session-actions.ts`: `sourceDir` → `join(root, "actions")`,
   `sourceGlob` → `"actions/*.md"`, header comment, `README.md` exclusion consistent
   with phase 1's mechanism.
3. `npm run session-actions`; commit the regenerated module - never hand-edit it.
4. Update `test/builtin-session-actions.test.ts:22` and make its `readdirSync` respect
   the exclusion.
5. Update `README.md:5816` and `docs/agent-guides/change-contracts.md:371-372`.
   Historical plans (`docs/plans/session-action-workflow-stages/*`) keep their old paths.

## Compatibility

No schema, API, or id changes. `builtin:pull-request` and the required `pull-request`
skill binding are untouched.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`.
- `npm run build` and `npm run smoke` (generated module changed).
- `npm run session-actions` immediately after the commit is a no-op.
- No UI surface changes, so no new e2e spec is required for this phase.

## Merge and exit criteria

- All checks green; CI green on the PR.
- `actions/` contains `pull-request.md` and `README.md`; `docs/session-actions/` is gone.

## Downstream handoff

Later phases may rely on `actions/pull-request.md` as the authored source of the builtin
pull-request session action (phase 3 edits its content and regenerates). Filenames in
`actions/` are durable ids; do not rename.

## Cross-phase audit record

- 2026-08-04: initial version. Exclusion rule inherited from phase 1's finding; content
  edit to `pull-request.md` deliberately deferred to phase 3 so the evidence policy lands
  as one reviewable change.
