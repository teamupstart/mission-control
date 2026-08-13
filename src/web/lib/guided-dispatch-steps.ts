import type { AgentType, TaskKind } from "@shared/types.ts";
import type { DispatchDraft } from "./task-draft.ts";

/**
 * The guided dispatch pass, as an ordered list of questions and the pure moves between them.
 *
 * React-free on purpose, and in its own module rather than beside `useGuidedDispatch()`:
 * that module is the preference's single read/write path and imports React, whereas this is
 * the part `test/` can cover in milliseconds without a DOM. `DispatchModal` owns the state,
 * the option lists and the key handling; everything here is a function of its arguments.
 *
 * The ORDER IS DATA, not a switch, which is how Repo joined the front of it without a
 * transition being rewritten. A step added to `GUIDED_STEPS` is asked, drawn on the rail and
 * reachable by ⌫ for free.
 */

/** The steps this pass asks, in the order it asks them. */
export const GUIDED_STEP_IDS = ["repo", "kind", "harness", "afterWork"] as const;

export type GuidedStepId = (typeof GUIDED_STEP_IDS)[number];

export interface GuidedStep {
  readonly id: GuidedStepId;
  /** The rung's name on the strip. Short, because four of them share one row. */
  readonly name: string;
  /**
   * The question the picker asks - and its accessible name, which is how the browser tests
   * reach it. FIXED per step: a contextual line ("A scout has no diff…") replaces the
   * question on screen but never the name, or a spec would have to know which branch it
   * caught the modal in.
   */
  readonly question: string;
  /**
   * What answers the step.
   *
   * `options` is a closed set this pass draws itself and takes by mnemonic, position digit or
   * ↵. `field` is the form's OWN control answering it, and Repo is the only one: it drives
   * `RepoCombobox`, an open filter over every repo in the workspace, which already filters,
   * already arrow-navigates and already portals its list clear of anything that scrolls. The
   * pass contributes the rung, the question and the fact that ↵ advances - never a second list
   * beside that one.
   *
   * Two rules follow, stated here because they are exceptions rather than accidents and a
   * later step must not copy them without meaning to. In a `field` step every character is a
   * character, so a DIGIT TYPES rather than selecting by position - repository names contain
   * digits, and a digit that picked would make a repo called `service2` unfilterable. And
   * ESCAPE BELONGS TO THE LIST, which closes on it and ends the pass with it, leaving the
   * ordinary form; a second press closes the dialog, as Escape does everywhere else.
   */
  readonly answeredBy: "options" | "field";
  /**
   * The draft keys answering this step may write.
   *
   * Declared rather than inferred because it is the claim worth testing: the pass fills the
   * same `DispatchDraft` the form does and must never reach a key the form's own controls do
   * not write. Kind carries `workflowId` because choosing scout moves After work to None -
   * that is `afterWorkForKind`, the rule the Kind `<select>` already applies - and harness
   * carries `model`/`effort` because switching harness drops overrides that do not travel.
   */
  readonly writes: readonly (keyof DispatchDraft)[];
}

export const GUIDED_STEPS: readonly GuidedStep[] = [
  {
    id: "repo",
    name: "Repo",
    // Asked FIRST, and first is what makes ↵ alone a real answer: the draft opens on
    // `readLastDispatchRepo()`, and operators dispatch in runs, so the commonest answer to
    // this question is already in the field before it is asked.
    question: "Which repo is this for?",
    answeredBy: "field",
    writes: ["repoRoot"],
  },
  {
    id: "kind",
    name: "Kind",
    question: "What kind of run is this?",
    answeredBy: "options",
    writes: ["kind", "workflowId"],
  },
  {
    id: "harness",
    name: "Harness",
    question: "Which harness runs it?",
    answeredBy: "options",
    writes: ["agent", "model", "effort"],
  },
  {
    id: "afterWork",
    name: "After work",
    question: "What runs after the work?",
    answeredBy: "options",
    writes: ["workflowId"],
  },
];

/**
 * Where a pass stands: which question is on screen, and which ones have been answered.
 *
 * `answered` is always a prefix of `GUIDED_STEP_IDS` - going back to a step un-answers it and
 * everything after it, so the rail can never show a tick over a question the operator is
 * about to be asked again. The DRAFT keeps the values either way; this is only about what the
 * strip claims and what ⌫ walks.
 *
 * `active: null` is a pass that has ended, by running out of questions or by ⇥. The two are
 * told apart by what `answered` holds, which is what makes "⇥ keeps every answer" a property
 * of this type rather than a promise made in a comment.
 */
export interface GuidedPass {
  readonly active: GuidedStepId | null;
  readonly answered: readonly GuidedStepId[];
}

/** No pass: the ordinary form, and what an edit or an Ensemble always holds. */
export const NO_GUIDED_PASS: GuidedPass = { active: null, answered: [] };

