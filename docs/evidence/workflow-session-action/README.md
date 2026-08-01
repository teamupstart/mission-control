# A session action node in the workflow builder

Visual evidence for Phase 1 of the SessionAction plan, captured from the real builder: a
built daemon (`node dist/server/index.mjs`) on an isolated `MISSION_HOME`, driven by a
headless Chrome over CDP against the served dashboard. Nothing here is a fixture render -
the catalog reached the browser over SSE, and the draft was read back through
`GET /api/workflows/:id`.

The seeded draft is `Session -> Release judge (Persona) -> Pull Request (session action) ->
End`, authored through `PATCH /api/workflows/:id`, which is the only way an action node can
exist in this build: the builder deliberately ships no control that creates one.

## pipeline-action-stage.png

The Pipeline, scrolled to the seam between the two stages so both are in frame.

The reviewer stage on the left carries the full authoring set - a **Remove** on its header,
an **×** on its member row, and the **＋ Add reviewer or check…** picker. The action stage
beside it carries none of them, because an action runs alone and nothing in this build can
execute one: an add picker there would list four reviewers and refuse every one.

The action names itself **Pull Request** from the catalog, wears the `SESSION ACTION` badge
that separates it from the reviewers it sits among, and states what the runtime will require
as the thing it proves - `Skill · pull-request · Completes when a pull request is opened and
verified`. Its subtitle is the fact an operator most needs about whatever follows it:
`1 session action · later stages review new evidence`.

The seams say `PASS` before it and `COMPLETE` after it. That is the whole distinction the
port exists for, drawn: a pass carries the same evidence onward, a complete means everything
downstream reads evidence captured once the action had run.

On the right, **Publish** is disabled and the Validation panel says why in a sentence:
*This build cannot run a session action yet, so a workflow containing one cannot be
published.* The refusal is a validation diagnostic rather than a store-only 409 precisely so
it can appear here, beside the control it disables.

## graph-action-node.png

The Graph view with the action node selected.

The **Node palette** offers exactly what it always did - Persona, All-pass Join, Check, End -
and no session action. **Duplicate nodes** stays greyed out even though a node is selected,
because duplicating an action is an add control by another name.

The node draws one source handle. There is no `pass` and no `fail`: a fail handle would
invite a route back to Session for what is a delivery problem, and a pass handle would let a
Join read "the session did the thing" as a favourable verdict. Its violet edge and hue are
its own, distinct from the Session node's blue - the two nodes that write to the conversation
were indistinguishable when they shared it.

The selected-node rail is read-only, with no picker: it explains what the node does, what it
requires, and what proves it finished, and offers **Delete node** as the escape hatch for a
graph that arrived through the raw API. The Connections list names the route by its real
port: `Pull Request (complete) → Complete (terminal)`.

## Reproducing

The same states are asserted without a human in `e2e/specs/workflow-session-action.spec.ts`:

```sh
npm run build
npx playwright test --config e2e/playwright.config.ts e2e/specs/workflow-session-action.spec.ts
```
