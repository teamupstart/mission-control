# Phase 1: Board sub-cards for Claude SDK sessions

Source: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

A Claude SDK session (the default for dispatched tasks and residents) with background sub-agents shows nested sub-cards beneath its board tile, and an idle parent reads "idle · N agents still running". Owns every index contract.

## Entry and scope

Entry: the planning PR has merged. In: contract, Claude SDK reducer, registry projection, both F4 fixes, Option 2 board half, activity line, fake sentinel, tests, docs/ui.md and docs/sessions.md. Out: tray (2), setting and chip (3), hook and Codex sources (4, 5), any stop or open control.

## Repository findings

- Session at src/shared/types.ts:558; SESSION_FIELD_COMPARATORS (registry.ts:10492) is compile-enforced.
- consume() (claude/sdk.ts:1034-1118) handles only init and compact_boundary system frames; its assistant branch (1074-1083) re-arms the turn without checking parent_tool_use_id.
- Events: this.out.emit(SdkEvent) (harness/types.ts:1083), supervisor.ts:1666, applyDriverEvent (registry.ts:2982), whose switch is not exhaustive. registerSdkSession (2865) and auth relaunch (sdk.ts:503-545) must reset the field.
- hooks/harness-hook.mjs toIngest (75-100) drops agent_id; HookIngestSchema (protocol.ts:257) strips unknown keys; claude/hooks.ts:97-131 maps tool and SubagentStop hooks to working; applyHook (registry.ts:3311) accepts hooks for SDK sessions.
- change-contracts.md:44-57 registers hideable tile items in DISPLAY_ITEMS. This indicator is not hideable (D1); if test/board-card-items.test.ts classifies every tile child, mark it always-on like the attention flags.
- Tiles: tile() in BoardView.tsx:255-302; .board-repo child selectors (styles.css:30611); no virtualization. Fake SDK: fake-claude.mjs sentinels (245-287), emit() 966, appendTurn() 908.

## Steps

1. Contract, comparator and SdkEvent kind as the index states.
2. src/server/harness/claude/subagents.ts, a pure reducer: background_tasks_changed sets membership (local_agent, not ambient); task_* frames add type, description, counters, last tool, summary and end state; leaving the level silently means stopped; acceptTurn folds finished entries; cap 12; CLIs without the level use edges filtered by is_backgrounded.
3. Wire consume() and acceptTurn(); emit per F5; reset on restart and relaunch; only frames without parent_tool_use_id arm the parent.
4. Registry: setSubagents, the applyDriverEvent case, clear on re-register.
5. Hook guard: forward agent_id as optional HookIngest.agentId; applyHook ignores state, activity and work-cycle signals that carry it.
6. src/shared/subagents.ts selectors; the tile ticker uses the line when the parent is idle or awaiting input with agents running.
7. SubagentTree beneath the tile, outside its border, on a spine: fold header "▾ N sub-agents · M running", three rows then "+N more", each row type, description, elapsed, tools, last tool; finished rows dimmed and folded ones counted as "N finished"; null values omitted, never zeroed; nothing drawn when empty. Preferred route: a keyed sibling after the tile in tile(), scrolled into view with it.
8. Fake sentinel E2E_BACKGROUND_AGENTS: writes an Agent tool_use transcript record, emits task_started (backgrounded), background_tasks_changed and task_progress, ends the turn with agents running, finishes one shortly after.

No SQLite change; optional field, so hand-built fixtures still compile.

## Tests

- test/claude-subagents.test.ts: level replace, filtering, foreground excluded, late backgrounding, silent stop, fold only on acceptTurn, cap, reset.
- claude-sdk-adapter tests: frames to events, no re-arm, coalescing. Comparator, registry projection, and a hook with agentId leaving an idle parent idle.
- e2e/specs/board-background-agents.spec.ts: sub-cards, idle line, dimmed finished row, an agent-free tile unchanged.
- npm run typecheck, lint, focused node --test files, build, test:e2e.

## Exit and handoff

Merged with the spec green. Later phases rely on the contracts, HookIngest.agentId, the sentinel and SubagentTree, and must not change shapes, the cap, F1 or F5.

## Audit record

The agent_id guard moved here from Phase 4: SDK sessions also run machine hooks, so the idle line would be wrong until Phase 4 merged.
