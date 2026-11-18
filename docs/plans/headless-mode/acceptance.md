# Headless mode: acceptance criteria

Each row is one test (or one check) whose title starts with the ID. Section references point into [spec.md](spec.md). A stream is done when every row it owns passes, no row it owns is marked `todo`, and the full checks are green.

Phase 0b writes every test below with `{ todo: "AC-..." }` so the branch stays green. The owning stream removes `todo` when it makes the test pass. Nobody weakens a test to make it pass; if a test is wrong, the orchestrator changes it and records why.

Revision 2026-11-18 (third): adds the Delivery section (AC-DEL-01 to 05) and amends AC-INT-03. Earlier the same day: AC-LAUNCH-05 to 11, AC-GUIDE-13, AC-API-21 and AC-PLUG-07 were added; AC-C-04, AC-API-02, AC-HOOK-01, AC-LAUNCH-01, AC-LAUNCH-02, AC-PLUG-04 and AC-INT-01 were amended; and AC-GUIDE, AC-API-18 to 20, AC-HOOK-12, AC-MCP-07 to 09, AC-SET-16 and AC-INT-04, 05 were added. Amended rows are marked (amended).

## Delivery (spike, alpha code)

This is a spike and alpha code. All changes for every stream and every phase are committed under a single upstream branch, `feat/headless-mode-spike`. There is no branch or pull request per stream or per phase. The branch starts from the Phase 0 commits on the local branch `feat/headless` (contracts, schema 35, seams, todo tests) and is pushed to `origin`. Nothing is merged to `main` or released until that is decided separately. Before then the contracts in spec 2 may change; each change is recorded in the owning stream's report and in the commit message. These rows are checks run by the `integration` stream at the end and by each stream when it hands over.

| ID | Test file | Criterion |
|---|---|---|
| AC-DEL-01 | (checks) | `git ls-remote --heads origin feat/headless-mode-spike` returns the branch, and its history contains the Phase 0 commits from `feat/headless` and the commits of every stream that has finished. |
| AC-DEL-02 | (checks) | No other upstream branch carries headless-mode code: for the first commit of each stream, `git branch -r --contains {sha}` lists only `origin/feat/headless-mode-spike`. No per-stream or per-phase feature branch is pushed. |
| AC-DEL-03 | (checks) | The branch is not merged into `main` and not released. It changes no production, signing, release, CI or deployment configuration (`.github/workflows/`, `electron-builder.yml`); the only `package.json` changes are the scripts and `bin` entry listed in spec 2.3. |
| AC-DEL-04 | test/handoff-docs.test.ts | `docs/headless-mode.md` opens with a notice that the feature is a spike and alpha code on `feat/headless-mode-spike`, unreleased, with no compatibility promise. |
| AC-DEL-05 | (checks) | Streams commit to the branch in the order of spec 15, with plain fast-forward pushes (no force push, no history rewrite, no `git reset --hard`). At each stream's last commit the rows that stream owns pass and typecheck and lint are green, before the next stream starts on top of it. |

## v1

### Contracts (stream `contracts`, spec 2)

| ID | Test file | Criterion |
|---|---|---|
| AC-C-01 | test/handoff-contracts.test.ts | Every schema in spec 2.1 parses a valid example and rejects a missing required field, including the guided schemas and `TurnOpenResponseSchema`. |
| AC-C-02 | test/handoff-contracts.test.ts | `KIND_HINTS` has an entry for every harness-launched kind in `DISPATCH_TASK_KINDS` and no other keys. `HANDOFF_KIND_ORDER` is a permutation of `HANDOFF_KINDS`. |
| AC-C-03 | test/handoff-contracts.test.ts | `receiptLine` returns the exact strings in spec 2.1, with and without `fromWords`. |
| AC-C-04 | test/handoff-migration.test.ts | (amended) A database at schema version 34 opens, migrates to 35, gains the three task columns and three tables (with `start_source`, `entrypoint` and `launcher_offered_at` on `handoff_sessions`), and existing task rows read back with `origin: null`. |
| AC-C-05 | test/handoff-migration.test.ts | Opening a version 35 database a second time changes nothing. |
| AC-C-06 | test/handoff-contracts.test.ts | `/api/health` capabilities include `handoff-v1`. |
| AC-C-07 | (smoke) | `npm run smoke` passes with `read_inbox`, `answer_task` and `read_dispatch_options` in `MISSION_MCP_TOOLS`. |
| AC-C-08 | test/handoff-contracts.test.ts | `INBOX_STATES` is waiting, ready, running, queued, shelved, failed, in that order, and `InboxItemSchema` accepts a `shelved` item. |

