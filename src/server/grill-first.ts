import { GRILL_SKILL } from "@shared/skills.ts";
import { taskGrillsFirst } from "@shared/task.ts";
import type { AgentType, Session, Task } from "@shared/types.ts";
import type { SessionAction } from "@shared/workflow.ts";
import {
  requiredSkillCommand,
  skillInvocationForAgent,
  type RequiredSkillCommand,
} from "./skills/invoke.ts";
import { BUILTIN_SESSION_ACTIONS, GRILL_SESSION_ACTION_ID } from "./workflows/builtin-session-actions.ts";

/**
 * Grill me first: a task of any kind that offers it (`GRILL_FIRST_TASK_KINDS`) and was pinned
 * on opens with the Grill session action, then gets its own contract unchanged.
 *
 * The action is the Library's built-in Grill, read as this machine runs it - the operator's
 * edited instruction when there is one (`builtin_session_action_overrides`), the shipped text
 * otherwise - so editing it in the Library changes what every later grill-first task is told.
 * What stays fixed is its contract: the `grill` skill it requires, which is why that skill is
 * a launch requirement here exactly as the planning skills are for a plan, and why both seams
 * resolve it before anything is written.
 */

/** The marker that opens the block. A stable anchor for tests and for a human reading a pane. */
export const GRILL_FIRST_HEADING = "## Grill me first";

/** What the block is built from: the action's instruction and this harness's skill line. */
export interface GrillFirstDelivery {
  instruction: string;
  invocation: string;
}

/** The Grill action as this machine runs it; the shipped one when no catalog is to hand. */
export function grillAction(read?: (id: string) => SessionAction | undefined): SessionAction {
  const shipped = BUILTIN_SESSION_ACTIONS.find((action) => action.id === GRILL_SESSION_ACTION_ID);
  const action = read?.(GRILL_SESSION_ACTION_ID) ?? shipped;
  if (!action) throw new Error("this build ships no Grill session action");
  return action;
}

/**
 * The block delivered ahead of the task's own contract. The instruction is the action's exact
 * Markdown, never trimmed or rewritten, like every session action a session receives.
 */
export function grillFirstAppendix(delivery: GrillFirstDelivery): string {
  return [
    GRILL_FIRST_HEADING,
    "This task was dispatched with Grill me first. Before you start the work, run the Grill session",
    "action below, then carry on with the task as it was delivered. Its skill, on this harness:",
    delivery.invocation,
    "",
    delivery.instruction,
  ].join("\n");
}

export type GrillFirstResolution =
  | { ok: true; delivery: GrillFirstDelivery }
  | { ok: false; message: string };

function refusal(problem: string): string {
  return `${problem} A Grill me first task opens with the Grill session action, which invokes the `
    + `${GRILL_SKILL} skill, so it would reach an agent that cannot load the interview it was told `
    + "to run. Its skill lives under Settings → Skills.";
}

function resolve(action: SessionAction, resolved: RequiredSkillCommand): GrillFirstResolution {
  return resolved.ok
    ? { ok: true, delivery: { instruction: action.promptMarkdown, invocation: resolved.command } }
    : { ok: false, message: refusal(resolved.message) };
}

/** The launch-time half: a fresh dispatch, whose conversation does not exist yet. */
export function grillFirstForAgent(
  agent: AgentType,
  action: SessionAction,
  resolveSkill: typeof skillInvocationForAgent = skillInvocationForAgent,
): GrillFirstResolution {
  return resolve(action, resolveSkill(agent, action.requiredSkillId ?? GRILL_SKILL));
}

/** The assignment half: a live session, measured against its skills reload watermark. */
export function grillFirstForSession(
  session: Session,
  action: SessionAction,
  resolveSkill: typeof requiredSkillCommand = requiredSkillCommand,
): GrillFirstResolution {
  return resolve(action, resolveSkill(session, action.requiredSkillId ?? GRILL_SKILL));
}

/**
 * Why this task cannot be dispatched for Grill me first, or null when it can or does not grill.
 * The pre-flight the dispatch doors ask, beside `planDispatchBlock`.
 */
export function grillFirstDispatchBlock(
  task: Pick<Task, "kind" | "agent" | "grillFirst">,
  resolveSkill: typeof skillInvocationForAgent = skillInvocationForAgent,
): string | null {
  if (!taskGrillsFirst(task)) return null;
  const resolved = grillFirstForAgent(task.agent, grillAction(), resolveSkill);
  return resolved.ok ? null : resolved.message;
}
