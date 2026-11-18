# Phase 4: MCP tools and plugin

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 5 and 7. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

The Claude Code plugin exists: `read_inbox`, `answer_task`, `read_dispatch_options` tools, the `handoff` and `checkin` skills, and the optional `/mc` shortcuts. When the hook asks, the model asks the launcher question first, then walks the person through the guided questions and a selectable confirm, using their first message as the brief. The work is pushed to `feat/headless-mode-spike`.

## 2. Entry criteria and dependencies

Phase 2 pushed to `feat/headless-mode-spike` (dispatch-options route). Phase 1 is a transitive prerequisite.

## 3. Scope and non-goals

In scope: `src/mcp/handoff-tools.ts`, `create_task` result fields, `plugin/` content, `scripts/build-claude-plugin.mjs`, plugin smoke. Not in scope: hook logic (phase 3), `mctl`, setup, Grill me first, `create_task` input changes, any pull request or other upstream branch.

## 4. Repository findings and contracts

- `create_task` lives in `src/mcp/server.ts` and routes to `/mcp/tasks`, `/mcp/v2/tasks` or `/mcp/v3/tasks`; its schema omits `grillFirst` and `personaId`. Add `afterWork` and `kindLabel` to the result only.
- Worker identity: `MISSION_SESSION_ID` is read at the top of `src/mcp/server.ts`; the new tools must refuse inside workers (AC-MCP-09).
- Home identity from spike S-01: `CLAUDE_CODE_SESSION_ID` plus parent pid.
- Skills are text; test structurally. The hook's instruction (phase 3) names `read_dispatch_options` and `entry` `first-message`; the skill's first-message entry must match.

## 5. Implementation steps

1. Start from the tip of `origin/feat/headless-mode-spike`.
2. Implement the three tools in `registerHandoffTools` against the phase 1 and 2 routes; `read_dispatch_options` accepts `entry`; `answer_task` and `read_dispatch_options` descriptions per spec 5.
3. Generate the `create_task` kind description from `KIND_HINTS`; add `kindLabel` and `afterWork` to the result.
4. Send home identity on create so origin is `home-session`.
5. Write `skills/handoff/SKILL.md` (spec 7.2: three entries including first-message, no kind list, no Grill me first, no work before the launcher answer), `skills/checkin/SKILL.md` (7.3), `commands/mc.md` (7.4, shortcuts marked optional).
6. `build-claude-plugin.mjs` produces the layout in 7.1; extend `smokeHandoffPlugin` to list `read_dispatch_options`.
7. Fetch, rebase on the branch tip, re-run verification, push fast-forward to `feat/headless-mode-spike`.

## 6. Data, API and compatibility

No schema change. Existing worker-facing MCP behaviour must be unchanged except the additive result fields.

## 7. Tests and verification

Owns AC-MCP-01 to AC-MCP-09, AC-PLUG-01 to AC-PLUG-07, AC-LAUNCH-03, and AC-DEL-05 for its own pushes. Run `test/handoff-mcp.test.ts`, `test/handoff-plugin.test.ts`, `npm run build`, `npm run smoke`, typecheck, lint, `npm test`.

## 8. Exit criteria

Owned rows pass; `dist/claude-plugin/` builds; smoke passes; commits pushed to `feat/headless-mode-spike`, no other upstream branch. The operator then releases dependents.

## 9. Downstream handoff

Phase 6 copies `dist/claude-plugin/` to the instance and installs it. The layout and tool names are fixed.

## 10. Cross-phase audit

The plugin `hooks.json` points at the hook built by phase 3 (the Phase 0 stub until it lands; both orders work). Skill text must match phase 2's question shape and phase 3's instruction.