### API (stream `api`, spec 3 and 4)

| ID | Test file | Criterion |
|---|---|---|
| AC-API-01 | test/handoff-api-http.test.ts | Every `/mcp/handoff/*` route, including dispatch-options, returns 401 without `x-harness-token`. |
| AC-API-02 | test/handoff-api-http.test.ts | (amended) `POST /mcp/handoff/sessions` stores the session with its repo root resolved from `cwd`, its `source` and `entrypoint`, and returns the repo's full inbox and `launcher.banner`. |
| AC-API-03 | test/handoff-api-http.test.ts | A task created through the MCP create route by a registered home session has origin `home-session` with repo and session id. |
| AC-API-04 | test/handoff-api-http.test.ts | A task created with surface `cli` has origin `mctl` and a null session id. A dashboard `POST /api/tasks` task has a null origin. |
| AC-API-05 | test/handoff-inbox-http.test.ts | (amended) The inbox returns only tasks with a non-null origin in the requested repo, ordered waiting, ready, running, queued, shelved, failed. |
| AC-API-06 | test/handoff-inbox-http.test.ts | A running task with a pending `request_input` review is `waiting` with the worker's exact prompt and option labels. |
| AC-API-07 | test/handoff-inbox-http.test.ts | A plan review is `waiting` with `revision`, a 6-hex `revisionHash` and a link. |
| AC-API-08 | test/handoff-inbox-http.test.ts | (amended) `queued` items carry their backlog position. A backlog task with `enabled` false is `shelved`, not `queued`. `failed` items older than 24 hours are omitted. |
| AC-API-09 | test/handoff-inbox-http.test.ts | `afterWork` matches the workflow the task will run, including a task whose kind default was overridden in settings. |
| AC-API-10 | test/handoff-inbox-http.test.ts | `repo=*` returns origin tasks from every repo. |
| AC-API-11 | test/handoff-answers-http.test.ts | Answering a question resolves the review with `resolved_by = "home:{sessionId}"`, and a worker waiting on `/mcp/reviews/:id/wait` receives the answer. |
| AC-API-12 | test/handoff-answers-http.test.ts | The answer returns a receipt whose `fromWords` is the excerpt of the session's open turn, and writes `handoff_receipts`. |
| AC-API-13 | test/handoff-answers-http.test.ts | Answering a task from another repo returns 403. |
| AC-API-14 | test/handoff-answers-http.test.ts | Surface `cli` answering a `home-session` task returns 403 with "answer this in the home session that started it". Surface `cli` answering an `mctl` task succeeds with actor `mctl`. |
| AC-API-15 | test/handoff-answers-http.test.ts | Answering an already-resolved review returns 409. An option label that is not offered returns 400. |
| AC-API-16 | test/handoff-api-http.test.ts | A route that the dashboard uses today (`/api/reviews/:id/resolve` with `by: "human"`) behaves exactly as before. |
| AC-API-17 | test/handoff-answers-http.test.ts | An answer from a session id with no `handoff_sessions` row (for example a worker session) returns 403 and resolves nothing. An `actor` or `by` field in the request body is ignored; the actor comes from the server. |
| AC-API-18 | test/handoff-api-http.test.ts | Registering a session id that belongs to a Mission-managed worker returns 403 and creates no `handoff_sessions` row, so that worker still cannot answer (AC-API-17 holds afterwards). |
| AC-API-19 | test/handoff-api-http.test.ts | After a newer registration for the same `claudePid`, a request carrying the older session id is attributed to the newer session (task origin, answers and turn excerpt). |
| AC-API-20 | test/handoff-api-http.test.ts | A task created from a home session with `enabled` false appears in the inbox as `shelved` with its origin. |
| AC-API-21 | test/handoff-turns-http.test.ts | `turns/open` returns `launcher.offer: true` once for the first real turn of a registered `startup` session with the interactive entrypoint, sets `launcher_offered_at`, and returns `false` on every later turn and on a repeated first turn. |

