import type { EnsembleSummary } from "@shared/ensemble.ts";
import { ENSEMBLE_STRATEGY_IDS, type EnsembleStrategyId } from "@shared/ensemble.ts";
import { creatableStrategies } from "@shared/ensemble-strategies.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  personaUpstreamLabel,
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  workflowCommandFact,
  workflowRunIsOpen,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_COMMAND_PURPOSE,
} from "@shared/workflow.ts";
import type {
  PersonaUpstreamState,
  PersonaView,
  SessionAction,
  WorkflowCommandView,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import type { LibraryShelf } from "../workflows/useWorkflowRoute.ts";

/**
 * What the Library is, as data.
 *
 * Every shelf's teaching copy and every card's facts are derived HERE, as pure functions over
 * the stores App already holds, so the page component is layout and nothing else - and so the
 * one thing this page exists to do (say what each kind of asset is FOR) is testable without a
 * DOM. No fetches live here: a shelf that needed a request of its own would be a fourth
 * source of truth about assets three surfaces already stream over SSE.
 */

export interface LibraryShelfCopy {
  id: LibraryShelf;
  /** The system noun, as the mono eyebrow. */
  eyebrow: string;
  /** The question this shelf answers - the heading a person actually reads. */
  question: string;
  /** Two sentences at most: what the thing is, and what it does to a run. */
  why: string;
  /** The glyph every card on this shelf wears. */
  glyph: string;
}

/**
 * The six shelves, in reading order.
 *
 * The questions are the headings and the nouns are demoted to eyebrows deliberately: the
 * problem this page was built for is that nothing in the product ever said what a workflow,
 * a Persona or an action was for, and a shelf headed "Personas" would have repeated that
 * silence in a larger font.
 */
export const LIBRARY_SHELF_COPY: readonly LibraryShelfCopy[] = [
  {
    id: "missions",
    eyebrow: "Missions · Sources",
    question: "Where does work come from?",
    why: "Both stop at the backlog. A mission files a task on a cadence; a source pulls your "
      + "real backlog in. Neither ever launches an agent.",
    glyph: "◷",
  },
  {
    id: "workflows",
    eyebrow: "Workflows",
    question: "What counts as done?",
    why: "A workflow reviews one session's work and loops it back for repair until every "
      + "reviewer passes it - then it can tell the session what to do next.",
    glyph: "⌁",
  },
  {
    id: "commands",
    eyebrow: "Commands",
    question: "What does each standard gate run?",
    // Says the two halves an operator has to hold together: a workflow names a portable
    // slot, and this is where the machine says what that slot actually runs. The last
    // sentence is the one that keeps the shelf honest about authoring - saving a Command
    // does not run it.
    why: "A workflow names a slot, never a command, so it travels between repositories. "
      + "Here each slot gets one machine-wide default plus any repository exceptions. "
      + "Nothing runs until a workflow reaches the slot.",
    // A shell prompt's caret: the one glyph in Library's mono vocabulary that already means
    // "a command line", and no icon package for it.
    glyph: "❯",
  },
  {
    id: "personas",
    eyebrow: "Personas",
    question: "Who does the reviewing?",
    why: "A Persona is one reviewer's standards in Markdown. Workflow stages gate on their "
      + "verdicts; ensembles judge with them.",
    glyph: "❝",
  },
  {
    id: "actions",
    eyebrow: "Actions",
    question: "What can a run tell the session to do?",
    why: "An Action is a reusable instruction a workflow stage sends to the bound session - "
      + "open a PR, run a migration. It completes; it never judges.",
    glyph: "▤",
  },
  {
    id: "ensembles",
    eyebrow: "Ensembles",
    question: "Not sure of the best approach?",
    why: "Launchers, not assets: race several agents from one pinned commit, judge the "
      + "candidates, keep the best. Watching and deciding happen on the runs and ensembles "
      + "pages.",
    glyph: "⧉",
  },
];

export function libraryShelfCopy(id: LibraryShelf): LibraryShelfCopy {
  // Non-null by construction: `LibraryShelf` is the union of the ids above.
  return LIBRARY_SHELF_COPY.find((shelf) => shelf.id === id)!;
}

/**
 * A tag chip on a card: a durable fact about the asset, never a live one.
 *
 * Two tones, named for what they MEAN rather than for one asset's word for it: `builtin` is
 * "this ships with the build and you cannot edit it", `attention` is "this exists but will not
 * do anything yet" - an unpublished workflow draft and a paused mission are the same fact.
 */
export interface LibraryCardTag {
  label: string;
  tone: "builtin" | "attention";
}

export interface LibraryCard {
  /** The asset id, or the strategy id on the Ensembles shelf. */
  id: string;
  name: string;
  /** One sentence. Empty is rendered as the honest "No description". */
  description: string;
  tags: LibraryCardTag[];
  /**
   * The mono line under the hairline: what this asset IS, not what it is doing. Anything
   * that changes while you watch belongs on the Line, and reaches this page only through the
   * per-shelf cross-link.
   */
  fact: string;
  /** Set when `fact` reports something the operator has to fix. */
  factTone?: "warn";
}

export function workflowCards(summaries: readonly WorkflowSummary[]): LibraryCard[] {
  return summaries
    .filter((workflow) => workflow.archivedAt === null)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en-US"))
    .map((workflow) => {
      const tags: LibraryCardTag[] = [];
      if (workflow.builtin) tags.push({ label: "built-in", tone: "builtin" });
      if (workflow.publishedVersion === null) tags.push({ label: "draft", tone: "attention" });
      const reviewers = `${workflow.personaCount} reviewer${workflow.personaCount === 1 ? "" : "s"}`;
      return {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        tags,
        // A validation error is a property of the DRAFT an operator is authoring, so it
        // belongs on an authoring card; a run's verdict does not, and is not here.
        ...(workflow.errorCount > 0
          ? {
              fact: `${workflow.errorCount} validation error${workflow.errorCount === 1 ? "" : "s"}`,
              factTone: "warn" as const,
            }
          : {
              fact: workflow.publishedVersion === null
                ? `Never published · ${reviewers}`
                : `v${workflow.publishedVersion} · ${reviewers}`,
            }),
      };
    });
}

/**
 * The reviewer shelf, with an upstream badge on any imported Persona whose source has moved on.
 *
 * `upstream` is a parameter rather than something read here for the reason at the top of this
 * file - no shelf fetches - and it is the one card fact on this page that is not derived purely
 * from the SSE stores: it is what the last drift check found. That is still a DURABLE fact about
 * the asset rather than a live one, which is why it belongs on a tag: a changed source file
 * stays changed until a human adopts it.
 */
/**
 * The two facts that decide whether a reviewer can run at all, as one line.
 *
 * `execution`, not `runner`/`model`: those two are the operator's stored OVERRIDES and are
 * null on most Personas, while `execution` is what the daemon resolved and therefore what
 * will actually run.
 *
 * It lives here, and every surface that says this reads it from here, because four of them
 * were spelling the same template by hand - the Library card, the palette row, the pipeline
 * picker and the workflow canvas - and the Persona rail was about to be a fifth. The rail
 * and the palette row drifting apart on the same Persona is not a cosmetic problem: they are
 * two answers to "which reviewer is this", and `test/palette-index.test.ts` pins this exact
 * string.
 */
export function personaRoutingLabel(persona: Pick<PersonaView, "execution">): string {
  return `${persona.execution.runner.id} · ${persona.execution.model.id}`;
}

export function personaCards(
  personas: readonly PersonaView[],
  upstream?: ReadonlyMap<string, PersonaUpstreamState>,
): LibraryCard[] {
  return personas
    .filter((persona) => persona.archivedAt === null)
    .slice()
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US"))
    .map((persona) => {
      const tags: LibraryCardTag[] = [];
      if (persona.builtin) tags.push({ label: "built-in", tone: "builtin" });
      const drifted = upstream?.get(persona.id);
      const label = drifted === undefined ? null : personaUpstreamLabel(drifted);
      if (label) tags.push({ label, tone: "attention" });
      return {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        tags,
        // The Persona's own configuration rather than anything a run is doing with it.
        fact: personaRoutingLabel(persona),
      };
    });
}

export function actionCards(actions: readonly SessionAction[]): LibraryCard[] {
  return actions
    .filter((action) => action.archivedAt === null)
    .slice()
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US"))
    .map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      tags: action.builtin ? [{ label: "built-in", tone: "builtin" as const }] : [],
      fact: `${sessionActionSkillLabel(action.requiredSkillId)} · ${
        sessionActionCompletionLabel(action.completion)
      }`,
    }));
}

