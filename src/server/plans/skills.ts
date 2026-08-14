import type { AgentType, Session, Task } from "@shared/types.ts";
import {
  requiredSkillCommand,
  skillInvocationForAgent,
  type RequiredSkillCommand,
} from "../skills/invoke.ts";
import {
  PLAN_HTML_SKILL_ID,
  PLAN_PHASED_SKILL_ID,
  isPlanTask,
  type PlanSkillInvocations,
} from "./prompt.ts";

/**
 * Whether a plan task can be honoured at all, and the invocations it will be told to use.
 *
 * The approved decision for this kind is that the delivered contract POINTS AT the planning
 * skills rather than restating them, and that decision is what makes their presence a launch
 * requirement instead of a nicety. An appendix pointing at a skill that is switched off points
 * at nothing: the agent would read a sentence naming a procedure it cannot load and improvise
 * one, which is worse than either restating the procedure or refusing, because it looks like
 * it worked. So a plan dispatch that could not invoke them is refused before anything is
 * provisioned, in `dispatchRetroTask`'s shape and for its reason.
 *
 * Both skills, not just the first. `phased-plan` is required at DISPATCH rather than at the
 * moment the human chooses to phase, because the alternative refuses after they have already
 * made the choice - which is the worse moment to discover a toggle. That ordering was the
 * deferred decision in this phase's plan and it is resolved here rather than downgraded to a
 * warning, since a warning the agent cannot act on is not a safeguard.
 *
 * Two resolvers, and the difference is load-bearing rather than defensive. A fresh dispatch
 * has no session, so it must not be measured against a reload watermark that describes some
 * other conversation's history; a live session must be, or the daemon types an invocation into
 * an agent still holding the previous skill set. `skills/invoke.ts` documents why answering
 * either question with the other function is wrong in both directions.
 */

export type PlanSkillResolution =
  | { ok: true; commands: PlanSkillInvocations }
  | { ok: false; message: string };

/**
 * The resolver's own sentence, plus what it costs here.
 *
 * The first half is the resolver's, written by whichever rung of the ladder failed, so it stays
 * accurate whether the master switch is off, this row is off, the catalog entry is gone, the
 * symlink drifted, or a live session has not reloaded yet. It is the same sentence the retro
 * refusal and the Workflow skill gate deliver.
 *
 * The second half is this caller's, because a refusal an operator cannot act on reads as a bug:
 * "Enable Skills and the html-plans skill" says nothing about why a dispatch just failed over a
 * setting, or where that setting is. It states WHERE rather than restating what to do, so it
 * stays true of the rung that is not about a toggle at all - a session waiting on a reload is
 * told to wait by the sentence in front of it, not to go and switch something on.
 *
 * One message for both seams. A dispatch and a handover fail this for the same reason and the
 * operator's next move is the same, so a second wording would be two sentences to keep true.
 */
function refusal(problem: string): string {
  return (
    `${problem} A plan task's intent invokes the planning skills rather than restating them, `
    + "so it would reach an agent that cannot load the procedure it was told to follow. "
    + "Both skills live under Settings → Skills."
  );
}

function compose(
  htmlPlans: RequiredSkillCommand,
  phasedPlan: RequiredSkillCommand,
): PlanSkillResolution {
  // Reported in the order the skills are needed, so an operator with both switched off is
  // pointed at the one that fails first rather than at whichever was checked first.
  if (!htmlPlans.ok) return { ok: false, message: refusal(htmlPlans.message) };
  if (!phasedPlan.ok) return { ok: false, message: refusal(phasedPlan.message) };
  return {
    ok: true,
    commands: { htmlPlans: htmlPlans.command, phasedPlan: phasedPlan.command },
  };
}

/**
 * What an agent of this kind could be told to run - the LAUNCH-time question.
 *
 * For a dispatch, which starts a conversation that does not exist yet and therefore starts
 * after the current skills generation by construction.
 */
export function planSkillsForAgent(
  agent: AgentType,
  resolve: typeof skillInvocationForAgent = skillInvocationForAgent,
): PlanSkillResolution {
  return compose(resolve(agent, PLAN_HTML_SKILL_ID), resolve(agent, PLAN_PHASED_SKILL_ID));
}

/**
 * What THIS live session could be told to run - the assignment question.
 *
 * The watermark rung is the whole difference: a session that has not yet acknowledged the
 * current symlink generation is still holding the previous skill set, so typing an invocation
 * into it names a skill it cannot load. Refused rather than typed.
 */
export function planSkillsForSession(
  session: Session,
  resolve: typeof requiredSkillCommand = requiredSkillCommand,
): PlanSkillResolution {
  return compose(resolve(session, PLAN_HTML_SKILL_ID), resolve(session, PLAN_PHASED_SKILL_ID));
}

/**
 * Why this task cannot be dispatched right now, or null when it can.
 *
 * The pre-flight the doors an operator dispatches through ask, so a refusal arrives on the
 * form or the button rather than as a failed card a few seconds later. Null - and no config
 * read at all - for every other kind, so a ship or scout dispatch is untouched by this gate.
 */
export function planDispatchBlock(
  task: Pick<Task, "kind" | "agent">,
  resolve: typeof skillInvocationForAgent = skillInvocationForAgent,
): string | null {
  if (!isPlanTask(task)) return null;
  const resolved = planSkillsForAgent(task.agent, resolve);
  return resolved.ok ? null : resolved.message;
}
