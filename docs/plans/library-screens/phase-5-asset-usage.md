# Phase 5: What is using this asset

## Outcome

Before you change a reviewer's standards or an Action's instruction, the screen tells you what
depends on it: which workflows reference it, and whether a run is gating on it right now. This is
the one part of the Rail direction that is not browser-only work, and it lands last so the other
four phases never wait on a wire-contract decision.

## Entry conditions and dependencies

- **Depends on Phase 2 and Phase 3**, both merged and green. Those phases leave the footer slot this
  phase fills, on Personas and Actions respectively.
- Phase 1 is a transitive prerequisite. Phase 4 is unrelated and may merge before or after.
- Read [`plan.md`](plan.md) - in particular *"One repository finding that changed this plan"* - and
  [`phased-plan.md`](phased-plan.md).
- Before writing any code, re-verify findings 1 and 2 below. They are the reason this phase exists
  separately, and the projection they describe may have moved.

## Scope

### Included

- projecting each workflow's referenced persona and session-action ids so the browser can answer
  "what uses this" without fetching every workflow;
- the "used by" footer on the Persona and Action screens;
- the live half: a run currently gating on this asset;
- CSS, shared-contract tests, server tests, render tests, and a Playwright spec.

### Excluded

- the Command screen. A slot is referenced by graph shape rather than by identity, and answering it
  is a different question;
- any change to workflow graphs, publishing, or the draft/published split itself;
- navigating anywhere new. The footer links to surfaces that already exist;
- rendering run state anywhere else in the Library, including the index.

## Repository findings

1. **The reference lives only in the graph, and the graph is not in the browser.** A draft node
   carries `personaId` / `sessionActionId`; a published node carries a frozen snapshot whose
   back-reference is `persona.sourcePersonaId`. Neither graph ships in the SSE snapshot.
   `WorkflowSummary` documents itself as *"the bounded catalog projection carried over SSE. Graphs
   and guidance stay on HTTP"*, and its only persona field is the scalar `personaCount`. Answering
   the question client-side today would mean one `GET /api/workflows/:id` per workflow.
2. **The live half is already there.** `WorkflowRunSummary.activePersonaNames` is derived server-side
   from attempts in `queued`, `running` or `retry_wait`, and `status === "waiting_for_action"` with
   `actionWait` covers Actions. The Library index already consumes the latter for a shelf cross-link.
   **`activePersonaNames` carries names, not ids**, so matching is ambiguous when an operator persona
   shadows a same-named built-in.
3. **Draft and published answer differently, and both are true.** A draft reference follows library
   edits; a published one is frozen at publish time. The footer must say which it is showing rather
   than silently merging them.
4. **The Library index has an explicit "nothing runs from here" contract**, asserted in its own copy
   and pinned by `test/library-page-render.test.ts` - *"shelf cross-links count what is live without
   rendering any of it"*. That contract governs the **index**. This phase renders live state on a
   **detail** screen the person opened deliberately, which is a different surface - but the
   distinction must be made deliberately, and the index's tests must stay green untouched.
5. **`src/shared/` is a controlled path**: wire contracts and browser-safe logic only, no `node:`
   imports. **`src/web/useEventStream.ts` requires exhaustive handling of every `ServerEvent`.**

## Decisions this phase must make and record

The source plan does not fix the mechanism, only the outcome. Choose deliberately, record the choice
and its rejected alternatives in the pull request, and prefer the smallest projection that answers
the question.

1. **Where the reference projection lives.** Extending `WorkflowSummary` with bounded id arrays keeps
   one delivery path and no new route, at the cost of growing every snapshot. A dedicated usage route
   keeps the snapshot small, at the cost of a second path and a staleness question. Weigh them
   against the summary's stated contract rather than against convenience.
2. **Draft, published, or both.** Per finding 3, decide what the footer claims and label it.
3. **How to resolve the ambiguity in finding 2**, or whether to accept it and say so on screen.

## Implementation steps

1. Re-verify findings 1 and 2 against the current code before designing. If the projection has
   changed, the design changes with it.
2. Decide the three questions above and write the decision into this phase's pull request
   description.
3. Implement the projection in the daemon, beside the code that already builds the summary, with no
   second source of truth for what a workflow references.
4. Extend the shared types in `src/shared/` for whatever the projection adds, keeping the path free of
   `node:` imports.
5. Carry it to the browser through the existing snapshot and event path. If a new event is
   introduced, handle it exhaustively in `src/web/useEventStream.ts`.
6. Build the footer as one shared component used by both screens, filling the slot Phases 2 and 3
   left. It names each referencing workflow, links to it, and states whether a run is gating now.
7. Render nothing rather than something misleading: a workflow the browser cannot resolve is omitted
   with a count, not guessed at.
8. Add the CSS beside the Phase 2 rules.

## Compatibility

- **No migration.** The projection is derived from data the daemon already holds; nothing new is
  persisted.
- A browser on an older build must tolerate the added field, and this build must tolerate its
  absence - render the footer empty rather than throwing.
- No change to workflow publishing, graph shape, or any persisted identifier.

## Tests and verification

### Unit, contract and server

- [ ] Server tests for the projection: a draft-only reference, a published-only reference, both, a
      built-in workflow, and an archived workflow.
- [ ] A contract test pinning the shared type and, if the snapshot grew, its bounded size.
- [ ] `src/web/useEventStream.ts` exhaustiveness holds.
- [ ] Render tests for the footer: no references, several, a live run, and the unresolvable case.
- [ ] `test/library-page-render.test.ts` stays green **without edits**. If it fails, finding 4's
      distinction was not respected.

### Playwright, required

- [ ] A Persona referenced by the built-in review workflow shows it in the footer, and the link opens
      that workflow.
- [ ] A Persona referenced by nothing shows the empty state.
- [ ] An Action shows the workflow that references it.
- [ ] With a run gating on the asset, the footer says so; when the run finishes, it stops saying so
      without a reload.
- [ ] Every earlier phase's spec still passes unedited.

### Commands

```
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- [ ] Both screens answer "what is using this" without a per-workflow fetch from the browser.
- [ ] The three decisions are recorded in the pull request with their rejected alternatives.
- [ ] The full gate passes, including `npm run smoke`, which the earlier browser-only phases did not
      need.
- [ ] Screenshots of the footer in its populated, empty and live states, attached from a gitignored
      location.

## Downstream handoff

This is the last phase. It leaves behind a workflow-reference projection that later work - a usage
count on the Library index cards, or a warning before archiving a referenced asset - can reuse. Any
such follow-up must consume the projection rather than re-deriving it from graphs, and must respect
the index's "nothing runs from here" contract, which this phase deliberately did not weaken.

## Cross-phase audit record

- This phase exists because a source-plan assumption was disproved. `plan.md` originally asserted
  "no new server route; used by is derived from catalogs the browser already holds". The repository
  showed the graphs are not in the snapshot, `plan.md` was corrected before decomposition, and the
  work was moved out of Phases 2 and 3 into this phase.
- Reconciled with Phase 2 and Phase 3: both leave an empty footer slot and ship no half-answer, so
  neither has to be revisited when this lands.
- Reconciled with Phase 4: no shared files. Commands has no footer, recorded in both phase files so
  the omission reads as a decision rather than an oversight.
- Reconciled with Phase 1: the footer adds links, not dismissible surfaces, so the Escape ladder is
  unaffected.