/**
 * The four portable Command slots, always all four and always in registry order.
 *
 * Driven off `WORKFLOW_CHECK_SLOTS` rather than off the passed catalog, so a slot the daemon
 * has not answered for yet is still a card: the slots are a fixed vocabulary that ships with
 * the build, so their EXISTENCE is knowable without the daemon. What each one runs is not,
 * which is what `hasSnapshot` decides.
 *
 * `hasSnapshot` is required rather than defaulted, and that is the safety property: the
 * optimistic default is exactly the bug - a caller who forgot it would silently publish a
 * durable claim nobody had evidence for. A caller that genuinely knows the catalog is loaded
 * has to say so.
 *
 * There is no ＋ New card on this shelf and there cannot be one. The slots ship with the
 * product; what an operator authors is what each one runs.
 */
export function commandCards(
  views: readonly WorkflowCommandView[],
  hasSnapshot: boolean,
): LibraryCard[] {
  const bySlot = new Map(views.map((view) => [view.slot, view]));
  return WORKFLOW_CHECK_SLOTS.map((slot) => ({
    id: slot,
    name: slot,
    description: WORKFLOW_COMMAND_PURPOSE[slot],
    tags: [{ label: "built-in", tone: "builtin" as const }],
    // Durable configuration, never run status. `Not configured` is not toned as a warning:
    // a slot nobody configured is a gate that passes with a note, which is the designed
    // behaviour of a portable workflow rather than something to fix - and the unloaded
    // reading is `workflowCommandFact`'s own, so this shelf, the editor's rail and the
    // workflow palette cannot answer the same question three ways.
    fact: workflowCommandFact(bySlot.get(slot), hasSnapshot),
  }));
}