### Guided questions (stream `guided`, spec 3.5)

| ID | Test file | Criterion |
|---|---|---|
| AC-GUIDE-01 | test/handoff-dispatch-options.test.ts | With no `kind`, the Kind question lists `HANDOFF_KINDS` in `HANDOFF_KIND_ORDER`, each label and description equal to `TASK_KIND_INFO`, plus "Check in on my tasks". Pipeline and resident never appear. |
| AC-GUIDE-02 | test/handoff-dispatch-options.test.ts | `pageOptions` never returns a page with more than 4 options. Non-final pages end with "More...". Six kinds plus Check in make two pages (ship, bugfix, plan, More; then scout, document, chat, Check in). A list of 4 or fewer is one page. |
| AC-GUIDE-03 | test/handoff-dispatch-options.test.ts | `recommendKind`: "fix the flaky login test" gives bugfix; "investigate why builds are slow" gives scout; "write up the setup docs" gives document; no hint word gives null; a tie goes to the earlier kind in `HANDOFF_KIND_ORDER`; matching is whole-word and case-insensitive ("prefix" does not match "fix"). |
| AC-GUIDE-04 | test/handoff-dispatch-options.test.ts | The recommended option is first and its label ends with " (Recommended)". When it is not on page 1, page 1's "More..." description names it. With a brief and no kind, `recommendedKind` is `recommendKind(brief)`; with neither, it is the default kind. |
| AC-GUIDE-05 | test/handoff-dispatch-options.test.ts | The Harness question lists every harness in the registry, and the recommended one is `resolveTaskAgent(kind)`, including when a per-kind default agent is set in settings. |
| AC-GUIDE-06 | test/handoff-dispatch-options.test.ts | The After work question lists the kind's default first (recommended), then None, then each active published workflow; an archived workflow is absent. The default equals `taskDefaultWorkflowId`, including a settings override and plan with local plan storage (Local Plan Validation). |
| AC-GUIDE-07 | test/handoff-dispatch-options.test.ts | For every harness-launched kind, `afterWorkApplies` and the default after work equal what the dashboard rule (`afterWorkForKind`) gives for the same settings. Scout and chat return `afterWorkApplies: false` and no After work question. |
| AC-GUIDE-08 | test/handoff-dispatch-options.test.ts | (amended) With `ui.guidedDispatch` false, the Kind, Harness and After work questions are absent and `defaults` still holds the recommended kind, agent and after work; the launcher question is still returned for `entry` `first-message`. With it true the questions return. |
| AC-GUIDE-09 | test/handoff-dispatch-options.test.ts | A `cwd` outside any repo gives `repoRoot: null` and a Repo question listing workspace repositories. A `cwd` inside a repo gives no Repo question. |
| AC-GUIDE-10 | test/handoff-dispatch-options.test.ts | `fallbackText` contains the same questions and options in the same order as `questions`, numbered, and ends with "Reply with a number." |
| AC-GUIDE-11 | test/handoff-dispatch-options.test.ts | Every question's `header` is at most 12 characters and every page has 2 to 4 options. |
| AC-GUIDE-12 | (existing e2e) | The dashboard's guided dispatch specs pass unchanged after the shared extraction (or after no extraction, when the parity test is the fallback). |
| AC-GUIDE-13 | test/handoff-dispatch-options.test.ts | With `entry` `first-message` the first question is the launcher question with the three options `work-here`, `hand-off`, `check-in`. The Recommended option is `hand-off` when `recommendKind(brief)` is not null and `work-here` otherwise. With `entry` `command` or `conversation` no launcher question is returned. |

### Turn log and plan approval (stream `api`, spec 4)

