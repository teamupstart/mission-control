import {
  PLAN_PAGE_FILENAME,
  PLAN_SOURCE_PATH_SHAPE,
} from "@shared/plans.ts";
import type { Task } from "@shared/types.ts";
import { PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL } from "./tools.ts";

/**
 * The delivery contract every plan task gets - which POINTS AT the planning skills instead
 * of restating them.
 *
 * That is the deliberate difference from `scouts/prompt.ts`, and it follows from the two
 * contracts being enforced by different things. A scout's report is SERVER-enforced: normal
 * completion cannot reach `done` until a page has been captured and verified, so its requirement
 * had to hold with every skill switched off - which meant restating the skill in the appendix. A plan
 * has no such gate. It is finished when a human says the plan is right, so the procedure can
 * stay where it is already written, in `skills/html-plans/SKILL.md`, and this appendix's job
 * is to guarantee the agent reaches it rather than to be a second copy of it.
 *
 * That guarantee is what turns the skills into a LAUNCH REQUIREMENT rather than a nicety:
 * `plans/skills.ts` refuses a dispatch that could not invoke them, because an appendix
 * pointing at a skill that is switched off points at nothing.
 *
 * The invocations are handed IN rather than resolved here, and that is the one shape in this
 * phase most worth not simplifying. The two delivery seams ask genuinely different questions
 * of the same config - a fresh dispatch has no session to measure a reload watermark against,
 * a live session does - so a module that resolved its own invocation would have to pick one
 * resolver, and either choice is wrong at the other seam (see `skills/invoke.ts`). Taking them
 * as arguments also leaves this module pure and testable per harness, which is the regression
 * a hardcoded `/html-plans` would cause and which is invisible on Claude.
 *
 * Do NOT copy the skill's rendering rules, its decision schema, or its diagram guidance in
 * here. Two statements of one procedure drift, and the copy in the appendix is the one nothing
 * tests against a real plan.
 */

/** The marker that opens the appendix. A stable anchor for tests and for a human reading a pane. */
export const PLAN_APPENDIX_MARKER = "--- Mission Control plan ---";

/**
 * The two skills this contract points at, named where they are spelled into the text.
 *
 * Here rather than in `plans/skills.ts`, which resolves them, because the contract is what
 * NAMES them: the appendix writes both ids into prose, and a second copy of a name that is
 * also a catalog id and a `SKILL.md` frontmatter `name` is exactly the drift this repository
 * keeps registries for. The gate reads them from here.
 */
export const PLAN_HTML_SKILL_ID = "html-plans";
export const PLAN_PHASED_SKILL_ID = "phased-plan";

/** Both, in the order they are needed - which is the order a refusal reports them in. */
export const PLAN_SKILL_IDS = [PLAN_HTML_SKILL_ID, PLAN_PHASED_SKILL_ID] as const;

/**
 * Whether this task's delivery carries the plan contract.
 *
 * One predicate rather than `task.kind === "plan"` spelled at each seam, for `isScoutTask`'s
 * reason: the two delivery paths, the launch requirement and the dispatch refusal must agree
 * about which tasks are plans, and a fourth reading of the same field is where "the prompt
 * said so but the launch did not" comes from.
 */
export function isPlanTask(task: Pick<Task, "kind">): boolean {
  return task.kind === "plan";
}

/**
 * The already-resolved, per-harness lines that invoke the two planning skills.
 *
 * Strings rather than skill ids, because rendering them is `skillCommand`'s job and it spells
 * them differently on every harness: `/html-plans` on Claude, `$html-plans - run this skill
 * now.` on Codex, `/skill:html-plans` on Pi.
 */
export interface PlanSkillInvocations {
  /** `html-plans`: how the plan is written, rendered, and opened for review. */
  htmlPlans: string;
  /** `phased-plan`: how an approved plan becomes phases and scheduled tasks. */
  phasedPlan: string;
}

/**
 * The contract text itself.
 *
 * Compact for the scout appendix's reason: it competes for attention with the operator's own
 * request, and a page of rules is read like a page of none. Here there is a second reason to
 * keep it short - every line spent explaining how to write a plan is a line arguing with the
 * skill this contract exists to hand the work to.
 */
export function planContractAppendix(skills: PlanSkillInvocations): string {
  const lines = [
    PLAN_APPENDIX_MARKER,
    "This is a plan task. The deliverable is a plan a human has read and agreed with - written,",
    "rendered as a page, and refined with them until it is right. It is not a change: do not",
    "implement what you are planning, and do not treat writing the file as having delivered it.",
    "",
    `1. Invoke the ${PLAN_HTML_SKILL_ID} skill and work from it. It owns how a plan is written,`,
    "   rendered and put in front of a person, and nothing here repeats it - so read it rather",
    "   than working from what you already believe a good plan looks like. On this harness:",
    `   ${skills.htmlPlans}`,
    `2. The plan belongs in this checkout at \`${PLAN_SOURCE_PATH_SHAPE}\`, with its rendered`,
    `   \`${PLAN_PAGE_FILENAME}\` beside it, where \`<name>\` is a short kebab-case name for the work.`,
    `3. Ask for the review, and for every open choice in it, with the \`${PLAN_DECISIONS_TOOL}\``,
    "   tool rather than in prose. It blocks until the human answers, which is what holds the",
    "   refinement open. A dismissal ends the work; it is never read back as a selection.",
    "4. The last decision that tool is given is the phased implementation follow-up the skill",
    `   specifies. When the human takes it, invoke the ${PLAN_PHASED_SKILL_ID} skill and let it write`,
    `   the phases and schedule the tasks with \`${PLAN_SCHEDULING_TOOL}\`. On this harness:`,
    `   ${skills.phasedPlan}`,
    "",
    "Unlike a scout, a plan is meant to land: commit the plan's files and expect the ordinary",
    "pull request at the end. The phase tasks carry paths rather than content, so those paths",
    "have to resolve on the default branch before any of the phases can start.",
  ];
  return lines.join("\n");
}
