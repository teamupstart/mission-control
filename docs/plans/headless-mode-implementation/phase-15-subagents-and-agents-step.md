# Phase 15: Subagents and the agents setup step (WP11)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.14, 7.17.

**1. Outcome.** The read-only briefer and kind subagents are linked for Claude, the pane header shows each task's subagent lines through the slot P12 reserved, and setup installs and doctor checks the agents.

**2. Entry and dependencies.** Direct prerequisites: P11 (flows), P12 (pane), P14 (setup list). Soft spike S4, recorded in Commonroom; if agents are not usable as `subagent_type`, ask the owner.

**3. Scope.** `agents/` (`mission-briefer`, `mission-explorer`, `mission-reviewer`), `src/server/skills/agent-links.ts` with the one `reconcileAgentLinks` call in `src/server/skills/reconcile.ts`, `src/shared/subagent-lines.ts`, the one pane integration (fill the `subagentLines` slot P12 reserved in `src/mod/pane/header.tsx` and nothing else in the pane), `test/home-dispatch-mod-pane-subagents.test.ts`, `src/cli/setup-steps/agents.ts` and its doctor check. Non-goals: any change to the owned hook or status line wrapper (D43).

**4. Findings.** `SubagentStart` and `SubagentStop` carry `agent_type` but no description; the description appears only in `SubagentStop`'s `background_tasks`, and the compaction helper fires `SubagentStop` with an empty type (L9). The skills reconciler already links into Claude, Codex and Pi (L27). Subagent lines move from the old picker to the pane.

**5. Steps.** Read spec 7.14 (agents step), 7.17. Write the link reconciler in its new file and call it once from `reconcile.ts`. Build the shared line formatter, then fill P12's reserved header slot with it. The slot reads an optional `subagentLines` field that P1's shapes already carry; if they carry none, add it additively in its own `contract:` commit. Add the agents step and doctor line.

**6. Data and API.** No new routes; `subagentLines` shape in `src/shared/`.

**7. Tests.** Link creation and removal, no clobbering of a user's own agent files, line formatting incl. empty agent type, the setup step on a fake home, and a rendered-pane check with the fake host: a task header shows its subagent lines at 40, 71 and 120 columns, shows nothing extra when the list is empty, and P12's pane tests still pass.

**8. Merge and exit.** Agents link and doctor reports them; F2 can now be accepted with P7.

**9. Handoff.** P17 documents agents. Do not change the line formatter's output without checking P12's tests.

**10. Cross-phase audit.** The `reconcile.ts` edit is one call and owned here; P15 owns the formatter and the one slot fill in `header.tsx`; P12 owns the rest of the pane and reserves the slot, so the formatter does not exist when P12 merges and P12 never imports it.
