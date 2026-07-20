# Plan: The ask channel

Status: implemented
Owner: ai-harness
Blocks: "P1: Move TUI mode and dialog grammar behind `harness.tui`" - do this first.
Related: `src/server/discovery/pane-dialog.ts` (397 lines of TUI grammar this makes redundant
for dispatched sessions), `src/mcp/server.ts` (the replacement channel, already shipped).

## Goal

Stop reading Claude's option menu off the screen. Disallow the built-in `AskUserQuestion` in
sessions the harness dispatches, so a clarifying question arrives as **structured tool
arguments** through the MCP channel this repo already ships, instead of as a picture of a menu
we parse with a regex grammar.

## Why now, ahead of the TUI capability

`pane-dialog.ts` is 397 lines of grammar matching TUI chrome - `OPTION_ROW`'s cursor glyph,
numbered rows, `Submit answers`, `Type something`, `have not answered all questions` - plus the
`actions.ts` walkers that arrow through it and re-verify each label against a fresh capture.
That is the bulk of what the TUI task proposes to move behind an interface. Moving code we
intend to delete costs the interface design, the migration and the tests, then throws all three
away.

This is prior art, not speculation. Sculptor (Imbue) drives Claude Code with
`--disallowed-tools 'AskUserQuestion,ExitPlanMode'` plus in-process SDK-MCP replacements, so the
agent blocks on a tool call while their UI renders natively and answers on its behalf.

## What the experiment showed

Four arms, live `tmux` sessions against the running daemon, each sent the same
question-inviting prompt. **Nothing below is inferred from a diff.**

| Arm | Configuration | Result |
|---|---|---|
| A | (control, no flags) | Renders an `AskUserQuestion` menu - the status quo. |
| B | `--disallowed-tools AskUserQuestion` | Agent asked **in prose and stopped.** Never attempted the tool, never sought an alternative. |
| C | B + the `--append-system-prompt` redirect | **Still prose.** The agent said so explicitly: *"my instructions say to ask you questions via a Mission Control `request_input` tool, but that tool isn't actually registered in this session (I checked)."* |
| D | C + `--mcp-config` | Agent called `request_input(question: "Which linter should I set up…")` and **blocked**. Review appeared in the dashboard; answering `biome` over HTTP resumed it with *"Biome it is."* |