| ID | Test file | Criterion |
|---|---|---|
| AC-TURN-01 | test/handoff-turns-http.test.ts | Opening a turn stores a whitespace-collapsed excerpt of at most 120 characters, and no column anywhere contains the full prompt. |
| AC-TURN-02 | test/handoff-turns-http.test.ts | Opening a turn closes the previous open turn of the same session. Closing a turn sets `closed_at` and the session's `last_stop_at`. |
| AC-TURN-03 | test/handoff-turns-http.test.ts | The first delta after a new item puts it in `full`. The next turn puts a still-waiting item in `reminders`, and a ready item nowhere. |
| AC-TURN-04 | test/handoff-turns-http.test.ts | A changed item (new `changedAt`) appears in `full` again. |
| AC-TURN-05 | test/handoff-turns-http.test.ts | Turn rows older than 7 days are deleted on startup cleanup. |
| AC-PLAN-01 | test/handoff-plan-approval-http.test.ts | Approval with a hash that is not the current revision returns 409 "the plan changed". |
| AC-PLAN-02 | test/handoff-plan-approval-http.test.ts | Approval when no earlier turn showed that hash returns 409 "show the person the plan card first". |
| AC-PLAN-03 | test/handoff-plan-approval-http.test.ts | Approval in the same turn the card was shown returns 409. |
| AC-PLAN-04 | test/handoff-plan-approval-http.test.ts | Approval when no later turn contains an approval word returns 409 "ask the person to say approve". |
| AC-PLAN-05 | test/handoff-plan-approval-http.test.ts | A valid approval resolves with `home-approval:{sessionId}`, and plan publication accepts it as a human approval. |
| AC-PLAN-06 | test/handoff-plan-approval-http.test.ts | Regression: a review resolved by `session:{id}` or `home:{id}` is still not a human approval for plan publication. |
| AC-PLAN-07 | test/handoff-contracts.test.ts | `containsApproval` is true for "approve", "Approved.", "yes, publish", "publish it", and false for "don't approve", "do not approve this", "not approved", "approval pending", "disapprove". |

### MCP (stream `mcp`, spec 5)

| ID | Test file | Criterion |
|---|---|---|
| AC-MCP-01 | test/handoff-mcp.test.ts | `read_inbox` from a cwd inside a repo returns grouped text that quotes each question exactly, plus JSON matching `InboxResponseSchema`. |
| AC-MCP-02 | test/handoff-mcp.test.ts | `answer_task` returns the receipt line as text and resolves the review. |
| AC-MCP-03 | test/handoff-mcp.test.ts | The `create_task` kind description contains one line per `KIND_HINTS` entry with its words. |
| AC-MCP-04 | test/handoff-mcp.test.ts | `create_task` results include `kindLabel` and `afterWork { slug, label }` for each built-in kind default. |
| AC-MCP-05 | test/handoff-mcp.test.ts | The MCP child sends `CLAUDE_CODE_SESSION_ID` and its parent pid as the home-session identity, and a task it creates gets origin `home-session`. |
| AC-MCP-06 | test/handoff-mcp.test.ts | The `answer_task` description says to send only what the person said and to wait for approve on plans. |
| AC-MCP-07 | test/handoff-mcp.test.ts | `read_dispatch_options` returns the daemon's questions as JSON in the `AskUserQuestion` shape (header, question, options with label and description), the value behind each label, and `fallbackText`; it accepts `entry`. |
| AC-MCP-08 | test/handoff-mcp.test.ts | The `read_dispatch_options` description tells the model to ask exactly the returned questions in order and not to add, reword or reorder options. `create_task` still has no `grillFirst` or `personaId` input. |
| AC-MCP-09 | test/handoff-mcp.test.ts | With `MISSION_SESSION_ID` set, `read_inbox`, `answer_task` and `read_dispatch_options` return the "not available inside a Mission Control worker" error and send no request. |

### Hooks and status line (stream `hooks`, spec 6)

