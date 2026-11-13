# Background sub-agent visibility - phased implementation

Source: [plan.md](plan.md). Five phases: 1 first; 2, 4 and 5 may run concurrently after it; 3 after 2.

This planning task delivers these documents only. Each phase is implemented and verified by its own backlog task and pull request; the planning change builds none of it.

## Human decisions

- D1 Build Option 1 (chip and popover) and Option 2 (nested sub-cards); one radio in Settings › Display › Board card picks one; no Off. Phase 1 ships Option 2; Phase 3 adds Option 1 and the radio.
- D2 Background sub-agents only. Every source phase.
- D3 No fleet-wide top-bar count.
- D4 The setting switches board and conversation halves together; default Nested sub-cards. Phase 3.

## Findings that changed the design

- F1 A finished agent's notification can start a parent turn itself, so finished agents fold on the next turn the operator sends (acceptTurn, or UserPromptSubmit for terminals). Refines plan.md's "next turn starts".
- F2 SDK background_tasks_changed is the full live set (replace semantics, reset on CLI restart). It decides membership; task_* frames add detail.
- F3 task_* frames also cover shells, MCP tasks and workflows: keep task_type local_agent, drop ambient.
- F4 Sub-agent frames re-arm the parent: the SDK assistant branch ignores parent_tool_use_id, and hooks fired inside a sub-agent (they carry agent_id) flip the parent to working. SDK sessions run machine hooks too, so Phase 1 fixes both.
- F5 Each session_upsert schedules a Line recompute: membership and state changes emit at once, counter-only changes at most once per 5 s per session; elapsed time is computed in the browser.
- F6 Merged tool rows drop turn ids and ToolCall has no id. Phase 2 repairs this for Jump to launch.
- F7 Claude SubagentStart has agent_id and agent_type only; background shows as the Agent tool's PostToolUse status async_launched and as background_tasks on Stop and SubagentStop. Existing installs lack SubagentStart until reinstalled.
- F8 Every Codex child is asynchronous; foreground only while an in-progress wait names it.
- F9 Residents are SDK sessions in the same TranscriptPanel, so every treatment reaches them.

## Sizing

1,550 to 2,150 non-test production lines, likely about 1,800: Phase 1 550-740, Phase 2 200-300, Phase 3 380-520, Phase 4 260-360, Phase 5 150-230. One PR would span server, hooks, two transports and two UIs. Phase 1 is the smallest slice that shows anything; adding Phase 2 pushes it past 900 lines and mixes in transcript-id and composer-geometry risk. Phase 3 is a second treatment plus a persisted key. Phases 4 and 5 are separate transports with separate test rigs, and Phase 5 touches the Codex thread-tree code that guards PR authorship.

## Phases

| # | File | Prerequisites |
| --- | --- | --- |
| 1 | [phase-1-board-sub-cards.md](phase-1-board-sub-cards.md) | planning PR |
| 2 | [phase-2-conversation-tray.md](phase-2-conversation-tray.md) | 1 |
| 3 | [phase-3-chip-display-choice.md](phase-3-chip-display-choice.md) | 2 |
| 4 | [phase-4-terminal-hook-sources.md](phase-4-terminal-hook-sources.md) | 1 |
| 5 | [phase-5-codex-app-server-source.md](phase-5-codex-app-server-source.md) | 1 |

Concurrency: 2, 4 and 5 edit disjoint source files; 4 and 5 both add sections to docs/harnesses-and-terminals.md. 3 may overlap 4 and 5; 3 and 4 both edit src/shared/protocol.ts in separate regions (UiConfig, HookIngestSchema). Merge order: planning PR, 1, then 2, 4, 5 in any order, 3 after 2.

## Cross-phase contracts (owned by Phase 1)

- Session.subagents?: SubagentSummary in src/shared/types.ts, comparator byJson.
- SubagentSummary: agents (at most 12, running first, then newest finished) and finishedFolded.
- SubagentEntry: id, type, description, state (running, completed, failed, stopped), startedAt, endedAt, toolUses, tokens, lastTool, summary, launchTurnId; every optional value is null when the source does not report it.
- SdkEvent kind subagents; Registry.setSubagents is the only writer; cleared on SDK re-register or relaunch.
- src/shared/subagents.ts: subagentCounts and subagentActivityLine.
- HookIngest.agentId: a hook carrying it never changes parent state, activity or work cycle.
- F1 and F5. Later phases add sources or renderers and never change these. Only Phase 3 adds a persisted key, UiConfig.backgroundAgentsStyle.

## Final verification (after every phase task merges)

Each phase passes typecheck, lint, focused tests, build and its e2e spec. Across the set: the default shows sub-cards and the tray; Chip and popover shows the chip and the Agents tab; Claude and Codex, SDK and terminal, all populate; foreground and ambient work never appears; a session without background agents renders as before.

## Scheduling

After these files are pushed: one create_task per phase in table order, titled "Background sub-agents - Phase n: name", a short intent pointing at plan.md, this file and the phase file, dependsOnCurrentSession true, dependsOnTaskIds per the table. Phases 1 to 4 change UI, so agent claude with model claude-opus-5-5; Phase 5 uses the default agent.
