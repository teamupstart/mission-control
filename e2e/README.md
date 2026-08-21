# Browser end-to-end tests

Playwright specs that drive the real dashboard against a real daemon. This is the only
layer in the repository where a click reaches a route, a route reaches a subprocess, and the
result comes back to the DOM through a server event.

```sh
npx playwright install chromium   # one-time, per machine
npm run build                     # required: this suite drives dist/, not src/
npm run test:e2e
```

Both prerequisites are real: without the browser the run dies with `browserType.launch:
Executable doesn't exist`, and without a build the daemon has no `dist/` to serve.

The browser download is a separate step rather than a `postinstall` hook because `npm
install` is run by everyone and this suite is not - fetching ~150MB of Chromium for a
contributor who only ever runs `npm test` is a tax on the common path. CI installs it as its
own step for the same reason, and skips it on the Node version that does not run this suite.

## Host concurrency

Playwright uses at most four workers, and Mission Control permits one E2E invocation per user on
a host at a time. This is a shared limit across linked worktrees: a second full or focused run
waits before Playwright starts any browser workers, prints the PID and checkout holding the lease,
and begins when that run exits. The kernel releases the lease automatically if its process dies.
If an unrelated process owns the derived lease port, the run refuses promptly instead of waiting.

The resolved worker count is a hard ceiling. A command that asks for more than four workers is
refused; use the ordinary default or lower it for a lighter run:

```sh
npm run test:e2e -- --workers=2
npm run test:e2e -- --workers=1
```

The two CI shards remain concurrent because each job runs on its own machine. The lease coordinates
processes sharing one host; it does not serialize separate runners.

Useful flags:

```sh
npm run test:e2e -- --headed                        # watch it run
npm run test:e2e -- --debug                         # step through with the inspector
npm run test:e2e -- -g "conversation"               # one test, matched by title
npm run test:e2e -- e2e/specs/dispatch-and-converse.spec.ts   # one spec file
npx playwright show-trace test-results/<dir>/trace.zip
```

## Evidence

Successful-path artifacts go to gitignored `e2e/.artifacts/<topic>/` because a green Playwright
run leaves nothing behind on its own: `screenshot` and `trace` are both configured
`on-failure`, so success is exactly the case with no record. Attach the generated screenshots
and transcripts to the pull request. Never commit them, including evidence produced for or
submitted to workflow personas.

Video is off. Recording it cost 16s of every CI shard whether or not anything failed, and it
showed nothing the trace does not already replay. A failure still leaves a trace and a
screenshot; open the trace with `npx playwright show-trace`.

### A card item switched off across two Board columns

`e2e/.artifacts/board-card-customization/` is the whole-board half of the same feature:
three frames of a fleet split across **needs you** and **idle**, at the defaults, with
Branch and Permission mode unchecked, and restored. One session settles idle and the other
is asked a question over `POST /mcp/reviews` so it sorts into a second column by tone -
which is what makes the frames evidence for "every card in every column" rather than for one
card. The `review` flag stays drawn in all three, because the attention flags are not
customizable.

Regenerate all three with:

```sh
mkdir -p e2e/.artifacts/board-card-customization
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/board-card-customization.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/board-card-customization/focused-playwright-transcript.txt
```

### The Board card panel and its preview

`e2e/.artifacts/board-card-preview/` carries the **Settings → Display → Board card**
checklist beside its live preview card, twice: once at the shipped defaults - every item
checked except the worktree, which is the one item no card drew before this feature - and
once with Goal and Model unchecked and the worktree switched on, so the same frame shows
what each checkbox actually costs and buys. No agent is dispatched, so nothing runs but the
settings page and a daemon.

The viewport is deliberately taller than the panel. An element screenshot taken across a
scroll is stitched rather than photographed, and the seam reads as a missing row in a frame
meant for pixel review.

Regenerate both with:

```sh
mkdir -p e2e/.artifacts/board-card-preview
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/board-card-preview.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/board-card-preview/focused-playwright-transcript.txt
```

### Native workflow image evidence

`e2e/.artifacts/workflow-image-evidence/` records the dashboard intake and audit surfaces for
one real built-daemon workflow run. The spec attaches a screenshot in the initial binding
preview, supplies its caption and repository scope, and proves the fake Claude and Codex
provider boundaries received and decoded the same bytes named by the manifest. It then shows
the retained thumbnail and audit metadata, submits a replacement image on an unchanged
repository snapshot, restages retained evidence for the next review, and converts another
body to a pruned fixture while preserving its digest and metadata.

Both fake providers reject a metadata-only image request. Their accepted-boundary records are
written inside the isolated Playwright state directory and compare MIME, byte count, and
sha256 digest against the exact native image input before returning a verdict.

Regenerate the optional dashboard frames with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-image-evidence.spec.ts \
  --workers=1 --reporter=list
```

### Dispatch restart recovery

`e2e/.artifacts/dispatch-restart-recovery/restart-recovery-backlog.png` shows a dispatch
interrupted before provisioning back in the Backlog, with the restart explanation and enabled
launch control visible together. The same run deliberately persists stale branch and base SHA
metadata to prove those descriptive fields do not hide an otherwise resource-free dispatch.
Its real command output belongs at
`e2e/.artifacts/dispatch-restart-recovery/focused-playwright-transcript.txt`.

Regenerate both with:

```sh
mkdir -p e2e/.artifacts/dispatch-restart-recovery
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/dispatch-restart-recovery.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/dispatch-restart-recovery/focused-playwright-transcript.txt
```

### Native worktree dispatch and reuse

`e2e/.artifacts/native-worktree-dispatch/` carries the task card before cleanup and after a
released slot is reused. The spec dispatches a multi-repo task through the dashboard, proves the
daemon persisted one native lease per repository, keeps a concurrent task on a distinct slot,
cancels through the visible task action, and proves a later dispatch reuses only the returned
directories with fresh lease IDs.

Regenerate the frames and transcript with:

```sh
mkdir -p e2e/.artifacts/native-worktree-dispatch
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/native-worktree-dispatch.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/native-worktree-dispatch/focused-playwright-transcript.txt
```

### Task worktree retention

`e2e/.artifacts/task-worktree-retention/` carries the two frames of the 30-day rule: a checkout
whose unpushed local commit postponed cleanup, still showing **Clean up**, and the same task
after an untouched window expired, with the cleanup control gone and its native slot back in
the pool. The spec dispatches through a real native worktree, kills the agent without an
outcome, makes a real git commit in the tree, and moves the retention ledger's own timestamps
backwards while the daemon is stopped - a fixture technique, since the duration has no
production setting and retention has no off switch.

Regenerate the frames and transcript with:

```sh
mkdir -p e2e/.artifacts/task-worktree-retention
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/task-worktree-retention.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/task-worktree-retention/focused-playwright-transcript.txt
```

### Scout prompt context reader

`e2e/.artifacts/scout-prompt-context/` holds the five frames from the finished-scout flow:
the live card title, then the archived reader at desktop and 420px under dark and light OS
preferences. Mission Control is intentionally dark-only, so the light-preference frames prove
the existing tokenized surface remains stable. The reader frames show the same concise title,
the prompt search result, the ordered Original request and Follow-up ledger, and the report
remaining usable beside that metadata.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/scout-archive.spec.ts \
  -g 'ordered human prompt context' \
  --workers=1 --reporter=list
```

### Scout rename

`e2e/.artifacts/scout-rename/inline-scout-rename.png` shows the selected archive's reader
heading replaced by the same focused, explicit-save inline editor sessions use. The spec
rebounds the shared rename action first, so the frame and interaction also prove Scouts is
reading the operator's configured binding rather than owning a second shortcut.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/scout-archive.spec.ts \
  -g 'renames inline' \
  --workers=1 --reporter=list
```

### Closing a scout without a report

`e2e/.artifacts/scout-close-warning/confirm-close-without-report.png` captures the first
**Complete & close** refusal after a scout omits its report. The dialog keeps the daemon's
exact report path and submission-tool guidance, presents it as an amber warning, and replaces
the ordinary primary action with the explicit red **Close without report** confirmation. The
same run proves the first click changes nothing and the second closes the task without
inventing an archive.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/scout-archive.spec.ts \
  -g 'warns first' \
  --workers=1 --reporter=list
```

### Full workflow graph canvas

`e2e/.artifacts/workflow-graph/workflow-graph-full-canvas.png` is captured
by the Library regression after it opens the built-in No-Mistakes Review workflow, switches to
Graph, and proves the React Flow viewport fills the builder canvas. The fixed 1682 by 1100
viewport makes the repaired working surface reviewer-visible at the scale where the defect was
reported.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/library.spec.ts \
  -g 'built-in workflow graph fills' \
  --workers=1 --reporter=list
