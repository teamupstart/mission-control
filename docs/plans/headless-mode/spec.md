# Headless mode: build spec (v1 and v1.1)

Read [plan.md](plan.md) first for the why. This file says exactly what to build. Every requirement that can be tested has an ID like `AC-API-03`; [acceptance.md](acceptance.md) lists them with the test file that proves each one.

If this spec and the code disagree about how something works today, the code wins. Note the difference in your stream's report so the spec can be corrected.

Placeholders in this file are written `{name}` so they are never mistaken for markup.

## 0. Rules for everyone building this

- **This is a spike and alpha code.** Every commit goes to one upstream branch, `feat/headless-mode-spike`. Do not create per-stream or per-phase branches, and do not merge to `main` or release (acceptance section Delivery, AC-DEL-01 to 05). Contracts may change before a merge is decided; record each change in your stream's report.
- Follow `AGENTS.md` (`CLAUDE.md`). The points below are the ones this feature hits hardest.
- Code namespace is `handoff`. Never reuse `MISSION_HEADLESS` or the word "headless" in identifiers; that env var already means "hooks stay silent".
- Wire types and browser-safe logic go in `src/shared/` with no `node:` imports.
- Schema changes go in `src/server/db.ts` `migrate()` with `addColumn` and `CREATE TABLE IF NOT EXISTS`, and bump `CURRENT_DATABASE_SCHEMA_VERSION`. Only the contracts stream edits `db.ts` migrations. Later changes go through the orchestrator.
- Routes validate bodies with `parseBody(c, Schema)` (`src/server/http-body.ts`).
- Every child process goes through the executable registry. `launchctl` and any other new fixed OS path must be added to `FIXED_OS_EXECUTABLES` in `src/server/executables/catalog.ts` and declared in `CHILD_PROCESS_BOUNDARIES` in `test/executable-contracts.test.ts`.
- No visible dashboard UI changes. The one allowed touch under `src/web/` is a behaviour-preserving import swap for the shared option rules in 3.5, and the dashboard's guided-dispatch e2e specs must pass unchanged.
- Use shared registries, not copies. Kind labels, blurbs, harnesses and after-work defaults come from `TASK_KIND_INFO`, the harness registry, `resolveTaskAgent` and `taskDefaultWorkflowId`. Never list kinds in a skill, hook or CLI by hand.
- Never write to the real `~/.claude`, `~/.claude.json`, `~/.mission-control`, `~/Library/LaunchAgents`, or any real launchd label from code under test. Every test that touches setup, plugin install, hooks or launchd sets `HOME`, `CLAUDE_CONFIG_DIR` and `MISSION_HOME` to a temp folder and injects a fake command runner for `launchctl` and `claude`.
- Never spend model tokens in tests. Use the fakes described in section 13.
- No em dashes in prose, comments or docs.

## 1. Phase 0 spikes

Record results in the "Spike results" section at the end of this file.

| ID | Question | Status |
|---|---|---|
| S-01 | Does a plugin's stdio MCP server know which Claude session started it? | Resolved: yes, `CLAUDE_CODE_SESSION_ID` (see results). |
| S-02 | Does `CLAUDE_CONFIG_DIR` isolate `claude plugin install`? | Resolved: yes. Installed mode for every instance. |
| S-03 | Is `systemMessage` from `UserPromptSubmit` and `PostToolUse` shown to the person? | Resolved: yes. Hooks still emit `additionalContext` too, for Pi and older builds. |
| S-04 | Does Claude Code render an MCP `elicitation/create` form (single-select enum) in an interactive terminal, and is it available inside a tool call from a plugin server? | Open, not blocking. Needs one interactive run. If yes, a later change can move the guided questions into one MCP tool and drop the skill's `AskUserQuestion` loop. The MVP uses `AskUserQuestion`. |
| S-05 | Does `SessionStart` input carry `source` with values startup, resume, clear, compact, and does a positional initial prompt (`claude "/mc"`) run a plugin command? | Open, needs one interactive run. Fallback: `source` unknown means the daemon treats the session as not eligible for the launcher (safe), and `mctl claude` passes `/mission-control:mc`. |
| S-06 | (a) Which value identifies an interactive session for the entrypoint check (candidate: `CLAUDE_CODE_ENTRYPOINT` equals `cli`, versus `sdk-cli` for `claude -p`)? (b) Does Claude Code let a plugin or settings file submit a first prompt, so plain `claude` could ask on open with no typing? (c) Does `UserPromptSubmit` for the first prompt of a startup session fire before any `/loop` or background report can? | Open, needs interactive and `-p` runs. Not blocking. (a) is required to enable the launcher: until it is confirmed, the check is `entrypoint equals "cli"` and anything else, including unknown, never gets the launcher. (b) if yes, a later change replaces the first-message intercept for plain `claude`. |

## 2. Contracts (Phase 0a, stream `contracts`)

Land these first, in one stream, so every later stream builds against fixed interfaces. Phase 0 of the contracts is already on the local branch `feat/headless` (schema 35, seams, todo tests); `feat/headless-mode-spike` starts from those commits. Section 2.4 lists what changes in that landed code.

### 2.1 `src/shared/handoff.ts`

Zod schemas and types. Names are part of the contract.

- `HANDOFF_SURFACES = ["home-session", "mctl"] as const`, type `HandoffSurface`.
- `TaskOriginSchema`: `{ surface: HandoffSurface, repoRoot: string, sessionId: string or null }`.
- `KIND_HINTS`: a record from `HandoffKind` to a readonly list of hint words, where `HandoffKind` is every kind in `DISPATCH_TASK_KINDS` that launches a harness. Starting values:
  - `bugfix`: fix, repair, broken, flaky, regression, crash, bug
  - `ship`: build, add, implement, change, refactor, upgrade
  - `plan`: design, architect, plan, propose, spec
  - `scout`: investigate, find out, audit, research, which, why
  - `document`: document, explain, write up, docs, readme
  - `chat`: discuss, talk through, brainstorm
