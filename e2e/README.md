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

Useful flags:

```sh
npm run test:e2e -- --headed                        # watch it run
npm run test:e2e -- --debug                         # step through with the inspector
npm run test:e2e -- -g "conversation"               # one test, matched by title
npm run test:e2e -- e2e/specs/dispatch-and-converse.spec.ts   # one spec file
npx playwright show-trace test-results/<dir>/trace.zip
```

## Evidence

Successful-path artifacts are committed where reviewers need to inspect the rendered state
because a green Playwright run leaves nothing behind on its own: `screenshot`, `video` and
`trace` are all configured `on-failure`, so success is exactly the case with no record.

### Full workflow graph canvas

[`evidence/workflow-graph-full-canvas.png`](evidence/workflow-graph-full-canvas.png) is captured
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

### Sibling links in the HTML preview

[`evidence/preview-sibling-link.png`](evidence/preview-sibling-link.png) is captured after
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

### A spent Foreman note retiring itself

[`docs/evidence/foreman-note-retires-on-your-answer/`](../docs/evidence/foreman-note-retires-on-your-answer/)
holds two before/after pairs from the run that asserts answering an ask retires the Foreman
note pinned on it - one pair for the driver form, one for the MCP review channel. The bug was
reported as a screenshot of a stale `SUGGESTED ANSWER` banner, so the frames answer it in the
same terms: route and registry assertions can prove the row changed, but only a capture shows
a reader that the banner went. The directory README records the regeneration command, and is
explicit about the two pre-existing warts the frames also happen to show.

### Per-harness dispatch defaults propagating

[`docs/evidence/harness-defaults-propagate/`](../docs/evidence/harness-defaults-propagate/)
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

[`docs/evidence/foreman-pr-follow-through/`](../docs/evidence/foreman-pr-follow-through/)
contains PNG and reviewer-renderable HTML captures of the asserted built-dashboard Foreman
settings, plus the focused browser and behavior transcripts. The visual shows that automatic
No-Mistakes review is absent, Straight to PR is bounded by Workflow ownership, and CI
follow-through is a separate control whose visible copy requires an existing PR.

The directory README records the exact regeneration commands.

### Accepted SDK stop

The focused Complete case keeps its fake SDK subprocess alive for four seconds after stop is
accepted. It verifies the Complete modal closes within 1.5 seconds, the retained session card
reads `stopping` with its Complete action unavailable, and the card later reaches `exited`.

The actual successful command output is committed as
[`evidence/complete-stopping-transcript.txt`](evidence/complete-stopping-transcript.txt).
[`evidence/complete-stopping-state.png`](evidence/complete-stopping-state.png) is the visual
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
CAPTURED e2e/evidence/complete-stopping-state.png
  ✓  1 [chromium] › e2e/specs/dispatch-and-converse.spec.ts:143:1 › Complete closes promptly while an accepted SDK stop drains (8.0s)

  1 passed (8.8s)
```

### Accepted workflow submission

The focused bind-and-submit case holds evidence compaction open for five seconds, observes the
`202 Accepted` response with a durable `capturing` run, follows the browser to that exact run,
and verifies the visible run header says `Capturing evidence` before compaction finishes.

The actual successful command output is committed as
[`evidence/workflow-submit-accepted-transcript.txt`](evidence/workflow-submit-accepted-transcript.txt).
[`evidence/workflow-submit-accepted.png`](evidence/workflow-submit-accepted.png) is the visual
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
CAPTURED e2e/evidence/workflow-submit-accepted.png
  ✓  1 [chromium] › e2e/specs/workflow-submit-accepted.spec.ts:45:1 › Bind and submit opens the durable capturing run before compaction finishes (2.8s)

  1 passed (3.5s)
```

### Continue in terminal carries the permission mode

[`docs/evidence/resume-mode-carry/`](../docs/evidence/resume-mode-carry/) holds the paired
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

[`docs/evidence/board-workflow-shortcut/`](../docs/evidence/board-workflow-shortcut/) contains
two full-Board captures from the same passing browser regression. `01-expanded.png` is taken
after the selected card receives its first <kbd>e</kbd>: the full workflow ladder is visible,
the control reads **Collapse workflow**, and the Board remains in overview mode. `02-collapsed.png`
is taken after the second <kbd>e</kbd>: the active-rung preview and **Show full workflow** return,
with session detail still closed.