```

### An HTML report opening rendered

`e2e/.artifacts/file-default-view/html-report-opens-rendered.png` is captured the moment a
session's `docs/reports/<slug>/report.html` is selected in the Files tab, with no click on the
view toggle in between: the page is rendered in the preview pane and **Preview** carries the
pressed state. It is the payoff shot for the `html-report` skill - the logged path resolves to
the report as a page, not to its markup in an editor - and the same run proves the report's own
`<script>` did not run inside the sandbox.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/file-default-view.spec.ts \
  -g 'opens rendered' \
  --reporter=list
```

### Sibling links in the HTML preview

`e2e/.artifacts/preview-sibling-links/preview-sibling-link.png` is captured after
the sibling-link regression clicks `<a href="b.html">` inside the sandboxed preview of
`docs/a.html`: the sibling document is rendered in the preview pane and the file list's
selection has followed it. Before the fix this exact click left a white pane - the srcdoc
iframe navigated against the dashboard's own URL and the SPA fallback answered with a
shell the sandbox could not load.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/preview-sibling-links.spec.ts \
  -g 'opens that file in the preview' \
  --reporter=list
```

### A paused ensemble review, against a failed one

`e2e/.artifacts/ensemble-review-pause/` holds the pair that settles a question no class-name
assertion can: whether a person can tell a review that is WAITING for them from one that is over.

- `blocked-amber-pipeline.png` - a review whose infrastructure budget is spent. Amber, naming how
  many infrastructure errors it took, with the evaluator's own count untouched at `attempt 1 of 2`.
  The run is non-terminal and both candidate snapshots are still on disk.
- `failed-red-pipeline.png` - the same review on a run the operator then CANCELLED, which is the
  only thing that ends a parked one. Red, no detail, no door, run over.
- `*-page.png` - each of those in situ, because a step that reads correctly cropped can still be
  lost on the real page.

The pair is the point. These two states differ only in a colour and a line of text, and getting
them confused means an operator abandons a run whose candidates are intact and waiting - so
`toHaveClass(/is-blocked/)` describes the tree, not the thing at stake. Both frames are taken
after that test's own assertions pass, so the picture and the measurement cannot drift apart.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/ensemble-review-restart.spec.ts \
  --workers=1 --reporter=list
```

### Resolving a stuck GitHub Inspector finding

`e2e/.artifacts/inspector-resolve-findings/` holds three frames from the run that asserts an
operator can close a finding no review round is left to close - the case that held
`mergeBlock: findings` on a pull request permanently and forced a merge by hand.

- `inspector-findings-stuck.png` - the ledger row carrying `2 findings`, with the **Resolve**
  control offered in its own column.
- `inspector-findings-resolved.png` - after the click: `clean`, `2 fixed`, the control retired
  because there is nothing left to resolve, and the count strip having followed.
- `inspector-findings-narrow-fold.png` - the same row at 420px, where `.sc-table` clips rather
  than scrolls. A new column is exactly the change that silently drops a cell off that edge, so
  the run measures the button's right edge against the table's box and photographs the result.

The pair matters because the two states differ only in words and a missing control, which is
what a reader of this panel actually navigates by; and the fold frame matters because a clipped
cell still reports `visible` to an assertion.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/inspector-resolve-findings.spec.ts \
  --workers=1 --reporter=list
```

### One review with optional Foreman context

`e2e/.artifacts/foreman-note-retires-on-your-answer/`
holds frames from the run that asserts an ask remains one decision when Foreman also has a
recommendation. The driver form and MCP review each start with Foreman closed, open a bounded
context sidecar, and mark the existing option Foreman named without selecting it or offering
**Approve & send**. The after frames prove submitting through the original form retires the
disclosure and sidecar without a second dismiss action. The directory README records the
regeneration command.

### Persona import, provenance and upstream drift

`e2e/.artifacts/persona-import-provenance/` holds
three frames from the run that asserts a Markdown role imported by path records where it came
from, badges the row when that file changes, and adopts the change as a new revision. The
provenance line, the amber `upstream changed` tag and the shelf card's version of the same tag
are all things a route assertion can prove changed but only a capture shows a reader.

Attach the generated frames to the pull request; they are never committed.

### The Persona detail screen on the Rail direction

`e2e/.artifacts/persona-rail/` holds five frames from the run that asserts the rebuilt Persona
screen. `01-rail-groups.png` is the rail split into Built-in and Yours with counts;
`02-overflow-menu.png` is the `⋯` menu open, which is where the four verbs that used to sit
beside Save now live; `03-provider-chip-open.png` is the provider chip's popover holding the
control the five-field metadata block used to hold; `04-provider-overridden.png` is the chip row
after the override, where the `source` readout has stopped saying `app defaults`; and
`05-builtin-promotes-duplicate.png` is a built-in promoting **Duplicate to edit** with no Save
on the header at all.

The quiet-versus-solid chip treatment is the whole point of that row and is the one thing an
assertion can only approximate - it is a weight and a colour, and a reader has to see it.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/persona-rail.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### The Action detail screen on the Rail direction

`e2e/.artifacts/action-rail/` holds eight frames from the run that asserts the rebuilt Action
screen. `01-rail-groups.png` is the rail split into Built-in and Yours, each row sub-labelled
with its contract rather than with a description that restates the title;
`02-contract-line.png` is the chip pair with the sentence they form written beneath them;
`03-completion-chip-open.png` is the completion chip's popover holding the `select` that used
to sit fourth in a row of four fields; `04-completion-changed.png` is the same screen after the
condition changed, saved and reloaded, with the contract line following it;
`05-unprovable-completion.png` is a completion this build cannot prove, kept and marked amber
with its reason beside it - the state that was previously a disabled option inside a closed
dropdown; `06-overflow-menu.png` is the `⋯` menu holding Duplicate and Archive;
`07-builtin-promotes-duplicate.png` is a built-in promoting **Duplicate to edit**, with neither
a Save nor a menu, because both would be empty gestures; and `08-capabilities-in-flight.png` is
that same unprovable action with the capabilities response held open, drawing no mark at all -
the frame `05` is the answer to.

The marked chip and the contract line are the two things an assertion can only approximate:
one is a colour and a weight, and the other is a sentence a person has to read to judge. `05`
and `08` are the pair to read together: the difference between them is one HTTP response, and
nothing else.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/action-rail.spec.ts \
  --workers=1 --reporter=list
```

### Library asset usage

`e2e/.artifacts/library-asset-usage/` holds the three states added to Persona and Action
details. `01-populated.png` shows a built-in Persona naming the draft and published
No-Mistakes Review graphs; `02-empty.png` shows the explicit answer for an unused Persona;
and `03-live.png` shows an Action while one exact workflow run is gating on it. The live test
then cancels that run and proves the mark retires through SSE without reloading the page.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/library-asset-usage.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### Per-harness dispatch defaults propagating

`e2e/.artifacts/harness-defaults-propagate/`
holds two captures from the run that asserts a saved per-harness model takes effect without a
restart. `harnesses-card-saved.png` is the Claude Code card after the edit, with its own
sentence naming the flag the next launch carries (`--model claude-sonnet-5`).
`dispatch-modal-names-new-default.png` is the dispatch form reading `Default - Sonnet 5` -
the label that used to keep advertising a retired model until the modal was reopened.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/harness-defaults-propagate.spec.ts \
  --workers=1 --reporter=list
```

### Foreman PR follow-through

`e2e/.artifacts/foreman-pr-follow-through/`
contains PNG and reviewer-renderable HTML captures of the asserted built-dashboard Foreman
settings, plus the focused browser and behavior transcripts. The visual shows that automatic
No-Mistakes review is absent, Straight to PR is bounded by Workflow ownership, and CI
follow-through is a separate control whose visible copy requires an existing PR.

The directory README records the exact regeneration commands.

### Foreman dependency-planner recovery

`e2e/.artifacts/foreman-planner-health/degraded-planner.png` captures the top-bar Foreman
popover after a leased worker reports the dependency planner degraded. The frame shows the
effective Codex provider/model, the three-failure count, the bounded provider error, the next
automatic retry, and the operator's **Retry planner now** path. The spec uses a synthetic
health report and spends no model tokens.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/foreman-planner-health.spec.ts \
  --workers=1 --reporter=list
```

### An effort that applies on the next turn

`e2e/.artifacts/effort-next-turn/` holds three frames and the transcript of the run that
produced them. The frames settle the one thing an accessible name cannot: whether a person
reading a card can tell "this is your level" from "this will be your level".