| ID | Test file | Criterion |
|---|---|---|
| AC-HOOK-01 | test/handoff-hook.test.ts | (amended) `SessionStart` posts the registration and prints a summary card in `additionalContext` when the inbox has items. With an empty inbox it prints only the notice (and the skill hint in `additionalContext`), no card. |
| AC-HOOK-02 | test/handoff-hook.test.ts | When the stub API does not answer within 300 ms, every event prints nothing and exits 0 in under 1 s. |
| AC-HOOK-03 | test/handoff-hook.test.ts | `SessionStart` against an API missing `handoff-v1`, or with a different version, prints the "don't match. Run: mctl setup" `systemMessage`. |
| AC-HOOK-04 | test/handoff-hook.test.ts | `SessionStart` with the API unreachable for a launchd-managed instance starts the kickstart command through the injected runner and prints "starting in the background". |
| AC-HOOK-05 | test/handoff-hook.test.ts | `UserPromptSubmit` posts the prompt, prints one `systemMessage` line per full item and one reminder line per reminder, and puts the full question and options in `additionalContext`. |
| AC-HOOK-06 | test/handoff-hook.test.ts | `Stop` posts the close and prints nothing. |
| AC-HOOK-07 | test/handoff-hook.test.ts | `PostToolUse` for a tool named `*answer_task` prints the receipt as `systemMessage`. Other tools print nothing. |
| AC-HOOK-08 | test/handoff-hook.test.ts | No event ever exits non-zero or prints `"decision"`. `MISSION_HEADLESS=1` makes every event a no-op. |
| AC-HOOK-09 | test/handoff-statusline.test.ts | (amended) The status line appends `● mc 2 running · 1 waiting` from the cache file after the inner command's output, unchanged inner output first, and shows `1 shelved` after queued when present. |
| AC-HOOK-10 | test/handoff-statusline.test.ts | With no cache and no recent health, an installed instance shows `○ mc offline`. A repo with no items shows nothing extra. |
| AC-HOOK-11 | test/handoff-statusline.test.ts | The API rewrites the cache file when that repo's inbox changes. |
| AC-HOOK-12 | test/handoff-hook.test.ts | With `MISSION_SESSION_ID` set, every event registers nothing, opens no turn, prints nothing, asks no launcher question and exits 0. |

### Launcher (streams `hooks`, `api`, `plugin`, `setup`, spec 2.5, 4.1, 6, 7, 9.3)

| ID | Test file | Criterion |
|---|---|---|
| AC-LAUNCH-01 | test/handoff-hook.test.ts | (amended) `SessionStart` with source `startup` or `clear` prints the server's notice as `systemMessage`. With source `resume` or `compact` it prints no notice. |
| AC-LAUNCH-02 | test/handoff-hook.test.ts | (amended) The notice text comes from the API response: a stub API returning a different banner is printed verbatim, so the hook holds no kind list. With the API unreachable no notice is printed. |
| AC-LAUNCH-03 | test/handoff-plugin.test.ts | `commands/mc.md` documents `/mc`, `/mc {kind} {text}`, `/mc check` and `/mc {taskId}`, says an unknown first word starts the brief, and says the shortcuts are optional. |
| AC-LAUNCH-04 | test/handoff-setup.test.ts | `mctl claude` on a TTY with no prompt argument passes `/mc` as the first positional argument. It does not when a prompt argument, `-p`, `--print`, `--resume`, `--continue` or `--no-launcher` is given, or when stdin is not a TTY. |
| AC-LAUNCH-05 | test/handoff-turns-http.test.ts | The daemon offers the launcher only for the first turn of a registered session whose source is `startup`. A session registered with `resume`, `clear`, `compact` or an unknown source is never offered it. |
| AC-LAUNCH-06 | test/handoff-turns-http.test.ts | No offer when the first prompt is empty or whitespace, or starts with `/` (including `/mc` and the `mctl claude` prompt). |
| AC-LAUNCH-07 | test/handoff-turns-http.test.ts | No offer when the registered entrypoint is not the interactive value, including an unknown or missing entrypoint and the non-interactive `-p` value. |
| AC-LAUNCH-08 | test/handoff-hook.test.ts | When `launcher.offer` is true, `UserPromptSubmit` puts the launcher instruction in `additionalContext`: call `read_dispatch_options` with `entry` `first-message`, ask the launcher question first, keep the person's message, do not start work until answered. When it is false the instruction is absent. A waiting-question card appears before the launcher instruction. |
| AC-LAUNCH-09 | test/handoff-hook.test.ts | With `MISSION_SESSION_ID` set (a worker) or `MISSION_HEADLESS` set, no launcher instruction is printed and no offer is requested. |
| AC-LAUNCH-10 | test/handoff-hook.test.ts | With `MISSION_HANDOFF_LAUNCHER=0` the hook never prints the launcher instruction, even if the daemon would offer, and still logs the turn. |
| AC-LAUNCH-11 | test/handoff-turns-http.test.ts | With `handoff.launcher.prompt` false the daemon never offers the launcher and `launcher_offered_at` stays NULL. The setting is registered as `setting` in `app-config-entries.ts` with default true and is shown by `mctl config view`. |

