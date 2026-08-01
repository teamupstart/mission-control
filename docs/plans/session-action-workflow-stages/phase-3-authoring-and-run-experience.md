# Phase 3: SessionAction authoring and run experience

Source plan: [`plan.md`](plan.md)

Phased index: [`phased-plan.md`](phased-plan.md)

## Outcome and value

Operators can create, revise, archive, select, arrange, publish, and reuse custom SessionActions
through Mission Control. Pipeline view presents actions as first-class singleton stages, Graph view
shows their `complete` routing, and run surfaces explain delivery, pickup, waiting, continuation,
and fresh evidence without portraying an action as a pass/fail evaluator.

Pipeline and run surfaces also render Inspector as a fixed final footer after End. This footer is a
projection of the immutable completion policy, not an authored or persisted graph node.

At the end of this phase, only server-reported available completion adapters are addable. The
initial public authoring path uses `session_turn`. Pull Request remains unavailable until Phase 4.

## Entry criteria and direct dependencies

Direct prerequisite: Phase 2 is merged and its recovery suite passes.

Before editing:

1. Read the source plan, phased index, Phase 2 downstream handoff, root `AGENTS.md`, architecture
   guide, change contracts, frontend design conventions, workflow builder plan, and relevant React
   rendering-test patterns.
2. Inspect the merged Personas library, workflow list/editor, Pipeline and Graph modes, run detail,
   Board ladder, Inspector presentation, event stream, and shared style primitives.
3. Run `git status --short`, preserve unrelated work, and run typecheck plus focused Phase 2 tests.
4. Manually exercise one API-created `session_turn` graph to establish the runtime baseline before
   changing browser controls.

## Scope

In scope:

- A SessionActions library surface with create, edit, archive, revision conflict, built-in, and
  archived-state presentation.
- Exact prompt Markdown and optional required-skill authoring.
- Server-owned completion-adapter capability selection.
- Pipeline and Graph controls for adding, selecting, reordering, removing, and routing actions.
- Published-snapshot outdated indicators and version-detail rendering.
- Run-detail and Board presentation for action wait states and evidence segments.
- A fixed Inspector footer driven by `WorkflowCompletionPolicy`.
- Responsive, keyboard, focus, empty, loading, error, and accessibility behavior.
- UI and operator documentation for custom SessionActions and Inspector placement.

Explicit non-goals:

- No browser-authored completion adapters, commands, model choice, webhooks, or arbitrary tools.
- No Persona conversion or mixed Persona/check/action stage.
- No Pull Request action add control, PR proof state, or No-Mistakes Review v8.
- No graph Inspector node, Inspector drag handle, Inspector delete action, or alternate completion
  policy editor.
- No client-side action execution, session observation, evidence capture, or completion inference.

## Repository findings and inherited contracts

### SessionActions resemble Personas only in catalog interaction

Reuse familiar library navigation, dialogs, revision conflict behavior, built-in labeling, and
archive affordances. Do not reuse copy that says evaluator, review, verdict, model, or pass/fail.
An action's key authoring fields are name, description, exact prompt, optional required skill, and
a server-supported completion rule.

### Pipeline is the primary stage authoring surface

An action is one singleton stage. It has no all-pass toggle and cannot accept a second member.
Graph view represents the same persisted truth and exposes the `complete` edge. Both modes must
round-trip through the shared compiler without reminting stable ids.

### Runtime state comes from the server

The browser receives action state, wait reason, delivery status, current segment, and provenance
through shared run projections and SSE. It must not inspect terminal text, infer session idle, poll
PRs, or reconstruct continuation state from unrelated entities.

### Inspector is a footer projection

The footer is shown only when the published workflow's immutable completion policy includes
Inspector. It follows the authored pipeline visually but cannot be selected, connected, moved, or
deleted. End remains visible as the final authored graph node.

## Implementation steps

### 1. Add SessionActions navigation and state ownership

Add an Actions or SessionActions library entry alongside Personas using the existing application
navigation conventions. Consume the registry snapshot and exhaustive SSE events introduced in
Phase 1. Keep one normalized client store and do not add a second fetch loop.

The list supports:

- search and stable sorting;
- built-in and operator-owned labels;
- archived filtering;
- revision and last-updated metadata;
- required-skill and completion-rule summaries;
- empty, loading, and error states.

Only show catalog records that the server marks displayable. Historical archived records remain
available where a draft or version references them.

### 2. Build create, edit, archive, and conflict flows

Create and edit forms expose:

- name;
- description;
- exact prompt Markdown;
- optional required skill id;
- completion rule selected from server-reported available adapters.

Use the shared byte/character limits and route error codes. Preserve prompt whitespace exactly
after form transport. Provide a clear confirmation for archive and explain that published workflow
versions retain snapshots.

Updates and archive send `expectedRevision`. On conflict, preserve the operator's draft, show the
current server revision, and offer explicit reload/reapply choices consistent with Persona UX.
Built-ins are read-only. Do not allow selecting the unavailable `pull_request` adapter or derive
available values from a client constant.

