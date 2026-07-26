# Phase 4: the Codex driver (app-server)

## Outcome

The Harnesses toggle appears for Codex; flipping it makes the next dispatched Codex
session run over `codex app-server` JSON-RPC: approvals arrive as answerable requests on
the card, threads resume across daemon restarts, approval policy, reviewer, and effort
apply as per-turn overrides, and the automation machinery from phase 3 (if merged) drives
it with no Codex-specific edits. The sandbox is fixed for the life of a thread.

## Entry criteria and dependencies

- Direct prerequisite: phase 2 merged (supervisor, dispatch branch, toggle, answer
  routing).
- Runs concurrently with phase 3 (disjoint files; either merge order). If this merges
  first, Codex SDK sessions are in the same interim state Claude's were after phase 2
  (reviewable, answerable, queue-refused) - phase 2's interim refusal is runtime-scoped,
  not agent-scoped, so it covers Codex automatically until phase 3 lands.

## Scope

In: the app-server adapter + generated bindings, approval/request projection, permission
and effort mapping, `clearContext` as thread replacement, resume, MCP config, capability
flips, handoff argv for Codex.

Non-goals: the official `@openai/codex-sdk` (rejected - resolved decision); launch-scoped
hook injection for app-server sessions (the event stream supersedes it); any Foreman
edit (phase 3 owns that machinery, runtime-generically).

## Repository findings and inherited contracts

Inherits C1-C9 (C9 if phase 3 has merged; otherwise the interim refusal). Findings:

- **Transport (C10)**: one `codex app-server` subprocess per session, spawned from
  the same resolved Codex binary spec as a terminal dispatch, stdio JSONL JSON-RPC 2.0,
  `initialize` handshake (use `optOutNotificationMethods` to drop delta noise we do not
  consume). Per-session subprocess buys crash isolation and per-session `-c` config
  scoping; revisit only if spawn cost is measured to matter. Strip inherited
  `TMUX_PANE`, `WEZTERM_PANE`, and `TERM_PROGRAM` before spawning, matching the first
  driver's attribution guard.
- **Bindings**: `codex app-server generate-ts --out <dir>` against the pinned binary;
  commit under `src/server/harness/codex/app-server/` with the generating version
  recorded in the module. The protocol is experimental - drift is absorbed by
  regenerating on a Codex version bump, and by the adapter being its only consumer.
- **Approvals**: v2 `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval` server-to-client requests, answered
  accept/accept-for-session/decline. Project `item/tool/requestUserInput` requests into
  the same question form rather than depending on a terminal menu.
- **Rollouts still written** (`~/.codex/sessions/`): `codexTranscript.locate` and
  `codexUsage` keep working for SDK sessions once `agentSessionId` (the thread/rollout
  id) is bound - C5's read-path guarantee. Verify `locate` finds a rollout by thread id
  for an app-server session.
- **Codex hook overrides** (`prepareCodexLaunch`) are argv for TUI launches; app-server
  sessions do not take them - `hooksSeen` comes from C5's bind, and `codexHooks`'s
  `scope: "launch"` semantics are unaffected for terminal sessions.
- **Permission modes**: `PermissionMode`'s Codex values
  (`askForApproval` / `approveForMe` / `fullAccess` / `readOnly`) map to
  approval-policy + reviewer + sandbox triples. `askForApproval` and `approveForMe`
  are both `on-request` + `workspace-write`; the reviewer (`user` or `auto_review`)
  distinguishes them. `fullAccess` is `never` + `danger-full-access`, and `readOnly`
  is `on-request` + `read-only`. Approval policy and reviewer apply on the next turn,
  but a live thread cannot change sandbox, so refuse a profile requiring a different
  sandbox. The auto-dispatch posture reuses `prepareCodexLaunch`'s existing
  `workspace-write` + `on-request` choice and routes approvals to the user. Keep the
  mapping table inverse to `parseRolloutPermissionModeRead`, which renders the card chip.

## Implementation steps

1. **Bindings module**: generate, commit, and version-stamp the TS bindings; a thin
   typed JSON-RPC client (request/response correlation, server-to-client request
   dispatch, notification fanout) over an injectable transport (scripted-frames
   testable, the C4 seam).
