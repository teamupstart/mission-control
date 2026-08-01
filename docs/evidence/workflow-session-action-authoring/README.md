# Authoring and running a session action

Visual evidence for Phase 3 of the SessionAction plan. Phase 1 shipped the durable
representation and Phase 2 the runtime; both deliberately withheld every control, so their
evidence is a sequence rather than a screen. This phase is the opposite: the whole change is
what an operator can now see, reach and read.

Every frame is the real dashboard against a real daemon, captured by
`e2e/specs/workflow-session-action-evidence.spec.ts`. Regenerate with:

```sh
npm run build
MC_E2E_EVIDENCE=1 npx playwright test --config e2e/playwright.config.ts \
  e2e/specs/workflow-session-action-evidence.spec.ts --reporter=list
```

It is behind that flag for `dispatch-and-converse.spec.ts`' reason: each capture carries a
fresh worktree uuid and a relative timestamp, so an unconditional run would rewrite fourteen
binaries on every `npm run test:e2e` for no added signal.

Nothing here is operator data. The repository, the session, the two actions, the Persona and
the workflow are all seeded by that spec, and the only substitution is the model -
`MISSION_CLAUDE_BIN` points at the same fake the rest of the suite uses.

Each frame is taken twice: at 1440, and at **720**, which is the Electron window's own
`minWidth`. The narrow pass is the one worth looking at. It is where a horizontally scrolling
stage strip, a four-field editor and a three-pane builder have to stay *reachable* rather than
merely not crash - at 720 the builder collapses its side panes into the Library / Properties
drawer toggle, and the strip keeps its scroll.

## 1. The session actions library

`01-actions-library-wide.png`, `01-actions-library-narrow.png`

`#/workflows/actions`, beside Personas. The sidebar lists the shipped **Pull Request** action
marked `Built-in` and two operator rows marked `Yours`, each row saying what it requires and
what proves it finished - `No required skill · Session turn finishes` - plus its revision and
when it last changed.

The editor holds the five authored fields. **Completes when** offers `Session turn finishes`
and nothing else, because that is what this daemon reported through
`GET /api/session-actions/capabilities`; `pull_request` has no verified adapter until Phase 4.
The instruction is a real CodeMirror editor over the exact Markdown, with the byte counter
reading against the ceiling one delivery packet can carry.

## 1b. A revision conflict, mid-recovery

`01b-conflict-recovery-wide.png`, `01b-conflict-recovery-narrow.png`

Two tabs disagreeing about the same action, photographed at the moment the operator has to
choose. Four things are in one frame:

- **The draft is preserved.** `# My unsaved instruction` is still in the editor. Nothing about
  a conflict rewrites a byte of it; the banner reports, it does not resolve.
- **The current server revision is named** - "A newer revision (r2) exists" - beside an eyebrow
  still reading `REVISION 1`, which is what this editor loaded.
- **Three ways out are offered.** **Reload latest** discards the edits. **Reapply my changes**
  writes them onto r2, on this same action. **Save as duplicate** keeps them as a new one.
  Only the middle one lands an edit on the row a workflow already points at, which is why it
  exists.
- **The divergence is visible side by side.** The sidebar row shows the other tab's state -
  description "edited in another tab", Revision 2 - while the editor still holds r1 plus this
  operator's change. That is exactly the input to the three-way merge: Reapply sends the
  prompt and not the description, so the other tab's edit survives.

The banner is toned rather than plain, which it was not until this frame was generated:
`.wf-state` carried only the base box, so a `role="alert"` drew as ordinary bordered prose.
At 720px the sentence takes its own line and all three controls stay reachable.

## 2. A session action stage in the Pipeline

`02-pipeline-action-stage-*.png`

`Session → Intent Conformance → Tidy the workspace → Check · test → Approved`. The action
stage carries the same Remove control and drag handle every other stage has, its row carries
the `SESSION ACTION` badge, and its subtitle states the consequence an author most needs:
*later stages review new evidence*. Its stage foot is a **replace** picker rather than an add
picker, because an action stage holds exactly one thing by construction.

The rail underneath states both rules together, which is the distinction the whole segment
model exists to keep straight:

> Any fail returns the submission to Session for repair, then the whole pipeline runs again. A
> session action finishing is not a repair: it captures fresh evidence and only the stages
> after it run again, against the new evidence.

## 3. The fixed Inspector footer

`03-pipeline-inspector-footer-*.png`

The same strip, scrolled to its end. Past `Approved` - the End - the seam reads **workflow
succeeded** and the footer sits after it, dashed, marked `FIXED`, saying what Inspector looks
at and where its switches actually are. It has no drag handle, no member list, no edge and no
delete, and it is not in the strip's roving tab order: it is a projection of
`WorkflowCompletionPolicy`, not a stage. A workflow whose final gate is None shows no footer.

## 4. The graph node

`04-graph-action-node-*.png`

The palette's `＋ Session action` entry with its own picker, and the node it creates. One
source handle - `complete` - and no `pass` or `fail`, which is the durable shape: a `fail`
handle would invite a route back to Session for what is a delivery problem, and a `pass` handle
would let a Join read "the session did the thing" as a favourable verdict. The rail repoints
the node at a different action and removes it, the two halves Phase 1 deliberately withheld.

## 5. A run parked on the action

`05-run-waiting-on-action-*.png`

A Preview binding, so the run holds still at `awaiting_send`. Three things are worth reading:

- the run's own status chip is **Waiting for a session action**, not "Waiting for the session"
  - one is a parked repair round a human can resubmit, the other is one instruction the daemon
  is watching;
- the stage's chip is **Ready to send**, from the action's own status table. It is never
  Passed: the action judged nothing;
- the action has its own **Session actions** card section above **Reviewer verdicts**, carrying
  the sentence behind the chip, the snapshot the version froze, and the exact instruction.

## 6. The Board ladder

`06-board-ladder-*.png`

The same run read as one vertical chain inside the session tile. The action rung names itself
and its consequence, the Inspector rung follows `Approved` rather than preceding it, and it is
marked `FIXED` and reads `Not reached` - not "No gate", which is what a workflow with no
Inspector policy at all would say. Its dot hangs off a dashed rail segment rather than a boxed
border, so the ladder keeps one visual language.

The narrow frame is the one that caught a defect. The Inspector rung first shipped with a
third label - a `completion policy` sub beside the name and the badge - and at 720px the
Board's ~200px column drew it straight through the state text on the right. The sub is gone
(the badge and the sentence already said it twice) and `.wf-ladder-title` now wraps, so no
rung can overlap its own state again.