/**
 * The strategy launchers, which are the one authoring-shaped thing on this page that is not
 * an asset: there is nothing to save, so the card's job is to open Dispatch already set to it.
 */
export function ensembleStrategyCards(): LibraryCard[] {
  // Through the shared registry's own filter, so a strategy this build has turned off cannot
  // be launched from here while Dispatch refuses to offer it.
  return creatableStrategies().map((info) => ({
    id: info.id,
    name: info.label,
    description: info.blurb,
    tags: [],
    fact: "Launch one →",
  }));
}

export function isEnsembleStrategyCard(id: string): id is EnsembleStrategyId {
  return (ENSEMBLE_STRATEGY_IDS as readonly string[]).includes(id);
}

/**
 * The one card on the Missions · Sources shelf that is not a mission.
 *
 * Task sources still belong to Settings and this phase deliberately does not move them: the
 * shelf names the second way work arrives and links to where it is configured, rather than
 * growing a second editor for rows Settings already owns.
 */
export const TASK_SOURCES_CARD_ID = "mission-control:task-sources";

export function taskSourcesCard(): LibraryCard {
  return {
    id: TASK_SOURCES_CARD_ID,
    name: "Task sources",
    description: "Pull a real backlog in - issues and boards become backlog tasks.",
    tags: [],
    fact: "Configured in Settings →",
  };
}

/** Recurring missions, as cards, with the sources card last. */
export function missionCards(schedules: readonly MissionSchedule[]): LibraryCard[] {
  return schedules
    .filter((schedule) => schedule.archivedAt === null)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en-US"))
    .map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      description: schedule.template?.title ?? "",
      tags: schedule.enabled ? [] : [{ label: "paused", tone: "attention" as const }],
      // The cadence is what an operator authored; `health` is the daemon's derivation of it
      // and is read, never recomputed.
      ...(schedule.health === "attention"
        ? { fact: `${schedule.expression} · needs attention`, factTone: "warn" as const }
        : { fact: `${schedule.expression} · ${schedule.timezone}` }),
    }));
}

/** The per-shelf "on the Line →" link: a count and where it points, or nothing. */
export interface ShelfCrossLink {
  label: string;
  /** Amber when the number is one the operator has to answer. */
  attention: boolean;
}

export function workflowRunsCrossLink(runs: readonly WorkflowRunSummary[]): ShelfCrossLink {
  const open = runs.filter((run) => workflowRunIsOpen(run.status));
  // `waiting_for_action` is the one open status where the run is stuck on the SESSION doing
  // something, which is the Actions shelf's business and the reason that shelf's link is
  // separately toned.
  return {
    label: open.length === 0 ? "runs →" : `${open.length} running →`,
    attention: false,
  };
}

export function actionWaitsCrossLink(runs: readonly WorkflowRunSummary[]): ShelfCrossLink {
  const waiting = runs.filter((run) => run.status === "waiting_for_action").length;
  return {
    label: waiting === 0 ? "runs →" : `${waiting} waiting on a session →`,
    attention: waiting > 0,
  };
}

export function ensemblesCrossLink(
  summaries: readonly EnsembleSummary[],
  attentionCount: number,
): ShelfCrossLink {
  if (attentionCount > 0) {
    return { label: `${attentionCount} need you →`, attention: true };
  }
  return { label: summaries.length === 0 ? "ensembles →" : `${summaries.length} run →`, attention: false };
}

export function missionsCrossLink(schedules: readonly MissionSchedule[]): ShelfCrossLink {
  const attention = schedules.filter(
    (schedule) => schedule.archivedAt === null && schedule.health === "attention",
  ).length;
  return attention > 0
    ? { label: `${attention} need attention →`, attention: true }
    : { label: "intake healthy →", attention: false };
}