- `effort-pending-mid-turn.png` - the chip while a Codex turn is running, reading
  `medium → high` with the **next turn** tag and a dashed outline, taken after the run has
  already watched three metadata refreshes go by without it reverting.
- `effort-pending-menu.png` - the same chip's menu open, where the sentence the chip has no
  room for is written out and the two options carry different sub-labels: one is set for
  the next turn, the other is what this turn is running.
- `effort-settled-next-turn.png` - the chip after the next turn actually started, back to a
  plain `high` with no tag and a solid outline.

All three matter together. The difference between the first and the last is a dashed border,
a struck-through level and the two words `next turn`, and getting them confused means an
operator believes a level took effect on work that ran without it.

`effort-next-turn/focused-playwright-transcript.txt` is that run's own output. Under
`MC_E2E_EVIDENCE` the spec narrates each milestone as its assertion lands - the live level
read off the rollout, the turn going busy, the choice, how many times the active turn
refreshed the card's metadata without the pending state moving, and the settle after the
next turn. A bare pass line proves the spec ran and says nothing about what it watched; these
lines are emitted by the run itself, so the transcript is a record of the flow rather than a
summary written afterwards.

Regenerate the frames and the transcript with:

```sh
mkdir -p e2e/.artifacts/effort-next-turn
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/effort-next-turn.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/effort-next-turn/focused-playwright-transcript.txt
```

Attach the generated frames and transcript to the pull request; they are never committed.

### Accepted SDK stop

The focused Complete case keeps its fake SDK subprocess alive for four seconds after stop is
accepted. It verifies the Complete modal closes within 1.5 seconds, the retained session card
reads `stopping` with its Complete action unavailable, and the card later reaches `exited`.

The successful command output belongs at
`e2e/.artifacts/dispatch-and-converse/complete-stopping-transcript.txt`.
`e2e/.artifacts/dispatch-and-converse/complete-stopping-state.png` is the visual
capture from that same run and shows the session card while the SDK event stream is draining.

Regenerate both with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/dispatch-and-converse.spec.ts \
  -g 'Complete closes promptly while an accepted SDK stop drains' \
  --reporter=list
```

Actual output from the captured run:

```text
Running 1 test using 1 worker

OBSERVED Complete closed while the accepted SDK stop was still draining
CAPTURED e2e/.artifacts/dispatch-and-converse/complete-stopping-state.png
  ✓  1 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:143:1 › Complete closes promptly while an accepted SDK stop drains (8.0s)

  1 passed (8.8s)
```

### Accepted workflow submission

The focused bind-and-submit case holds evidence compaction open for five seconds, observes the
`202 Accepted` response with a durable `capturing` run, follows the browser to that exact run,
and verifies the visible run header says `Capturing evidence` before compaction finishes.

The successful command output belongs at
`e2e/.artifacts/workflow-submit-accepted/workflow-submit-accepted-transcript.txt`.
`e2e/.artifacts/workflow-submit-accepted/workflow-submit-accepted.png` is the visual
capture from that same run and shows the selected run detail page in the capturing state.

Regenerate both with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-submit-accepted.spec.ts \
  --reporter=list
```

Actual output from the captured run:

```text
Running 1 test using 1 worker

OBSERVED bind-and-submit returned 202 with a durable capturing run
OBSERVED the accepted run detail page says "Capturing evidence"
CAPTURED e2e/.artifacts/workflow-submit-accepted/workflow-submit-accepted.png
  ✓  1 [chromium] › e2e/specs/workflow-submit-accepted.spec.ts:45:1 › Bind and submit opens the durable capturing run before compaction finishes (2.8s)

  1 passed (3.5s)
```

### Continue in terminal carries the permission mode