- `HomeSessionRegistrationSchema`: `{ sessionId, harness: "claude" or "pi", cwd, pluginVersion, claudePid: number or null, source: "startup" or "resume" or "clear" or "compact" or null, entrypoint: string or null }`.
- `TurnOpenSchema`: `{ sessionId, cwd, promptId: string or null, prompt: string }`. The API never stores `prompt`; see 4.1.
- `TurnOpenResponseSchema`: `{ cardDelta: CardDelta, launcher: { offer: boolean } }`.
- `TurnCloseSchema`: `{ sessionId }`.
- `InboxItemSchema`: discriminated by `state`: `"waiting" | "ready" | "running" | "queued" | "shelved" | "failed"`. Common fields: `taskId`, `title`, `kind`, `afterWork` (`{ id, slug, label }` or null), `origin`, `changedAt`, `prUrl` or null, `costUsd` or null. `waiting` adds `request` (see below). `queued` adds `position`. `shelved` is a backlog task whose `enabled` flag is false (filed but not started and not scheduled).
- `InboxRequestSchema`: discriminated by `type`:
  - `"question"`: `reviewId`, `prompt` (the worker's exact text), `options: { label }[]`, `allowsFreeText`.
  - `"plan"`: `reviewId`, `planId`, `revision` (number), `revisionHash` (first 6 hex of the manifest hash), `summary`, `link`.
  - `"review"`: `reviewId`, `summary` (diff reviews).
- `InboxResponseSchema`: `{ repoRoot, items: InboxItem[], cursor: string }`.
- `CardDeltaSchema`: `{ full: InboxItem[], reminders: InboxItem[], cursor }`. Returned to hooks.
- `AnswerTaskRequestSchema`: discriminated by `action`:
  - `{ action: "answer", reviewId, option: string or null, text: string or null }`
  - `{ action: "approve_plan", reviewId, revisionHash }`
  - `{ action: "request_changes", reviewId, text }`
  - `{ action: "approve_review" or "reject_review", reviewId, text: string or null }`
  Plus caller fields `{ sessionId: string or null, cwd }`.
- `AnswerReceiptSchema`: `{ reviewId, taskId, sent: string, fromWords: string or null, at }`. `receiptLine(r)` returns the exact user-facing line: `sent "{sent}" to {taskId}, from your words "{fromWords}"`, or without the `from your words` part when `fromWords` is null.
- `APPROVAL_PHRASES` and `containsApproval(text): boolean` (see 4.3).
- `InstanceFileSchema`: the contents of `{stateDir}/instance.json` (see 9.1). Hooks and the status line read it to learn the instance's launchd labels; `mctl` writes it. The default instance writes one too, once set up.
- `HANDOFF_PROTOCOL_VERSION = 1`. The feature is unreleased, so the guided additions below do not bump it.
- New for guided questions (see 3.5):
  - `HANDOFF_KIND_ORDER`: the explicit order kinds are offered in: ship, bugfix, plan, scout, document, chat. A test requires it to be a permutation of `HANDOFF_KINDS`, so a new harness-launched kind cannot ship without a place in the order.
  - `recommendKind(text): HandoffKind or null`: counts whole-word, case-insensitive matches of `KIND_HINTS` words and phrases in `text`. The kind with most matches wins; a tie goes to the kind earlier in `HANDOFF_KIND_ORDER`; no match returns null.
  - `GuidedOptionSchema`: `{ value: string, label: string, description: string, recommended: boolean }`.
  - `GuidedQuestionSchema`: `{ id: "launcher" | "repo" | "kind" | "harness" | "afterWork", header: string (at most 12 characters), question: string, options: GuidedOption[] (two to four per page), page: number, pages: number }`.
  - `DispatchOptionsRequestSchema`: `{ cwd, kind: HandoffKind or null, brief: string or null, entry: "command" or "first-message" or "conversation" }`. `entry` defaults to `"command"`.
  - `DispatchOptionsResponseSchema`: `{ guided: boolean, repoRoot: string or null, recommendedKind: HandoffKind or null, defaults: { kind, agent, afterWork: AfterWork or null }, questions: GuidedQuestion[], afterWorkApplies: boolean, banner: string, fallbackText: string }`.
  - `pageOptions(options, size)`: the one paging helper (see 3.5).
  - `LAUNCHER_CHOICES`: `work-here`, `hand-off`, `check-in`, the `value`s of the launcher question (see 3.5).

### 2.2 Database (`src/server/db.ts`, schema version 35)

- `tasks`: add `origin_surface TEXT`, `origin_repo TEXT`, `origin_session_id TEXT`. NULL means created by the dashboard or anything else that existed before this feature.
- `handoff_sessions`: `session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, cwd TEXT NOT NULL, repo_root TEXT, claude_pid INTEGER, plugin_version TEXT, start_source TEXT, entrypoint TEXT, launcher_offered_at INTEGER, started_at INTEGER NOT NULL, last_turn_at INTEGER, last_stop_at INTEGER, inbox_cursor TEXT`.
- `handoff_turns`: `id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, prompt_id TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER, excerpt TEXT NOT NULL, contains_approval INTEGER NOT NULL, mentioned_hashes TEXT NOT NULL DEFAULT '[]', cards_shown TEXT NOT NULL DEFAULT '[]'`. Index on `(session_id, opened_at)`.
- `handoff_receipts`: `review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT, surface TEXT NOT NULL, sent TEXT NOT NULL, from_words TEXT, created_at INTEGER NOT NULL`.
- `ReviewActor` in `src/shared/types.ts` gains `home:{sessionId}`, `home-approval:{sessionId}` and `"mctl"`. These are new persisted values in `reviews.resolved_by`; never rename them later.
- No schema change is needed for guided questions or `shelved` (it reads `tasks.enabled`).
- Phase 0 already created `handoff_sessions` on `feat/headless` without the three new columns. Because schema 35 has not shipped, add them to the same `CREATE TABLE`; if any database already ran the earlier 35, use `addColumn` for them as well.

### 2.3 Seams so streams do not share hot files

- `src/server/handoff/routes.ts` exports `registerHandoffRoutes(app, deps)`. `src/server/routes.ts` calls it once inside `buildApp`. Phase 0 handlers return `501 { error: "not implemented" }`.
- `src/mcp/handoff-tools.ts` exports `registerHandoffTools(server, http)`. `src/mcp/server.ts` calls it once. Phase 0 tools return an MCP error "not implemented".
- `MISSION_MCP_TOOLS` (`src/server/mission-mcp.ts`) gains `read_inbox`, `answer_task` and `read_dispatch_options`.
- `DAEMON_PROTOCOL_CAPABILITIES` (`src/shared/daemon-protocol.ts`) gains `handoff: "handoff-v1"`.
- `hooks/handoff-hook.mjs`: stub that reads stdin and exits 0.
- `plugin/`: skeleton (see 7.1) with empty skill files.
- `src/cli/index.ts`: stub that prints usage and exits 2.
- `package.json`:
  - `bin.mctl`: `src/cli/index.ts`
  - `scripts.mctl`: `tsx src/cli/index.ts`
  - `build:cli`: esbuild `src/cli/index.ts` to `dist/cli/mctl.mjs`
  - `build:handoff-hook`: esbuild `hooks/handoff-hook.mjs` to `dist/satellites/handoff-hook.mjs`
  - `build:claude-plugin`: `node scripts/build-claude-plugin.mjs`, which writes `dist/claude-plugin/`
  - All three are appended to `build`.
- `scripts/smoke-bundles.mjs` calls `smokeHandoffPlugin()` from `scripts/smoke-handoff-plugin.mjs` and `smokeHandoffCli()` from `scripts/smoke-handoff-cli.mjs`. Phase 0 versions pass trivially.

### 2.4 Changes to the already-landed Phase 0 contracts

The `contracts` stream reopens `src/shared/handoff.ts` once, before any other stream builds on it:

1. Add the `shelved` state to `INBOX_STATES` (between `queued` and `failed`) and `InboxItemSchema`.
2. Add the guided types and helpers listed at the end of 2.1, the registration fields `source` and `entrypoint`, and `TurnOpenResponseSchema`.
3. Add the three `handoff_sessions` columns (2.2).
4. Add `read_dispatch_options` to the pinned `MISSION_MCP_TOOLS` lists and the route and tool inventories (the same test files Phase 0 already updated).
5. Update `test/handoff-contracts.test.ts` and `test/handoff-migration.test.ts` for the new names and columns; the new tests are written with `todo` like the rest.

### 2.5 Launcher switches

- Environment variable `MISSION_HANDOFF_LAUNCHER`. The value `0` makes the hook never ask for the launcher (the daemon is not even consulted for it). Any other value, or unset, leaves it on.
- Setting `handoff.launcher.prompt`, default `true`, registered in `src/shared/app-config-entries.ts` as `setting` and added to the `mctl config view` output in v1. It is changeable in v1 by editing the app config the same way other settings without a Settings page are changed, and through `mctl config set` in v1.1. It adds no dashboard control.
- The guided questions (Kind, Harness, After work) additionally follow `ui.guidedDispatch` (3.5). The launcher question itself follows only the two switches above.

## 3. API (stream `api`)

All routes live under `/mcp/handoff/` and require `x-harness-token` like other `/mcp/*` routes. Handlers live in `src/server/handoff/`. The operation surface header `x-mission-operation-surface` is `mcp` for the MCP server and hooks, and `cli` for `mctl`.

### 3.1 Home sessions

- `POST /mcp/handoff/sessions` (`HomeSessionRegistrationSchema`): upsert `handoff_sessions` (storing `start_source` and `entrypoint`), resolve `repo_root` from `cwd` with the existing repo resolution, return `{ repoRoot, cardDelta, launcher: { banner } }` where `cardDelta` is the full inbox for that repo and `banner` is the server-built launcher line (see 6).
- Identity, from spike S-01: the MCP child sends `CLAUDE_CODE_SESSION_ID` from its environment plus `claudePid` (its parent pid). Hooks send the `session_id` from stdin plus `CLAUDE_PID`.
- A registration whose `sessionId` is a Mission-managed session (a worker the registry knows, or any id carried by `MISSION_SESSION_ID`) is refused with 403. A worker can never become a home session (AC-API-18).
- Stale ids: the MCP child's environment is fixed at launch, so after `/clear` or `/resume` it may carry an earlier session id. When a request names a `sessionId` whose row has a `claude_pid`, and a newer registration exists for the same `claude_pid`, the API treats the newer row as the caller (AC-API-19).
- A registration with a source other than `startup` clears nothing and never makes the session eligible for the launcher.

### 3.2 Task origin

- A task created through `create_task` by a caller that resolves to a registered home session gets `origin_surface = "home-session"`, `origin_repo`, `origin_session_id`.
- A task created by `mctl run` (surface `cli`) gets `origin_surface = "mctl"`, `origin_repo`, `origin_session_id = NULL`.
- Every other path leaves all three NULL.
- `Task` (`src/shared/types.ts`) gains `origin: TaskOrigin or null`.

### 3.3 Inbox

- `GET /mcp/handoff/inbox?repo={path}&cursor={c}`: items for tasks with `origin_repo` equal to that repo and a non-null origin. Order: waiting, ready, running, queued, shelved, failed. Within a group, newest `changedAt` first.
- State mapping:
  - `waiting`: task running, and its session has a pending review of kind `input`, `plan`, `plan-decisions` or `diff`.
  - `ready`: task done with an outcome URL, or a plan published.
  - `running`: dispatching or running with nothing pending.
  - `queued`: backlog and enabled; `position` is its backlog order among queued items.
  - `shelved`: backlog and not enabled.
  - `failed`: failed or cancelled within the last 24 hours.
- `afterWork` comes from the task's `workflow_id`, labelled with the workflow's name and slug.
- `?repo` may be `*` for `mctl get tasks --all`.

### 3.4 Answers

`POST /mcp/handoff/answers` (`AnswerTaskRequestSchema`) resolves the review through the same code path as `POST /api/reviews/:id/resolve`, by building an in-process request the way `src/server/session-control.ts` does, with the actor set server-side:

- From a home session: actor `home:{sessionId}`, or `home-approval:{sessionId}` for an accepted plan approval.
- From `mctl` (surface `cli`): actor `mctl`.

Rules:

- A home-session caller must be a registered `handoff_sessions` row. Any other session id, including a worker's, is refused with 403. The actor always comes from the server; an actor in the request body is ignored (AC-API-17).
- The review's task must have `origin_repo` equal to the caller's repo, or the answer is refused with 403.
- Surface `cli` may answer only tasks with `origin_surface = "mctl"`. Anything else is 403 with `"answer this in the home session that started it"`.
- A review that is already resolved, or whose request id is stale, returns 409.
- `action: "answer"` with `option` must match one of the request's option labels, or 400.
- On success the API writes `handoff_receipts` and returns the `AnswerReceipt`. `fromWords` is the excerpt of the caller session's most recent open turn, or NULL.

### 3.5 Dispatch options (guided questions)

`POST /mcp/handoff/dispatch-options` (`DispatchOptionsRequestSchema`) returns `DispatchOptionsResponseSchema`. It is the terminal's version of the dashboard's guided pass: Repo, Kind, Harness, After work, in that order, minus the questions that do not apply, preceded by the launcher question when `entry` is `first-message`.

Source of truth. The rules that decide which kinds are offered, what each after-work default is, and when After work is skipped currently live in `src/web/components/DispatchModal.tsx` (`afterWorkForKind`) and `src/shared/task.ts`. Extract the pure rules into `src/shared/dispatch-options.ts` and have both the dashboard and this route import them. If an exact extraction is not clean, implement the rules server-side and add the parity test AC-GUIDE-07, which fails when the two disagree for any kind. Either way the dashboard's behaviour does not change.

Which questions are returned:

- Launcher: present only when `entry` is `first-message`. Three options with `value`s `work-here`, `hand-off`, `check-in`. Labels: "Work in this session", "Hand off to Mission Control", "Check in on my tasks". The Recommended option is `hand-off` when `recommendKind(brief)` is not null, otherwise `work-here`; it is listed first and its label ends with " (Recommended)". The description of `work-here` says the message will be answered normally. Choosing `work-here` ends the flow; `check-in` runs the `checkin` skill; `hand-off` continues with the questions below, using `brief` (the first message) as the brief.
- `guided: false` (Settings, Dispatch, "Guided dispatch" is off, read from `ui.guidedDispatch`): the Kind, Harness and After work questions are not returned, but the launcher question still is when `entry` is `first-message`. `defaults` carries the recommended kind, the kind's default agent and its default after work, so choosing `hand-off` goes straight to the confirm card.
- Repo: present only when `repoRoot` is null (the cwd is not inside a repo). Options are the workspace repositories, paged. The person can also type a path through the prompt's Other field.
- Kind: present when the request carries no `kind`. Options are `HANDOFF_KINDS` in `HANDOFF_KIND_ORDER`, each with the label and blurb from `TASK_KIND_INFO`, plus a final "Check in on my tasks" option. Paged by `pageOptions` (below).
- Harness: one option per harness in the registry. The recommended option is `resolveTaskAgent(kind)`, so a per-kind default set in Settings wins. Model and effort are not asked; the person can say them in the brief or when editing it.
- After work: present only when `afterWorkApplies` is true. Options, in order: the kind's default (`taskDefaultWorkflowId(kind, kindWorkflowDefaults, planStorage)`, so plan with local plan storage shows Local Plan Validation), None, then each active published workflow. Paged. The default is recommended.
- `afterWorkApplies` is false for kinds that produce no diff (scout, chat). The card says so in one line.

Recommendation. When `brief` is given and `kind` is not, `recommendedKind` is `recommendKind(brief)`; otherwise it is `DEFAULT_TASK_KIND` for a launcher entry. The recommended option is listed first and its label ends with " (Recommended)".

Paging. `pageOptions(options, size)` splits a list into pages of at most `size` (4 for `AskUserQuestion`). Every page except the last holds `size - 1` items plus a final "More..." option; the last page holds up to `size` items. When the recommended item is not on page 1, the "More..." option's description names it. A list of four or fewer is one page. With six kinds and Check in, Kind is two pages: ship, bugfix, plan, More; then scout, document, chat, Check in on my tasks.

`fallbackText`: the same questions as plain numbered lists, in the same order, for sessions where `AskUserQuestion` is unavailable (`claude -p`, SDK, Pi, older builds). It ends with "Reply with a number."

`banner` is the one-line notice printed at session start (section 6).

The route also answers the cwd question: `repoRoot` comes from the existing repo resolution for `cwd`, and is null outside a repo.

## 4. Turn log and plan approval (stream `api`)

### 4.1 Turn log and launcher offer

- `POST /mcp/handoff/turns/open` (`TurnOpenSchema`) returns `TurnOpenResponseSchema`:
  - closes any open turn for the session
  - inserts a row with `excerpt` = the first 120 characters of `prompt` (whitespace collapsed), `contains_approval = containsApproval(prompt)`, and `mentioned_hashes` = any 6-hex tokens in `prompt`
  - returns `cardDelta` for the session's repo: `full` is the items not yet shown to this session at their current `changedAt`, and `reminders` is the waiting items already shown
  - records every `full` item's key, state and plan `revisionHash` in `cards_shown`
  - never stores `prompt` anywhere
  - returns `launcher.offer = true`, and sets `launcher_offered_at`, only when all of these hold: the session's `start_source` is `startup`; its `entrypoint` is the interactive value (spike S-06, candidate `cli`); `launcher_offered_at` is NULL; this is the session's first turn; the setting `handoff.launcher.prompt` is true; the prompt, trimmed, is not empty and does not start with `/`; the session is a registered home session (never a worker). Otherwise `offer` is false and `launcher_offered_at` is left as it was.
- `POST /mcp/handoff/turns/close` (`TurnCloseSchema`): sets `closed_at` and the session's `last_stop_at`.
- `SessionStart`'s card counts as shown in a synthetic turn with an empty excerpt. The synthetic turn is not the first turn for the purpose of the launcher offer.
- Rows older than 7 days are deleted at daemon start and once a day.

### 4.2 Plan approval

`approve_plan` is accepted only when all of these hold. Otherwise it returns 409 with a message the model can show:

1. `revisionHash` equals the plan's current revision hash. If not: `"the plan changed; show the new revision before approving"`.
2. A turn of this session, opened before the current open turn, shows that `revisionHash` in `cards_shown`. If not: `"show the person the plan card first"`.
3. A turn of this session, opened after that card turn, has `contains_approval = 1`. If not: `"ask the person to say approve"`.

An accepted approval resolves with actor `home-approval:{sessionId}`. Update `loadHumanResolvedReviews` (`src/server/db.ts`) and `approval()` (`src/server/plans/publication.ts`) so `home-approval:` counts as a human approval for plan publication. `session:` (delegated control) and plain `home:` must still not count.

### 4.3 `containsApproval`

- True when the text, lowercased, contains `approve`, `approved`, `yes, publish` or `publish it` as whole words.
- False when one of `not`, `don't`, `dont`, `do not`, `never` appears within three words before the match.

## 5. MCP tools (stream `mcp`)

In `src/mcp/handoff-tools.ts`.

- `read_inbox`: no required args. Calls the inbox route with `cwd` = `process.cwd()`. Returns text grouped as "Waiting on you", "Ready", "Running", "Queued", "Shelved", "Failed", with each question quoted exactly, plus the structured JSON.
- `answer_task`: arguments mirror `AnswerTaskRequestSchema` without caller fields. Returns the receipt line as text. The description states:
  - send only what the person said
  - quote nothing you were not told
  - for plans, show the plan card and wait for the person to say approve
- `read_dispatch_options`: arguments `{ kind?: string, brief?: string, entry?: "command" | "first-message" | "conversation" }`. Calls the dispatch-options route with `cwd` = `process.cwd()`. Returns the `questions` array as JSON in the shape `AskUserQuestion` takes (header, question, options with label and description), the `value` behind each label, `defaults`, `afterWorkApplies`, `guided`, and `fallbackText`. The description states: ask exactly these questions, one at a time, in this order; do not add, reword or reorder options.
- `create_task` description: the kind parameter's description is generated from `KIND_HINTS`, one line per kind (`bugfix: fix, repair, broken ...`). Unchanged for workers.
- `create_task` result: adds `afterWork: { slug, label }` or null and `kindLabel`, resolved by the server with the same resolution the task will dispatch with.
- `create_task` does not gain `grillFirst` or `personaId`. Grill me first is not offered from the terminal.
- Home-session identity: send `sessionId` from `CLAUDE_CODE_SESSION_ID` and `claudePid` (parent pid) per spike S-01. When `MISSION_SESSION_ID` is set (a Mission Control worker), the MCP server sends no home-session identity, and `read_inbox`, `answer_task` and `read_dispatch_options` refuse with "not available inside a Mission Control worker".

## 6. Hooks and status line (stream `hooks`)

`hooks/handoff-hook.mjs {Event}`, bundled to `dist/satellites/handoff-hook.mjs`. It reuses `readStdin`, `readClientToken` and `BASE_URL` from `src/shared/hook-bridge.mjs` and `src/shared/harness-runtime.mjs`.

Rules for every event:

- The API call has a 300 ms timeout. On timeout or any error, print nothing and exit 0.
- Always exit 0. Never print `decision: "block"`.
- If `MISSION_HEADLESS` is set, do nothing (existing meaning).
- If `MISSION_SESSION_ID` is set (a Mission Control worker), do nothing. No registration, no turn log, no banner, no launcher (AC-HOOK-12).
- Output is one JSON object: `systemMessage` for the one-line notices, and `hookSpecificOutput.additionalContext` for full details the model needs. Omit keys that have nothing to say; print nothing at all when both are empty.

Per event:

- `SessionStart`:
  - POST `/mcp/handoff/sessions` with the input's `source` and the environment's entrypoint; render the card delta as one summary card in `additionalContext`
  - notice: when `source` is `startup` or `clear`, print the server's `launcher.banner` as `systemMessage`. When the launcher will be offered the banner says so, for example `mission-control: I will ask how you want to start. /mc opens the picker any time.` When the launcher is off it lists what can be handed off, for example `mission-control: hand work off with /mc - ship, bugfix, plan, scout, document, chat`. When the inbox has items, append the counts: `... | 2 running, 1 waiting`. Not printed for `resume` or `compact`. The kinds in the line come from the server, never from the hook.
  - `additionalContext` also tells the model: when the person asks to hand work to Mission Control, use the `handoff` skill; `/mc` opens the picker
  - if the API is unreachable and the instance is launchd-managed, start `/bin/launchctl kickstart gui/{uid}/{label}` detached and print `mission-control: starting in the background`
  - if `/api/health` lacks capability `handoff-v1`, or its version differs from the plugin's, print `mission-control: plugin {a} and API {b} don't match. Run: mctl setup`
- `UserPromptSubmit`: if `MISSION_HANDOFF_LAUNCHER` is `0` the hook skips the launcher step but still logs the turn. POST `/mcp/handoff/turns/open` with the prompt.
  - If `launcher.offer` is true, put the launcher instruction in `additionalContext`: before doing anything else, call `read_dispatch_options` with `entry` `first-message` and the person's message as `brief`, ask the returned launcher question with `AskUserQuestion`, then follow the `handoff` skill's first-message entry. Keep the person's message; do not start the work until they answer. If they choose Work in this session, answer the message normally.
  - For each `cardDelta.full` item, a `systemMessage` line such as `mission-control: mc-91c2 asks a question (logging cleanup)`, and the full question, options and an instruction to show it in `additionalContext`.
  - For reminders, one line: `mission-control: reminder, mc-91c2 still waiting`.
  - When both a launcher offer and a waiting question exist, the question card comes first in the context and the launcher instruction last.
- `Stop`: POST `/mcp/handoff/turns/close`. Print nothing.
- `PostToolUse` with matcher `.*answer_task`: read the receipt from `tool_response` and print it as `systemMessage` with the `mission-control: ` prefix.

Status line: extend `hooks/harness-statusline.mjs` to append one segment after the inner command's output.

- Format: `● mc 2 running · 1 waiting · 1 queued`, `● mc 1 ready · PR #212`, `● mc 3 of 3 busy · 1 queued`, `○ mc offline`. A shelved item counts as `1 shelved` after queued. Show nothing when the repo has no items.
- It reads a cache file `{stateDir}/handoff/statusline/{sha1(repoRoot)}.json` written by the API whenever that repo's inbox changes, so rendering never waits on HTTP.
- If the cache file is missing, the API is down (no successful health check recorded in the last 30 s) and the instance is installed, show `○ mc offline`.

## 7. Plugin and skills (stream `plugin`)

### 7.1 Layout (`plugin/`, built to `dist/claude-plugin/`)

```
.claude-plugin/plugin.json   name "mission-control", version = package.json version
hooks/hooks.json             SessionStart, UserPromptSubmit, Stop, PostToolUse(.*answer_task)
                             command: node "${CLAUDE_PLUGIN_ROOT}/satellites/handoff-hook.mjs" {Event}
.mcp.json                    mission-control: node "${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"
satellites/handoff-hook.mjs  copied from dist
mcp/server.mjs               copied from dist
skills/handoff/SKILL.md
skills/checkin/SKILL.md
commands/mc.md
```

`scripts/build-claude-plugin.mjs` assembles it from `plugin/` plus built bundles, and writes the instance-neutral env: hooks and MCP read `MISSION_HOME` and `MISSION_PORT` from the environment that `mctl ... claude` or the installed settings provide.

### 7.2 Skill `handoff`

Must contain these sections, in this order:

1. When to use. Trigger phrases: "hand this off to mission control", "send this to mc", "have mission control fix", "design this with mission control", "delegate", "queue that for later", the `/mc` command, and the launcher instruction a hook adds to the first message of a session.
2. Three entries. **First-message entry** (the hook said to ask the launcher question): call `read_dispatch_options` with `entry` `first-message` and the person's message as `brief`, ask the launcher question first, and do nothing else until it is answered. Work in this session: answer the person's message normally and never mention Mission Control again unless asked. Check in: run the `checkin` skill. Hand off: continue with section 3, using the first message as the brief (if it is empty or only a greeting, ask the person to describe the task). **Launcher entry** (`/mc`, no brief yet): ask the questions first, then ask the person to describe the task, then draft the brief. **Conversation entry** (the work is already described): draft the brief first, pass it as `brief` so the server can recommend a kind, then ask the questions with `entry` `conversation`. All three end at section 6.
3. Ask the guided questions. Call `read_dispatch_options`. If `guided` is false, skip to section 5 with the defaults. Otherwise ask each returned question with `AskUserQuestion`, one at a time, in the returned order, using the returned labels and descriptions unchanged. Map the answer back to the option's `value`. If the person types an Other answer, match it to an option label ignoring case, otherwise ask again. If "More..." is chosen, show the next page. If "Check in on my tasks" is chosen, stop and run the `checkin` skill. After Kind, call `read_dispatch_options` again with the chosen `kind` to get Harness and After work. If `AskUserQuestion` is not available, print `fallbackText` and wait for a number.
4. Gather what is known: files, errors, reproduction commands, decisions, stated limits.
5. Write the brief with the template for the kind: bugfix, plan, ship, scout, document, chat.
6. Call `create_task` (never `dispatch_task`) with the chosen kind, agent and `workflowId` (omit for the kind default, null for None). Show the card using the returned `kindLabel` and `afterWork`, with the repo and harness. Then ask one confirm question with `AskUserQuestion`: Dispatch now, Add to backlog, Edit brief, Cancel.
7. Act on the answer: Dispatch now calls `dispatch_task`; Add to backlog does nothing more; Edit brief rewrites and shows the card again; Cancel calls `delete_task`. Typing "go" means Dispatch now.
8. Rules:
   - never call `dispatch_task` without Dispatch now or the person's "go"
   - never invent, reword or reorder options the server returned
   - never start the person's work before the launcher question is answered
   - one task per named thing
   - ask one question if the request is too vague to brief
   - never put secrets, tokens or customer data in a brief
   - never offer Grill me first

### 7.3 Skill `checkin`

Sections:

1. When to use: "how are my tasks", "anything waiting on me", "what did mission control finish", a hook saying a question is waiting, or Check in chosen from the launcher.
2. Call `read_inbox`; present groups in the order the tool returns.
3. Quote each worker question exactly, with its options.
4. Map the person's reply to an option. If unclear, ask instead of guessing.
5. Call `answer_task`. The receipt line appears on its own; do not restate it.
6. Plans: show summary, revision and link. Approve only after the person says approve. If the reply is lukewarm ("looks fine i guess"), ask "Say approve to publish rev N, or tell me what to change."
7. Rules:
   - never answer on the person's behalf
   - never reword a question
   - one answer per question

### 7.4 Command `/mc`

Optional shortcuts; the launcher no longer needs them.

- `/mc` with no arguments runs the `handoff` skill's launcher entry.
- `/mc {kind} {text}` is the fast path: `{kind}` is any `HANDOFF_KINDS` value. Kind is answered, `{text}` is the brief, and the questions start at Harness.
- `/mc check` runs the `checkin` skill.
- `/mc {taskId}` shows one task: brief, after-work step, PR and cost.
- An unknown first word is treated as the start of the brief, not as an error.
- A first prompt that starts with `/` never triggers the first-message launcher (4.1), so `/mc` and other commands are never asked twice.

## 8. `mctl` (stream `mctl`)

`src/cli/`, entry `src/cli/index.ts`, bundled to `dist/cli/mctl.mjs`. It shares an HTTP client with the MCP server: move the request helper used by `src/mcp/server.ts` into `src/shared/handoff-client.ts` only if it has no `node:` imports, otherwise into `src/cli/client.ts` and import it from both.

### 8.1 Global flags

- `--instance {name}`, or env `MCTL_INSTANCE`. Default is the default instance (section 9).
- `--json` on every read command.

### 8.2 Commands

| Command | Behavior |
|---|---|
| `get tasks` (alias `ls`) `[--all] [--state {s}]` | Table `ID STATE KIND TITLE AGE COST` for this repo's origin tasks, from the inbox route. |
| `describe {id}` | Brief, kind, after work and current step, PR, cost, origin, and any pending request. For a home-session task the request ends with `answer this in your home session`. |
| `logs {id} [-f]` | The worker's conversation from the existing transcript route. `-f` follows the existing transcript stream (`/api/sessions/:id/transcript/stream`), and `/events` SSE for the task's state, until the task is terminal or Ctrl-C. Never polls. |
| `status [--watch]` | Counts by state, slots used of the ceiling, API version, Foreman leader present. `--watch` redraws on SSE events. |
| `get kinds` | `KIND HINT WORDS AFTER WORK`, using current settings. |
| `get workflows` | Workflows by slug and id, and the kinds that default to each. |
| `config view` | Slot ceiling, notification settings, After work per kind, and `handoff.launcher.prompt`. |
| `run` | See 8.3. |
| `setup`, `doctor`, `daemon status\|restart\|kick`, `uninstall [--purge]`, `claude [args]` | See section 9. |
| `attach {id}` (v1.1) | See 12.1. |
| `config set {key} {value}` (v1.1) | See 12.3. |

### 8.3 `mctl run`

```
mctl run ({prompt} | -f {file}) [--kind k] [--after-work w] [--agent a]
         [--model m] [--effort e] [--permission-mode p] [--repo path]
         [--depends-on id]... [--priority p] [--label l]... [--shelve]
         [--dry-run] [--watch] [--json]
```

- There is no stdin brief. A bare `-` exits 2 with usage, because reading a piped brief would conflict with the TTY rule below (operator decision, 2026-11-18).
- `mctl run` does not run the guided questions. It is the scripted path: flags in, task out. The guided questions belong to the Claude session. (`--grill` is removed with the terminal Grill me first decision.)
- Refuses with exit 2 unless stdin is a TTY: `mctl run needs an interactive terminal. Agents: use the mission-control MCP tools.`
- `--kind` defaults to `DEFAULT_TASK_KIND`. An unknown kind exits 2 and lists the kinds. `--task` is an alias.
- `--after-work` accepts a workflow slug, a workflow id, `{id-or-slug}@{version}` to pin a version, or `none` (prints `warning: no review will run after this task`). It is resolved by the server; an unknown value exits 2 and lists workflows.
- `--model`, `--effort` and `--permission-mode` are validated against the harness registry (`harnessFor(agent)`); invalid values exit 2.
- It calls the same create route as `create_task` with surface `cli`, then the dispatch route, unless `--shelve` is set.
- `--dry-run` resolves and prints kind, after work, agent, model and repo, creating nothing.
- Prints the header line `{id}  {kind} · after work: {slug} · {agent} {model} · {repo}`.
- `--watch` prints one timestamped line per stage change: `starting`, `working`, `waiting`, `reviewing {slug} · step n of m`, `ready`, `failed`. For a `waiting` question on an `mctl`-origin task, it prompts inline, as `1. Keep   2. Delete   (enter to skip)`, and sends the answer through `/mcp/handoff/answers`.
- Exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | ready or done |
  | 1 | failed |
  | 2 | usage error, or cancelled |
  | 3 | an `mctl`-origin question is waiting and its prompt reached end of input (stdin closed or Ctrl-D); nothing was answered |
  | 4 | refused at dispatch |
  | 130 | Ctrl-C, including at a prompt (detach; the task keeps running) |

  Cancelled exits with code 2, the same as a usage error. Distinguish them by the message.

## 9. Instances and setup (stream `setup`)

### 9.1 Instance resolution (`src/cli/instance.ts`)

| | Default instance | Named instance `{n}` |
|---|---|---|
| State folder | `stateDir()` as today | `~/.mission-control-instances/{n}` |
| Port | `PORT` (7317 unless `MISSION_PORT`) | stored in `instance.json`; first free port from 7417 at setup |
| launchd labels | `com.mission-control.daemon`, `com.mission-control.foreman` | `com.mission-control.daemon.{n}`, `com.mission-control.foreman.{n}` |
| Claude config | the user's default (`CLAUDE_CONFIG_DIR` or `~/.claude`) | `{state}/claude` |
| Plugin mode | installed through `claude plugin` | installed through `claude plugin` into the instance's config folder (spike S-02 proved it isolated) |

- Names match `[a-z][a-z0-9-]{0,30}`. `default` is reserved.
- `instance.json` records `{ name, port, claudeConfigDir, labels, pluginMode, runtimeRoot, createdAt }`. `pluginMode` is `installed`, or `plugin-dir` only when the person passes `--plugin-dir-mode` to setup as a manual override.
- `runtimeRoot` is the checkout whose `dist/` the services run.

### 9.2 `mctl setup`

- Requires `dist/server/index.mjs`, `dist/server/foreman-worker.mjs` and `dist/claude-plugin/`. If any is missing, exit 2 with `run npm run build first`.
- Copies `dist/claude-plugin/` to `{state}/plugin/{version}/`, so a later rebuild cannot break running sessions.
- Writes two LaunchAgent plists, daemon and Foreman. Both have `RunAtLoad` and `KeepAlive`, logs in `{state}/`, and `EnvironmentVariables` `MISSION_HOME`, `MISSION_PORT` and `CLAUDE_CONFIG_DIR` (named instances only). They run `node` on `{runtimeRoot}/dist/server/index.mjs` and `{runtimeRoot}/dist/server/foreman-worker.mjs`.
- Loads them with `/bin/launchctl bootstrap gui/{uid} {plist}`.
- A named instance never unloads, edits or reads any other label, including the legacy labels `scripts/install-service.mjs` removes.
- Default instance only: if another process holds the state folder's `daemon.lock` (for example the desktop app), refuse with the owner's pid and the line `the desktop app is running Mission Control; quit it or use --instance`.
- Plugin: runs `claude plugin marketplace add {state}/plugin` and `claude plugin install mission-control@mission-control-local` with that instance's `CLAUDE_CONFIG_DIR`.
- Status line: wraps `statusLine` in that config folder's `settings.json` with the same JSONC surgical edit and `statusline-inner` sidecar `hooks/install.mjs` uses, pointing at the copied status line script.
- Duplicates, default instance only: if `settings.json` already has Mission Control hook groups (`isMissionHookCommand`) or `~/.claude.json` has a user-scope `mission-control` MCP server, back up both files to `{state}/backups/{timestamp}/`, then remove those entries so only the plugin's copies run. Print what moved and where the backup is.
- Idempotent: running setup twice changes nothing the second time.

### 9.3 Other commands

- `mctl claude [args]`: execs `claude` (located through the executable registry) with:
  - `MISSION_HOME`, `MISSION_PORT`, and `CLAUDE_CONFIG_DIR` (named instances)
  - `--plugin-dir {state}/plugin/{version}` only in `plugin-dir` mode
  - the launcher prompt: when stdin and stdout are TTYs, the user passed no prompt argument and no `-p`, `--print` or `--resume`/`--continue`, and `--no-launcher` is absent, the first positional argument is `/mc` so the picker opens the moment Claude starts, with no typing (spike S-05 decides the exact spelling; fallback `/mission-control:mc`). Because it starts with `/`, it never triggers the first-message launcher a second time (4.1).
  - the remaining args passed through
- `mctl doctor`: one line per check, `✓` or `✗` with a fix:
  - API reachable
  - capability `handoff-v1`
  - plugin version equals API version
  - Foreman leader heartbeat within 30 s
  - status line wrapped
  - no duplicate hooks or MCP registration
  - launchd labels loaded

  Exit 1 if any check fails.
- `mctl daemon status`: labels, pids, port and log paths.
- `mctl daemon restart`: `/bin/launchctl kickstart -k` both labels.
- `mctl daemon kick`: `kickstart` without `-k`.
- `mctl uninstall`:
  - `bootout` both labels and delete their plists
  - restore the status line from its sidecar
  - remove the plugin (`claude plugin uninstall`)
  - `--purge` also deletes the instance folder, named instances only
  - never touches another instance

### 9.4 Workers inherit the instance

`agentSubprocessEnv` (`src/server/agent-subprocess-env.ts`) passes `CLAUDE_CONFIG_DIR` through to every harness child, so a named instance's workers use the instance's Claude config. Add it only if it is not already passed.

Because those workers load the instance's plugin, the hook and MCP server must recognise them and stay silent (rule in section 6, AC-HOOK-12, AC-API-18).

## 10. Integration (Phase 2, stream `integration`)

- A full-loop test that spawns the real daemon (pattern: `test/settings-backup-daemon.test.ts`) with fake agent binaries. It drives the source MCP server as a home session, and runs the hook script with prompts. Steps:
  1. register the home session with source `startup` and the interactive entrypoint; the hook prints the notice
  2. the first `UserPromptSubmit` returns the launcher instruction; `read_dispatch_options` with `entry` `first-message` returns the launcher question; the test plays the model and answers Hand off, then kind, harness and after work
  3. `create_task` with those answers and the first message as the brief, then the confirm, then `dispatch_task`
  4. a second `UserPromptSubmit` in the same session returns no launcher instruction
  5. the fake worker calls `request_input`
  6. a `UserPromptSubmit` hook run outputs the question
  7. `answer_task` returns a receipt
  8. the fake worker receives the answer and finishes
  9. the inbox shows `ready`
- Worker identity test: the same hook and MCP server run with `MISSION_SESSION_ID` set register nothing and print nothing.
- Isolation test: with a temp `HOME` that contains a fake default `~/.mission-control`, `~/.claude/settings.json`, `~/.claude.json` and a fake LaunchAgents folder, run `mctl --instance sandbox setup`, then `uninstall --purge`. Assert every default file is byte-identical, and that the fake runner never saw a default or legacy label.
- Dashboard parity: the existing e2e guided-dispatch specs pass unchanged after the shared extraction.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` pass.

## 11. Docs (Phase 2, stream `docs`)

- `docs/headless-mode.md`, in plain English:
  - an opening notice that this is a spike and alpha code on `feat/headless-mode-spike` (AC-DEL-04)
  - what it is
  - install
  - instances and the sandbox
  - the launcher: when it asks, when it does not, and how to switch it off
  - the guided questions, and how they match the dashboard
  - the home session flow
  - each hook and what it shows
  - each skill
  - the `mctl` reference
  - the plan approval rule
  - what the turn log stores
  - security limits: ordinary answers are not proven human; starting a task is gated by the skill and a confirm, not the server; the machine token is shared with any local process
- Linked from `docs/README.md` and `README.md`.
- `docs/dispatch-and-backlog.md` gets one paragraph pointing to the terminal version of the guided pass.
- `docs/security.md` gains a section "Home-session answers and plan approvals".
- `docs/configuration.md` lists `handoff.launcher.prompt`, `MISSION_HANDOFF_LAUNCHER`, and says Guided dispatch also governs the terminal questions.
- The docs link checker test passes.

## 12. v1.1

### 12.1 `mctl attach {id}` (stream `attach`)

- Refuses without a TTY, and for a task whose session is not an SDK session.
- Prints `This hands the worker to this terminal. It will not go back to the background. Continue? [y/N]` and stops unless the answer is `y`.
- Adds a terminal home kind `foreground` in `src/server/terminal/`:
  - `mctl attach` registers its own tty and pid with the API before it `exec`s the resume command the existing handoff builds (`src/server/sdk/handoff.ts`)
  - the transfer coordinator accepts the successor when its pid and tty match that registration
- Completes the transfer within 10 s in the test with a fake `claude`.

### 12.2 Desktop notifications (stream `notify`)

- `src/server/handoff/notifier.ts`, started from `src/server/index.ts`.
- It notifies once per question when all of these hold:
  - the task has origin `home-session` or `mctl`
  - a `waiting` request is older than `notifyAfterMinutes` (default 5)
  - the origin session's last turn is closed, and closed at least `notifyAfterMinutes` ago
  - no dashboard event-stream client is connected (the desktop app already alerts)
- Delivery: `/usr/bin/osascript -e 'display notification "{body}" with title "Mission Control"'`. osascript is already in `FIXED_OS_EXECUTABLES`.
- Never for ready, running, queued or shelved items.
- Settings: `handoff.notifications.enabled` (default true) and `handoff.notifications.afterMinutes` (default 5), registered in `src/shared/app-config-entries.ts` as `setting`.

### 12.3 `mctl config set` (stream `config-set`)

- Allowlist:
  - `foreman.maxSessions`
  - `handoff.notifications.enabled`
  - `handoff.notifications.afterMinutes`
  - `handoff.launcher.prompt`
  - `workflow.kindWorkflowDefaults.{kind}`
  - `ui.guidedDispatch`
- Values are written through the same daemon route and schema the Settings page uses.
- Prints `old -> new` and asks `[y/N]`. Refuses without a TTY.
- An unknown key exits 2 and lists the allowed keys.

## 13. Test rules for this feature

- Run one file with `node --test --import ./test/setup-state.mjs --import tsx test/{file}.test.ts`.
- Set the test home above dynamic imports (`process.env.MISSION_HOME = mkdtempSync(...)`, then `await import(...)`).
- HTTP: `buildApp(...)` and `app.request(path, { headers: { "x-harness-token": ensureToken() } })` (see `test/mcp-create-task.test.ts`).
- MCP: spawn the source `src/mcp/server.ts` with `StdioClientTransport` against `buildApp` served on port 0 (see `test/mcp-backlog-tools.test.ts`).
- Hooks: `execFile(process.execPath, [hook, event])` with stdin JSON and a stub HTTP server (see `test/hook-script-decision.test.ts`). Set `MISSION_HEADLESS: ""`, `MISSION_SESSION_ID: ""` and `MISSION_HANDOFF_LAUNCHER: ""`.
- Workers: a fake SDK handle (`test/mission-session-closure.test.ts`) or fake binaries through `MISSION_CLAUDE_BIN` (`test/claude-sdk-process.test.ts`).
- A real daemon spawn calls `ensureNativeStateLockAddon` at module scope.
- CLI: `spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...])`, plus direct calls to exported command functions with an injected `isTTY`, `stdout` and command runner.
- Skills and the command are text. Test them structurally (frontmatter, section headings, named tools, forbidden phrases); never by running a model.
- Test titles start with the AC ID: `test("AC-API-03 waiting items come first", ...)`.
- New test files: `test/handoff-{area}.test.ts`.

## 14. Out of scope

- Visible dashboard UI changes.
- Pi-specific behavior beyond what the shared hook format and `fallbackText` already give.
- The pipeline kind, model and effort questions, extra-repo, dependency and persona questions in the guided flow (the person can state them in the brief or the Edit brief step).
- Grill me first from the terminal.
- MCP elicitation (spike S-04), until a later change.
- A prompt on open for plain `claude` with no typing at all (spike S-06 part b), until Claude Code supports it. `mctl claude` provides it today.
- Merging the spike branch to `main`, a release, or compatibility promises for alpha contracts.
- Slack, spending budgets, Linux services.
- Proving that an ordinary answer was typed by a person, or a server gate on dispatch.

## 15. Streams and order

All streams commit to `feat/headless-mode-spike`, in this order (AC-DEL-05).

| Stream | Owns | Needs |
|---|---|---|
| `contracts` | 2.1 to 2.5 | none |
| `api` | 3, 4 | contracts |
| `guided` | 3.5 and the shared extraction | contracts; can run beside `api` |
| `mcp` | 5 | contracts, `api`, `guided` |
| `hooks` | 6 | contracts, `api` |
| `plugin` | 7 | `mcp`, `hooks` |
| `mctl` | 8 | `api` |
| `setup` | 9 | `plugin` |
| `integration`, `docs` | 10, 11 | all of v1 |
| `attach`, `notify`, `config-set` | 12 | v1 |

## Spike results

Run on 2026-11-18 with Claude Code v2.1.327 on macOS. Probe code lives outside the repo.

### S-01: yes

A plugin's stdio MCP server knows its session. With `claude --plugin-dir {probe}` and no prompt:

- The MCP server's environment had `CLAUDE_CODE_SESSION_ID`, equal to the `session_id` the `SessionStart` hook read on stdin. It also had `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT`.
- The hook's environment had the same `CLAUDE_CODE_SESSION_ID`, plus `CLAUDE_PID` (the `claude` process). The MCP server's environment did not have `CLAUDE_PID`.
- Both processes' parent was the same `claude` pid.
- `tools/call` requests carried `_meta["claudecode/toolUseId"]`, not a session id.

Use `CLAUDE_CODE_SESSION_ID` from the MCP server's environment, with parent pid plus cwd as a cross-check. Not tested: whether the MCP server is restarted after `/clear` or `/resume`. Its environment is fixed at launch, so after `/clear` it may carry the earlier session id. Hooks always have the current `session_id` on stdin, so the API treats the latest hook registration for the same `claudePid` as current (3.1, AC-API-19).

### S-02: yes

With `CLAUDE_CONFIG_DIR` set to a fresh folder `{CFG}`:

- `claude plugin marketplace add {dir}` wrote `{CFG}/settings.json` (`extraKnownMarketplaces`, source `directory`), `{CFG}/plugins/known_marketplaces.json`, `{CFG}/.claude.json` and a backup under `{CFG}/backups/`.
- `claude plugin install {name}@{marketplace}` wrote `{CFG}/plugins/installed_plugins.json` (scope `user`), copied the plugin to `{CFG}/plugins/cache/{marketplace}/{name}/{version}/`, and set `enabledPlugins` in `{CFG}/settings.json`.
- `claude plugin list` under `{CFG}` showed only the new plugin. None of the plugins enabled in the real `~/.claude/settings.json` appeared. No file under `~/.claude`, and not `~/.claude.json`, changed.
- Hook isolation is inferred: user hooks live in the same `settings.json` that was not read. No session was started under `{CFG}`, because that needs a sign-in.

Config-folder install is isolated, so the `--plugin-dir`-only fallback is not needed.

### S-03: yes

One prompt that made one MCP tool call. A `systemMessage` from `UserPromptSubmit` showed in the transcript as `UserPromptSubmit says: {text}`. A `systemMessage` from `PostToolUse` showed as `PostToolUse:{tool name} says: {text}`. Both were visible to the person without the model repeating them. `UserPromptSubmit` input had `prompt_id` and `prompt`. Hooks still emit the `additionalContext` instruction as section 6 says, because Pi and older Claude Code builds were not tested.

### S-04, S-05 and S-06: open

None needs to block a stream. Record the answers here after one interactive run each. S-06 part (a) must be answered before the first-message launcher is enabled by default; until then the entrypoint check accepts only the candidate interactive value, so an unknown value never prompts.
