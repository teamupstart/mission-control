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
| C | B + `--append-system-prompt-file` redirect | **Still prose.** The agent said so explicitly: *"my instructions say to ask you questions via a Mission Control `request_input` tool, but that tool isn't actually registered in this session (I checked)."* |
| D | C + `--mcp-config` | Agent called `request_input(question: "Which linter should I set up…")` and **blocked**. Review appeared in the dashboard; answering `biome` over HTTP resumed it with *"Biome it is."* |

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
--mcp-config              <STATE_DIR>/ask-channel/mcp.json
--allowed-tools           mcp__mission-control__request_input
--disallowed-tools        AskUserQuestion
--append-system-prompt-file <STATE_DIR>/ask-channel/redirect.md
```

They are produced by a single function so the dangerous half can never ship without the half that
makes it safe. If the MCP server bundle is missing, the function returns **nothing at all** - a
session with `AskUserQuestion` intact is the status quo, whereas one with it removed and no
replacement is arm B.

Both files are written into the state dir on demand, self-healing on every dispatch.

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

- `ask-channel.test.ts` - the argv fragment's shape; that it is empty when the MCP bundle is
  absent (never disallow without provide); that codex gets nothing; that the two files are
  written and refreshed.
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
dispatch died at spawn and surfaced as "agent session never appeared". There is now a
one-time, per-binary `--help` probe; anything inconclusive counts as unsupported.

**The tool description over-claimed.** It asserted "your terminal is not being read" to every
session on the machine, including human-started ones that keep `AskUserQuestion` and are being
watched. That claim is dispatch-scoped and now lives only in `REDIRECT_PROMPT`.

**The modal hid too much.** Suppressing an `input` body outright hard-coded `title === body`
into the UI and flattened long free-text questions into a heading. The test is now
`body !== title` (`showsBody`), so a body with content of its own still renders as a paragraph.

**The channel files were written non-atomically.** A torn `mcp.json` means no `request_input`
while `--disallowed-tools` still applies - arm B. Writes now go to a temp file and `rename`.

One note on the run itself: the first fix round died on an account session limit, not on
anything in the code, and the daemon reset the shared checkout to `main` mid-run (its own
"reset checkouts before assigning" behaviour). The commit survived; the work continued in a
dedicated worktree.