### 3. Add action insertion to Pipeline view

Extend the existing stage palette/add controls with a SessionAction choice. The selector lists only
addressable actions whose completion adapter is currently available. At this phase, the Pull
Request built-in is filtered from add choices.

An inserted action becomes a singleton `SessionActionStage`:

- it may appear after Session and between any authored stages allowed by graph validation;
- it may move through existing stage reorder affordances;
- it cannot add Persona/check members;
- it has no all-pass control;
- its outgoing label is Complete, never Pass;
- remove reconnects or surfaces blockers through the shared compiler rules;
- selecting a replacement changes only the draft reference.

Use stage-type labels, iconography, and copy that make evaluation and mutation visibly distinct.
Do not encode correctness through color alone.

### 4. Extend Graph view through shared capabilities

Render the `session_action` node and `complete` handle from the shared node capability descriptor.
Add it to the palette only when an available action can be selected. Graph connections, validation
messages, keyboard deletion, selection, and property editing must use the same draft graph as
Pipeline view.

Prove these round trips:

```text
Pipeline edit -> Graph view -> Pipeline view
Graph edit -> Pipeline view -> Graph view
published graph -> draft -> republish
```

Stable node, edge, Join, Session, and End ids must survive when topology is unchanged.

### 5. Add snapshot and version presentation

Published version detail renders the action snapshot used by that version, including name,
description, prompt, required skill, completion kind, source id, and source revision. If the live
catalog revision differs, mark the snapshot outdated without mutating the version.

Drafts referencing archived actions remain intelligible and guide the operator to replace or
restore them according to server policy. Never silently bind by normalized name.

### 6. Present action execution without verdict language

Extend run detail, attempt timelines, and Board ladder with action-specific states:

- preparing;
- awaiting approval;
- delivering;
- delivery uncertain;
- waiting for session pickup;
- session active;
- needs operator input;
- settled, verifying completion;
- capturing fresh evidence;
- blocked;
- complete.

Labels should follow the server's bounded state projection. An action row has no score, pass badge,
failure feedback, or repair verdict. Show the owning action snapshot and a safe prompt preview
without exposing secrets or unbounded evidence.

### 7. Make evidence segments understandable

Display repair round and evidence segment separately wherever a run shows submission history. Use
plain language such as "Round 1, evidence 2" and explain that actions refresh evidence without
spending a repair round.

The timeline should connect:

```text
parent evidence -> action turn -> fresh evidence -> downstream stages
```

This is presentation only. Use server-provided parent and continuation provenance. Do not infer
relationships from timestamps.

### 8. Render Inspector as a fixed final footer

In Pipeline editor/version views and run/Board stage ladders, append a visually distinct Inspector
footer when `WorkflowCompletionPolicy` enables it. The footer:

- follows the authored End stage;
- is labeled fixed or completion policy;
- has no drag handle, selection state, member editor, graph edge, or delete control;
- explains that it evaluates the finished pull request after workflow success;
- reflects existing Inspector pending, reviewing, needs-fix, passed, and failure states in run
  surfaces;
- disappears when the immutable completion policy does not include Inspector.

Graph view keeps Inspector outside the canvas and may show a compact non-interactive policy note
outside graph editing controls. Do not synthesize a graph id for it.

### 9. Handle responsive and accessible interaction

Follow existing focus management and dialog patterns. Ensure:

- every field has a programmatic label and bounded validation message;
- action insertion and stage reorder are keyboard-operable;
- focus returns predictably after create, archive, or stage removal;
- status is conveyed by text and semantics, not color alone;
- long names, prompts, and wait reasons wrap without breaking the stage ladder;
- narrow Electron windows preserve access to actions and Inspector details;
- reduced-motion settings apply to state transitions.

Use the project's existing visual language. Do not introduce a separate design system for this
feature.

### 10. Update user-facing documentation

Update README and the relevant workflow/ensemble documentation with:

- the distinction among Check, Persona, and SessionAction;
- reusable action fields and immutable published snapshots;
- supported completion rules and capability filtering;
- arbitrary placement and fresh-evidence continuation;
- repair round versus evidence segment;
- Preview versus Live action behavior;
- fixed Inspector footer semantics;
- the fact that Pull Request is not available until its verified adapter ships.

Avoid examples that imply a generic shell-command node or that Inspector is editable.

## API, data, and compatibility notes

- Browser choices come from server capabilities and addressable catalogs.
- Existing draft and published workflows without actions render unchanged except for the accurate
  fixed Inspector footer when their completion policy already includes Inspector.
- Existing Graph and Pipeline routes remain round-trip compatible.
- Archived and outdated presentation never changes a published snapshot.
- The browser continues exhaustive event handling for all catalog and runtime events.
- Pull Request remains hidden from add controls while its adapter is unavailable.

## Focused tests