Regenerate both frames with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-session-action-run.spec.ts \
  -g 'e toggles the selected Board workflow card' \
  --reporter=list
```

### Reviewer verdicts lists reviewers only

[`evidence/workflow-run-reviewer-verdicts.png`](evidence/workflow-run-reviewer-verdicts.png) is
the run page of a completed two-reviewer run, captured by the regression that arrives at it from
the session card's own `⌁ Approved` chip. Both reviewers are named with the verdict they gave, and
the three structural attempts every graph produces - the Session, the all-pass join, the End - are
absent: before the fix each rendered as a card reading `… completed · attempt 1` under a heading
that promises a verdict. What those nodes did is still on the pipeline strip above, and the
stage's own join packet is still under the list.

Regenerate it with:

```sh
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/workflow-run-reviewer-verdicts.spec.ts \
  --reporter=list
```

### Ship it replacement workflow

The focused browser case opens the session's Ship it choice, verifies the visible
`Run No-Mistakes Review` control, observes its `POST` to the session workflow route, waits
for the matching durable run, opens that exact run in the dashboard, and verifies the run
reader names `No-Mistakes Review`.

The actual successful command output is committed as
[`evidence/ship-it-review-transcript.txt`](evidence/ship-it-review-transcript.txt). Two runtime
captures from that same command make both visible states reviewable:

- [`evidence/ship-it-review-control.png`](evidence/ship-it-review-control.png) shows the Ship it
  panel with `Run No-Mistakes Review` next to the direct shipping path.
- [`evidence/ship-it-review-run.png`](evidence/ship-it-review-run.png) shows the run created by
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
CAPTURED e2e/evidence/ship-it-review-control.png
OBSERVED POST /api/sessions/:id/workflow-review with a requestId
OBSERVED Runs monitor selected the created No-Mistakes Review v8 run
CAPTURED e2e/evidence/ship-it-review-run.png
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

[`evidence/conversation.png`](evidence/conversation.png) is a capture from a green run: a
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

### The agent's own question

[`docs/evidence/driver-question-in-conversation/`](../docs/evidence/driver-question-in-conversation/)
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

[`docs/evidence/queued-turn-delivery/`](../docs/evidence/queued-turn-delivery/) carries the
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

[`docs/evidence/line-strip/`](../docs/evidence/line-strip/) carries three artifacts, and they
answer different questions. Two of them the spec writes itself under `MC_E2E_EVIDENCE`; the
third is the run's stdout, which nothing writes to disk on its own - the command below
redirects it, and that redirection is not optional.

The two frames are the ones only a picture answers: `line-live.png` is the strip after a
task is filed, with the Backlog stage naming what autopilot would take next, and
`line-attention.png` is the same strip after that task is parked - amber border, glyph,
name, count and sentence, with the wire feeding it lit to match. "Amber when it needs the
operator" is checkable in the DOM as a class name and readable as a strip only here.

[`transcript.txt`](../docs/evidence/line-strip/transcript.txt) is the run's own verbatim
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
  | tee docs/evidence/line-strip/transcript.txt
```

Three parts of that are load-bearing. `MC_E2E_EVIDENCE` is what turns the screenshots and the
`OBSERVED` lines on at all. `--workers=1` keeps the two tests' output from interleaving,
which is what makes the committed transcript readable and stable between runs. And the `tee`
is the only thing that produces `transcript.txt` - without it you regenerate two files out of
three and the third silently keeps describing an older run.

Actual output from the captured run:

```text
Running 2 tests using 1 worker

OBSERVED the strip rendered 6 stages in pipeline order: Intake -> Backlog -> Working -> Review -> Decide -> Shipped
OBSERVED a filed backlog task reached the strip over SSE, no reload: Backlog 0 -> 1, "next up: Fix pane focus stealing"
CAPTURED docs/evidence/line-strip/line-live.png
OBSERVED parking that task turned Backlog amber (tone-attention), and it is the only amber stage
CAPTURED docs/evidence/line-strip/line-attention.png
OBSERVED clicking the Shipped stage opened the Shipped drawer in place, without leaving #/fleet
OBSERVED the drawer's "Ship log →" escalation navigated to #/shipped
OBSERVED the strip is fleet-only: it did not follow the navigation off the fleet page
  ✓  1 [chromium] › e2e/specs/line-strip.spec.ts:85:1 › the Line renders every stage, tracks the fleet live, and its stages reach their targets (1.4s)
OBSERVED the strip renders once, outside <header class="topbar">, so --topbar-h and .card.expanded are untouched
  ✓  2 [chromium] › e2e/specs/line-strip.spec.ts:168:1 › the strip sits outside the topbar, so it cannot shorten an expanded card (992ms)

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

[`docs/evidence/line-drawers/`](../docs/evidence/line-drawers/) carries sixteen frames and the
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

Regenerate all seventeen with:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/line-drawers.spec.ts \
  --workers=1 --reporter=list \
  | tee docs/evidence/line-drawers/transcript.txt
```

