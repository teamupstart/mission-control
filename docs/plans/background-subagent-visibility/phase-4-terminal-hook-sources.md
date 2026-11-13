# Phase 4: Terminal-session sources from hooks

Source: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

Claude and Codex terminal sessions populate Session.subagents from hooks, so their background agents show as degraded rows (type, state, elapsed). Operators whose installed Claude hooks lack SubagentStart are told to reinstall.

## Entry and scope

Entry: Phase 1 merged. In: bridge fields, HookIngestSchema, Claude EVENTS, a hook reducer per harness, the registry hook path, a setup check, docs/harnesses-and-terminals.md and docs/setup.md. Out: SDK sessions, which the driver owns; their hook sub-agent signals are ignored.

## Repository findings

- Phase 1 forwards agent_id and guards parent state. hooks/harness-hook.mjs toIngest (75-100) still drops agent_type, tool_input, tool_use_id and tool_response; HookIngestSchema (protocol.ts:257-310); routes.ts:4790 calls applyHook (registry.ts:3311).
- F7, and F8 for Codex. Codex hooks are set per launch (codex/launch.ts:34-39) with agent_id and agent_type, no description or background flag.
- Installers read claudeHooks.events (hooks/install.mjs:59, src/main/integrations.ts:63) and never rerun themselves; scriptsInUse (claude-hooks.ts:130-139) lists installed events; setup-catalog.ts:665-683 hosts checks.
- applyDriverEvent rejects non-SDK sessions (registry.ts:2993), so this path calls setSubagents directly.

## Steps

1. Bridge: also forward agent_type, tool_use_id, a bounded Agent tool descriptor (description, subagent_type, run_in_background, response status, agentId) and a bounded background_tasks list, with optional schema fields.
2. Claude EVENTS gains SubagentStart, which never changes parent state.
3. Hook reducers, terminal runtime only. Claude: add on async_launched or a background_tasks subagent entry, type from SubagentStart, end on SubagentStop or on leaving background_tasks. Codex: add on SubagentStart, end on SubagentStop, counting every child because hooks cannot see a wait (F8). Both fold on UserPromptSubmit (F1) and leave counters null.
4. applyHook passes the summary to setSubagents; SDK sessions skip it.
5. Setup check: installed Claude hooks missing any claudeHooks.events entry raise a notice with the existing reinstall action.

## Tests

- Unit: bridge mapping and bounds, schema, SubagentStart leaves parent state alone, both reducers, SDK sessions ignored, setup check.
- e2e/specs/setup-hooks-missing-event.spec.ts: a hooks fixture without SubagentStart shows the notice and its reinstall action, like existing setup specs.
- npm run typecheck, lint, focused tests, build, test:e2e.

## Exit and handoff

Merged with the spec green. No contract changes.

## Audit record

The agent_id guard moved to Phase 1. launchTurnId stays null. Edits HookIngestSchema while Phase 3 edits UiConfig in the same file, in separate regions.

Conversation coverage is deferred to Phase 2. Phase 4 delivers terminal sessions' `Session.subagents`, which the board renders and Phase 2's tray will read. This branch is stacked on Phase 1 only and has no conversation renderer, so a review request to assert a terminal sub-agent in the conversation could not be met without building Phase 2's tray here. The operator chose to defer that assertion, and [phase-2-conversation-tray.md](phase-2-conversation-tray.md) now asks its spec to cover a terminal session.