Add or extend React static-rendering, shared compiler, route, and state tests for:

- action list, search, built-in/operator, archived, empty, loading, and error states;
- create/edit validation, exact prompt transport, archive, and revision conflict recovery;
- server capability filtering and unavailable Pull Request exclusion;
- Pipeline insertion, replacement, removal, reorder, and singleton restrictions;
- Graph node ports, valid/invalid connections, selection, deletion, and diagnostics;
- Pipeline/Graph stable-id round trips;
- snapshot detail and outdated/archived references;
- every action runtime status and absence of verdict language;
- round/segment provenance rendering;
- fixed Inspector footer presence, absence, immutability, and ordering after End;
- existing workflows and Personas UI remaining unchanged;
- exhaustive SSE handling;
- keyboard labels, focus hooks, and narrow-layout class behavior.

Run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

Perform runtime and visual verification in both Pipeline and Graph modes at normal and narrow
Electron widths. Capture the exact scenarios and screenshots or recordings in the implementation
PR description.

## Exit criteria

- An operator can create a reusable `session_turn` action, insert it anywhere valid, publish it,
  run it, and understand the fresh downstream evidence.
- Pipeline and Graph views round-trip without identity churn.
- Pull Request is not addable while its adapter is unavailable.
- Inspector appears as an immutable footer after End and never enters the graph.
- All runtime statuses are comprehensible without pass/fail terminology.
- Typecheck, lint, tests, build, smoke, and visual/runtime verification pass.

## Downstream handoff to Phase 4

Phase 4 adds `pull_request` to server-reported available adapters, which automatically makes the
compiled Pull Request action displayable and addable through the completed catalog and builder
surfaces. Do not hard-code a special browser insertion path.

Phase 4 may extend action wait copy with bounded PR-proof states, but it must retain the generic
action stage and fixed Inspector footer. No-Mistakes v8 should be assembled through the same graph
compiler and snapshot path an operator uses.

As built, the seams Phase 4 will touch live at these names:

| Contract | Where |
|---|---|
| The one filter every add control passes through | `addableSessionActions(catalog, available)` in `src/shared/workflow.ts` |
| A picker's options, including the retained arm | `sessionActionChoicesForDisplay` / `sessionActionChoiceLabel`, same file |
| The daemon's capability answer, fetched not imported | `useSessionActionCapabilities` in `src/web/workflows/sessionActionApi.ts` |
| The library and editor | `SessionActionLibrary.tsx`, `SessionActionEditor.tsx`, route `#/workflows/actions` |
| Stage authoring | `StageSeed`, `insertStage`, `replaceStageAction`, `parseStageOption` in `PipelineEditor.tsx` |
| Graph authoring | the `session_action` arm of `NewWorkflowNode`, the palette entry and `addNode` in `WorkflowLibrary.tsx` |
| The action's own chip and sentences | `sessionActionStatus`, `actionWaitSentence`, `actionBlockSentence` in `run-model.ts` |
| Segment presentation | `runRounds`, `segmentProvenanceSentence`, `continuationSourceAttempt`, same file |
| The fixed footer | `InspectorFooter` in `pipeline-bits.tsx`, plus `inspectorFooterStatus` in `run-model.ts` |

Phase 4 turning `pull_request.available` true is the whole browser change: the built-in appears
in every picker, the editor offers the completion, and the existing retained-option arm stops
firing for it. Four things must NOT be added along the way:

- a browser-side special case for the built-in. It is addressable catalog data like any other
  row, and the only reason it is currently absent is `available: false`;
- a second answer to "may I add this?". `addableSessionActions` is the filter, and the
  availability set it takes comes from the daemon;
- a PR-shaped arm in `sessionActionStatus`. The PR adapter's extra proof surfaces as
  `awaiting_proof`, which already reads "Verifying" and already has a sentence. New *wait
  reasons* appended to `SESSION_ACTION_WAIT_REASONS` fail typecheck in three `Record`s until
  someone says what each means to a human - that is the intended cost;
- an Inspector graph node. The footer is a projection, and v8's Pull Request stage reaches End
  like any other stage before the completion policy claims it.

One thing this phase deliberately did NOT do, because it belongs with the verified adapter: the
Pull Request action's completion is unreachable in the editor, so nothing exercises the
`pull_request` arm of the completion selector against a real save. `completionChoices` covers
the retained case in `test/session-action-library-render.test.ts`, and Phase 4 should extend
`e2e/specs/workflow-session-action.spec.ts` - whose last two tests currently pin the refusal -
rather than deleting them.

## Cross-phase audit

- Phase 2 runtime state remains server-owned and is displayed without client inference.
- Custom SessionActions are fully usable before the PR specialization ships.
- The unavailable built-in is not a visible dead authoring choice.
- Inspector presentation matches the approved fixed-footer decision without changing persistence.
- Phase 4 alone owns PR adoption proof, legacy handoff extraction, and built-in v8 changes.