`--workers=1` keeps the twenty-one tests' output from interleaving, and the `tee` is the only
thing that produces `transcript.txt` - without it you regenerate sixteen files out of
seventeen.

### The topbar's one row

[`docs/evidence/topbar-one-row/`](../docs/evidence/topbar-one-row/) carries two frames of the
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

### The everything-palette

[`docs/evidence/palette/`](../docs/evidence/palette/) carries three frames and the run's own
stdout, written by `specs/palette.spec.ts` under the same `MC_E2E_EVIDENCE` flag.

The frames answer what only a picture can. `palette-empty.png` is the palette before a letter
is typed - the **Do** group and nothing else, which is the claim that an unprompted palette
does not dump fifty settings rows at you. `palette-search.png` is one query reaching all three
groups at once, each row wearing its kind chip and its state line; "grouped as Jump to / Do /
Settings, each row carrying a kind chip" is checkable in the DOM as a role and a class, and
legible as a palette only here. `palette-kind-filter.png` is the same query after one
<kbd>Tab</kbd>: narrowed to a single kind, with the active filter named beside the caret.

[`transcript.txt`](../docs/evidence/palette/transcript.txt) is the run's verbatim stdout, and
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
  | tee docs/evidence/palette/transcript.txt
```

`--workers=1` keeps the seven tests' output from interleaving, and the `tee` is the only thing
that produces `transcript.txt`.

### Where the Inspector's brief lives

[`docs/evidence/inspector-brief-location/`](../docs/evidence/inspector-brief-location/) carries
three frames from `specs/inspector-brief-location.spec.ts`, which asserts that the Inspector
panel names both places a repo may keep its brief - `personas/INSPECTOR.md` first, a root
`INSPECTOR.md` as the fallback - and that neither filename is split across lines.

`inspector-settings-lede.png` is the sentence at reading scale and
`inspector-settings-panel.png` places it where an operator meets it, above the switch that
turns the Inspector on. The third frame is the one that makes the other two mean anything.
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

[`docs/evidence/workflow-run-audit/`](../docs/evidence/workflow-run-audit/) carries three frames
from `specs/workflow-run-audit.spec.ts`, and they exist because the change is a SUBTRACTION.
`toHaveCount(0)` proves `Copy run id`, `Export run`, `Export version` and `Open version` are
unreachable; only a picture shows what the action row reads like without them, and that the `v1`
badge which absorbed `Open version` still looks like the badge it always was.

`01-header.png` is the row itself. `02-collapsed.png` and `03-opened.png` are the
`Audit and bug reports` disclosure the three of them moved into, closed and open - closed being
the state that matters, since the whole claim is that this material costs a reader nothing until
they ask for it.

The directory README records the regeneration command.

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
  by the task titler, Foreman, the goal refiner and the Inspector.
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
| `MISSION_POOL_REAP_MS=0` | the pool sweep is **not** scoped by `MISSION_HOME` - it reaps the shared treehouse worktree pool and will delete a sibling checkout's work |
| `MISSION_POLL_MS=0` | terminal discovery is **not** scoped either - it walks every process on the machine and cards anything that looks like an agent |

Those last two matter most and are the least obvious. Without `MISSION_POLL_MS=0` a daemon
booted on a developer's laptop adopts their real running sessions: the fleet count is
non-deterministic against CI where there are none, and the dashboard's Kill and Reset
controls act on live work.

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
correct through refactors. Four traps, all of which have cost time already:

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

Each test gets its own daemon (`fixtures/test.ts`). That costs about a second and a half and
buys independence: a spec asserting "exactly one session on the fleet" must not silently
depend on running before the spec that dispatches a second.

## What this layer still cannot see

Playwright drives web contents. Native Electron shell behaviour - drag regions, traffic
lights, window chrome, vibrancy - is invisible to CDP and to synthetic clicks, and stays a
manual check.