### Plugin (stream `plugin`, spec 7)

| ID | Test file | Criterion |
|---|---|---|
| AC-PLUG-01 | test/handoff-plugin.test.ts | `build-claude-plugin` produces the layout in spec 7.1. `plugin.json` has name `mission-control` and the package version. |
| AC-PLUG-02 | test/handoff-plugin.test.ts | `hooks.json` registers the four events, every command uses `${CLAUDE_PLUGIN_ROOT}`, and the `PostToolUse` matcher is `.*answer_task`. |
| AC-PLUG-03 | test/handoff-plugin.test.ts | `.mcp.json` declares one `mission-control` stdio server whose script exists in the built plugin. |
| AC-PLUG-04 | test/handoff-plugin.test.ts | (amended) `skills/handoff/SKILL.md` and `skills/checkin/SKILL.md` have valid frontmatter (name, description) and contain each section heading in spec 7.2 and 7.3. The handoff skill names `read_dispatch_options`, `AskUserQuestion`, `fallbackText`, `create_task` and `dispatch_task`, forbids calling `dispatch_task` without Dispatch now or "go", forbids rewording options, and contains no offer of Grill me first. It lists no kind names by hand. |
| AC-PLUG-05 | test/handoff-plugin.test.ts | `commands/mc.md` exists and refers to the handoff and checkin skills. |
| AC-PLUG-06 | (smoke) | `smokeHandoffPlugin` runs the built hook with `{}` for each event and exits 0, and completes an MCP `initialize` and `tools/list` against the plugin's server path, listing `read_dispatch_options`. |
| AC-PLUG-07 | test/handoff-plugin.test.ts | The handoff skill has the three entries of spec 7.2 (first-message, launcher, conversation). The first-message entry says to ask the launcher question before anything else, to keep the person's message as the brief, to answer it normally on Work in this session, and never to start the work before the answer. |

### mctl (stream `mctl`, spec 8)

| ID | Test file | Criterion |
|---|---|---|
| AC-CLI-01 | test/handoff-cli.test.ts | With no args, `mctl` prints usage and exits 2. An unknown command exits 2. |
| AC-CLI-02 | test/handoff-cli.test.ts | `get tasks` prints the table for this repo's origin tasks. `--all`, `--state waiting` and `--json` behave as specified, and `--json` parses. |
| AC-CLI-03 | test/handoff-cli.test.ts | `describe` shows kind, after work, origin, PR, and for a waiting home-session task the line "answer this in your home session". |
| AC-CLI-04 | test/handoff-cli.test.ts | `logs -f` prints new transcript lines from SSE events and exits when the task becomes terminal. It makes no repeated HTTP requests for the same data. |
| AC-CLI-05 | test/handoff-cli.test.ts | `status` prints counts, slots used and API version. `get kinds` prints each kind's hints and current after work. `get workflows` and `config view` print the documented fields, including `handoff.launcher.prompt`. |
| AC-CLI-06 | test/handoff-cli.test.ts | Every command uses the selected instance's port and token (`--instance`, then `MCTL_INSTANCE`, then default). |
| AC-CLI-07 | test/handoff-cli-run.test.ts | `run` without a TTY exits 2 with the "needs an interactive terminal" message and creates nothing. |
| AC-CLI-08 | test/handoff-cli-run.test.ts | `run` on a TTY creates and dispatches a task with origin `mctl`, kind, after work, model and effort as given, and prints the header line. |
| AC-CLI-09 | test/handoff-cli-run.test.ts | `--after-work` resolves a slug, an id and `slug@version`. `none` prints the warning. Unknown values, unknown kinds and invalid models exit 2 with the valid list. |
| AC-CLI-10 | test/handoff-cli-run.test.ts | (amended) `--shelve` creates without dispatching. `--dry-run` creates nothing and prints the resolution. `-f` reads the brief from a file. A bare `-` exits 2 with usage and creates nothing. `--task` works as an alias of `--kind`. `--grill` is not a flag and exits 2. |
| AC-CLI-11 | test/handoff-cli-run.test.ts | `--watch` exits 0 on ready, 1 on failed, 2 on cancelled, 3 when an `mctl`-origin question is waiting and its prompt reaches end of input (stdin closed or Ctrl-D) with the review still pending, 4 when dispatch is refused, and 130 on SIGINT, including Ctrl-C at the prompt, leaving the task running. |
| AC-CLI-12 | test/handoff-cli-run.test.ts | `--watch` prompts for an `mctl`-origin question and sends the chosen option. For a home-session task it prints the pointer and does not prompt. |
| AC-CLI-13 | test/handoff-cli.test.ts | There is no `mctl` command that answers, approves, cancels or reorders a task (the command table matches spec 8.2 exactly). |