`e2e/.artifacts/resume-mode-carry/` holds the paired
red and green transcripts for `specs/continue-in-terminal-mode.spec.ts`, the two frames of
the asserted browser state (the card's mode chip beside the open "resume this conversation
in" chooser, per harness), and the real CLIs' own `--help` output for the flags the resume
argv re-asserts. The red transcript is the same spec run against a build with the fix
stashed, and its received strings are the reported bug verbatim: a spawned resume command
that ends at the conversation id, mode gone.

That spec is the reason the fixture set includes a fake `cmux` (`CMUX_BIN`, written by
`fake-agents.ts`): tmux availability is a question about a pair - its sessions open
detached and need an emulator to raise them, and CI has neither - while cmux's workspaces
draw their own window, resolve through an env override, and launch with a single
`new-workspace` call whose `--command` argument IS the command line a click asked a
terminal to run. The directory README records the regeneration commands.

### Board workflow shortcut

`e2e/.artifacts/board-workflow-shortcut/` contains
two full-Board captures from the same passing browser regression. `01-expanded.png` is taken
after the selected card receives its first <kbd>e</kbd>: the full workflow ladder is visible,
the control reads **Collapse workflow**, and the Board remains in overview mode. `02-collapsed.png`
is taken after the second <kbd>e</kbd>: the active-rung preview and **Show full workflow** return,
with session detail still closed. The same regression then clicks that compact preview and proves
it opens the exact durable run rather than session detail or an unselected Runs list.

Regenerate both frames with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-session-action-run.spec.ts \
  -g 'Board workflow controls expand in place and open the exact run' \
  --reporter=list
```

### Reviewer verdicts lists reviewers only

`e2e/.artifacts/workflow-run-reviewer-verdicts/workflow-run-reviewer-verdicts.png` is
the run page of a completed two-reviewer run, captured by the regression that arrives at it from
the session card's own `⌁ Approved` chip. Both reviewers are named with the verdict they gave, and
clicking the second reviewer's settled pipeline tile selects that reviewer in the worklist and
shows its full verdict. The three structural attempts every graph produces, the Session, the
all-pass join, and the End, remain absent: before the fix each rendered as a card reading
`… completed · attempt 1` under a heading
that promises a verdict. What those nodes did is still on the pipeline strip above, and the
stage's own join packet is still under the list.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-run-reviewer-verdicts.spec.ts \
  --reporter=list
```

### Run-scoped critical Persona feedback

The `workflow-persona-directive.png` evidence capture shows the drawer opened from a Persona
row's actions menu. The locked run and Persona scope, future-round
persistence, critical priority, byte limit, and editable instruction are all visible in the
built dashboard. The same browser regression saves the instruction, proves it changes only
that Persona in rounds 2 and 3, and checks the directive snapshots stored on both attempts.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-run-disable.spec.ts \
  -g 'critical feedback follows' \
  --workers=1 --reporter=list
```

### Ship it replacement workflow

The focused browser case opens the session's Ship it choice, verifies the visible
`Run No-Mistakes Review` control, observes its `POST` to the session workflow route, waits
for the matching durable run, opens that exact run in the dashboard, and verifies the run
reader names `No-Mistakes Review`.

The successful command output belongs at
`e2e/.artifacts/dispatch-and-converse/ship-it-review-transcript.txt`. Two runtime
captures from that same command make both visible states reviewable:

- `e2e/.artifacts/dispatch-and-converse/ship-it-review-control.png` shows the Ship it
  panel with `Run No-Mistakes Review` next to the direct shipping path.
- `e2e/.artifacts/dispatch-and-converse/ship-it-review-run.png` shows the run created by
  that click, selected in the Runs monitor with its workflow name, version, state, stages,
  evidence, model-call ledger, and timeline.

Regenerate the two PNGs with (the transcript above is this command's stdout, captured
separately - see the Line section below for the redirection that does it):

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/dispatch-and-converse.spec.ts \
  -g 'Ship it starts No-Mistakes Review through the workflow route' \
  --reporter=list
```

Actual output from the captured run:

```text
Running 1 test using 1 worker

OBSERVED Ship it panel exposes "Run No-Mistakes Review" beside the direct shipping path
CAPTURED e2e/.artifacts/dispatch-and-converse/ship-it-review-control.png
OBSERVED POST /api/sessions/:id/workflow-review with a requestId
OBSERVED Runs monitor selected the created No-Mistakes Review v8 run
CAPTURED e2e/.artifacts/dispatch-and-converse/ship-it-review-run.png
  ✓  1 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:157:1 › Ship it starts No-Mistakes Review through the workflow route (3.7s)

  1 passed (4.2s)
```

### The run

Focused run of `specs/dispatch-and-converse.spec.ts`, verbatim:

```
$ npx playwright test --config e2e/playwright.config.ts e2e/specs/dispatch-and-converse.spec.ts --reporter=list

Running 3 tests using 3 workers

  ✓  2 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:142:1 › the dispatched agent was launched headless, without the daemon's terminal identity (2.9s)
  ✓  1 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:61:1 › dispatching an agent puts a live session on the fleet (3.2s)
  ✓  3 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:84:1 › typing into the conversation gets a reply back from the agent (6.5s)

  3 passed (7.4s)
```

Reproduce it with that command, or `npm run test:e2e` for the whole suite. Both need a
successful `npm run build` first.

### The conversation

`e2e/.artifacts/dispatch-and-converse/conversation.png` is a capture from a green run: a
dispatched session's expanded conversation carrying the seeded dispatch turn plus the three
messages the spec types and the three mocked replies that came back, with the `Agent SDK`
runtime badge and the `Claude e2e Mock` model line the driver reported.

Regenerate it with:

```sh
MC_E2E_EVIDENCE=1 npm run test:e2e
```

It is behind that flag rather than captured on every run because the card carries a relative
timestamp and a fresh worktree uuid, so an unconditional capture would rewrite a binary on
every run for no added signal.

### Multiline text boxes grow with the draft

`e2e/.artifacts/multiline-textarea/` contains three captures showing five explicit input
lines in every multiline surface covered by the regression: the dispatch brief, the
Console reply composer, and the compact terminal-style composer. The browser assertions
also prove a sixth line uses an internal scrollbar instead of growing the surrounding pane
without a bound.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/multiline-textarea.spec.ts \
  --workers=1 --reporter=list
```

### The agent's own question

`e2e/.artifacts/driver-question-in-conversation/`
carries the two frames `specs/driver-question-in-conversation.spec.ts` takes between its own
assertions: the `AskUserQuestion` form an Agent SDK session raises, and the gold entry the
answer leaves in that session's conversation.

That spec is the reason `fake-claude.mjs` sends a `can_use_tool` control request UP the wire
on one sentinel prompt. Every other `control_request` on that pipe is the SDK asking the CLI
something; this is the CLI asking its human, and without it no browser spec can reach the
driver-request surface at all - `/select-option` and `/submit-options` refuse unless a real
request is pending, because the id they echo is held by the driver.

```sh
MC_E2E_EVIDENCE=1 npx playwright test --config e2e/playwright.config.ts \
  e2e/specs/driver-question-in-conversation.spec.ts --reporter=list
```

### Queued turn delivery

`e2e/.artifacts/queued-turn-delivery/` carries the
frames `specs/queued-turn-delivery.spec.ts` takes between its own assertions, behind the same
`MC_E2E_EVIDENCE` flag: a message queued against a working driver, and that same message
delivered as an ordinary turn and answered once the session goes idle. The second frame is the
one the fix bought - before it, the row stayed queued for the life of the session.

That spec runs on **both** embedded harnesses, and it is the reason `fake-codex.mjs` exists:
the outbox is supposed to be indifferent to which agent it is delivering to, and a pair of runs
is what makes that checkable rather than argued. Codex's fake speaks `codex app-server`
JSON-RPC over stdio and writes the rollout JSONL the conversation renders from, which is the
same two-wire shape `fake-claude.mjs` has - a control protocol the driver binds to, and a
transcript file on disk the dashboard reads separately.

```sh
MC_E2E_EVIDENCE=1 npx playwright test --config e2e/playwright.config.ts \
  e2e/specs/queued-turn-delivery.spec.ts --reporter=list
```

### The Line

`e2e/.artifacts/line-strip/` carries three artifacts, and they
answer different questions. Two of them the spec writes itself under `MC_E2E_EVIDENCE`; the
third is the run's stdout, which nothing writes to disk on its own - the command below
redirects it, and that redirection is not optional.

The two frames are the ones only a picture answers: `line-live.png` is the strip after a
task is filed, with the Backlog stage naming what autopilot would take next, and
`line-attention.png` is the same strip after that task is parked - amber border, glyph,
name, count and sentence, with the wire feeding it lit to match. "Amber when it needs the
operator" is checkable in the DOM as a class name and readable as a strip only here.

`e2e/.artifacts/line-strip/transcript.txt` is the run's own verbatim
stdout, and it exists because `2 passed` is a verdict rather than evidence: it says some
assertions held, not that the strip rendered six stages, took an SSE update with no reload,
went amber, and navigated on click. Each `OBSERVED` line is printed only after the assertion
it describes has already succeeded, so the transcript cannot narrate a step that did not
happen. The spec only *prints* those lines - it writes no transcript file, so capturing one
is the caller's job.

Regenerate all three with:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/line-strip.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/line-strip/transcript.txt
```

Three parts of that are load-bearing. `MC_E2E_EVIDENCE` is what turns the screenshots and the
`OBSERVED` lines on at all. `--workers=1` keeps the two tests' output from interleaving,
which is what makes the pull-request transcript readable and stable between runs. And the `tee`
is the only thing that produces `transcript.txt` - without it you regenerate two files out of
three and the third silently keeps describing an older run.

Actual output from the captured run:

```text
Running 2 tests using 1 worker

OBSERVED the strip rendered 6 stages in pipeline order: Intake -> Backlog -> Working -> Review -> Decide -> Shipped
OBSERVED a filed backlog task reached the strip over SSE, no reload: Backlog 0 -> 1, "next up: Fix pane focus stealing"
CAPTURED e2e/.artifacts/line-strip/line-live.png
OBSERVED parking that task turned Backlog amber (tone-attention), and it is the only amber stage
CAPTURED e2e/.artifacts/line-strip/line-attention.png
OBSERVED clicking the Shipped stage opened the Shipped drawer in place, without leaving #/fleet
OBSERVED the drawer's "Ship log →" escalation navigated to #/shipped
OBSERVED the strip is fleet-only: it did not follow the navigation off the fleet page
  ✓  1 [chromium] › e2e/specs/line-strip.spec.ts:85:1 › the Line renders every stage, tracks the fleet live, and its stages reach their targets (1.4s)
OBSERVED the strip renders once, outside <header class="topbar">, so the topbar and fleet body keep separate height budgets
  ✓  2 [chromium] › e2e/specs/line-strip.spec.ts:168:1 › the strip sits outside the topbar, preserving separate height budgets (992ms)

  2 passed (2.9s)
```

The click at the end of that walk is the one line in this transcript that used to read
`navigated to #/runs?status=completed`. Shipped is a drawer now: it pointed at the completed
workflow runs while nothing in the app rendered the adoption ledger its count is folded from,
which was wrong in both directions - a session ships without ever starting a run, and a
finished run ships nothing. What the transcript still evidences through it is the same claim
it always did: a stage press reaches its target, and the strip does not follow you off the
fleet when something finally navigates.

### The Line's drawers

`e2e/.artifacts/line-drawers/` carries seventeen frames and the
run's own stdout, written by `specs/line-drawers.spec.ts` under the same `MC_E2E_EVIDENCE`
flag. The frames answer what only a picture can: `review-open.png` is a live run's ladder with
the session card **below it at full size**, `board-pushed-down.png` and `board-returned.png`
are the same board with the drawer open and closed (the spec asserts the card's box is
identical in both; the pictures are what make that legible), and `intake-capped.png` is five
missions in a panel showing three.

`review-blocked.png` is the one the Review row was rebuilt for: a run whose session was
removed, named by the title its binding captured rather than by a conversation GUID, reading
`Blocked · session gone` under a red leading edge, with `Dismiss` beside `Open run`. The live
run under it carries no remedy and prints its cause at the **same indent** - the spec asserts
that alignment in pixels, and the picture is what makes it legible.
`review-grouped.png`, `review-pair-not-a-pile.png` and `review-group-expanded.png` are the
fold: two runs stopped for one reason stay two rows, three become one bar, and the caret
produces all three back.

`decide-cancel.png` is a live ensemble in the Decide drawer with its dossier action still
leading and **Cancel run…** beside it. The same browser case opens the confirmation, backs out
once, then confirms and proves the action reaches the daemon, tears down the fake member Tasks,
and removes the terminal run from the drawer over SSE without a reload.

`shipped-adopted.png` and `shipped-open.png` are the fourth drawer, which used to be a
navigation. The first is the real path - a dispatched session, the `gh pr create` hook, and
the row that lands in the adoption ledger - with **the strip's Shipped count and the drawer's
header showing the same number**, which they do because both are the same rolling seven days
over the same column. The second is a cross-repo week with a title, a branch fallback, and all
three merge states, each spelled as a **mark and a word**; `shipped-filtered.png` is the same
week with one chip pressed. That a hue is never the only carrier of merge state is checkable
in the DOM as text, and legible as a row only here.

`backlog-drawer.png`, `backlog-bands.png` and `backlog-drawer-empty.png` are the queue: the
stage press landing on a drawer rather than on the Sitrep, the three bands with their marks
and the controls each band does and does not carry, and what an emptied queue says. The two
that only a picture can settle are `backlog-planner.png` and `backlog-autopilot-on.png`.
The first is the planner open over the queue - **Foreman's own recorded reason, quoted and
attributed, above the computed facts** - and it is the frame that shows the panel hanging
*below the drawer's bottom edge*, which is the whole point of placing it `fixed`: the body it
is anchored inside is capped at three rows and scrolls, and the drawer clips. The spec
asserts that geometry in pixels; this is what makes it legible. The second is the footer with
the autopilot armed, reading `Autopilot on · 0/3 agents · nothing launches until Foreman is
live` beside the switch that wrote it.

Regenerate all eighteen with:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/line-drawers.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/line-drawers/transcript.txt
```

`--workers=1` keeps the twenty-two tests' output from interleaving, and the `tee` is the only
thing that produces `transcript.txt` - without it you regenerate seventeen files out of
eighteen.

### The topbar's one row

`e2e/.artifacts/topbar-one-row/` carries two frames of the
same bar, same fleet, same 1360px viewport, separated only by the commit: 113px on two rows,
and 69px on one. `specs/topbar-one-row.spec.ts` asserts the row count in the DOM as a height,
which is the honest check and is completely illegible as a title bar - these are what make it
readable, and what answer the question the after frame raises on its own ("the search is a
glyph, so what did that buy?").

The capture sits deliberately ABOVE the assertion it illustrates, so the same command run
against the previous commit produces the two-row frame instead of stopping at a red assertion
with nothing to look at. The directory README records both commands, including the pre-fix
round trip.

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/topbar-one-row.spec.ts \
  -g 'one row at the width' \
  --workers=1 --reporter=list
```

### The console detail's tab row, carrying the toolbar

`e2e/.artifacts/console-tabs-toolbar/` carries two frames from
`specs/console-tabs-toolbar.spec.ts`, behind the same `MC_E2E_EVIDENCE` flag. The change is a
band that stopped existing and two controls that moved into a row which already had room, so
what a picture answers is whether the row still reads as a tab strip.

`01-console-detail-tab-toolbar.png` is the console detail at the default 1280px window: three
bands - head, `PATH`/`BRANCH`, tab strip - with **Terminal view**, **Terminal** and
**Claude Code** at the far end of the tabs, Foreman past them, and the transcript starting
directly under the row. The worktree band that used to sit between them is gone, and the path
appears exactly once, in the row above.

`03-narrow-one-row.png` is the give-way ladder at a 1160px window, and it is the frame the
ladder exists for: one line, every tab still carrying its own word, the three toolbar controls
drawn as glyphs that still answer to a screen reader. That it is one row is checkable in the
DOM as a height; that it still reads as a toolbar is legible only here.

Regenerate both with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/console-tabs-toolbar.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### The everything-palette

`e2e/.artifacts/palette/` carries three frames and the run's own
stdout, written by `specs/palette.spec.ts` under the same `MC_E2E_EVIDENCE` flag.

The frames answer what only a picture can. `palette-empty.png` is the palette before a letter
is typed - the **Do** group and nothing else, which is the claim that an unprompted palette
does not dump fifty settings rows at you. `palette-search.png` is one query reaching all three
groups at once, each row wearing its kind chip and its state line; "grouped as Jump to / Do /
Settings, each row carrying a kind chip" is checkable in the DOM as a role and a class, and
legible as a palette only here. `palette-kind-filter.png` is the same query after one
<kbd>Tab</kbd>: narrowed to a single kind, with the active filter named beside the caret.

`e2e/.artifacts/palette/transcript.txt` is the run's verbatim stdout, and
it exists because `7 passed` is a verdict rather than evidence: it says some assertions held,
not that ⌘K opened on five different pages, that a live run carried its status into the row,
or that a setting row landed on its control rather than the top of its panel.

Regenerate all four with:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/palette.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/palette/transcript.txt
```

`--workers=1` keeps the seven tests' output from interleaving, and the `tee` is the only thing
that produces `transcript.txt`.

### The conversation rendering picker, at its own size

`e2e/.artifacts/settings-conversation-picker/` holds the before/after pair for the
Conversation section of **Settings → Display**. `02-after.png` is captured by
`specs/settings-conversation-picker.spec.ts` on a run whose measurements passed.

The bug it closes: `ViewGlyph` drew an inline `<svg>` carrying a viewBox and neither `width`
nor `height`. That is not a small icon - a replaced element with an intrinsic ratio and no
intrinsic size takes 100% of the line and scales its height by the ratio, so each glyph drew
at the width of its row. Its rects also set no `fill`, so they painted SVG-default black
instead of the row's `currentColor` tint.

The sizes it laid out at are recorded in the spec's header comment, which is the one place
this repository states them: they are a browser's answer, and the spec is what asked. Note
that the two rows did not match each other - a glyph took the flex line minus its label, so
the longer word left a smaller picture.

The spec measures rather than matches, because used height is exactly what a markup
assertion cannot produce - `test/settings-sidebar-render.test.ts` pins the attributes across
every settings category, and this pins what the attributes were for. Reintroducing the bug
in the fixed component, by dropping the sizing from its 44x32 thumbnail, fails it with
`Received: {"height": 634, "width": 872}` against the expected `44x32`. That figure is the
reintroduction's, not the original's - a different drawing at a different ratio - and it is
quoted here only because it is this spec's literal failure output.

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/settings-conversation-picker.spec.ts \
  -g 'sized thumbnails' \
  --workers=1 --reporter=list
```

`01-before.png` is the same section on the pre-fix build, and no spec regenerates it: a
passing suite cannot photograph a bug it has removed. Reproduce it by reverting
`src/web/components/ConversationViewPanel.tsx`, `src/web/styles.css` and
`src/web/lib/conversation-view.ts` to the commit before the fix, rebuilding, and pointing a
capture at `[data-anchor="display/conversation-view"]`. It is kept because the fix is a
visual one, and a reviewer comparing a 749px row against a 61px row learns in one look what
two numbers in a passing assertion do not show.

`00-before-after.png` is the two stacked into one frame with their measurements, composed by
`compare.html` in the same directory - the file to attach when one image has to carry the
review. Rebuild it by serving the repository root and screenshotting that page; it reads the
two PNGs beside it, so it is only as fresh as they are.

### A Jira task source in Settings

`e2e/.artifacts/jira-task-source/` carries three frames
from `specs/settings-task-sources-jira.spec.ts`, behind the same `MC_E2E_EVIDENCE` flag. The
spec can prove a field exists, holds a value and survives a reload; it also turns off
**Allow backlog autopilot** and proves that per-source task default survives the same round
trip. The frames are what show that the Jira group tiles into the card's existing rhythm,
and that the sentence naming a missing credential lands somewhere a person will read it.

That last one is the frame two fixes were made for, and neither is visible in a DOM
assertion alone: the action note moved **below** the buttons that produce it (the card is
taller than the pane, so an answer printed at the top arrived off screen above the question),
and it now carries the **error** tone rather than the dim hint tone it shared with
"Forgotten - the next sweep will file these items again".

The spec reaches a real preflight for the empty-filter case, because that answer is returned
before any binary or socket is touched and is therefore identical on every machine. The
credential sentences are fulfilled through `page.route`: what the panel owes an operator is
that it renders the daemon's answer verbatim, and reaching a real Jira for that would put a
token and a VPN in the suite's path.

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/settings-task-sources-jira.spec.ts \
  --workers=1 --reporter=list
```

### Where the GitHub Inspector's brief lives

`e2e/.artifacts/inspector-brief-location/` carries
three frames from `specs/inspector-brief-location.spec.ts`, which asserts that the GitHub Inspector
panel names both places a repo may keep its brief - `personas/INSPECTOR.md` first, a root
`INSPECTOR.md` as the fallback - and that neither filename is split across lines.

`inspector-settings-lede.png` is the sentence at reading scale and
`inspector-settings-panel.png` places it where an operator meets it, above the switch that
turns the GitHub Inspector on. The third frame is the one that makes the other two mean anything.
`inspector-settings-lede-before-word-break-all.png` is the same clip with the
`word-break: break-all` that settings blurbs used to style inline code with, which breaks
between any two characters and rendered the path as `personas/INSPE` + `CTOR.md` - a filename
chopped mid-word in the one sentence whose job is telling you which file to create.

Unlike the topbar's pair, both states come from ONE run against the current commit: the spec
puts the old declaration back on the chips as an inline style, shoots, and removes it again.
A screenshot of correct text is a weak artifact on its own - a reviewer cannot tell it from
the state before the change - and a defect frame that only a reverted build can produce is one
no command regenerates. The assertions still describe what shipped, because the inline style
is gone before they are read.

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/inspector-brief-location.spec.ts \
  --workers=1 --reporter=list
```

### The run header, decluttered

`e2e/.artifacts/workflow-run-audit/` carries three frames
from `specs/workflow-run-audit.spec.ts`, and they exist because the change is a SUBTRACTION.
`toHaveCount(0)` proves `Copy run id`, `Export run`, `Export version` and `Open version` are
unreachable; only a picture shows what the action row reads like without them, and that the `v1`
badge which absorbed `Open version` still looks like the badge it always was.

`01-header.png` is the row itself. `02-collapsed.png` and `03-opened.png` are the
`Audit and bug reports` disclosure the three of them moved into, closed and open - closed being
the state that matters, since the whole claim is that this material costs a reader nothing until
they ask for it.

The directory README records the regeneration command.

### The run header's one next move

`e2e/.artifacts/workflow-run-next-move/` carries two frames
frames from `specs/workflow-blocked-resubmit.spec.ts`, and they answer the report that started
this work: a screenshot of a blocked run offering nine controls with the reason inside a tooltip.

`01-waiting-one-primary.png` is a run with a move - one filled primary, `Copy feedback` after it,
`Cancel run` behind the divider - where five same-weight controls used to sit. `02-blocked-says-why.png`
is the same header once its session disappeared: no primary at all, and the reason as a sentence
in the identity block whose bolded first clause is the fact and whose second half names the move
that IS available. That a refusal produces prose rather than a disabled button is checkable in the
DOM as a count and a text node, and legible as a header only here.

Attach the generated frames to the pull request; they are never committed.

### A finished run, run again

`e2e/.artifacts/workflow-run-again/` carries two frames
from `specs/workflow-run-again.spec.ts`, and they exist because the state they show used to have
nothing in it: every control left on a `completed`, `cancelled` or `failed` run copied, downloaded
or navigated, so a finished review was a dead end.

`01-finished-header.png` is that header with its one primary, and with `Cancel run` correctly
absent - there is nothing left to stop, which is precisely what made the row inert.
`02-confirm.png` is the confirm it raises: one click, no typed phrase, and a body that names the
session, the workflow version and the model spend.

Attach the generated frames to the pull request; they are never committed.

### The bind chip, back after a finished run

`e2e/.artifacts/workflow-bind-chip-returns/` carries three frames from
`specs/workflow-bind-chip-returns.spec.ts`. They exist because the fix is a control *appearing*,
and the state it appears in used to be a dead end: a session whose review had completed hid the
`＋ workflow` chip forever, so the outcome chip stood there with no next move beside it.

`console-detail-approved-and-bind-chip.png` is the headline - a console detail header reading
`⌁ Approved` and `＋ workflow` side by side, the history and the next move at once.
`bind-dialog-from-finished-run.png` and
`console-detail-bind-dialog.png` are where each chip leads: the bind dialog pinned to that
session, with the bound version chosen and `Submit bound version` enabled - the resubmit the
daemon accepts while the original binding is still active.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-bind-chip-returns.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### Delete, on the backlog editor's danger side

`e2e/.artifacts/backlog-task-delete/` carries four frames from
`specs/backlog-task-delete.spec.ts`. `01-editor-footer.png` is the one the change exists for:
the editor's footer reading `Delete  Save  Revert` on the left and `Cancel  Dispatch now` on
the right. That Delete is *present* is a DOM assertion; that it reads as the same control the
Sitrep row offers, wearing the same `btn btn-danger-ghost` every destructive action in this
app wears, is a question only a picture answers.

`02-card-gone.png` is the Board column after the delete, one card and a count of 1.
`03-refusal-stays-open.png` is the daemon's own refusal wording under the fields with the
form still up, which is the half that would rot silently. `04-dispatch-footer-has-none.png`
is the new-task footer, whose whole content is an absence.

The capture helper grows the viewport to 1280x1100 and puts it straight back: the dialog is
taller than the 720px default and its body is what scrolls, so an element screenshot at the
default size crops away the exact footer these frames exist to show.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/backlog-task-delete.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### Dispatching a parked backlog task

`e2e/.artifacts/dispatch-backlog-autopilot/` carries the two visible states from
`specs/dispatch-backlog-autopilot.spec.ts`. `01-dispatch-toggle-off.png` shows **Backlog
details** with **Allow backlog autopilot** off and its parked-task consequence in plain text.
`02-parked-backlog-card.png` shows the task after **Add to backlog**, with its off switch and
`autopilot will skip this` consequence visible on the Board. The same run reopens the card and
proves the editor reads the disabled state back.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/dispatch-backlog-autopilot.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### The retro offer appearing, and being taken

`e2e/.artifacts/retro-offer/` carries seven frames and the run's own stdout from
`specs/retro-offer.spec.ts`, behind the same `MC_E2E_EVIDENCE` flag. The change is a control
that **appears**, so the pair either side of that is the point: `01-no-offer-yet.png` is a
fresh session's action row, and `02-offer-on-the-card.png` is the same row once a human has
corrected the session and its review has come back clean - `Run retro` between Reset and
Complete, with the GitHub Inspector's `⌕ ✓` beside the pull request chip that earned it.

`03-delivered-into-the-conversation.png` is what one click does: the flash reading
`Retro sent - the session will propose memories for you to approve.` under the row, and the
instruction itself in the conversation below. `05-complete-offers-a-retro-first.png` and
`04-complete-without-a-backstop.png` are the Complete dialog's two shapes, which differ only
by whether the session earned the offer - the backstop sits on the dialog's own side of the
footer, away from Cancel and Complete & close, because it is not a third answer to the
dialog's question.

`06-post-merge-follow-up-started.png` is the click taken after the pull request merged: the
flash naming the linked follow-up task, with the source task still complete beside it.

`07-offer-earned-by-answering-a-question.png` is the same control earned the OTHER way: that
session's human typed no correction at all, they answered the agent's own `AskUserQuestion`
form in the dashboard, and the daemon read the durable human-resolved review. Its case runs
with `MISSION_RETRO_SCAN_MS=0`, so the transcript scanner cannot have supplied the answer.

That the offer is **absent** the rest of the time is checkable in the DOM as a count; that it
reads as an offer rather than as a permanently disabled control is legible only here.

Regenerate all seven with:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/retro-offer.spec.ts \
  --workers=1 --reporter=list \
  | tee e2e/.artifacts/retro-offer/transcript.txt
```

Attach the generated frames to the pull request; they are never committed.

### A backlog task filed as a GitHub issue

`e2e/.artifacts/push-task-to-github/` carries seven frames from
`specs/push-task-to-github.spec.ts`, the pair either side of the push being the ones the change
exists for. `01-task-not-yet-filed.png` is the editor with **Create GitHub issue** in the
provenance strip above the fields; `02-task-linked-to-issue.png` is the same strip after the
click, now reading `Filed upstream as acme/demo-repo#123` - the first time `Task.source` is
drawn anywhere in the dashboard, and the same rendering a swept-in task gets for free.

`03-refusal-keeps-the-button.png` and `04-unknown-outcome-withdraws-it.png` are the two
failures side by side, which is the point of capturing them: a refusal (`gh` said no, nothing
was published) keeps a live button, and an unknown outcome (`gh` never reported back, the issue
may exist) takes the button away rather than disabling it. That difference is a safety property
and it is visible only as a picture of two banners. `05-no-eligible-source.png` is the hint that
stands in for the action when no GitHub source is configured for the task's repo.

The last two are the strip's two shapes when the action IS offered, which differ by how many
sources cover the repo: `06-one-eligible-source.png` is a button on its own, because a picker
of one is a control nobody can use, and `07-two-eligible-sources.png` adds the picker naming
both - the choice matters, since two sources can sweep different labels and the issue carries
the labels of whichever files it.

The daemon in this spec runs against a faked `gh` (`MISSION_GH_BIN`), so no issue is ever
created anywhere; the fake records the argv, which is where the `--label` per swept label and
the repo the create ran in are asserted.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/push-task-to-github.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### A stage carried forward, and the round it passed in

`e2e/.artifacts/workflow-carried-stage/` carries three frames from
`specs/workflow-carried-stage.spec.ts`, and they exist because the defect and the fix are both
a matter of what a stage SAYS about itself.

`01-carried-stage-run-view.png` is the continuation segment with the repair: the stage reads a
neutral `Not re-run` and carries `✓ Passed in Round 1 · evidence 1` beneath its members. Before
it, that same chip read amber `Waiting` over `Not started` rows - a stage announcing itself as
about to run, in the round that will never run it. `02-source-round-proof.png` is where one
press on that line lands, which is the whole complaint being answered: the earlier round, the
same stage, reading `All passed`. `03-board-card-carried.png` is the Board tile, whose one rung
slot went to the finished stage before the sort learned about carried ones.

That the chip is grey rather than green is checkable in the DOM as a class; that the two rounds
read as one continuous story is legible only here.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-carried-stage.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### A copy that confirms, and one that admits it failed

`e2e/.artifacts/copy-confirms-and-reports/` carries three frames from
`specs/copy-confirms-and-reports.spec.ts`, and they exist because two of the states they show
could not be reached at all before: the Sitrep's copy and the Persona editor's called
`navigator.clipboard.writeText` directly, so in the packaged Electron build - where the async
Clipboard API can be permission-blocked even after a direct click - they copied nothing and
said nothing.

`01-sitrep-copied.png` and `03-persona-copied.png` are the confirmation, and the reason to look
at them is the word: `Copied`, not the `Copied ✓` both of these buttons used to read. One
confirmation label across the app is what the context menu builds on, and a decorated variant
is only visible as a picture.

`02-sitrep-copy-failed.png` is the one that had no prior state to compare against. The Sitrep's
copy fetches `/api/report.md` first and swallowed every error into an empty `catch`, so a daemon
answering 500 and a blocked clipboard were indistinguishable and both produced nothing on
screen. The frame is the band that now sits under the panel header saying which happened. A
count and a text node prove the sentence is in the DOM; only the picture shows it did not
squeeze the header row it hangs beneath.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/copy-confirms-and-reports.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### Copy local, in the notice that decides what happens to your edits

`e2e/.artifacts/file-conflict-copy-local/` carries two frames from
`specs/file-conflict-copy-local.spec.ts`. `Copy local` had no feedback of any kind - it wrote
behind a `void` and rendered nothing either way - and it sits in the conflict notice, beside
the two buttons that discard your edits or overwrite someone else's.

`01-copy-local-copied.png` is the notice with the confirmation in it, which is the whole
change: before it, a reader staking their work on the next click had no way to tell a
successful copy from a refused one. `02-copy-local-refused.png` is the refusal, and it is worth
a picture because the sentence has to sit beside its own button rather than take the slack the
notice's leading sentence does - a layout claim no DOM assertion makes.

Reaching either needs a real revision conflict, so the spec dispatches a session, loads a file
from its checkout, rewrites that file on disk underneath the open document, and types to
trigger the autosave. The 409 is deterministic rather than raced: the save carries the revision
captured at load and the daemon compares hashes.

Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/file-conflict-copy-local.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### An external engine's pipelines, and the page that did not change

`e2e/.artifacts/runs-pipelines-tab/` carries three frames from
`specs/runs-pipelines-tab.spec.ts`, behind the same `MC_E2E_EVIDENCE` flag. The claim they
answer is that a second engine's work reads as native rather than as a bolted-on panel, and
that is a matter of weight, spacing and colour that no assertion reaches.

`01-rail-and-halt.png` is the rail: two repositories, each under its own engine daemon's
state, with the halted feature leading and its reason in the reader beside it.
`02-run-detail.png` is one feature's whole gated sequence in the workflow diagram's grammar -
the Spec and pull-request termini, five phase cards, labelled wires, the attempt a kickback
opened, and the gate verdicts underneath. `03-tier-s-and-unknown.png` is the degrading pair:
a tier-S run's skipped steps drawn dashed like disabled commands, and a step this build has
never heard of drawn in the state the engine reported rather than dropped.

Its sibling, `specs/runs-workflows-unchanged.spec.ts`, takes no pictures and is the more
important of the two. It drives a real dispatch, a real published workflow and a real review
round, switches the pipeline integration ON with two features projected underneath, and then
asserts that the Workflows tab is the page it always was - the rail's filters, the run row,
the header, the strip, the round scrubber and the Review worklist. The approved plan makes
"the existing Runs page is not modified" a requirement; this is what holds it, in the only
configuration where breaking it is possible.

Regenerate the frames with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/runs-pipelines-tab.spec.ts \
  --workers=1 --reporter=list
```

Attach the generated frames to the pull request; they are never committed.

### Acting on a pipeline

`specs/pipeline-controls.spec.ts` is the other half of that surface: the verbs. It presses
them where an operator does - the attention inbox and the run header - and then reads what the
fake `conduct-ts` was actually asked for, out of the invocation log the fixture keeps
(`readConductorInvocations`). That log is the assertion that matters, because a green flash
proves only that a predicate matched: `daemon park` takes a BARE POSITIONAL and `decide-grant`
takes exactly three flags, and the engine answers either mistake with a zero exit and a
refusal about an unrelated subcommand.

The fake WRITES the markers the real engine writes - the pidfile, `PAUSED`, `parked/<slug>`,
`grants/<slug>.json` - so the daemon chip and the run's group move because a file moved and a
projection pass read it, not because a fixture told the dashboard what to think. Both hosted
consoles land in the same cmux record `continue-in-terminal-mode.spec.ts` reads, which is
where the reseal ceremony's argv and its hold-open wrapper are visible.

One case in that file is SAMPLED rather than awaited, and the comment there says why: the
rail heals itself every four seconds, so an auto-retrying `toBeVisible` would sit through the
wrong state and pass the moment the next poll arrived. Asserting what an operator saw for that
second means reading the chip outright, over the window the stale answer would have owned. The
first draft of that test passed against the unfixed code, which is the whole argument for
running a new regression test against the bug before trusting it.

It also misbehaves on demand, in the two shapes that matter. Drop a `.daemon/REFUSE` file and
every verb answers the way the real engine answers an invocation its argv detectors rejected -
the generic sentence about the `inline` subcommand, on stdout, behind EXIT CODE 0, having done
none of the work. Drop `.daemon/HALFWAY` instead and a verb DOES its work and then says that
same wrong thing about it, which is what any verb looks like when its confirmation and its
side effect are not one atomic act. Both are the engine's documented shape rather than a
failure mode the fixture invented, and the second is the only way to see the surface re-read a
repository whose state moved without anyone being told.

`e2e/.artifacts/pipeline-controls/` carries ten frames behind `MC_E2E_EVIDENCE`: the inbox
row with its verbs and the same row drained, the paused daemon chip, the grant form with
`plan` absent and explained, the reseal form, the run's cost chip, the spend popover carrying
the engine's line, a refused verb showing the command and the engine's transcript, a reseal
path refused for leaving the feature's worktree, and a shipped feature the engine could not
price reading as `unpriced` rather than as $0.00. Regenerate them with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/pipeline-controls.spec.ts \
  --workers=1 --reporter=list
```

## Steering a workflow reviewer

`specs/workflow-run-disable.spec.ts` drives the Runs monitor's per-run disable toggle, and
its precondition is a run that FAILED review deterministically. Workflow Personas reach the
model over the same `claude -p` protocol the titler uses, and their prompt embeds the
published Persona guidance verbatim - so the fake answers any prompt carrying
`E2E_FAIL_VERDICT` (or `E2E_PASS_VERDICT`) in that guidance with a fixed, schema-valid
verdict. A spec that needs a reviewer with a known opinion plants the marker in the Persona
it creates and gets a stable `waiting_for_session` run to act on, with no mid-review races
to wait out. The spec's server-side seeding failures are surfaced through
`daemon.readLog()`, because the daemon's home - and any log file in it - is deleted on stop.

## What this layer is for

The repository already tests UI three other ways, and none of them can reach this seam:

| Layer | Asserts | Cannot see |
|---|---|---|
| `renderToStaticMarkup` (~90 files) | markup shape | whether anything works |
| `node:test` + `buildApp()` (~34 files) | route behaviour in-process | the browser |
| Electron geometry (2 files) | laid-out heights | behaviour, state, the daemon |
| **`e2e/`** | **click → route → subprocess → SSE → DOM** | native shell chrome |

**Every new UI feature and every UI change needs a spec here** - see the rule in
[AGENTS.md](../AGENTS.md). There are no exemptions: if a person using the dashboard can see
the change, assert its user-visible consequence in a browser.

For a change that is purely visual, that consequence is still assertable: the text someone
reads, the control they can reach, the element that is now present or gone, the state a
control reports. Assert what the change is *for*, not the CSS that implements it.

The other layers are additions, never substitutes. Reach for them alongside a spec when they
say something a browser cannot - `renderToStaticMarkup` to pin an exact markup shape, and the
Electron geometry tests to measure used height for overflow and clipping. Changes with no UI
surface at all (pure functions, reducers, route edge cases) are not UI changes and belong in
`test/`.

## Why it costs nothing

Nothing in `src/` talks to a model API. There is no `api.anthropic.com`, no
`ANTHROPIC_API_KEY`, and the only `BASE_URL` is the daemon's own loopback address. Every
model interaction is a spawned CLI subprocess resolved through one chain in
`src/server/harness/bin.ts`:

```
MISSION_<AGENT>_BIN ?? FLEET_<AGENT>_BIN ?? HARNESS_<AGENT>_BIN ?? <legacy> ?? "<agent>"
```

The Agent SDK runtime goes through that same chain - `claude/sdk-deps.ts` pins
`pathToClaudeCodeExecutable` to the harness's own resolution rather than the vendor
package's bundled CLI, precisely so an operator's wrapper is honoured. So pointing those
three env vars at fakes closes every route to a real model.

A dispatch uses **two** of them, which is worth knowing before adding a spec:

- `claude -p --output-format json` - the one-shot headless runner (`llm/claude-cli.ts`) used
  by the task titler, Foreman, the goal refiner and the GitHub Inspector.
- `claude --input-format stream-json …` - the Agent SDK session.

`e2e/fixtures/fake-claude.mjs` serves both. Faking only the session would still bill a real
account on every dispatch, and `dispatch-and-converse.spec.ts` asserts that both paths landed
on the fake so that regression is caught rather than invoiced.

## Isolation

`startDaemon()` redirects everything the daemon would otherwise reach for:

| Variable | Why |
|---|---|
| `MISSION_HOME` | SQLite DB, token, logs into a temp dir |
| `HOME` | Claude transcripts derive from `homedir()`; without this the fake writes into the operator's real `~/.claude` |
| `MISSION_WORKSPACE_DIRS` | repo discovery sees only the seeded fixture repo |
| `MISSION_CLAUDE_BIN` / `CODEX` / `PI` | every agent launch hits a fake |
| `MISSION_GH_BIN` | every `gh` call hits a fake. Not about cost: `gh issue create` **publishes** to a repository other people watch, and on a machine where `gh` is signed in an unfaked binary would file a real issue on every run of the push spec |
| `MISSION_POLL_MS=0` | terminal discovery is **not** scoped either - it walks every process on the machine and cards anything that looks like an agent |

That last setting matters most and is the least obvious. Without `MISSION_POLL_MS=0` a daemon
booted on a developer's laptop adopts their real running sessions: the fleet count is
non-deterministic against CI where there are none, and the dashboard's Kill and Reset
controls act on live work.

**Two specs turn discovery back on, and they are the exception that explains the rule.**
`session-interrupt-terminal.spec.ts` needs a session whose runtime is `terminal`, and there
is exactly one way one comes into being: `registry.ts:mergeDiscovered` stamps that runtime,
and only the discovery poller reaches it. No route, no dispatch and no handoff produces one.
`session-driven-by-engine.spec.ts` needs the same door for a different reason - the pipeline
correlation exists *because* an external engine's agents arrive through discovery rather than
through dispatch, so a spec that faked a session would be testing the one path the hazard
cannot reach. Those two files - and only those - set `MISSION_POLL_MS` through the `daemonEnv`
option, which merges last and therefore wins.

They pay for the hazard rather than ignoring it: neither asserts on the fleet as a whole, each
addresses its own cards by tmux session names it generated for that test, and neither touches a
control on any other card. A spec that turns discovery on and then counts sessions, or presses
Kill on "the only card", is the failure mode this note exists to prevent. Both also need real
`tmux` - the one multiplexer with no binary override, since `TMUX_BIN` declares `env: null` -
which CI installs for exactly this reason, and which both specs skip themselves over when
absent.

`startDaemon()` then verifies two things before any test runs, because the whole isolation
story is worthless if the daemon under test is not the one it thinks it is:

- **The daemon answering is the child we spawned**, checked by comparing the `pid` in
  `/api/health` against `child.pid`. The port is OS-assigned rather than fixed, but a port
  can still be taken in the window before the daemon binds - and when the squatter is itself
  a Mission Control daemon, `service: "mission-control"` matches, the fixture rewrites *that*
  daemon's harness config, and every dispatch lands in its real database. Identity is
  checkable, so it is checked.
- **The database landed under the temp home**, because `openDb`'s own isolation guard keys on
  `NODE_TEST_CONTEXT`, which the `node:test` runner sets and Playwright does not.

## Writing specs

There are no `data-testid` attributes and none should be added - there are 229 `aria-label`s
and 155 `role`s, so `getByRole`/`getByLabel`/`getByPlaceholder` already work and stay
correct through refactors. Eight traps, all of which have cost time already:

1. **Never use `{ exact: true }` on a button name.** Keyboard hints render as `<kbd>` inside
   the label and are part of the accessible name: the dispatch button is `"+Dispatch"`.
2. **Never use `getByText` for tooltip prose.** `Tooltip` portals a screen-reader `.tt-desc`
   span into `document.body` for every tooltip in the tree. It is `clip-path`-hidden but has
   a 1x1 box, so Playwright counts it visible and your locator matches two elements.
3. **Press `Escape` after filling the repo combobox.** It portals its listbox over the
   fields below and opens on focus and on every keystroke; the next `fill` otherwise lands on
   a covered control. Its handler calls `stopPropagation`, so this closes the list, not the
   modal.
4. **`expect.poll` for anything outside the DOM.** Playwright auto-waits on locators only. A
   `readdirSync` on the record directory the moment a card appears fails about one run in
   six, because the card is registered before the subprocess it launched has written
   anything.
5. **Never assert that something is absent without first making it present.** Asserting a
   variable did not leak proves nothing when the variable was never set - on CI it is `null`
   whether the code strips it or not, so the test passes through the exact regression it
   names. Seed a recognisable sentinel, then assert the sentinel did not arrive.
   `DAEMON_TERMINAL_IDENTITY` does this for the three pane variables `sdkSubprocessEnv`
   strips. The same reasoning applies to any "did not happen" assertion: arrange for it to be
   able to happen, or the test is decoration.
6. **A web-first assertion cannot see a TRANSIENT wrong state.** `expect(locator).toHaveValue()`
   and friends retry for the whole timeout, so a value that is wrong now and right in two
   seconds passes - and if a poll is what corrects it, the assertion passes over exactly the
   defect it was written for. `settings-task-sources-jira.spec.ts` needs `await
   locator.inputValue()` read once, after a barrier that says when "now" is, because the panel's
   own 4s poll heals the flash it is asserting about. Retry when you are waiting for something
   to become true; read once when the claim is that something never became false.
7. **Verify a regression test against the broken build.** Both traps above produced a green test
   on a build with the fix reverted, which is the only way to find that out. `git stash push`
   the fix, rebuild, run the case, see it red, then restore. If it cannot be made red, it is
   not pinning anything.
8. **Never open the daemon's database with `new DatabaseSync`.** Use `withDaemonDb` from
   `fixtures/daemon-db.ts`. Twelve call sites across ten specs reach the file directly. Ten of
   them **write**, seeding state nothing here can produce for real - a review round is a model
   call, an observed head is a `gh` call - and those are the ones that need a `busy_timeout`,
   which none of them had. WAL is not the whole story: it buys concurrent *readers*, but two
   writers still serialize on one write lock, and a connection with no timeout does not wait
   for it at all - SQLite returns `SQLITE_BUSY` immediately and you get `Error: database is
   locked`. That is a contention failure, so it is invisible alone and shows up only when two
   suites share a machine. The other two call sites only **read** (`dispatch-and-converse` and
   `sdk-idle-restore` poll `sdk_sessions.turn_in_progress`); a reader never blocks under WAL,
   so they were never at risk and route through the helper for the single entry point and the
   guaranteed close, not for the timeout. `test/e2e-daemon-db-access.test.ts` fails the build
   if any spec opens the file directly, because the author who does will not see it any other
   way.

Each test gets its own daemon (`fixtures/test.ts`). That costs about a second and a half and
buys independence: a spec asserting "exactly one session on the fleet" must not silently
depend on running before the spec that dispatches a second.

## What this layer still cannot see

Playwright drives web contents. Native Electron shell behaviour - drag regions, traffic
lights, window chrome, vibrancy - is invisible to CDP and to synthetic clicks, and stays a
manual check.
