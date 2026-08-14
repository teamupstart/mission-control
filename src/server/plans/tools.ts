/**
 * The one spelling of the two Mission MCP tools a plan task's contract names.
 *
 * Named here for `scouts/submission-tool.ts`'s reason, with one difference worth stating:
 * neither of these is a plan-specific tool. `request_plan_decisions` and `create_task` both
 * predate the plan kind and stay available to any session. What is plan-specific is that a
 * plan task's PROMPT names them and its LAUNCH has to pre-approve them, and those two
 * sentences have to spell the tool identically or the agent stops on a permission prompt for
 * a tool everyone believed was waved through. So this module owns the pairing, not the tools.
 *
 * The membership check lives at the use site rather than here: `KIND_MISSION_MCP_TOOLS`
 * (`../mission-mcp.ts`) is typed `readonly MissionMcpTool[]`, so a name the bundled server
 * does not register cannot be assigned into it.
 */

/**
 * How the plan is shown for review and how the phased follow-up is asked.
 *
 * Without it the agent falls back to asking in prose, which is the exact failure the
 * `html-plans` skill exists to prevent - a question nobody is watching for, at the end of a
 * turn, in a dashboard whose whole point is that the human is not reading the pane.
 */
export const PLAN_DECISIONS_TOOL = "request_plan_decisions" as const;

/** How `phased-plan` schedules one dependency-linked backlog task per phase. */
export const PLAN_SCHEDULING_TOOL = "create_task" as const;
