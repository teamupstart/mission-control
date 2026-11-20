# FR-05 headless mode: implementation plan

| | |
|---|---|
| What this plan delivers | The dependency-ordered phases, spikes, and risks for building FR-05 headless mode (a Claude Code mod plus a natively drawn Mission Control pane, with `mctl`) on `main`, one pull request per phase, every change behind the `headless-mode` preview flag. |
| Spec | Commonroom, workspace Meta Harness, spec `d2cdf331-4f03-4c77-957d-246cfde0017c`, **version 18**, 236,444 characters, sha256 `feece3821c5ef3ca868907c056b7fd6b87878c138c3ca881c90fd718d679e514`. The spec, not this plan, is the contract: where they differ, the current spec version wins. |
| Base | `main` at `c2b873f6f`. It has no `src/mod/`, `src/cli/` or `src/server/home-dispatch/`, no preview flag in `src/shared/feature-flag-registry.ts`, and database schema 35 (`CURRENT_DATABASE_SCHEMA_VERSION`). |
| Not done here | No code, no edit to the spec, no post to Commonroom. Phase tasks go to the backlog and are not started. |
| Revision | 16. Revision 2 (approved) applied the owner's first-review choices: the "mods can load" checks are folded into WP7 and spike S17 (6.5), and spike answers are recorded in task reports and Commonroom, not in a repository file. Revision 3 added the phased implementation files. Revision 4 repairs the Plan Validation review (section 9): widget placement is out of v1, spike reports have one recording path, P4 now merges after P3, the pane-open handoff between P11 and P12 is safe, and the mod upgrade path has a version probe and a reinstall step. Revision 5 closes the second review round (section 9): the pane-open ownership wording, P7 after P3, interim behavior for P10's `logs` and P13's launcher handoff, P17 after P13, and an honest recovery path when a mod reinstall fails. Revision 6 closes the third round: P15 owns the one pane edit for subagent lines (a slot P12 reserves), S28's timing is stated for its two stages, and P17 merges after P6 and P16. Revision 7 closes the fourth round: P15 also owns the producer of each task's subagent lines, and P14 owns the edit that makes `mctl claude` use the shared `claude` detection. Revision 8 sweeps all files for the same class of gap and names the owner, field and later phase for every stub, slot and optional field. Revision 9 names the one read path for subagent lines, gives P14 one merge rule for the soft spikes, and makes P13's launcher outcome conditional on the S10/S11 gate. Revision 10 replaces the invented subagent field with the spec's own `subagents` fields and `subagentLines` function, names every route by its spec path, states the hard and soft gate rules once and repeats them, and states both branches of every spike-dependent outcome. Revision 11 gives S4 a mergeable fallback, uses one confirmation threshold for P14's checks, orders P5 after P3 and P8 after P5, and adds a producer to consumer audit. Revision 12 replaces that audit with script-derived tables in 6.8 (producer to consumer, and spikes), splits the grouped spike rows, makes P8 name S14, S18 and S19, and defines the interim for P7's steps before P14's commands exist. Revision 13 states the chat poll interval once (1.5 s, or 3 s under the S23 fallback), moves the runtime and Focus test to P5, where the first task is started, and adds constants and fixture-source tables to 6.8. Revision 14 makes an unanswered S23 use the conservative 3 s and 30-row behavior everywhere, defines the throwaway kits the spikes run on before any phase exists, and arranges the merge order in six waves with the required order stated inside each. Revision 15 drops the unowned S19 daemon claim (P8's inert path is the fallback), adds the deviations table to section 9, and applies the fixes found by two fresh-context reviewers, which cover the Focus import guard and P9's send, the hard-gate wording, S28b's dependency on P5, the fakes every phase needs, and stub owners. Revision 16 adds the known gaps list at the end of section 9 and changes nothing else. |

## 1. Read this first: the brief and the spec disagree on the version

The request names spec "current version 8" and work packages WP0 to WP17. The spec is at **version 18**. Version 8 was the first publication of this design. Versions 9 to 18 repaired it and added the Codex review gate: F20, section 7.25, **WP18**, D54 to D57, L40 to L43, Q24 to Q26 and spikes S24 to S27. Every item the request names (section 7.10 and 7.10a, 7.22 to 7.24, WP0 to WP17 with WP10 withdrawn, 8.4, D44, D48 to D53, S17 to S23) is unchanged in meaning at version 18, so this plan covers version 18 and adds WP18 and its spikes. Planning against version 8 would leave out a work package that the merge order of WP14 and WP9 already depends on.

A phase task must re-read the spec's version and sha256 before it starts. If the spec has moved past 18, the task stops and reports the difference instead of building to a stale contract.

## 2. How this plan relates to the plans that already exist

| Plan | Where | Status | What this plan does with it |
|---|---|---|---|
| `headless-mode-native-pane` | `docs/plans/` on `main` (#1551) | Current. It tracks spec versions 8 to 18 (what changed and why). It has no phases. | Kept as is. This plan is its implementation counterpart. It is not a phase plan, and nothing here edits it. |
| `headless-agent-sdk` | `docs/plans/` on `main` | Unrelated: the Agent SDK transport for one-shot calls and the Foreman worker. | Name collision only. No dependency, and no phase touches it. |
| Headless mode delivery plan (spec v3, 15 phases including `wp10-follow-drop-in`, MCP tools and skills) | Local plan store | Superseded. It builds a terminal runtime, MCP tools and skills that D38, D42, D43 and D50 withdrew. | Not used. Its phase files are not scheduled. |
| Headless mode implementation phases (7 phases, older spec) | Local plan store | Superseded by the same decisions. | Not used. |
| Headless install plan that avoids conflicts (a named `spike` instance with its own state home) | Local plan store | Superseded by D28 and D44: the mod installs into the normal setup through the app-staged folder marketplace. | Not used. Its conflict list is a useful input to spike S17 only. |
| Headless mode spec and acceptance (old) | Local plan store | Superseded: the spec in Commonroom replaces both earlier specs. | Not used. |
| "`mctl setup` checks that Claude Code mods can load (FR-05 spec v12)" | Local plan store | **Id clash, resolved by owner decision.** It proposes spec edits (new decisions D54 to D58, a spike S25, setup checks for `disableAllHooks`, managed mod policy and the Claude Code version floor). Spec version 12 was published for the Codex gate instead, so those ids now mean something else in the spec (D54 to D57 and S25 are Codex's). The proposal was never merged into the spec. | **Folded into WP7 and spike S17** as plan-local requirements (6.5), by the owner's decision on the first review. They carry no spec ids: the phase task cites local plan `8065dbe0-950a-4572-b358-8e5b5489e69b`, revision 2, by its check names, until the owner renumbers them into the spec. |

Git history also shows that an earlier set of `docs/plans/headless-mode*` documents was removed from `main` (`c847dd69f`). Nothing in this plan depends on them.

## 3. What the build is, in one picture

```mermaid
flowchart LR
  P[Person in Claude Code] --> MOD[Mod: dialogs, band, toasts, status, one tool]
  P --> PANE[Pane: Needs you, Tasks, Workflows, Residents]
  MOD --> D[(Daemon: /dispatch/* routes, in process)]
  PANE --> D
  D --> W[Workers and residents on their dashboard runtime]
  CLI[mctl: reads, run, setup, doctor] --> D
  D --> RDY[GET /dispatch/readiness: Codex checks]
```

The load-bearing facts, all from the spec:

- The mod calls only `/api/health` and `/dispatch/*`. It never calls another `/api/*` route (7.10).
- Answers, chat and approvals happen in the pane, over new `/dispatch/` wrappers that apply the home-session rules (D48, D49).
- The mod ships only inside Mission Control (D44), is staged by rename at `{stateDir}/mod/`, and is installed by `mctl setup` through a folder marketplace (7.10a).
- Nothing depends on tmux or herdr (D50).

## 4. Constraint 1: dropping WP10 must not affect the existing focus and pane-jump feature

Jordan's constraint, checked against D50 and against `main`.

### 4.1 What WP10 would have added, and what exists today

| | Exists on `main` today | WP10 would have added (all new, none on `main`) |
|---|---|---|
| The feature people use | Dashboard **Focus**: `POST /api/sessions/:id/focus` (`src/server/routes.ts`), `focus()` and `raiseThrough` in `src/server/actions.ts`, the terminal backends in `src/server/terminal/` (tmux, herdr, wezterm, iterm, cmux, ghostty), and Settings > Setup > Terminals "Opens in" (`docs/harnesses-and-terminals.md`, "Multiplexer focus terminal") | Nothing here. WP10 never touched it. |
| Headless jump | None | A terminal runtime for home-dispatched tasks, `mctl pick`, `POST /dispatch/jump`, the tmux key table, the herdr mirror, the `mctl claude` workspace, `tasks.origin_terminal`, `home_dispatch_sessions.terminal` |

D50 withdraws the right-hand column. The words "the jump route" in D50 mean the **new** `/dispatch/jump`, not `/api/sessions/:id/focus`. PR #1541, the only code ever written for WP10's neighbours, was closed unmerged (L39), so withdrawing WP10 removes no shipped code and changes no behavior that exists.

### 4.2 Verdict

**D50 does not affect the existing Focus feature.** It adds nothing to, and removes nothing from, any path Focus uses. Three things could still break it indirectly, and the plan closes each with a test rather than an assumption (guard 1 is tested in P5, the first phase that starts a real task through the dashboard path; guards 2 and 3 in P1; P18 repeats all three):

1. **Runtime resolution.** D50 says home-dispatched tasks keep the runtime a dashboard task of their kind gets. If a home-dispatched task ever passes a runtime override, it could land on a runtime Focus cannot raise. WP3 (draft start), WP6b (`mctl run`) and WP14 (through WP3's drafts) must create tasks through the same path as the dashboard and pass no runtime. Test: a home-dispatched task of a kind whose default runtime is a terminal gets a pane, and `POST /api/sessions/:id/focus` on it returns what it returns for a dashboard task. The test is P5's and uses the existing fake agent helpers, so it spends no model tokens; P18 repeats it with the task started through `mctl run` and through the mod's dispatch flow.
2. **The route-surface oracle.** WP1 regenerates the committed route-surface oracle (`test/route-surface-oracle.test.ts`). The regenerated diff must add `/dispatch/*` entries and change no existing `/api/*` entry. Test: a guard that fails if any `/api/sessions/:id/focus` or terminal route entry differs from `main`.
3. **Controlled paths.** `src/server/terminal/` and `src/server/actions.ts` are owned by no work package. Test: a guard that fails if any file under `src/mod/`, `src/cli/` or `src/server/home-dispatch/` imports from `src/server/terminal/`, or imports anything from `src/server/actions.ts` other than `sendText` (the existing send function, which only P9's `chat.ts` may import, never `focus` or `raiseThrough`), and the pull request description of every phase states that those paths are untouched (phased-plan.md rule 3).

```mermaid
flowchart LR
  subgraph Existing[Exists on main, unchanged]
    B[Dashboard Focus button] --> R[POST /api/sessions/id/focus]
    R --> A[actions.focus and raiseThrough]
    A --> T[src/server/terminal backends]
  end
  subgraph New[Headless mode, new]
    PN[Pane] --> DR[/dispatch/* routes/]
    DR --> IP[In-process session read and send]
  end
  subgraph Withdrawn[WP10, withdrawn, never built]
    X1[mctl pick, /dispatch/jump, key table, herdr mirror, mctl claude workspace]
  end
```

### 4.3 What the user does lose, stated plainly

A headless user cannot jump from the pane to a worker's terminal pane. They chat in the pane, or press `d Open in the dashboard` and use the existing Focus button there. That is a smaller feature than version 7 promised, not a regression: it never existed. The plan's one suggested spec change, for the owner to apply and not for this plan to edit, is to write "the new `/dispatch/jump` route (not `/api/sessions/:id/focus`)" into D50 so no later reader mistakes the two.

## 5. Spikes, run first

The spec's WP0 says the spikes need a person at a terminal, and says to record answers in the spec. This plan does not edit the spec, and by the owner's decision it adds no results file to the repository. No spike opens a pull request. The person-run spikes (they need a managed Mac, several terminals or the desktop app) are written up by the person who ran them. The two agent-run spikes, S28a and S28b, are scout tasks whose final report is the write-up. In both cases the owner posts the answer to Commonroom. A gated phase task reads the recorded answer before it merges, and its pull request names the spike it relied on.

### 5.1 The gates and what they block

| Spike | Question (short) | Blocks | Gate? | If no |
|---|---|---|---|---|
| S10, S11 | Can the launcher open from `classic.SessionStart`, or hold the first prompt? | WP14 launcher | **Merge gate** | Owner decides; the rest of WP14 merges with the launcher off |
| S16 | Does a message through `/dispatch/tasks/{taskId}/send` reach a worker waiting on `request_input`; else does `chat_first` work? | WP16, WP17 | **Merge gate** | Owner decides how chat works |
| S27 | Does every `codex login` and `logout` change `auth.json`'s mtime? | WP18 | **Merge gate**, but either answer has a defined behavior (7.25) | Record `CODEX_AUTH_MTIME_RELIABLE = false` |
| S14 | Do `marketplace add` and `install --scope user` run without prompts on this machine? | WP7, WP13 | Soft | `CLAUDE_CODE_PLUGIN_DIRS` through the settings installer, and ask the policy owner (Q19) |
| S17 | Do they run without prompts on a managed Upstart Mac with the real policy? | WP7 | Soft | `CLAUDE_CODE_PLUGIN_DIRS` through the settings installer, and ask the policy owner (Q19) |
| S18 | Does `/reload-plugins` load a restaged build with no `plugin update`, and does a fresh session after restaging show the new installed version in `claude plugin list`? | WP7, WP13 | Soft | Loading at session start is not enough on its own: P14 detects a stale installed version and reinstalls (6.5, `mod-current`) |
| S19 | Does a mod one `modApi` behind or ahead stay fully inert? | WP13 | Soft | P8's inert path is the fallback: nothing is registered before the `modApi` check passes, and P8's pull request records the S19 result. The spec's "daemon hides the capability" is not built, because no phase owns a daemon change (deviation in section 9) |
| S20 | Does `claude` detection find every install place, including from a LaunchAgent? | WP7 | Soft | Add the place, or `MISSION_CLAUDE_BIN` |
| S21 | Does the Esc, refuse, reopen-after-150-ms pattern keep the keyboard in iTerm2, Terminal.app, tmux and herdr, docked and inline, ten times? | WP17 | Soft | Esc hands the keyboard back; only Back returns to the list |
| S22 | Does the pane draw and take keys in the desktop app's local sessions and in VS Code? | WP17 | Soft | Terminal only in the alpha; the pane view says so (P12) |
| S23 | What do the 5 s inbox poll, 1.5 s chat poll and 50 items cost? | WP17 | Soft | Chat poll 3 s, Tasks tab capped at 30 rows; this is also the behavior when S23 has no recorded answer, and 1.5 s with every row applies only once S23 records the default as within budget |
| S4 | Are agents usable as `subagent_type`? | WP11 | Soft | Link the agents, warn in doctor, and no flow names them (P15) |
| S5 | Is there one Foreman leader? | WP7 | Soft | Have the app adopt the Foreman service, like the daemon (spec 11.2) |
| S8, S12, S15 | `start_dispatch` phrasing, `$.prompt.fill`, tool offer and withdrawal | WP14 | Soft | S8: strengthen the tool description and the nudge wording, then try again. S12: take the description as text typed under Other in a dialog. S15: offer the tool for the whole session and refuse calls while the flag is off (spec 11.2) |
| S24, S25, S26 | `codex login status` per account type, `codex` found from the LaunchAgent, model-id matching | WP18 | Soft | S24: treat exit 1 with a key set as `unknown`, not signed out, and let `codex-headless` decide. S25: probe the known install places as 7.10a does for `claude`, and raise the cache to 30 minutes. S26: compare through the model catalog's own id normalisation and report an unmatched pin as information (spec 11.2) |

Two rules cover every spike gate. A merge gate is satisfied only by the owner's answer posted to Commonroom: read it, quote it in the pull request, and stop without merging the gated part if none exists (the whole phase, except that for P11 it is the launcher part only, and the rest of P11 then merges with the launcher switched off). Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded.

An unrecorded hard gate also holds every phase that has the gated phase as a prerequisite (S27 holds P7 and so P11, P15, P17 and P18; S16 holds P9 and so P12, P15, P17 and P18).

### 5.2 S17 to S23, with the pass test a person runs

| Spike | Setup | Pass when | Evidence to record |
|---|---|---|---|
| S17 | A managed Upstart Mac with the real policy. Stage a build at `{stateDir}/mod/`. | `marketplace add` and `install --scope user` finish with no prompt; the mod loads in a terminal session, a desktop-app local session and a terminal worker | The commands, exit codes, `claude plugin list`, the policy files read, which of the 6.5 switches the policy sets and what each stopped, and what each surface showed |
| S18 | Stage build A, install, open a session. Stage build B over it by rename. | `/reload-plugins` loads B with no `plugin update`; `claude plugin list` shows B's version, in the same session after reload and in a fresh session; an open `$.ui.ask` survives | The two build versions, what `/reload-plugins` printed, and the installed version string `claude plugin list` shows before restaging, after reload and in a fresh session |
| S19 | Run mods with `modApi` one below `minModApi` and one above the daemon's | Exactly one notice; no dialog, tool, status entry, band or toast | A screen recording or transcript for each |
| S20 | Detect `claude` from a shell install, Homebrew, the native installer, the desktop app's embedded CLI if any, and from the app and LaunchAgent with a minimal `PATH` | Each finds the same `claude`; the first version that loads mods is recorded for Q20 | The detection output per place, with the version |
| S21 | Run the Esc pattern ten times in each of iTerm2, Terminal.app, tmux and herdr, docked and inline | Ten of ten keep the keyboard in the pane in every cell, or the failing cells are listed | A table of 8 cells by 10 runs |
| S22 | Open the pane in the desktop app's local sessions and in VS Code | It draws and takes keys on each, or the command's "terminal only" message is chosen | Screenshots (gitignored) and the verdict |
| S23 | A fake daemon with 50 inbox items and one open chat | Daemon CPU and the pane's redraw time stay within the budget the owner sets in the task report | CPU samples and redraw timings for 5 s and 1.5 s polls, and for 3 s as the fallback |

**Spike kit.** The spikes run before P1, so none of them uses code from P2, P12 or P14. Each runs on a throwaway kit the person builds in a scratch folder, which is not committed, not reused by any phase, and written up with the result (section 5).

| Spike | Input, built by the person |
|---|---|
| S10, S11 | A throwaway mod that hooks `classic.SessionStart` (S10) or holds the first prompt (S11) and prints a marker |
| S14, S17, S20 | A throwaway folder marketplace with one plugin (a `plugin.json` and an empty hooks module), driven by shell commands only; S17 runs it on the managed Mac |
| S18 | Two builds, A and B, of that plugin that differ only in the `plugin.json` version and in one registered command that opens an `$.ui.ask` dialog; B is staged over A by rename |
| S19 | The same plugin with `modApi` one below `minModApi` and one above, a hook that registers a dialog, a tool, a status entry, a band and a toast so inertness is observable, and a stub HTTP server of about twenty lines that answers `/api/health` and registration with a chosen `minModApi` |
| S21, S22 | A throwaway plugin that opens a pane of static rows and applies the Esc, refuse, reopen-after-150-ms pattern, run in each surface the spike names |
| S23 | The S21 and S22 plugin extended to a pane of 50 rows and a polling chat view, plus a stub daemon that serves 50 inbox items and one chat transcript at the two poll rates |
| S16 | The existing session send path on `main` (the one P9 wraps), against a worker waiting on `request_input` that the person starts from the dashboard; the person tests the `chat_first` fallback by hand, answering in the dashboard first and then sending the message |
| S24, S25, S26, S27 | The Codex CLI on the machine, shell commands, and `stat` on `auth.json` |
| S4, S5, S8, S12, S15 | The throwaway plugin extended with one tool, one `$.prompt.fill` call and one agent file, and the Foreman as the app starts it on `main` |

Run order: S17, S14, S20 first (they decide whether the install path stands), S10 and S11 and S16 next (the two merge gates that can stop a package), then the rest in parallel. S27 and S24 to S26 are independent and run beside them.

### 5.3 S28: outcome ledger and retro trigger for home-dispatched workers (FR-06)

This is the second explicit item in the request. The spec's section 12.2 says Mission Control keeps an FR-06 outcome ledger of every task end, and that FR-05 v2 will read it and let any harness report a finish, with shapes "not designed yet". FR-05 v1 builds none of that (D32). The spike's job is to find out whether a worker started from a home session can feed the ledger and be offered a retro, so that the contract needs no breaking change later. It runs in two stages (below). S28a runs on `main` and does not gate P1; it can answer questions 1, 4 and 5 and give a first reading of 6 from the planned schemas, so any additive field it recommends can go into P1 or P2 before they merge or, afterwards, into a `contract:` commit. S28b needs the inbox and chat routes, so it answers 2, 3 and the rest of 6 after P1 has merged; anything it finds is handled only by additive changes under the spec's rule that later contract changes only add (8.1 rule 3), never by reopening a v1 shape.

**What `main` shows (read, not assumed).**

- There is no outcome ledger. A search of `src/`, `docs/` and `.agents/` finds no `outcome ledger` or `task_outcomes` table. The only "ledger" hits are the spend ledger, the Inspector's ledger rows and workflow delivery ledgers.
- A retro is offered per session by `retroSummary` (`src/server/retro-worthiness.ts`) when a human turn exists beyond the opening brief (`corrections`) or the Inspector resolved findings (`findings`). It is started by `POST /api/sessions/:id/retro` (`src/server/retro.ts`), which types a packet into a live session, files a backlog task, or creates one post-merge follow-up task, and which is a person's action from the dashboard.
- `complete_retro_no_change`, `retroFollowupForSource` and `retroPrPostureForTask` carry the outcomes the ledger would list (lesson, no lesson).

**Questions the spike answers.** Each answer is a yes or no with a pointer to evidence.

1. **End signals.** For a home-dispatched task, which events mark the end (task status, session exit, pull request merge), and does each carry the task's origin so a ledger row could say it came from a home session?
2. **Corrections.** When a person answers through `POST /dispatch/answers`, or chats through `/dispatch/tasks/{taskId}/send`, does `retroSummary` see a correction? The send route delivers with origin `human`, so chat probably counts. An answer to a `request_input` question may not appear as a human turn. This is the most likely gap: a headless-only user could do all their steering in the pane and never make a task retro-worthy.
3. **Trigger surface.** With no dashboard open, nothing offers the retro. Where could it surface without breaking the pane's rule that nothing starts without the person's press (F19, D39): a Needs you item, a toast, or a Tasks row, and what does its press call?
4. **Delivery.** `POST /api/sessions/:id/retro` is an `/api` route, and the mod may not call it (7.10). Would the daemon need a `/dispatch/` wrapper, and which home-session rule (7.2) governs it?
5. **Field mapping.** Which of the ledger's fields (task, session, outcome of lesson, no-lesson or dismissed, review id, path, sha256, commit, pull request, merge sha, published-at) does Mission Control already hold for a home-dispatched task, and which would be new columns?
6. **Contract headroom.** Do the v1 shapes in WP1 (`src/shared/home-dispatch.ts`, the inbox item, the `tasks` origin) have room for an additive retro item and an outcome read, per the spec's rule that later contract changes only add (8.1 rule 3)?

**Two stages, because the second half needs code that does not exist yet.**

| Stage | When | Method | Output |
|---|---|---|---|
| S28a | Now, on `main`, beside the other spikes. A scout task (6.7). | A code trace of questions 1, 4 and 5, plus a fake-agent run of an ordinary dashboard task that gives only a baseline of what `retroSummary` counts (question 2 is answered in S28b) | A written result in the S28a task's final report, with file and line pointers, which the owner posts to Commonroom |
| S28b | After the inbox (WP2b), draft and start (WP3) and chat routes (WP16) merge. A scout task (6.7). | A no-token run on the fakes in `e2e/fixtures/fake-agents.ts`: dispatch a home task, answer a question through `/dispatch/answers`, chat through `/send`, finish it, and read `retroSummary` and the retro routes | A written result in the S28b task's final report, which the owner posts to Commonroom: answers to questions 2, 3 and 6, a go or no-go on adding an additive retro item to the pane, and the list of fields FR-06 must add |

**Guardrails.** S28 writes no endpoint, table or pane item. It may recommend one additive field for a later `contract:` commit (8.1 rule 3). It records Q-style open items for the FR-06 owner rather than answering them.

## 6. The phases

One pull request each, to `main`, behind `headless-mode`; P0 opens none. Work package ids are the spec's. WP10 has no phase. "Starts after" says when an agent may begin against the stubs and fakes; "Merges after" says what must already be on `main`.

### 6.1 Phase table

| Phase | Work package | Goal | Starts after | Merges after | Gates |
|---|---|---|---|---|---|
| P0 | WP0 | Person-run spikes S4 to S27 on throwaway kits (5.2), with no pull request and no scheduled task (6.7); S28a is a scout task; each answer is posted to Commonroom by the owner | none | none | none |
| P1 | WP1a | The preview flag, shared contracts, schema 36, route stubs (501 while on), regenerated route oracle, flag-off tests, the Settings row browser assertion, and the route-surface and import guards of 4.2 (guards 2 and 3) | none | none | none |
| P2 | WP1b | The CLI command registry, the mod and pane skeleton, `npm run build:mod`, the `PluginState` contract, and the fakes in `test/helpers/home-dispatch-fakes.ts` | P1 | P1 | none |
| P3 | WP2a | Home sessions, the registration answer, the launcher decision, the intent detector | P2 | P2 | none |
| P4 | WP2b | The read-only inbox, `blocked` state, `needsYouOrder`, `workflowStages`, `residentLoopLabel`, answers and receipts, plan approval, config view, reviewer rows, the inbox `subagents` counts and the shared `subagent-state.ts` module. Calls P3's home-session predicate, so it merges after P3. | P2 | P3 | none |
| P5 | WP3 | Dialog pages, drafts, the banner builder, the shared `kindAfterWork`, and the runtime and Focus test of 4.2 (guard 1). Calls P3's home-session predicate, so it merges after P3. | P2 | P3 | none |
| P6 | WP8 | Repository task skills in `composeTurnOne` | P2 | P2 | none |
| P7 | WP18 | Codex readiness, `GET /dispatch/readiness`, the Codex setup step and doctor checks, the flag-gated fail-fast reviewer gate. Applies P3's home-session rules, so it merges after P3. | P2 | P3 | **S27 recorded** (hard); S24 to S26 (soft) |
| P8 | WP13 | Mod core: adapter, `ModHost`, poll, toasts, the band and its `1` button, the status entry, the banner, the real `paneOpen` and `paneClose` host calls with a placeholder pane view until P12, and the `mod-calls` smoke check (6.5) | P2 | P3, P4, P5 | S14, S18, S19 (all soft) |
| P9 | WP16 | Residents and chat routes, including the transcript stream and the transcript response's `subagents` lines | P2 | P3, P4 | **S16** (hard) |
| P10 | WP6a | `mctl` client and read commands. Until P9 lands, `mctl logs` reports that the transcript routes are not available yet (6.3). | P2 | P4 | none |
| P11 | WP14 | Dispatch flows, `start_dispatch`, the intent nudge, the confirm summary's Codex line. The `inbox`, `check`, `pane` and task-id arguments call P8's `paneOpen`, which shows a placeholder until P12 lands (6.3). | P2 | P8, P5, P7 | **S10 or S11** (hard, launcher part only); S8, S12, S15 (soft) |
| P12 | WP17 | The pane: four tabs, item views, two-press approval, chat and follow, Residents, reviewer rows, and two reserved subagent slots (the Tasks row text and the follow view's header lines) that P15 fills. Placements are dock and inline; the widget placement is v1.1 and falls back to the inline view (6.6). It replaces P8's placeholder. | P2 | P8, P9 | **S16** (hard); S21, S22, S23 (soft) |
| P13 | WP6b | `mctl run`, `mctl claude` (starts Claude with no workspace and no added prompt; the launcher is P11's and appears only when P11's launcher is enabled (S10 or S11 passed) and P14 is in, 6.3), `mctl daemon` | P2 | P10, P5 | none |
| P14 | WP7 | `mctl setup` and `doctor` (every step except agents and Codex), `claude` detection (and the one edit that makes P13's `mctl claude` use it), the "Mods can load" step and its checks (6.5), mod staging, install and the stale-version reinstall, the Foreman LaunchAgent | P2 | P8, P10, P13 | S5, S14, S17, S18, S20 (all soft; see 5.1 and 6.3) |
| P15 | WP11 | The `subagentLines` formatter (`src/shared/subagent-lines.ts`) and its two pane slot fills (the Tasks row and the follow view's header, with rendered-pane and end-to-end tests), the agents setup step and doctor check | P2 | P11, P12, P14 | S4 (soft) |
| P16 | WP15 | Packaging: the built mod ships outside `asar`, and the app stages it at start | P2 | P14 | none |
| P17 | WP9 | Docs | P2 (drafting) | P14, P15, P12, P7, P13, P6, P16 | none |
| P18 | WP12 | The full-loop test, the flag-off sweep, the no-multiplexer check, the context check, the live walkthrough | P2 | P6, P13, P16, P17 (all others transitively) | none |

Plus two scout tasks that open no pull request: **S28a** (starts with the plan) and **S28b** (after P4, P5 and P9 merge). Each ends with a written final report (6.7).

Deviation from the spec: WP1 is split into P1 and P2 along its file list. It lands the flag, schema, every route, the CLI registry, the mod and pane skeleton, the build, and the fakes; the spec itself caps a pull request near 1,500 lines (8.1 rule 5) and WP1's file list is likely to pass it. P1 is contracts and server seams; P2 is the CLI, mod, pane and fakes. One owner per file is kept. The owner chose the split (section 8).

### 6.2 Merge order

```mermaid
flowchart TD
  P0[P0 Spikes] -.-> P7
  P0 -.-> P8
  P0 -.-> P9
  P0 -.-> P11
  P0 -.-> P12
  P1[P1 WP1a contracts, flag, stubs] --> P2[P2 WP1b CLI, mod, pane skeleton, fakes]
  P2 --> P3[P3 WP2a sessions]
  P3 --> P4[P4 WP2b inbox]
  P3 --> P5[P5 WP3 dialogs, drafts]
  P2 --> P6[P6 WP8 repo skills]
  P3 --> P7[P7 WP18 Codex readiness]
  P3 --> P8[P8 WP13 mod core]
  P4 --> P8
  P5 --> P8
  P3 --> P9[P9 WP16 residents, chat]
  P4 --> P9
  P4 --> P10[P10 WP6a mctl reads]
  P8 --> P11[P11 WP14 dispatch flows]
  P5 --> P11
  P7 --> P11
  P8 --> P12[P12 WP17 pane]
  P9 --> P12
  P10 --> P13[P13 WP6b mctl run]
  P5 --> P13
  P8 --> P14[P14 WP7 setup, doctor, install]
  P10 --> P14
  P13 --> P14
  P11 --> P15[P15 WP11 subagents]
  P12 --> P15
  P14 --> P15
  P14 --> P16[P16 WP15 packaging]
  P14 --> P17[P17 WP9 docs]
  P15 --> P17
  P12 --> P17
  P7 --> P17
  P13 --> P17
  P6 --> P17
  P16 --> P17
  P17 --> P18[P18 WP12 full loop]
  P16 --> P18
  P6 --> P18
  P13 --> P18
```

Merge waves. A wave groups phases whose work can overlap. Inside a wave the required merge order is the last column, and two phases with no edge between them merge in any order. The six waves remove and weaken no edge of the graph above. Waves are a grouping for scheduling, not barriers: only the graph edges and the order column bind.

| Wave | Phases | Required merge order inside the wave |
|---|---|---|
| 1 | P1, P2 | P1, then P2 |
| 2 | P3, P6, P4, P5, P7 | P3 and P6 in any order; P4, P5 and P7 each after P3 |
| 3 | P8, P9, P10 | P8 after P3, P4 and P5; P9 after P3 and P4; P10 after P4 |
| 4 | P11, P12, P13, P14 | P11 after P8, P5 and P7; P12 after P8 and P9; P13 after P10 and P5; P14 after P8, P10 and P13 |
| 5 | P15, P16 | P15 after P11, P12 and P14; P16 after P14 |
| 6 | P17, P18 | P17 after P14, P15, P12, P7, P13, P6 and P16; P18 after P6, P13, P16 and P17 |

### 6.3 Per-phase notes that the phase files must carry

- **Every phase.** Behind `headless-mode`; flag-off tests prove no behavior change; no edit to `src/server/terminal/`, `src/server/actions.ts`, `src/mcp/server.ts`, `src/server/mission-mcp.ts`, `hooks/harness-hook.mjs` or `hooks/harness-statusline.mjs` (D43, 4.2); tests use `node:test` and the fakes; no em dash in prose; no model tokens in any test.
- **P1.** Registers the flag as `preview`. Because it is the first real flag, it owes a Playwright assertion against the shipped registry that its Settings row appears and that toggling it changes a second window without reloading (`docs/feature-flags.md`, "Three pull requests per flag"). Uses schema 36 because `main` is at 35. Regenerates the route oracle and the diff adds only `/dispatch/*` entries.
- **P2.** Fakes serve a schema-valid reply for every `/dispatch/*` route and include a scriptable fake `claude`. Later phases replace stubs and never change a stub's shape. Route stub owners (paths as in spec 2.3): `POST /dispatch/sessions` P3; `POST /dispatch/dispatch-options`, `POST /dispatch/drafts`, `POST /dispatch/drafts/{id}` and `POST /dispatch/drafts/{id}/confirm` P5; `GET /dispatch/inbox`, `POST /dispatch/answers` (actions `answer`, `approve_plan`, `request_changes`, `approve_review`, `reject_review`, `chat_first`) and `GET /dispatch/config` P4; `GET /dispatch/residents`, `POST /dispatch/residents/{runId}/{action}`, `GET /dispatch/tasks/{taskId}/transcript`, `GET /dispatch/tasks/{taskId}/transcript/stream` and `POST /dispatch/tasks/{taskId}/send` P9; `GET /dispatch/readiness` P7; the `home-dispatch-v1` capability on `GET /api/health` P1. CLI and mod stub owners: `mctl get`, `describe`, `logs`, `status`, `config` P10; `run`, `claude`, `daemon` P13; `setup`, `doctor` and step bodies P14 (the `agents` step P15, the `codex` step P7); mod `flows/*` P11; `pane/*` P12. No later field is planned; the subagent fields are in the v1 shapes (see the subagent lines bullet below).
- **P5, P6.** P6 owns `composeTurnOne` in `src/server/dispatcher.ts`. The task-shaping plan's Phase 2 also edits `composeTurnOne` (spec 12.2), so P6 must be rebased onto whichever lands first, and its pull request names the other plan.
- **P7.** Merges after P3, whose home-session rules the readiness route applies. Owns the one flag-gated change to `src/server/workflows/engine.ts` and `src/server/llm/provider-failure.ts`. The pull request calls it out, adds a test that with the flag off every reviewer path keeps today's retries (Q25), and merges only after S27's answer is recorded as `CODEX_AUTH_MTIME_RELIABLE`.
- **P9 and P12.** Neither merges until S16 and its `chat_first` fallback are recorded. If both fail, they wait for the owner (8.1 rule 8).
- **P5 and P8.** P5 merges after P3 because its options, drafts and banner routes call P3's home-session predicate. P8 merges after P5 because the mod banner is drawn from P5's builder.
- **P4.** Merges after P3. The inbox, answers and approval routes call P3's home-session predicate, so there is no interim state in which they run without it.
- **P8 and P11, the pane-open handoff.** P8 implements the real `paneOpen` and `paneClose` host calls (open id `mission`, focus, size, close) and draws a placeholder view reading `The Mission Control pane is not available in this build yet.` P11's `inbox`, `check`, `pane` and task-id arguments call `paneOpen` with the tab or task id and nothing else, so they work before P12 lands and show the placeholder. P11's exit check: with the fake host, each argument records one `paneOpen` with the right target, and no argument errors while the placeholder is in place. P12 replaces the placeholder and changes no call signature.
- **P10, `mctl logs` before P9.** The transcript routes are P1 stubs that answer 501 until P9 lands. `mctl logs` and `mctl logs -f` then print `the transcript routes are not available in this build yet`, exit 1 and do not retry. P10's tests cover that state against a daemon whose routes answer 501, and the real routes need no change to `mctl` once P9 merges.
- **P13, the launcher handoff.** `mctl claude` starts Claude with no workspace and no added prompt. The launcher is P11's and appears on its own only when P11's launcher is enabled (S10 or S11 passed and recorded) and P11 and P14 (the mod install) are in. Before then, or if P11 merged with its launcher switched off, `mctl claude` starts a plain Claude session, which is the expected result. P13's exit check asserts both states (no mod installed, and launcher switched off) with a fake `claude` runner; the launcher's own acceptance belongs to P11.
- **P13 and P14, `claude` detection.** P14 merges after P13. P13 resolves `claude` from `PATH` in one place in `src/cli/commands/claude.ts`. P14 creates the shared detection (`src/cli/claude-cli.ts`) and owns the one edit that makes `mctl claude` call it, tested with the fake `claude` runner (a `MISSION_CLAUDE_BIN` override and a binary outside `PATH` are both found). Whichever of the two is open when the other lands rebases onto it.
- **P14 and the soft spikes.** Soft spikes never block a merge: when no answer is recorded the phase uses the fallback in plan 5.1 and its pull request says which answers it used or that none was recorded. For P14 the fallback is: a check whose fact comes from the Claude Code documentation (the `mods-version` floor, `mods-user-switch`, `mods-managed-policy`, `mods-sideload-policy`, `mods-traffic` and `mods-can-load`) ships as warn until a recorded S17 or S20 answer confirms the fact on a machine, and documentation alone never permits fail; the checks that read this machine's own state at run time (`mod-enabled`, `mod-current` and `mod-calls`) fail as plan 6.5 lists without a spike answer; and the pull request lists every check shipped as warn for want of an answer. Raising such a check to fail after an answer is recorded is a small follow-up pull request that changes only the severity table in `src/server/environment/claude-mods.ts` and its test.
- **Branches stated in each downstream phase.** Every outcome that depends on a spike or flag result states both branches in that phase's outcome and exit criteria: P7 (S27 true or false), P9 and P12 (S16 direct or `chat_first`), P11 (launcher on or off), P12 (S21, S22, S23 fallbacks), P13 (launcher present or plain Claude), P14 (S17 unprompted or policy-blocked), P15 (S4), P17 and P18 (each as recorded).
- **P11.** The launcher part merges only when S10 or S11 passes; otherwise the rest of P11 merges with the launcher switched off.
- **P14 and P16, D44.** The mod ships only inside Mission Control. No pull request opens in claude-code-extensions. `src/server/mod-stage.ts` publishes by writing a sibling folder and renaming it, never by copying onto the published path (the rule CLAUDE.md sets for native addons). P16 changes `electron-builder.yml` by one named entry, and keeps `asar` off. P8 owns the edit to `scripts/smoke-bundles.mjs` that makes `npm run smoke` run `claude plugin validate dist/mod/mission-control` when `claude` is installed.
- **P14 and P16, upgrading an installed mod.** Staging a new build does not by itself change what `claude plugin list` shows, and the install step skips anything already listed. P14 therefore compares the installed version with the staged `plugin.json` version after staging, and if they differ it reinstalls (`claude plugin uninstall`, then marketplace add if needed, then install), never `claude plugin update` (D47). There is no rollback: uninstalling removes the old install and the staged folder already holds the new build. If the install after the uninstall fails, setup retries once. If it still fails, the mod may be left uninstalled, so setup prints the cause and the two recovery commands (`claude plugin marketplace add {stateDir}/mod`, `claude plugin install mission-control@mission-control --scope user`), finishes the other steps and exits 1, and doctor reports `mod-enabled` failed. The daemon keeps working and a session without the mod shows nothing. P14 tests the upgrade, and the double-failure path, against a fake `claude` runner with a stale installed version. P16 adds a test that an app-staged newer build makes doctor report the mod stale and `mctl setup` bring it current. S18 supplies the real-world evidence.
- **P12, placements.** Dock and inline only. The widget placement (the desktop app's small form) is v1.1 (6.6): when Claude Code reports `widget`, the pane draws the inline form, and no widget-specific layout, task or test exists in this plan.
- **P12.** The pane is drawn inside Claude Code, so Playwright cannot drive it. Its proof is the fake-host `node:test` files named in 7.22 and `claude plugin test` run locally, with output attached to the pull request (Q17). A Playwright spec is required for a dashboard UI change: P1's Settings row, and P5's `DispatchModal.tsx` swap if its visible behavior changes.
- **Subagent lines, one path.** Per-task subagent data has one path: `subagents` counts (`{running, finished}`) on each item of the `GET /dispatch/inbox` response (P4's route) and the per-subagent `subagents` lines in the `GET /dispatch/tasks/{taskId}/transcript` response (P9's route). There is no separate tasks route in v1: the Tasks tab and item views read tasks through the inbox response. `subagentLines` is not a field: it is the pure function in `src/shared/subagent-lines.ts` (spec 7.17) that P15 owns. P1 declares both fields from spec 7.7 and 7.23. P4 creates `src/server/home-dispatch/subagent-state.ts` (from the session registry's subagent state, or the smallest in-memory tracking in the daemon's existing hook-event handler, never in the owned hook wrapper) and fills the inbox counts; P9 reuses it for the transcript lines. P12 reserves two slots in `src/mod/pane/header.tsx` (the Tasks row text and the follow view's header lines) and renders nothing in them while the fields are empty. P15 creates `src/shared/subagent-lines.ts`, fills both slots and edits nothing else in the pane. Tests: P4 and P9 prove the fields from recorded events; P15 renders the pane at 40, 71 and 120 columns with and without lines and proves recorded events reach the rendered row and follow view end to end; P12's tests must still pass.
- **P17.** Docs list the pane, its keys, the `1` first-key note and residents, and say the pane's cost leaves out review calls (Q26). They also carry the mods troubleshooting section of 6.5.
- **P18.** The no-multiplexer check asserts nothing in headless mode requires tmux or herdr, and the three Focus guards of 4.2 run again against the whole stack, guard 1 with the task started through `mctl run` and through the mod's dispatch flow.

### 6.4 Gate recording, with no results file

Because spike answers live in task reports and Commonroom, a gate is satisfied only when the answer is posted there. The gated phase tasks (P7, P9, P11, P12) carry the gate in their task text and, before merging, read the owner's recorded answer through Commonroom and quote it in the pull request. If no answer is recorded, the task stops and reports that, and does not merge.

### 6.5 Folded in: "Mods can load" checks for WP7 (and one smoke check for WP13)

Source: local plan `8065dbe0-950a-4572-b358-8e5b5489e69b`, revision 2, folded in by the owner's decision. It was written as spec edits to version 11, so these requirements are **not in spec version 18**, and its decision and spike numbers are not used here. The Claude Code facts in it come from the Claude Code mods documentation and were not observed on a machine, so spike S17 and S20 confirm them.

**What it adds.** One setup step between finding `claude` and installing the mod, plus doctor lines. If a check marked fail does not pass, setup skips the mod install, prints each cause with its fix, finishes the other steps, and exits 1, as it does when no `claude` is found (D45). Setup never changes any of these switches, except the mod's own enabled state. The Severity column is the severity once the fact is confirmed: until a recorded S17 or S20 answer confirms it on a machine, the documentation-based checks (`mods-version`, `mods-user-switch`, `mods-managed-policy`, `mods-sideload-policy`, `mods-traffic`, `mods-can-load`) ship as warn, while `mod-enabled`, `mod-current` and `mod-calls` read this machine's own state and fail as listed.

| Check | Looks at | Severity |
|---|---|---|
| `mods-version` | `claude --version` is at least 2.1.287 (the docs also give 2.1.286 for the desktop app) | fail below 2.1.287; warn below 2.1.327 until S20 fixes the floor (Q20) |
| `mods-user-switch` | `disableAllHooks` is not `true` in user, project or local settings | fail |
| `mods-managed-policy` | Managed settings set none of `allowManagedModsOnly`, `allowManagedHooksOnly`, `disableAllHooks`; a `strictKnownMarketplaces` list is reported | fail for the first three; warn for the list |
| `mods-sideload-policy` | Managed settings do not set `disableSideloadFlags` | fail |
| `mods-stale-env` | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is unset | warn |
| `mods-traffic` | Not `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set on a version below 2.1.288 | fail |
| `mods-can-load` | `claude plugin test` in an empty temporary folder says mods can load | fail |
| `mod-enabled` | `claude plugin list` shows `mission-control@mission-control` installed and enabled at user scope; setup installs or re-enables it, doctor fails | fail in doctor |
| `mod-current` | The version `claude plugin list` shows for `mission-control@mission-control` equals the staged `plugin.json` version. On a difference, setup reinstalls (6.3) and re-checks in a fresh `claude` invocation; doctor only reports | fail in doctor; setup fails only if the reinstall does not bring it current |
| `mod-calls` | `claude plugin validate {stateDir}/mod/mission-control` lists only allowed calls from `src/mod/allowed-calls.json`, owned by P8 (`$.http.fetch`, `$.ui.*`, `$.session.append`, `$.command.register`, `$.tool.register`, `$.prompt.fill`, `$.state`, `$.clock`, `$.env.get`) | fail; also run by `npm run smoke` (P8) |

**Where it lives.** A second narrow allowlist beside `MANAGED_ENV_KEYS` in `src/server/environment/claude-managed.ts`, which exists on `main` today. A new probe module, `src/server/environment/claude-mods.ts`, and a step file in `src/cli/setup-steps/` that P14 owns. The probes read files read-only, run `claude` through the executable registry, and spend no model tokens. Nothing in the dashboard calls them.

**Two findings that reach beyond headless mode.** Reported by setup and doctor only, with no dashboard change:

- `disableAllHooks` also silences Mission Control's own hook and status line wrapper, which session discovery depends on, whether or not headless mode is on.
- `disableSideloadFlags` rejects `--mcp-config` at startup, and Mission Control passes it to the workers it dispatches (`askChannelArgs` in `src/server/ask-channel.ts`). This has been read in the docs and not seen on a machine; S17 checks it on a managed Mac.

**Out of scope.** `claude -p`, Agent SDK runs, `--bare`, `--safe-mode` and Codex's non-interactive runs: undefined behavior, covered by no check or doc beyond saying they are unsupported.

**Tests and docs.** A `test/home-dispatch-claude-mods.test.ts` runs every check against planted user, project, local and managed settings in a temporary home and a fixture managed root, with a fake `claude` runner, and asserts the planted files are unchanged. P17 adds a troubleshooting section, which includes the manual recovery commands, naming each switch, how doctor reports it, and its fix, and notes that disabling the mod in `/plugin` lasts only until the next `mctl setup`.

**What the owner still has to do.** Land these checks in the spec under new ids (D54 to D57 and S25 are taken), so the spec and the build agree. Until then P14's pull request cites this plan's check names.

### 6.6 What is not built

WP4, WP5a, WP5b and WP10 (withdrawn); FR-05 v2 shaping, context injection, skill routing and any outcome or retro endpoint (D32); the Settings > Setup install row (Q21); a push event stream (Q16); the widget placement (v1.1).

### 6.7 How the phases are scheduled

`phased-plan.md` and the `phase-*.md` files beside this plan carry the detail. Eighteen backlog implementation tasks are scheduled, one per phase P1 to P18, each depending on this planning session and on its direct merge prerequisites. Two more backlog tasks are scout tasks, which end with a final report and open no pull request: S28a (depends only on this planning session) and S28b (depends on P4, P5 and P9 as well). Their reports are the written results the S28 rows promise, and the owner posts them to Commonroom. Nothing depends on a scout task, because a task that opens no pull request cannot release dependents.

The person-run spikes of P0 are not tasks: they need a managed Mac, several terminals or the desktop app. Each is written up by the person who runs it and posted to Commonroom by the owner. Gated phases carry their gate in the task text (6.4) and read that posted answer.

### 6.8 Mechanical audit

Both tables were derived by a script run over the 20 Markdown files at this revision, not written from memory. Table A takes every path, route, field, function, flag, CLI command and fixture named in the backticks of a phase's Scope line, assigns it to the lowest-numbered implementing phase (phases 1 and 2 only declare shapes and stubs, so they count only when no other phase names the artifact, as for `CodexReadiness` and `npm run build:mod`; phases 17 and 18 only document and test), lists every other phase file that names the same token, and checks that the producer is a direct or transitive prerequisite of each consumer in the dependency graph of the phased plan. Artifacts that no other phase file names are omitted. Every pair that is not ordered by the graph carries its reason: a mention only (the consumer names the artifact without using it), or a tested interim state. Table B takes every spike row of plan 5.1 and the gate cells of plan 6.1, the phased plan table and each phase's section 2, and checks that the three agree.

**A. Producer to consumer**

| Artifact (named in the Scope line of its producing phase) | Producer | Consumers named in other phase files | Producer is a direct or transitive prerequisite of each consumer |
|---|---|---|---|
| `CodexReadiness` | P1 | P7, P11 | yes |
| `npm run build:mod` | P2 | P16 | yes |
| `dashboardUrl` | P3 | P12 | yes |
| `residentLoopLabel` | P4 | P12 | yes |
| `src/server/home-dispatch/subagent-state.ts` | P4 | P9 | yes |
| `subagents` | P4 | P9, P12, P15 | yes |
| `workflowStages` | P4 | P12 | yes |
| `src/shared/home-dispatch-banner.ts` | P5 | P8 | yes |
| `composeTurnOne` | P6 | P5 | yes, except P5: mention only: P5 says it does not edit it |
| `mctl doctor --live` | P7 | P17 | yes |
| `ModHost` | P8 | P11 | yes |
| `paneOpen` | P8 | P11, P12 | yes |
| `src/mod/allowed-calls.json` | P8 | P14 | yes |
| `GET /dispatch/tasks/{taskId}/transcript` | P9 | P4, P12, P15 | yes, except P4: mention only: P4 names P9's route as the carrier of the `subagents` lines |
| `mctl logs` | P10 | P9 | yes, except P9: mention only: P9 names the command that reads its stream route |
| `src/mod/pane/header.tsx` | P12 | P15 | yes |
| `mctl claude` | P13 | P11, P14 | yes, except P11: mention only: P11 says P13's command is unaffected by the launcher setting |
| `mctl run` | P13 | P5, P18 | yes, except P5: mention only: P5's handoff says P13 reuses its drafts; P13 lists P5 |
| `mctl doctor` | P14 | P7 | yes, except P7: tested interim: same as `mctl setup` |
| `mctl setup` | P14 | P7, P16, P17, P18 | yes, except P7: tested interim: P7's `codex` step runs under its own tests until P14 merges, then from P2's step list (P14 skips stub steps) |
| `src/cli/claude-cli.ts` | P14 | P13 | yes, except P13: tested interim: P14 merges after P13; P13 resolves `claude` from PATH until P14's one edit |
| `src/server/mod-stage.ts` | P14 | P16 | yes |

**B. Spikes**

The hard rule and the soft rule of 5.1 apply to every row. In every phase file the gate is named in section 2, and its outcome and exit criteria state both branches.

| Spike | Class | Phases it gates (plan 6.1, phased plan and each phase's section 2 agree) | No answer recorded | Negative answer: fallback (plan 5.1) |
|---|---|---|---|---|
| S10, S11 | Hard (merge gate) | P11 | The gated phase stops without merging the gated part | Owner decides; the rest of WP14 merges with the launcher off |
| S16 | Hard (merge gate) | P9, P12 | The gated phase stops without merging the gated part | Owner decides how chat works |
| S27 | Hard (merge gate) | P7 | The gated phase stops without merging the gated part | Record `CODEX_AUTH_MTIME_RELIABLE = false` |
| S14 | Soft | P8, P14 | The phase merges using the fallback | `CLAUDE_CODE_PLUGIN_DIRS` through the settings installer, and ask the policy owner (Q19) |
| S17 | Soft | P14 | The phase merges using the fallback | `CLAUDE_CODE_PLUGIN_DIRS` through the settings installer, and ask the policy owner (Q19) |
| S18 | Soft | P8, P14 | The phase merges using the fallback | Loading at session start is not enough on its own: P14 detects a stale installed version and reinstalls (6.5, `mod-current`) |
| S19 | Soft | P8 | The phase merges using the fallback | P8's inert path is the fallback: nothing is registered before the `modApi` check passes, and P8's pull request records the S19 result. The spec's "daemon hides the capability" is not built, because no phase owns a daemon change (deviation in section 9) |
| S20 | Soft | P14 | The phase merges using the fallback | Add the place, or `MISSION_CLAUDE_BIN` |
| S21 | Soft | P12 | The phase merges using the fallback | Esc hands the keyboard back; only Back returns to the list |
| S22 | Soft | P12 | The phase merges using the fallback | Terminal only in the alpha; the pane view says so (P12) |
| S23 | Soft | P12 | The phase merges using the fallback | Chat poll 3 s, Tasks tab capped at 30 rows; this is also the behavior when S23 has no recorded answer, and 1.5 s with every row applies only once S23 records the default as within budget |
| S4 | Soft | P15 | The phase merges using the fallback | Link the agents, warn in doctor, and no flow names them (P15) |
| S5 | Soft | P14 | The phase merges using the fallback | Have the app adopt the Foreman service, like the daemon (spec 11.2) |
| S8, S12, S15 | Soft | P11 | The phase merges using the fallback | S8: strengthen the tool description and the nudge wording, then try again. S12: take the description as text typed under Other in a dialog. S15: offer the tool for the whole session and refuse calls while the flag is off (spec 11.2) |
| S24, S25, S26 | Soft | P7 | The phase merges using the fallback | S24: treat exit 1 with a key set as `unknown`, not signed out, and let `codex-headless` decide. S25: probe the known install places as 7.10a does for `claude`, and raise the cache to 30 minutes. S26: compare through the model catalog's own id normalisation and report an unmatched pin as information (spec 11.2) |

Each fallback is applied by the phase in the third column.

**C. Constants that appear in more than one file**

Derived by the same script: every duration, row cap and column width that two or more files state. Each has one default, at most one fallback, and one owning phase.

| Constant | When S23 recorded the default within budget | When S23 recorded it too costly, or has no recorded answer | Owner | Stated in |
|---|---|---|---|---|
| Inbox poll | 5 s | 5 s | P8 | plan 5.1 and 5.2 (S23), phase 8 |
| Chat poll | 1.5 s | 3 s | P12 | plan 5.1 and 5.2, phase 9 handoff, phase 12 (outcome, scope, tests) |
| Tasks tab rows | all | capped at 30 | P12 | plan 5.1 and R10, phase 12 |
| Pane widths tested | 40, 71 and 120 columns | 40, 71 and 120 columns | P12, and P15 for its slots | plan 6.3, phases 12 and 15 |

**D. Where tests get their fixtures**

Tests in phases before P5 use planted database rows or the P2 fakes. P5 is the first phase that starts a real task through the dashboard path, so the runtime and Focus test (guard 1 of 4.2) is P5's, and P18 repeats it through `mctl run` and the mod's dispatch flow.

Rerun the derivation and update tables A to C whenever a phase file adds a Scope artifact or a spike. A pair that is not ordered and has no stated reason is a plan error.

## 7. Risks

| # | Risk | Likelihood and effect | Mitigation |
|---|---|---|---|
| R1 | The spec keeps moving: 18 versions in about a day, and the brief was already stale | High. A phase built to an old version breaks at integration. | Pin the sha256 in this plan; every phase re-reads the version first and stops on a mismatch. |
| R2 | The Claude Code mod API behaves differently from its types (Esc, focus, placement, `$.ui.status`) | Medium. The pane's feel depends on L33 to L37, which are 2.1.329 observations, not guarantees. | S19 to S23 first; each has a stated fallback; P12 pins the version it was tested on. |
| R3 | Managed Claude Code policy blocks the folder marketplace or mods (Q19) | Medium for Upstart machines. P14 could finish and still not install. | S17 on a managed Mac, ideally before P14 merges (soft, see the merge rule in 6.3); fallback `CLAUDE_CODE_PLUGIN_DIRS`; the "Mods can load" checks of 6.5 name the cause and the fix instead of failing silently. |
| R4 | A merge gate fails (S10 and S11, or S16) | Medium. F3 or F5 has no accepted behavior without it. | Gates are explicit in the table; the owner decides; the rest of the package still merges where the spec allows. |
| R5 | P1 is large and sits on the critical path | High. Every phase waits for it. | Split into P1 and P2; P1 is server seams only. |
| R6 | Parallel pull requests collide on hot files (`db.ts`, `routes.ts`, the route oracle, `register.ts`, `engine.ts`) | High with up to five phases in flight at once. | Spec 8.1 hot-file owners; P1 stubs every route so later phases change values, not rows; each pull request rebases before merging. |
| R7 | The Codex fail-fast gate changes dashboard behavior | Medium. It sits in the shared workflow engine. | Flag-gated; a flag-off test proves today's retries; Q25 keeps dashboard tasks out of FR-05. |
| R8 | Existing Focus breaks indirectly (constraint 1) | Low, and the cost is high. | The three guards in 4.2 (guards 2 and 3 in P1, guard 1 in P5), repeated in P18. |
| R9 | Headless-only users never reach a retro because pane answers are not "corrections" | Medium. FR-06's learning loop starves for home-dispatched work. | S28a on `main` now and S28b once the routes exist; later findings are additive contract changes; findings go to the FR-06 owner. |
| R10 | Poll cost with many items or several sessions (S23) | Low to medium. | The 3 s and 30-row fallbacks. |
| R11 | A worker's text reaches the model or forges an inbox line | Low if the renderer is shared. | One renderer with fences (7.18, L15); P12 and P18 test the context check (F18). |
| R12 | The mod cannot be tested in CI (Q17) | Certain. Adapter tests run locally only. | Flows are tested under `node:test` with the fake host in CI; local adapter output is attached to the pull request. |
| R13 | `composeTurnOne` is edited by two plans | Medium. | P6 rebases on whichever lands first and names the other plan. |
| R14 | Stale local plans are scheduled by mistake | Low, but wrong work would result. | Section 2 marks them superseded; only this plan's phases are scheduled. |
| R15 | The user expects a pane-to-terminal jump | Medium for tmux users. | Section 4.3 states the loss; the dashboard link and Focus remain. |
| R16 | P14 builds the 6.5 checks from a plan that is not in the spec, and from documentation facts nobody has observed | Medium. A check could fail a working machine, for example a wrong version floor. | P14 cites the check names; S17 and S20 are soft, so a check whose fact comes from documentation ships as warn until a recorded answer confirms it on a machine, and documentation alone never permits fail (the merge rule in 6.3), a follow-up raises it to fail, and the owner lands the checks in the spec under new ids. |
| R17 | A gate answer lives only in a task report and Commonroom, so a phase task can miss or misread it | Medium. A gated pull request could merge on a stale or absent answer. | 6.4: the phase task names the spike in its text, quotes the recorded answer in its pull request, and stops if none exists. |
| R18 | An installed mod stays on an old build after a new one is staged, because install skips anything already listed | Medium. The pane or daemon routes could disagree with the mod (`modApi` inert path), and nothing says why. | `mod-current` check, a version probe after staging, a reinstall that retries once and otherwise leaves a printed recovery path (no rollback is claimed), tests in P14 and P16, and S18 evidence (6.3, 6.5). |

## 8. Decisions adopted

Asked as selectable decisions on revision 1, and recorded here. Choices that differed from the plan's recommendation are marked, and revision 2 applies them.

1. **Jordan's constraint and D50 wording.** Adopted: add the three Focus guards (guards 2 and 3 in P1, guard 1 in P5, all three repeated in P18), and ask the owner to clarify D50 in the spec ("the new `/dispatch/jump` route, not `/api/sessions/:id/focus`"). The owner applies the clarification; this plan does not edit the spec.
2. **WP1 as two pull requests.** Adopted: P1 contracts and server seams, then P2 CLI, mod and pane skeleton and fakes.
3. **The "mods can load" plan.** Adopted, **differing from the recommendation**: fold its checks into WP7 and spike S17 now (6.5), with no spec ids until the owner renumbers them.
4. **S28 scope.** Adopted: two stages, S28a now on `main` and S28b after the inbox and chat routes merge (5.3).
5. **Where spike answers live.** Adopted, **differing from the recommendation**: task reports and Commonroom only, with no results file in the repository (5 and 6.4).
6. **Phased follow-up.** Adopted: create the phased implementation plan, once this revision is approved.

## 9. Repairs after the Plan Validation review (revisions 4 to 16)

Revision 4:

| Finding | Repair | Where |
|---|---|---|
| Widget placement is out of v1 (6.6) but P12 listed it | P12 builds dock and inline only; `widget` falls back to inline | 6.1, 6.3, phase 12 |
| Spike reports had two recording paths, and S28a promised a task report while 6.7 said no task | S28a and S28b are scout tasks whose final reports carry the results; person-run spikes are written up by the person; all are posted to Commonroom; no repository file | 5, 5.3, 6.1, 6.7 |
| P4 consumed P3's home-session predicate but could merge first | P4 merges after P3 and the graph, waves and tasks say so | 6.1, 6.2, 6.3, phase 4 |
| P11's pane arguments called P12's open, with only a stub before it | P8 implements `paneOpen` with a placeholder view; P11 calls only `paneOpen`; P11 has an exit check for the interim state; P12 replaces the placeholder | 6.1, 6.3, phases 8, 11, 12 |
| No path for an installed mod to receive a restaged build | `mod-current` check, version probe after staging, reinstall (never `plugin update`) with a failure path, tests in P14 and P16, S18 extended | 5.1, 5.2, 6.3, 6.5, R18, phases 14 and 16 |

Revision 5, after the second review round:

| Finding | Repair | Where |
|---|---|---|
| P12 said P11 calls P12's open function, against the P8 `paneOpen` contract | P12 now says it replaces P8's placeholder behind the existing `paneOpen` call and adds no entry point | phase 12 |
| P7 applies P3's home-session rules but could merge first | P7 merges after P3; graph, waves, task and phase 7 updated | 6.1, 6.2, 6.3, phase 7 |
| P10 `mctl logs` could merge before P9's routes | Interim behavior defined and tested: the 501 stub gives a not-available message and exit 1, no retry | 6.1, 6.3, phase 10 |
| P13 promised a launcher that P11 builds | `mctl claude` starts plain Claude with no added prompt; the launcher is P11's and appears once P11 and P14 are in; exit check added | 6.1, 6.3, phase 13 |
| P17 documents P13's commands but could merge first | P17 merges after P13; graph and task updated | 6.1, 6.2, phase 17 |
| Reinstall recovery claimed the old install was kept, with no rollback step | No rollback is claimed: retry once, then print two recovery commands, exit 1, doctor reports `mod-enabled` failed; the double-failure path is tested | 6.3, 7 (R18), phase 14 |

Revision 6, after the third review round:

| Finding | Repair | Where |
|---|---|---|
| P15 promised subagent lines in the pane with no pane edit, and P12 merges first | P12 reserves a header slot; P15 owns the formatter and the one slot fill, with a rendered-pane test | 6.1, 6.3, phases 12 and 15 |
| S28 said it ran before WP1 froze contracts, but S28b runs after P4 and P9 | S28a does not gate P1 and answers questions 1, 4, 5 and a first reading of 6; S28b answers 2, 3 and the rest of 6 later; later findings are additive under 8.1 rule 3 | 5.3, R9 |
| P17 documents P3 to P16 but could merge before P6 and P16 | P6 and P16 are now prerequisites of P17; graph, table, phase 17 and the task updated | 6.1, 6.2, phase 17 |

Revision 7, after the fourth review round:

| Finding | Repair | Where |
|---|---|---|
| No phase produced each task's subagent data | See revision 10: the data is the `subagents` field on inbox items (P4) and on the transcript response (P9), formatted by P15's `subagentLines` function | 6.1, 6.3, phases 1, 4, 9, 12, 15 |
| P13 merged before P14 and nothing made `mctl claude` use the shared detection afterward | P13 resolves `claude` from `PATH` in one place; P14 owns the one edit that switches it to the shared detection, with a test | 6.1, 6.3, phases 13 and 14 |

Revision 8, after a sweep requested by the operator's Shepherd for the same class of gap:

| Gap | Repair | Where |
|---|---|---|
| Stubs, slots and optional fields without a named owner, field or completing phase | P1 and P2 list the owner of every route stub, CLI command, setup step, mod flow and pane; P12 names the fields its rows read (`run.reviewers`, `run.agent`) | 6.3, phases 1, 2, 11, 12 |

Revision 9, after the fifth review round:

| Finding | Repair | Where |
|---|---|---|
| P15 added a field to a task read that no phase or route named | Superseded by revision 10, which names the one path from the spec | 6.3 |
| S17 and S20 were soft in the plan but confirmed before merge in phase 14 | One rule: P14 may merge without them; checks ship as warn until a recorded answer confirms the fact; raising to fail is a small follow-up | 5.1, 6.3, R3, R16, phase 14 |
| P13 said the launcher appears once P11 and P14 are in, though P11 may merge with it off | The launcher appears only when P11's launcher is enabled (S10 or S11 passed); otherwise a plain Claude session is expected, and P13 tests both states | 6.1, 6.3, phases 11 and 13 |

Revision 10, after a sweep by class (named paths, gates, conditionals):

| Class | Repair | Where |
|---|---|---|
| Named paths | The spec defines no `subagentLines` field: it is the pure function in `src/shared/subagent-lines.ts` (P15), and the data rides on `subagents` counts on each `GET /dispatch/inbox` item (P4) and `subagents` lines in the `GET /dispatch/tasks/{taskId}/transcript` response (P9), both from one `subagent-state.ts` module (P4); there is no separate tasks route. Every route in P1, P3, P4, P5, P9 and P10 now uses its spec 2.3 path; `{taskId}` is used everywhere; the probe module is named `claude-mods.ts` | 6.1, 6.3, phases 1, 3, 4, 5, 9, 10, 12, 15 |
| Gates | One hard rule and one soft rule in 5.1, repeated in phased-plan.md rules 8 and 9 and in each phase that has a gate; every gate column says hard or soft; S14 no longer appears as a merge prerequisite of P8 | 5.1, 6.1, phased plan, phases 7, 8, 9, 11, 12, 14, 15 |
| Conditionals | Both branches of S27, S16, S10 and S11, S21 to S23, S17 and S4 are stated in each downstream phase's outcome and exit criteria, including P17 and P18 | 6.3, phases 7, 9, 11, 12, 14, 15, 17, 18 |

Revision 11, after the sixth review round:

| Finding | Repair | Where |
|---|---|---|
| S4 was soft but P15 stopped when agents were unusable | P15 still merges: agents are linked, doctor warns, no flow names them; the plan 5.1 S4 row says so | 5.1, phase 15 |
| P14 allowed fail on merely documented facts while R16 said warn until confirmed | One threshold: documentation alone never permits fail; only a recorded S17 or S20 answer does, except the three checks that read the machine's own state | 6.3, 6.5, R16, phase 14 |
| P5 could merge before P3's home-session predicate | P5 merges after P3; graph, waves, phase 5 and the P5 task updated | 6.1, 6.2, 6.3, phases 3 and 5 |
| P8 could merge before P5's banner builder | P8 merges after P5; graph, phase 8 and the P8 task updated | 6.1, 6.2, 6.3, phase 8 |
| Same class (producer after consumer) elsewhere | A producer to consumer audit table in 6.2 lists every cross-phase artifact and its ordering edge; no further missing edge was found | 6.2 |

Revision 12, after the operator's Shepherd asked for a mechanical audit:

| Finding | Repair | Where |
|---|---|---|
| Validators keep sampling different ordering edges | Tables A and B in 6.8 are derived by script from the 20 files; every unordered pair has a stated reason; the hand-written audit table is removed | 6.2, 6.8 |
| The audit found P7's `codex` step consumed P14's commands with no stated interim | P7's step runs under its own tests until P14 merges, then from P2's step list; P14 skips a stub step with `step not available in this build` and tests it | 6.8, phases 7 and 14 |
| Spike rows were grouped, and P8's gate cell omitted S18 and S19 | Rows split (S14, S17; S4, S5, S8, S12, S15); P8 gates are S14, S18 and S19 in plan 6.1, the phased plan and phase 8 | 5.1, 6.1 |

Revision 13, after the seventh review round:

| Finding | Repair | Where |
|---|---|---|
| P9 promised a 1.5 s chat poll while P12 allows 3 s under S23 | One statement everywhere: 1.5 s by default, 3 s under the S23 fallback; table C in 6.8 lists every constant stated in more than one file | 6.8, phases 9 and 12 |
| The home-dispatched Focus test sat in P1 and P3 before any task could be started | Guard 1 is P5's test (the first phase that starts a task), with guards 2 and 3 in P1; P3 only checks that no runtime is set; P18 repeats guard 1 through `mctl run` and the mod flow; table D in 6.8 says where tests get their fixtures | 4.2, 6.1, 6.8, phases 1, 3, 5, 18 |

Revision 14, after the eighth review round:

| Finding | Repair | Where |
|---|---|---|
| The S19 fallback said the daemon hides the capability, but no phase owned a daemon change | Revision 14 tried a P3 registration rule; revision 15 dropped the daemon-side claim: P8's inert path is the fallback, P8 records the S19 result, and both branches are tested | 5.1, phase 8, deviations table |
| An unanswered S23 followed the soft rule's fallback while table C applied it only on a negative answer | One behavior: 1.5 s and every row only after S23 records the default within budget; otherwise, including no answer, 3 s and 30 rows | 5.1, 6.8 table C, phases 9 and 12 |
| Spikes run first but their inputs (staged builds, a pane) are built by later phases | A spike kit table in 5.2: each spike runs on a throwaway kit in the person's scratch folder, not on P2, P12 or P14 code | 5.2, 6.1 |
| Waves said any order but listed ordered pairs, and there were seven | Six waves, each with its required merge order; no edge removed | 6.2 |

Revision 15, after two fresh-context reviews (a consistency pass and a dependency pass):

| Finding | Repair | Where |
|---|---|---|
| Revision labels disagreed across files | Header, section 9 and phased plan say revision 15 | 9 |
| P9's wrap of the existing send path would import `actions.ts`, which guard 3 forbids | Guard 3 forbids `src/server/terminal/` and every import from `actions.ts` except `sendText` in P9's `chat.ts` | 4.2, phases 1 and 9, phased plan rule 3 |
| P11 gave two stop rules when no gate answer is recorded; unrecorded hard gates silently held later phases | One rule: stop without merging the gated part (launcher only for P11); an unrecorded hard gate holds every phase that depends on the gated phase | 5.1, phased plan, phases 7, 9, 11, 12 |
| S28b starts a home task but did not wait for P5 | S28b waits for P4, P5 and P9 | 5.3, 6.1, 6.7 |
| Fakes: no producer for a fake `claude`, a skip signal for stub steps, canned replies for every route, `npm run build` calling `build:mod`, a fake `codex` | P2 owns the fake daemon (every route) and a scriptable fake `claude`, setup-step stubs export `implemented: false`, P7 owns `test/helpers/fake-codex-cli.ts` | 6.3, phases 2, 7, 14, 16 |
| File owners: P1's shared-schema glob and stub names, `types/index.d.ts`, P4's two outside files, P16's app-start file, the smoke edit, `register.ts` order | Named in phases 1, 2, 4, 8, 14, 16 and the phased plan section 7 | phases and phased plan section 7 |
| Second review pass (after the first fixes): S28b prerequisites in P9, the predicate's callers, the tasks guard 1 starts from, the F18 and `d Open in the dashboard` tests in P12, Table A's rule for P1 and P2, setup-step stub files, `--live` and its interface, the per-gate negative answers, `counts` before P4, the names of the predicate and `dispatchIntentFor` stubs, who draws the terminal-only line, the fake `claude` recording launches, one allowed-calls list, the fake-daemon table's rebase rule, and the advisory 1,500-line cap | Fixed where each appears; a second pass of both reviewers follows before the save | 4.2, 6.3, 6.8, phases 1, 2, 3, 4, 7, 8, 9, 12, 14, phased plan |
| Smaller items: P6 flag wording, P10 `repo=*`, P8 and S14, parallelism count, Playwright for P5, `--off`, spec 11.2 fallbacks copied into 5.1, waves are not barriers, mermaid edges | Fixed where each appears | 5.1, 6.1, 6.2, phases 4, 6, 8, 10, 14, 17, 18 |

No recorded human decision changed. Decision 5 (spike answers in task reports and Commonroom) is kept: reports are task reports where an agent ran the spike, and Commonroom posts everywhere.

### Deviations from the frozen acceptance criteria

The run's acceptance criteria were frozen at the start. The plan has since evolved, and each criterion it no longer matches literally is recorded here with its reason. Every other criterion is met as written: phases P1 to P18 with WP1 split into P1 and P2 and spikes first as P0; dependency order in six merge waves (6.2); merge gates S10 or S11, S16 and S27 (5.1); the three Focus guards (4.2); S28 in two stages (5.3); spike answers recorded in task reports and Commonroom only (5, 6.4); gate conditions in the task text of P7, P9, P11 and P12; phase files committed under `docs/plans/headless-mode-implementation/`; rubric deviations in `phased-plan.md` section 4; every backlog task depending on the planning session.

| Frozen criterion | What the plan does | Reason and authority |
|---|---|---|
| Spikes first (P0) | P0 is first in the table and the run order, but spikes gate merges, not starts, so P1 to P6 may start before any spike answer | Spec 8.1 and recorded decision 5: the gates are merge gates |
| Spec "version 8" | Plans against version 18 and adds P7 (WP18) | The spec moved to version 18 after the brief was written; section 1 records the difference and each phase re-reads the version before starting |
| Risk register R1 to R15 | R1 to R18 | R16 to R18 were added by review rounds (the unspecified mods-can-load checks, gate answers living only in task reports, and the stale installed mod); the first fifteen are unchanged |
| 18 backlog tasks | 20 backlog tasks: 18 phase tasks plus the scout tasks S28a and S28b | Recorded decision 4 (S28 in two stages); both scouts open no pull request and S28b also waits for P4, P5 and P9 (it starts a real home task through P5's draft and start); every task depends on the planning session |
| Spike answers recorded in task transcripts | Recorded in each task's final report (a scout task's report, or the person's write-up for person-run spikes) and posted to Commonroom | A final report is the part of a transcript a later task can read; recorded decision 5, with no results file in the repository |
| The three Focus guards in P1 and P18 (recorded decision 1) | Guards 2 and 3 in P1, guard 1 in P5, all three repeated in P18 | Guard 1 needs a task started through the dashboard path, which P1 (stubs only) and P3 cannot produce; review round 7 |
| S19 fallback "The daemon hides the capability from an older mod" (spec 11.2) | P8's inert path is the fallback and P8 records the S19 result; no daemon change is built | Spec 7.2's registration request carries only `clientVersion` (the mod's version) and no `modApi`, so a daemon rule would need a new request field no phase owns; the mod-side check covers an older and a newer mod; review round 8 |
| "Mods can load" checks absent from the spec | Folded into P14 as plan-local requirements without spec ids | Recorded decision 3, differing from the recommendation; the owner renumbers them into the spec |
| Rich HTML for each plan file | Every HTML page since revision 6 is a short stub that points at its Markdown file | The Markdown is authoritative; the full bundle could not be sent in one tool call with rich pages. Restoring rendered pages needs one more revision and is not required by any finding |

### Known gaps and follow-ups

Items that no phase depends on to be implemented. They are listed so they are not lost, and are not blockers; they are handled while the product is built.

- The 20 HTML pages have been short stubs pointing at their Markdown since revision 6; rendered pages and diagrams can be restored in a later revision.
- Two spec details were not read: the shape of the per-subagent `subagents` lines inside the transcript response (spec 7.23) and the `GET /dispatch/config` payload. P1 takes both shapes from the spec.
- The tables in 6.8 were derived by a script that is not committed. When a phase's Scope line changes, rerun the derivation by hand.
- Table D (where tests get their fixtures) is a stated rule, not a script check.
- Guard 3's one `sendText` exception names a function in `src/server/actions.ts` as it is at this revision; a later rename updates the guard.
- The spike fallbacks in 5.1 that were copied from spec 11.2 follow spec version 18; S19's differs from the spec on purpose (deviations table).
- P4, P12 and P14 estimate above the advisory 1,500-line cap; the owner may split one if its pull request passes the cap.
- Section 9 keeps the full repair history of every review round and may be pruned once the plan is accepted.
- `phased-plan.md` section 1 lists its revision bullets out of numeric order.