### Instances and setup (stream `setup`, spec 9)

| ID | Test file | Criterion |
|---|---|---|
| AC-SET-01 | test/handoff-instances.test.ts | The default instance resolves to `stateDir()`, `PORT`, the two default labels and the user's Claude config. `sandbox` resolves to the paths and labels in spec 9.1. Invalid names and `default` are refused. |
| AC-SET-02 | test/handoff-instances.test.ts | Setup picks the first free port from 7417, stores it in `instance.json`, and reuses it on later runs. |
| AC-SET-03 | test/handoff-setup.test.ts | Setup without built artifacts exits 2 with "run npm run build first". |
| AC-SET-04 | test/handoff-setup.test.ts | Setup writes two plists with the env vars in spec 9.2, and calls `launchctl bootstrap` for exactly those two labels through the injected runner. |
| AC-SET-05 | test/handoff-setup.test.ts | Setup for a named instance never writes, or passes to `launchctl`, any default or legacy label, and never touches `~/.claude`, `~/.claude.json` or `~/.mission-control`. |
| AC-SET-06 | test/handoff-setup.test.ts | Setup for the default instance refuses while another process holds `daemon.lock`, naming its pid. |
| AC-SET-07 | test/handoff-setup.test.ts | Setup copies the plugin to `{state}/plugin/{version}/` and wraps the status line in that instance's `settings.json`, keeping the prior command in the sidecar. |
| AC-SET-08 | test/handoff-setup.test.ts | Default-instance setup with existing Mission Control hook groups and a user-scope MCP registration backs both files up, removes the duplicates, and reports the backup path. |
| AC-SET-09 | test/handoff-setup.test.ts | Running setup twice leaves every file byte-identical after the second run. |
| AC-SET-10 | test/handoff-setup.test.ts | (amended) `mctl claude` execs `claude` with the instance env and passes through extra args. In installed mode (the default for every instance) it passes no `--plugin-dir`; with `--plugin-dir-mode` it does. |
| AC-SET-11 | test/handoff-setup.test.ts | `doctor` reports each check in spec 9.3 and exits 1 when one fails. It flags duplicate hooks. |
| AC-SET-12 | test/handoff-setup.test.ts | `uninstall` boots out both labels, deletes the plists, restores the status line and uninstalls the plugin. `--purge` deletes a named instance's folder and is refused for the default instance. |
| AC-SET-13 | test/handoff-setup.test.ts | `daemon restart` and `daemon kick` call `kickstart -k` and `kickstart` for the instance's labels. |
| AC-SET-14 | test/executable-contracts.test.ts | `/bin/launchctl` is in `FIXED_OS_EXECUTABLES`, and every new child process call is declared in `CHILD_PROCESS_BOUNDARIES` (existing test stays green). |
| AC-SET-15 | test/handoff-instances.test.ts | `agentSubprocessEnv` passes `CLAUDE_CONFIG_DIR` from the daemon env to harness children. |
| AC-SET-16 | test/handoff-instances.test.ts | A named instance's `instance.json` records `pluginMode: "installed"` unless `--plugin-dir-mode` was passed. |

### Integration (stream `integration`, spec 10)

