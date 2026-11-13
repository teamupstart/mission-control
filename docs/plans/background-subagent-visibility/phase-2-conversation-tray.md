# Phase 2: Conversation tray and Jump to launch

Source: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

A conversation with background sub-agents shows a Background agents tray above the composer, whatever the rail shows, with Jump to launch per agent. Residents get it with no resident branch (F9). Completes Option 2.

## Entry and scope

Entry: Phase 1 merged. In: BackgroundAgentsTray, its mount, launchTurnId for Claude SDK, jumpable merged tool rows, geometry and e2e coverage, docs/ui.md. Out: the setting and Agents tab (3). Other sources keep launchTurnId null and show no link.

## Repository findings

- TranscriptPanel.tsx: .find-split holds the log (1149-1275), the in-flight pill floats over it (1279-1295), then compose-notice (1343) or .transcript-compose (1358). Mount between 1332 and 1343 as flex none, never inside .transcript-compose (image drop, 1495).
- Jump: setJump (485, 1327) scrolls to [data-turn-id] (645-649) and flashes (668-678).
- F6: tools.ts:359-375 keeps only the first merged id; ToolRun and TerminalToolRun render no data-turn-id (1963, 2238); toolCall() drops block.id (claude/transcript.ts:79-92); older history pages in (loadOlder, 890).
- test/transcript-scroll-electron.test.ts measures that the reply box stays in the pane.

## Steps

1. Launch ids: map task_started.tool_use_id to the turn holding that tool_use. If SDK frame uuids differ from transcript uuids, carry the tool_use id on ToolCall and resolve in the browser; record which in the PR.
2. Every turn id merged into a tools row stays jumpable.
3. A launch outside the loaded window loads older pages until found or the start is reached, then says so in a tooltip.
4. BackgroundAgentsTray: header "⑂ Background agents · N running · M done" with a fold control; rows of state, type, description, elapsed, tools; finished dimmed; finishedFolded as "N finished"; absent when empty.
5. Styles for board and terminal views and narrow widths.

## Tests

- Unit: launch-id mapping, merged-row ids, tray markup via renderToStaticMarkup.
- Electron: a transcript-scroll case with the tray keeps the composer in the pane and the log scrolling.
- e2e/specs/conversation-background-agents.spec.ts: tray rows; Jump to launch scrolls the launch turn into view; the tray also shows for a resident launched as in residents-launch.spec.ts.
- npm run typecheck, lint, focused tests, build, test:e2e.
- Terminal sessions (added by Phase 4): once Phase 4 has merged, the tray spec also covers a hook-reported terminal sub-agent. `e2e/specs/board-terminal-background-agents.spec.ts` already drives a real tmux Claude session through hook posts; extend it, or reuse its pane and hook helpers, to open that session's conversation and assert the agent's row in the tray. Phase 4 first deferred this assertion here; once this phase merged, Phase 4's spec added it itself, so it lives in `board-terminal-background-agents.spec.ts`.

## Exit and handoff

Merged with the spec green. Phase 3 uses the tray as the nested conversation half and must not move its mount.

## Audit record

Consumes Phase 1 contracts unchanged; fills the reserved launchTurnId for Claude SDK only.