Arms C and D delivered the redirect with `--append-system-prompt-file <path>`, which is what
shipped first. That variant is gone: review round 2 showed its capability probe could never
return true, and the documented `--append-system-prompt <text>` replaced it. Arm D was then
**re-run against the running daemon on the flag that actually ships** - see
[Re-verified on the inline flag](#re-verified-on-the-inline-flag). Everything the arms
established about the DESIGN (a disallowed tool does not redirect itself; provide must be
atomic with disallow) is unchanged by which flag carries the prompt.

### Arm B is the risk, confirmed

The task asked us to prove that `--disallowed-tools` does not degrade into the agent simply
never asking. It degrades into something adjacent and just as bad: the agent asks in **prose and
ends its turn**. That is *worse* than the menu it replaces. A menu at least sits on the screen
where `pane-dialog.ts` reads it and Foreman can answer it. A prose question ends the turn and the
dashboard shows an idle session with no pending anything.

**A disallowed tool does not redirect itself.** The redirect is not a nicety; it is the feature.

### Arm C is the finding that shapes the design

The premise that we are "one step away" is not true on this machine. `claude mcp list` has no
`mission-control` entry. Registration happens only through the Electron *Install integrations*
button (`integrations.ts:197`) or a hand-run `claude mcp add` that `hooks/install.mjs:350` merely
*prints*. So `request_input` is currently unreachable by **every** session here - it has never
fired, not because agents decline to call it, but because it is not there.

Arm C is precisely what "disallow the built-in and trust user-scope registration" looks like in
practice: **both doors shut**, and the agent politely narrates its own gagging.

So `--mcp-config` on the dispatch argv is load-bearing, not an optimisation. It makes *disallow*
and *provide* **atomic** - the same spawn that removes the built-in supplies the replacement, so
no machine state can have one without the other. User-scope registration keeps working for
human-started sessions and stops being the thing this feature rests on.

### Two further findings from the probe

- **The MCP call raises its own permission prompt.** Arm D stopped on
  `Do you want to proceed? 1. Yes …` before the tool ran. Without pre-approval we trade one menu
  for another. `--allowed-tools mcp__mission-control__request_input` fixes it. Auto-mode-on-
  dispatch would also cover it, but `autoModeOnDispatch` is an optional setting, so it cannot be
  the guarantee. Verified separately: `--allowed-tools` adds an auto-approve rule and does **not**
  restrict the toolset - the full tool list survives it.
- **The options collapsed into prose.** `request_input(question)` is free-text only, so
  "eslint, biome, or oxlint" arrived inside the question string. That misses the stated goal.

## Design

### 1. `request_input` gains structured options

`PlanDecision` + `DecisionForm` already render exactly the `AskUserQuestion` form - options,
radio vs checkbox, `allowOther`. They are only reachable through `request_plan_decisions`, which
demands a plan body and renders as a plan. Rather than start a parallel tool, `request_input`
takes an optional `options` array and carries it as a single-element `decisions` array on an
`input` review.

Free text stays the fallback for genuinely open asks, so the redirect prompt names **one** tool
and the agent picks the shape from the question rather than choosing between two tools.

`CreateReviewSchema` already passes `decisions` through generically; only the refine needed
widening. `ReviewModal` gains one branch: an `input` review that carries decisions renders the
`DecisionForm` instead of the textarea.

### 2. The ask channel is four argv pieces, built together or not at all

A new `src/server/ask-channel.ts` owns the whole contract and returns one argv fragment:

```
--mcp-config            <STATE_DIR>/ask-channel/mcp.json
--allowed-tools         mcp__mission-control__request_input
--disallowed-tools      AskUserQuestion
--append-system-prompt  <the redirect prompt itself, inline>
```

They are produced by a single function so the dangerous half can never ship without the half that
makes it safe. If the MCP server bundle is missing, the function returns **nothing at all** - a
session with `AskUserQuestion` intact is the status quo, whereas one with it removed and no
replacement is arm B.

`mcp.json` is written into the state dir on demand, self-healing on every dispatch, and
atomically (temp file + `rename`) so a concurrently-starting `claude` can never read it torn.
The redirect needs no file: it travels inline as `--append-system-prompt`'s value.

### 3. Scope: dispatched sessions only

Matches `applyAutoMode`'s existing precedent - only sessions the harness launched, never one the
operator started and we merely discovered. `pane-dialog.ts` stays reachable and stays intact.
**Do not delete the grammar in this task**; establish the replacement first, delete it in the TUI
task.

Codex gets nothing: the flags are Claude's.

### 4. Foreman's prompt stops describing a menu it will no longer see

`foreman/prompt.ts` names `AskUserQuestion` in three places as *the* canonical menu and as the
only place a pending ask exists. For a dispatched session that is now false: the ask arrives as an
`input-review`, a surface Foreman already handles. The menu guidance stays - permission prompts
and human-started sessions still produce menus - but permission prompts become the canonical
example, and the comments note which surface a dispatched ask actually lands on.

## What this does not do

- **`ExitPlanMode` is out of scope.** We have `share_plan` / `request_plan_decisions`, but plan
  mode interacts with permission modes - a separate question.
- **No grammar is deleted.** A session a human started does not get our flags, so `pane-dialog`
  stays reachable and correct for those.

## A note on `tmux` argv

`dispatcher.ts:455-459` claimed tmux "joins the trailing arguments with spaces and runs the
result through a shell rather than exec'ing the argv", and constrained model ids to a safe
charset because of it. Measured on tmux 3.6b, that is not what happens: `$HOME`, `a*b` and
`two words` each arrive as one unmodified argv element. Modern tmux (>= 3.3) uses multiple
arguments as the argv directly. The comment is corrected; the model-id charset constraint stays
as cheap insurance for older tmux, where the old description did hold.

This matters here because the argv now carries filesystem paths, whose charset we do not control.

## Tests

- `ask-channel.test.ts` - the argv fragment's shape, including that the redirect travels as the
  flag's own inline value; that it is empty when the MCP bundle is absent or the state dir
  cannot be written (never disallow without provide, and never throw into a dispatch); that
  codex gets nothing; that `mcp.json` is written, refreshed, and left with no stray temp file.
- `review-input-decisions.test.ts` - `request_input` with options produces an `input` review
  carrying one decision; the schema accepts it; `ReviewModal` renders the form rather than the
  textarea.

## Review round 1

Six findings, all fixed. Four were the operator's call and they chose to fix all of them.

**Foreman was answering blind.** `classifyPending` passed only `inputReview.body`, so the
options the agent offered never reached the reviewer. Before this change the choices were rows
on the pane and the prompt told the reviewer to copy one exactly; after it, they were nowhere
- the transcript cannot cover for it, since a blocked tool call is not written there until it
returns. Foreman was free to answer outside the offered set on exactly the asks this feature
routes to it. `withOfferedOptions` now renders the labels and details into the question, and
says to name one of them or escalate, because this surface is answered with prose rather than
by selecting a row.

**A filesystem error failed the whole dispatch.** Only the missing-bundle path returned `[]`;
`mkdirSync`/`writeFileSync` threw into `Dispatcher.dispatch`'s try block and marked the task
`failed`. That inverted the module's own contract. `askChannelArgs` now cannot throw at all.

**The channel rested on an undocumented flag.** `--append-system-prompt-file` is absent from
`claude --help`, and Claude Code hard-errors on unknown options, so on a CLI without it every
dispatch died at spawn and surfaced as "agent session never appeared". Round 1 added a
one-time, per-binary `--help` probe for it; round 2 removed the flag instead (see below).

**The tool description over-claimed.** It asserted "your terminal is not being read" to every
session on the machine, including human-started ones that keep `AskUserQuestion` and are being
watched. That claim is dispatch-scoped and now lives only in `REDIRECT_PROMPT`.

**The modal hid too much.** Suppressing an `input` body outright hard-coded `title === body`
into the UI and flattened long free-text questions into a heading. The test is now
`body !== title` (`showsBody`), so a body with content of its own still renders as a paragraph.
(Round 2 found that escape hatch was unreachable, and fixed the producer - see below.)

**The channel files were written non-atomically.** A torn `mcp.json` means no `request_input`
while `--disallowed-tools` still applies - arm B. Writes now go to a temp file and `rename`.

One note on the run itself: the first fix round died on an account session limit, not on
anything in the code, and the daemon reset the shared checkout to `main` mid-run (its own
"reset checkouts before assigning" behaviour). The commit survived; the work continued in a
dedicated worktree.

## Review round 2

Four findings, all fixed. Two were the operator's call.

**The probe never returned true, so the whole feature was inert.** Round 1's fix grepped
`claude --help` for the literal `--append-system-prompt-file`. Real `claude` (2.1.216) prints
the two variants folded together as `--append-system-prompt[-file]`, so the literal never
appears, the probe always answered "unsupported", and every dispatch silently kept the
built-in menu. It passed its tests only because the stub binary echoed the literal string -
the test asserted the assumption rather than the world.

The fix simplifies rather than hardens: the channel now passes the documented
`--append-system-prompt <text>` with the prompt INLINE. That deletes the probe, its cache,
the `agentBin` parameter threaded in for it, `redirect.md`, and the second `writeIfChanged`
call. Passing ~1.2KB as one argv element was measured before it was chosen: 1260 bytes
arrived byte-identical through tmux, including `$HOME`, `a*b` globs, both quote styles,
backticks, `$(cmd)`, semicolons, pipes, ampersands and newlines. The accepted tradeoff is
that the prompt is visible in a dispatched agent's `ps` line; it is a static instruction with
no secrets in it. `writeIfChanged` stays for `mcp.json`, atomicity included.

**Round 1's `showsBody` escape hatch could never fire.** `request_input` sent the question as
BOTH title and body, so `body !== title` was false for every review the tool produced, and a
long or multi-line question rendered only as the flex-row `<h3>` - the `white-space: pre-wrap`
added to `.question` in the same change was unreachable. Fixed at the producer, where the
duplication was: the review now takes `titleLine(question)` as its title (the shared clipper,
word boundary and ellipsis at `TITLE_MAX_CHARS`) and the whole question as its body. A short
question still clips to itself, so the equal case stays de-duplicated; past the clip the
readable paragraph is back.

**Two pending questions shared one radio group.** `DecisionForm` used the decision id as the
group `name`, and `request_input` hardcodes that id as `q`. A `name` is document-scoped and
`ReviewModal` draws every pending review into one document, so two option-carrying `input`
reviews - an abandoned ask still pending while the agent asks again - collided: clicking in
one unchecked the other in the DOM while React re-rendered only the card that changed, leaving
the first showing no selection with its Submit still enabled. The form now takes a
`namePrefix` and the modal passes the review id. The decision id is untouched, because it is
echoed back in the response payload.

**`MISSION_MCP_SERVER` was undocumented.** New env var, no Configuration row. Added.

## Review round 3

### Re-verified on the inline flag

Round 2 swapped the redirect's delivery mechanism, and the only end-to-end evidence on record
had been collected on the mechanism it replaced. Round 2's tests asserted the argv's shape,
which is exactly the shape of the failure round 2 was fixing: round 1 typechecked and passed
its tests while being completely inert.

So arm D was run again, against the running daemon, on the shipped commit. `askChannelArgs`
emitted 8 argv elements (4 flags) with a 1292-byte inline prompt; the agent was spawned
through the real `spawnDetachedSession`, was given a question-inviting prompt, and called
`mcp__mission-control__request_input` with three structured options (biome / eslint / oxlint),
blocking with **no permission prompt**. Resolving the review from the dashboard returned the
answer and the session resumed.

That closes the one open question - whether Claude Code applies `--append-system-prompt` in
INTERACTIVE mode, some prompt flags having historically been `--print`-only - and confirms a
~1.2KB multi-line value survives tmux intact.

Measured alongside it, on the title/body split: a 54-character question keeps `title === body`
and stays de-duplicated, while a long multi-line one clips to *"Should the retry policy use
exponential backoff with…"*, so `title !== body` and the `pre-wrap` paragraph renders.

The `ask-channel.test.ts` assertion was tightened to match: it now asserts the element after
`--append-system-prompt` IS the prompt text, not merely that the flag is present.

### The dispatch argv reached the process filter

`isBackgroundAgent` (`discovery/processes.ts`) decided "this is a daemon, not a session" by
content-matching the WHOLE `ps` command string for `claude ... daemon` and `mcp serve`. That
was safe while a dispatched line was `<claude> --model <id>`. It is not now: the line is
~1594 characters and carries `--mcp-config <MISSION_HOME>/ask-channel/mcp.json` plus the whole
inline prompt.

Measured on the live process: today's line matches neither pattern, so nothing was broken.
But an operator whose `MISSION_HOME` is `~/daemon-state`, or one edit putting the word
"daemon" into the prompt's prose, would make every dispatched session undetectable - it never
binds, and the dispatch fails `READY_TIMEOUT_MS` later as "agent session never appeared".

The filter was fixed rather than the prompt. The first attempt narrowed the patterns to the
command HEAD, which removed the coupling but was written against two plausible-looking forms
rather than the machine: `ps` shows FIVE background Claude Code processes, and only
`claude daemon run …` names its role in head position. The pty-host and spare workers name
theirs as a subcommand (`claude bg-pty-host …`, `claude bg-spare …`) or as a flag on the app
bundle with no subcommand at all (`…/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host …`),
so head-matching dropped four of the five. They had all been caught only by ACCIDENT before,
because their socket path contains `cc-daemon-501` and that satisfied a `\bdaemon\b` search of
the whole line. That accident was load-bearing.

So the heuristic is gone entirely, replaced by an explicit allowlist matched at a fixed argv
POSITION: `BACKGROUND_SUBCOMMANDS` (`daemon`, `bg-pty-host`, `bg-spare`, `mcp serve`) or
`BACKGROUND_FLAGS` (`--bg-pty-host`, `--bg-spare`), read from argv[1] alone (argv[2] as well,
for `mcp serve`'s second word). Both lists are append-only: a form we miss becomes a phantom
session in the dashboard, and a form we match too eagerly makes a real agent disappear from
it.

Position, not just whole tokens, because a token scan of the entire argv still had the hole
one rung up. Checking that on the live machine caught it: a headless `claude -p` whose prompt
happened to quote the token `--bg-pty-host` was classified as a pty host. Prose quoting a flag
is prose; argv[1] is the one slot no argument VALUE can occupy, and every real form declares
its role there.

`process-background-filter.test.ts` is built from the five real `ps` lines verbatim rather
than from invented ones, which is the point of the finding, plus `claude mcp serve`, a bare
interactive `claude`, a full dispatched argv, a `--mcp-config` path containing "daemon", and
prompt prose containing "daemon" and "mcp serve".