| ID | Test file | Criterion |
|---|---|---|
| AC-INT-01 | test/handoff-loop.test.ts | (amended) The full loop in spec 10 passes against a real daemon with fake agents and spends no model tokens, starting from the first-message launcher offer and the guided questions, and showing no second offer in the same session. |
| AC-INT-02 | test/handoff-isolation.test.ts | Sandbox setup and `uninstall --purge` leave every default-instance file byte-identical, and the runner never sees a default or legacy label. |
| AC-INT-03 | (checks) | (amended) `npm run typecheck`, `npm run lint`, `MISSION_TEST_CONCURRENCY=4 npm test`, `npm run build` and `npm run smoke` all pass on the tip of `feat/headless-mode-spike`. |
| AC-INT-04 | test/handoff-loop.test.ts | The same hook script and MCP server run with `MISSION_SESSION_ID` set (a worker) leave `handoff_sessions` empty and the worker cannot call `answer_task`. |
| AC-INT-05 | test/handoff-loop.test.ts | Answers chosen in the guided questions (kind, harness, after work) produce a task whose kind, agent and workflow equal the dashboard's result for the same choices on the same settings. |

### Docs (stream `docs`, spec 11)

| ID | Test file | Criterion |
|---|---|---|
| AC-DOC-01 | test/handoff-docs.test.ts | `docs/headless-mode.md` exists, contains each section heading in spec 11, and is linked from `docs/README.md` and `README.md`. |
| AC-DOC-02 | test/handoff-docs.test.ts | `docs/security.md` has the "Home-session answers and plan approvals" section. |
| AC-DOC-03 | test/handoff-docs.test.ts | No file added or changed under `docs/` by this feature contains an em dash. |
| AC-DOC-04 | (existing) | The repository's doc link checker test passes. |
| AC-DOC-05 | test/handoff-docs.test.ts | `docs/headless-mode.md` states the launcher behaviour (when it asks and when it does not), how to switch it off, the Guided dispatch switch, and the limit that dispatch is gated by the skill and a confirm, not the server. |

## v1.1

### Attach (stream `attach`, spec 12.1)

| ID | Test file | Criterion |
|---|---|---|
| AC-ATT-01 | test/handoff-attach.test.ts | `attach` without a TTY, or for a non-SDK session, exits 2 and changes nothing. |
| AC-ATT-02 | test/handoff-attach.test.ts | `attach` prints the one-way warning and stops unless the answer is `y`. |
| AC-ATT-03 | test/handoff-attach.test.ts | With a fake `claude`, `attach` registers its tty and pid, the transfer coordinator accepts the successor within 10 s, and the task stays running with its workflow pinned. |
| AC-ATT-04 | test/handoff-attach.test.ts | A successor whose pid or tty does not match the registration is not accepted. |

### Notifications (stream `notify`, spec 12.2)

| ID | Test file | Criterion |
|---|---|---|
| AC-NOT-01 | test/handoff-notifier.test.ts | A question waiting longer than the threshold, with the origin session idle that long and no dashboard stream connected, sends exactly one notification through the injected osascript runner. |
| AC-NOT-02 | test/handoff-notifier.test.ts | No notification is sent for ready, running, queued or shelved items, when a dashboard stream is connected, or when the setting is off. |
| AC-NOT-03 | test/handoff-notifier.test.ts | A newer turn in the origin session resets the idle clock. |
| AC-NOT-04 | test/handoff-notifier.test.ts | Both settings are registered as `setting` in `app-config-entries.ts` with their defaults. |

### Config set (stream `config-set`, spec 12.3)

| ID | Test file | Criterion |
|---|---|---|
| AC-CFG-01 | test/handoff-config-set.test.ts | Each allowlisted key, including `ui.guidedDispatch` and `handoff.launcher.prompt`, is written through the Settings route and reads back. |
| AC-CFG-02 | test/handoff-config-set.test.ts | It prints old and new values and writes only after `y`. Without a TTY it exits 2. |
| AC-CFG-03 | test/handoff-config-set.test.ts | An unknown key or an invalid value exits 2, with the allowed keys or the schema error. |

### Final (stream `integration`)

| ID | Test file | Criterion |
|---|---|---|
| AC-FIN-01 | (checks) | Every check in AC-INT-03 passes again with v1.1 merged on the branch. No `todo` remains on any `AC-` test. |
