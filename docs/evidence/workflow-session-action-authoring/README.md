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
fresh worktree uuid and a relative timestamp, so an unconditional run would rewrite eighteen
binaries on every `npm run test:e2e` for no added signal.

It is TWO tests, because the last frame needs a session free to pick an instruction up rather
than one already parked on a Preview packet, and each test gets its own daemon.

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

Preview is what makes this frame possible - the run parks and holds still - and it is also what
this frame cannot show. Capture 8 is the same surface after a **Live** action finished.

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

## 7. A published snapshot the catalog has moved past

`07-published-snapshot-outdated-wide.png`, `07-published-snapshot-outdated-narrow.png`

Immutability is only demonstrable by making the catalog disagree with the version first, so the
capture flow does exactly that: publish while the action sits at revision 2, then **rewrite** its
instruction, then **archive** it. The version detail reads

> `Tidy the workspace · revision 2 · outdated · archived source`

with both indicators at once - and the `<pre>` below still holds *"Remove the stray scratch file
and say so."*, the text that was frozen. Not the text the live row now carries, and not an error
about a source that no longer exists. The required skill and the completion the version was
published with sit beside it, and the fixed Inspector footer is drawn from that version's own
policy rather than the workflow's current one.

This is where a run's audit trail ends. Without it, *"an action ran"* is the last thing history
can tell you about what was typed into somebody's session.

## 8. A completed continuation, and the evidence it produced

`08-completed-continuation-wide.png`, `08-completed-continuation-narrow.png`

Capture 5 binds **Preview** deliberately - it parks at `awaiting_send` and holds still long
enough to photograph the waiting vocabulary - which means it can never show the other half of
the model. This one is a **Live** binding driven to completion, and it is the whole chain in a
single frame:

- the scrubber reads `Round 1 · evidence 1` and `Round 1 · evidence 2` - two evidence snapshots
  inside **one** repair round, with the run header still `ROUND 1 OF 6`, so the continuation
  visibly spent no budget;
- the notice beneath names the action that produced the second and says what it cost: *"Evidence
  2 of round 1, captured after Tidy the workspace finished. Continuing after an action does not
  spend a repair round, and only the stages after it run again."*;
- the action's stage chip reads **Complete**. Never Passed - it judged nothing;
- the downstream `Check · test` ran against the *new* evidence, which is the thing a
  continuation exists for;
- the action's own card carries the turn's timeline - sent, picked up, turn finished - under
  the sentence *"The turn finished, and the fresh evidence the stages below it review was
  captured."*

That is `parent evidence -> action turn -> fresh evidence -> downstream stages`, read off one
screen. Nothing in it is stubbed: a real git worktree, a real SDK session with a real child
process behind it, the instruction really typed into that session's pane, and the child segment
captured from a real `git` read of the worktree. Only the model is a fake.

## 9. The shipped Pull Request action

`09-builtin-pull-request-action-*.png`

The built-in read-only, so the two contract fields it exists for are visible together:
`Required skill · pull-request` and `Completes when · Pull request is opened and verified`,
both disabled because a built-in has no save. The editor carries the exact shipped Markdown -
the same bytes a run types - and the byte counter beside it is what refuses an instruction that
could not be delivered whole.

Duplicate is the only lit control, which is the whole affordance: a copy you own keeps that
completion and that skill, so a customized instruction does not quietly lose its verification.

## 10. No-Mistakes Review v8, at the end of the strip

`10-no-mistakes-v8-pull-request-stage-*.png`

Read left to right: the **Pull Request** session action stage, the `COMPLETE` seam, **Complete**
(End), the `WORKFLOW SUCCEEDED` seam, and only then the fixed **Inspector** footer. That order
is the feature - the action opens the pull request and reaches End, and the Inspector reviews it
afterwards. The two are deliberately separate cards, and the footer is dashed and badged `FIXED`
so it cannot read as a stage the author placed.

The settings rail shows the other half - **Missing PR: Wait** - which is correct only because
the graph cannot reach End without a pull request. A version whose gate had to prepare one would
say `Prepare PR` here.

**This frame caught a real defect.** The Inspector footer was the one card in the strip
declaring a `width` without `flex: none`. The strip is a flex row that scrolls rather than
reflows, so flex-shrink runs before `overflow-x` ever applies: the card collapsed toward
min-content and its grid let the sentence spill out past the border, drawing the dashed edge as
a ~40px sliver beside its own text. Invisible until a pipeline was long enough to overflow -
which is exactly what a fourth stage produced. Fixed in `styles.css` and pinned by
`test/workflow-pipeline-label-width.test.ts`, which now asserts the property for every strip
card rather than for the one that happened to break.

## 11, 12 and 13. A pull request opened somewhere else, then found

`11-pr-on-another-branch-*.png`, `12-pr-on-another-repo-*.png`, `13-pr-verified-provenance-*.png`

Captured by `e2e/specs/workflow-pull-request-mismatch.spec.ts`, which runs a real Pull Request
action against a real dispatched session and parks it on each state in turn. The chip appears in
three places at once - the stage card, the member row, and the Session actions card - and the
sentence beside it names the remedy, because the two mistakes are fixed differently.

These are the states that must not read as *Awaiting PR*. "No pull request yet" and "a pull
request was opened somewhere else" look identical from the outside and are opposite problems,
and an operator told only "awaiting" keeps watching for something that already exists.

**Both frames caught real defects, and neither was reachable from a unit test.**

- The bound checkout's repository was compared as `git rev-parse --show-toplevel`, which is the
  WORKING TREE. Mission Control dispatches every agent into a linked worktree, so that path is
  per-session while the pull request is adopted against the repository the worktree was cut
  from - and a correct pull request therefore compared as belonging to a different repository
  on the ordinary path. Both sides now normalise to the resolved `--git-common-dir`, which is
  one string for a main checkout and all of its worktrees.
- A wait-reason change was durable but never published, so the run detail page kept rendering
  the label it first drew. Completion and every block already published; the waits - the states
  an operator sits and watches - did not. `setSessionActionWait` now publishes when the reason
  actually changes.

Capture 13 is the same run recovered and finished, and it is what makes the two states above
**waits rather than blocks**: the pull request is found on the right branch at the commit the
continuation captured, and the action completes. The card then carries the audit trail a
finished action leaves - the chip reads `Complete` (never Passed; it judged nothing), and
beneath the turn's timeline sits `#77 on <branch>, verified at <commit>`.

That line appears only once the proof exists. Offering to open a pull request nothing has
verified is the claim this whole completion refuses to make - which is also why the header's
**Open PR** control is dark in captures 11 and 12 and lit here.
