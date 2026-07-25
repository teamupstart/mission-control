# Phase 4: the Codex driver (app-server)

## Outcome

The Harnesses toggle appears for Codex; flipping it makes the next dispatched Codex
session run over `codex app-server` JSON-RPC: approvals arrive as answerable requests on
the card, threads resume across daemon restarts, permission posture and effort apply as
per-turn overrides, and the automation machinery from phase 3 (if merged) drives it with
no Codex-specific edits.

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
  `resolveAgentBin("codex")`, stdio JSONL JSON-RPC 2.0, `initialize` handshake (use
  `optOutNotificationMethods` to drop delta noise we do not consume). Per-session
  subprocess buys crash isolation and per-session `-c` config scoping; revisit only if
  spawn cost is measured to matter.
- **Bindings**: `codex app-server generate-ts --out <dir>` against the pinned binary;
  commit under `src/server/harness/codex/app-server/` with the generating version
  recorded in the module. The protocol is experimental - drift is absorbed by
  regenerating on a Codex version bump, and by the adapter being its only consumer.
- **Approvals**: v2 `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval` server-to-client requests, answered
  accept/decline/cancel. Codex's `ask_user_question` / `request_user_input` items exist
  in some collaboration modes; project them if they arrive, but do not depend on them.
- **Rollouts still written** (`~/.codex/sessions/`): `codexTranscript.locate` and
  `codexUsage` keep working for SDK sessions once `agentSessionId` (the thread/rollout
  id) is bound - C5's read-path guarantee. Verify `locate` finds a rollout by thread id
  for an app-server session.
- **Codex hook overrides** (`prepareCodexLaunch`) are argv for TUI launches; app-server
  sessions do not take them - `hooksSeen` comes from C5's bind, and `codexHooks`'s
  `scope: "launch"` semantics are unaffected for terminal sessions.
- **Permission modes**: `PermissionMode`'s Codex values
  (`askForApproval` / `approveForMe` / `fullAccess` / `readOnly`) map to
  approval-policy + sandbox pairs (e.g. `on-request` + `workspace-write`,
  `never` + `workspace-write`, `never` + `danger-full-access` behind the same
  confirmation posture the menu had, `on-request` + `read-only`). The auto-dispatch
  posture reuses `prepareCodexLaunch`'s existing choice
  (`workspace-write` + `on-request`). Write the mapping table in the adapter with the
  measured-values doctrine (verify each against the pinned binary).

## Implementation steps

1. **Bindings module**: generate, commit, and version-stamp the TS bindings; a thin
   typed JSON-RPC client (request/response correlation, server-to-client request
   dispatch, notification fanout) over an injectable transport (scripted-frames
   testable, the C4 seam).
2. **`src/server/harness/codex/sdk.ts`**:
   - `launch(opts)`: spawn `codex app-server`, initialize, `thread/start` with cwd,
     model, effort (`modelReasoningEffort`), sandbox/approval from the mapped
     `permissionMode`, MCP via `-c mcp_servers.mission-control.*` spawn config (reuse
     `mission-mcp.ts`'s descriptor rendering - all three keys or none, the existing
     rule); `turn/start` with `opts.prompt`. `thread.started` → `bound` (thread id as
     `agentSessionId`).
   - Item/turn notifications → `state` / activity ticker / `turn_done` (token usage).
   - Approval requests → C3 projection (`kind: "approval"`, command or diff summary as
     prompt, accept/decline options); `answer()` responds to the JSON-RPC request.
     Track pending approvals so an expired/superseded answer 409s like a changed pane
     menu.
   - `send()` → `turn/start` (or `turn/steer` when a turn is in flight - measured
     behavior, verify); `interrupt()` → `turn/interrupt`; `setPermissionMode` → store +
     apply on next `turn/start` overrides, report the applied posture;
     `setModel` → per-turn model override; `clearContext()` → new `thread/start` on the
     same card, re-emit `bound` with the new thread id (the registry rebind path from
     phase 2 handles rotation).
   - `pr_created`: watch command-execution items for `opensPullRequest` matches - same
     evidence rule as Claude's.
   - Subprocess exit → `exited { resumable: true }`; resume path uses `thread/resume`.
3. **Capability flips**: codex `runtimes: ["terminal", "sdk"]`,
   `HARNESSES.codex.sdk = codexSdk` (C4 contract test moves them together). The panel
   control appears with no panel edit (it folds over `runtimes`).
4. **Handoff**: Codex arm of the phase 2 route -
   `[resolveAgentBin("codex"), "resume", threadId]` (verify the exact resume argv
   against the pinned binary; the TUI picker's `--include-non-interactive` concern does
   not apply to a direct id resume).
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
seam. No later phase may speak app-server outside `harness/codex/sdk.ts` and its
bindings module.

## Cross-phase audit record

- 2026-07-24: initial version. Concurrency with phase 3 re-checked: this phase touches
  `harness/codex/*`, capability records, and the handoff route's argv table; phase 3
  touches `foreman/*`, `reset.ts`, `skills/reload.ts`, queue files - no shared files
  except `harness-capabilities.ts` (phase 3 does not edit it) and tests are additive.
  The phase 2 interim queue refusal was confirmed runtime-scoped so it covers Codex
  regardless of merge order - recorded also in phase 2's audit.
