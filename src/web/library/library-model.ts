import type { EnsembleSummary } from "@shared/ensemble.ts";
import { ENSEMBLE_STRATEGY_IDS, type EnsembleStrategyId } from "@shared/ensemble.ts";
import { creatableStrategies } from "@shared/ensemble-strategies.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  workflowRunIsOpen,
} from "@shared/workflow.ts";
import type {
  PersonaView,
  SessionAction,
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
 * The five shelves, in reading order.
 *
 * The questions are the headings and the nouns are demoted to eyebrows deliberately: the
 * problem this page was built for is that nothing in the product ever said what a workflow,
 * a Persona or an action was for, and a shelf headed "Personas" would have repeated that
 * silence in a larger font.
 */
export const LIBRARY_SHELF_COPY: readonly LibraryShelfCopy[] = [
  {
    id: "workflows",
    eyebrow: "Workflows",
    question: "What counts as done?",
    why: "A workflow reviews one session's work and loops it back for repair until every "
      + "reviewer passes it - then it can tell the session what to do next.",
    glyph: "⌁",
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
  {
    id: "missions",
    eyebrow: "Missions · Sources",
    question: "Where does work come from?",
    why: "Both stop at the backlog. A mission files a task on a cadence; a source pulls your "
      + "real backlog in. Neither ever launches an agent.",
    glyph: "◷",
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

export function personaCards(personas: readonly PersonaView[]): LibraryCard[] {
  return personas
    .filter((persona) => persona.archivedAt === null)
    .slice()
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US"))
    .map((persona) => ({
      id: persona.id,
      name: persona.name,
      description: persona.description,
      tags: persona.builtin ? [{ label: "built-in", tone: "builtin" as const }] : [],
      // The two facts that decide whether this reviewer can run at all, and they are the
      // Persona's own configuration rather than anything a run is doing with it.
      fact: `${persona.execution.runner.id} · ${persona.execution.model.id}`,
    }));
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