/** A pass at its first question, with nothing answered. */
export function startGuidedPass(): GuidedPass {
  return { active: GUIDED_STEPS[0]?.id ?? null, answered: [] };
}

/** True while a question is on screen. The strip, the pickers and the dimming key off this. */
export function isGuidedPassRunning(pass: GuidedPass): boolean {
  return pass.active !== null;
}

/** The step being asked, or null. */
export function activeGuidedStep(pass: GuidedPass): GuidedStep | null {
  return GUIDED_STEPS.find((step) => step.id === pass.active) ?? null;
}

function indexOfStep(id: GuidedStepId | null): number {
  return GUIDED_STEPS.findIndex((step) => step.id === id);
}

/** The answered prefix ending just before `count` steps. */
function prefix(count: number): readonly GuidedStepId[] {
  return GUIDED_STEPS.slice(0, Math.max(0, count)).map((step) => step.id);
}

/**
 * The active question has been answered: tick it and move to the next, or end the pass.
 *
 * The draft write is the CALLER's - it runs the same `update(...)` the field's own control
 * runs, so the wizard and the form cannot disagree about what choosing something means.
 */
export function answerGuidedStep(pass: GuidedPass): GuidedPass {
  const at = indexOfStep(pass.active);
  if (at < 0) return pass;
  return { active: GUIDED_STEPS[at + 1]?.id ?? null, answered: prefix(at + 1) };
}

/**
 * ⌫: back one question, un-answering the one we leave.
 *
 * A no-op at the first step rather than an exit, because ⇥ is the exit and it is printed on
 * the strip. Backspacing out of the pass would make the same key mean "correct that" three
 * times and "abandon this" once.
 *
 * The first step never reaches this in practice now that it is Repo: there ⌫ is the field's,
 * deleting a character out of the text being filtered on. Both readings agree - neither takes
 * the operator anywhere - which is why prepending Repo needed nothing here.
 */
export function backGuidedStep(pass: GuidedPass): GuidedPass {
  const at = indexOfStep(pass.active);
  if (at <= 0) return pass;
  return { active: GUIDED_STEPS[at - 1]?.id ?? null, answered: prefix(at - 1) };
}

/**
 * Clicking an answered rung: reopen that question, un-answering it and everything after.
 *
 * Refused for a step that has not been answered, so the strip cannot skip a question by
 * being clicked ahead - the rungs that are not buttons are exactly the ones this rejects.
 */
export function jumpToGuidedStep(pass: GuidedPass, id: GuidedStepId): GuidedPass {
  if (!pass.answered.includes(id)) return pass;
  const at = indexOfStep(id);
  if (at < 0) return pass;
  return { active: id, answered: prefix(at) };
}

/**
 * ⇥, the Guided toggle, and a switch to Ensemble: leave the pass, keeping every answer.
 *
 * Nothing is written and nothing is reverted. The draft already holds what was answered, and
 * the questions that were never asked keep the defaults a fresh draft opened with - which is
 * exactly the form the operator would have got by not turning this on.
 */
export function endGuidedPass(pass: GuidedPass): GuidedPass {
  return pass.active === null ? pass : { active: null, answered: pass.answered };
}

/**
 * Kind's mnemonics, hand-chosen because the automatic answer is wrong here: `ship` and
 * `scout` share their first letter, so first-free-letter would give scout `c` - the letter
 * the harness step spends on Claude Code, and not a letter anyone would guess. `p` and `t`
 * are the letters that distinguish the two words, and each option prints its own.
 *
 * A `Record` over the tuple, so a third kind does not compile until it has said which key
 * takes it. `test/guided-dispatch-steps.test.ts` fails if two kinds claim the same letter.
 */
export const GUIDED_KIND_KEYS: Record<TaskKind, string> = { ship: "p", scout: "t" };

/**
 * The harness mnemonics, hand-chosen for the same reason: Claude Code and Codex both start
 * with `c`, so `c`, `x` and `i` are the distinguishing letters rather than the first ones.
 */
export const GUIDED_HARNESS_KEYS: Record<AgentType, string> = {
  claude: "c",
  codex: "x",
  pi: "i",
};

/**
 * A mnemonic for an option whose text is not known until it is fetched - the published
 * Workflows on the After work step.
 *
 * First free letter of the label, which is why the two sentinels are seeded as taken before
 * the list is walked: `d` belongs to "Dispatch default" and `n` to "None", so a workflow
 * called "Docs Sweep" earns `o` rather than shadowing the option above it. Returns null when
 * every letter is spoken for - that option is still reachable by its position digit and by
 * the arrows, and prints its digit instead of a letter.
 */
export function guidedMnemonic(label: string, taken: ReadonlySet<string>): string | null {
  for (const ch of label.toLowerCase()) {
    if (ch >= "a" && ch <= "z" && !taken.has(ch)) return ch;
  }
  return null;
}
