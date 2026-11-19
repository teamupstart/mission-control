# Phase 7 (WP5a): MCP tools and forms

## Outcome
The `mission-control` MCP server offers the six dispatch tools with native forms and an `AskUserQuestion` fallback, registered live with the flag (F3, F4, F5, F10, F16).

## Entry and dependencies
Phases 2, 3 and 4. Merge gated by spikes S1, S2 and S7.

## Scope and non-goals
Spec 7.10, 7.18, 7.20. Owns `src/mcp/home-dispatch/*`. Non-goals: skills (phase 9), edits to `src/mcp/server.ts` beyond the phase 1 seam.

## Repository findings
The server recognises SDK workers but not terminal workers (L26); daemon-launched MCP children never publish dispatch tools (L19).

## Steps
Tools `start_dispatch`, `submit_brief`, `checkin`, `read_inbox`, `answer_task`, `read_dispatch_options`; forms via elicitation with picks going straight to the daemon; one renderer with fences for worker text (L15, 5); add and remove tools with `tools/list_changed` and feature_flags events; Q3 position if S7 fails.

## Tests and verification
`home-dispatch-mcp-forms`, `-mcp-fallback`, `-live-tools`, `-conversation` with a fake forms client; smoke: flag off no dispatch tools, on all six; suite, typecheck, lint.

## Merge and exit
Tool descriptions and `create_task` results byte-identical with the flag off.

## Downstream handoff
Phase 9 skills name these tools exactly.

## Cross-phase audit
Tool names and schemas are fixed in phase 1 and unchanged here.