2. **`src/server/harness/codex/sdk.ts`**:
   - `launch(opts)`: spawn `codex app-server`, initialize, `thread/start` with cwd,
     model and mapped sandbox/approval posture, MCP via
     `-c mcp_servers.mission-control.*` spawn config (reuse `mission-mcp.ts`'s
     descriptor rendering - all three keys or none, the existing rule);
     `turn/start` with `opts.prompt`, model, effort, approval policy, and reviewer.
     `thread/started` → `bound` (thread id as `agentSessionId`).
   - Item/turn notifications → `state` / activity ticker / `turn_done` (token usage).
   - Approval requests → C3 projection (`kind: "approval"`, command or diff summary as
     prompt, accept/accept-for-session/decline options); `answer()` responds to the
     JSON-RPC request.
     Track pending approvals so an expired/superseded answer 409s like a changed pane
     menu.
   - `send()` → `turn/start` (or `turn/steer` when a turn is in flight - measured
     behavior, verify); `interrupt()` → `turn/interrupt`; `setPermissionMode` → store +
     apply approval/reviewer on subsequent `turn/start` calls, refusing a different
     sandbox rather than reporting it applied;
     `setEffort` and `setModel` → per-turn overrides; `clearContext()` → new
     `thread/start` on the same card, re-emit `bound` with the new thread id (the registry
     rebind path from phase 2 handles rotation).
   - `pr_created`: watch command-execution items for `opensPullRequest` matches - same
     evidence rule as Claude's.
   - Subprocess exit → `exited { resumable: true }`; resume path uses `thread/resume`.
3. **Capability flips**: codex `runtimes: ["terminal", "sdk"]`,
   `HARNESSES.codex.sdk = codexSdk` (C4 contract test moves them together). The panel
   control appears with no panel edit (it folds over `runtimes`).
4. **Handoff**: implement `SdkSpec.resumeArgv(threadId)` as `["resume", threadId]`
   (verify the exact argv against the pinned binary; the TUI picker's
   `--include-non-interactive` concern does not apply to a direct id resume). The phase 2
   route prepends `resolveAgentBin("codex")` without a Codex-specific branch.
5. **Supervisor**: no structural change - the Codex adapter slots behind `SdkSpec`.
   Verify restore relaunches app-server + `thread/resume` cleanly.
6. **Tests**: `codex-sdk-adapter.test.ts` on scripted JSON-RPC frames (handshake,
   thread/start config assembly, approval → request → answer → response,
   steer-vs-start choice, clearContext rotation, resume), mode-mapping table test,
   bindings smoke (generated module imports and typechecks), handoff argv test,
   `harness-sdk.test.ts` extension.

## Data and compatibility

No schema changes. `sdk_sessions.agent_session_id` stores the thread id. Terminal Codex
dispatches (toggle off) are byte-identical, including their launch-scoped hooks.

## Verification

Unit suites, plus E2E: flip the Codex toggle, dispatch into an allowlisted repo;
confirm the card streams state, a command approval renders and answers from the card,
effort/mode changes apply on the next turn, daemon restart resumes the thread, handoff
opens the TUI on the same thread, and the usage ledger picks the session up from its
rollout exactly once. Toggle off → terminal path unchanged.

## Merge / exit criteria

CI green; E2E checklist demonstrated; the generated bindings module records the codex
version; no Foreman/queue file touched. If phase 3 is already merged, additionally run
its parity checklist against a Codex SDK session (queue, form answers, reset,
provenance) - if not yet merged, phase 5 owns that combined gate.

## Downstream handoff

Phase 5 may rely on: Codex SDK sessions being fully answerable and resumable; the
mapping table as the single statement of Codex mode posture for SDK sessions. Phase 6
may rely on: the adapter as the second reference implementation proving C4's transport
seam. No later phase may add app-server method vocabulary outside
`harness/codex/sdk.ts`; transport and generated types stay in its adjacent app-server
modules.

## Cross-phase audit record

- 2026-07-24: initial version. Concurrency with phase 3 re-checked: this phase touches
  `harness/codex/*`, capability records, and the handoff route's argv table; phase 3
  touches `foreman/*`, `reset.ts`, `skills/reload.ts`, queue files - no shared files
  except `harness-capabilities.ts` (phase 3 does not edit it) and tests are additive.
  The phase 2 interim queue refusal was confirmed runtime-scoped so it covers Codex
  regardless of merge order - recorded also in phase 2's audit.
- 2026-07-25: implemented against codex-cli 0.145.0. The corrected permission,
  effort, transport, and generated-binding contracts are recorded in the findings and
  implementation steps above; `codex-sdk-modes.test.ts`,
  `dispatch-auto-mode.test.ts`, and `codex-app-server-bindings.test.ts` guard them.
  Phase 3 had not merged, so phase 5 owns the combined parity gate.
