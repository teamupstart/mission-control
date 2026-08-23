import {
  SEE_WORK_TOUR_DEMO_INTENT,
  SEE_WORK_TOUR_PREVIEW_INTENT,
} from "@shared/protocol.ts";
import type { Task } from "@shared/types.ts";
import type { MissionMcpRequirement } from "./mission-mcp.ts";
import type { CreateTaskInput } from "./tasks.ts";

/**
 * The two operations a tour may ask the daemon for.
 *
 * `dispatch` launches the tour's live demonstration task; `preview` creates the fixed
 * conversation a tour shows when the fleet is empty. A tour declares only the ones it uses,
 * and one it does not declare is refused rather than falling through to general dispatch.
 */
export type TourOperation = "dispatch" | "preview";

export interface TourTaskRecipe {
  /**
   * Every launch property except the repository. The browser body chooses a repo root and
   * nothing else, which is what keeps a tour route from becoming a second dispatcher.
   */
  create: Omit<CreateTaskInput, "repoRoot" | "extraRepoRoots">;
  /** Present when the recipe launches immediately. Absent leaves the task in the backlog. */
  dispatch?: { overrideDisabled: true; missionMcp: MissionMcpRequirement };
  /** The outcome recorded when this task is closed. */
  outcome: string;
  /**
   * Whether a task really is this recipe's.
   *
   * Checked before any cleanup runs, against the title, labels, and intent prefix the recipe
   * itself wrote. This is the whole reason the complete route cannot reach a task the tour
   * did not create, and it is deliberately an exact match rather than a prefix scan.
   */
  identifies: (task: Task) => boolean;
}

export interface ServerTourDefinition {
  id: string;
  /** The recipes this tour may launch, by operation. */
  operations: Partial<Record<TourOperation, TourTaskRecipe>>;
}

const SEE_WORK_DEMO: TourTaskRecipe = {
  create: {
    title: "Tour demo",
    intent: SEE_WORK_TOUR_DEMO_INTENT,
    kind: "ship",
    agent: "codex",
    model: "gpt-5.6-terra",
    workflowId: null,
    backlog: true,
    dependencies: [],
    priority: null,
    labels: ["tour-demo"],
  },
  dispatch: { overrideDisabled: true, missionMcp: { tools: ["request_input"] } },
  outcome: "Tour demo",
  identifies: (task) =>
    task.title === "Tour demo" &&
    task.labels.includes("tour-demo") &&
    task.intent.startsWith("[Mission Control See the work tour demo]"),
};

const SEE_WORK_PREVIEW: TourTaskRecipe = {
  create: {
    title: "Tour conversation",
    intent: SEE_WORK_TOUR_PREVIEW_INTENT,
    kind: "chat",
    agent: "codex",
    workflowId: null,
    backlog: false,
    dependencies: [],
    priority: null,
    labels: ["tour-demo", "tour-preview"],
  },
  outcome: "Tour conversation",
  identifies: (task) =>
    task.title === "Tour conversation" &&
    task.kind === "chat" &&
    task.labels.includes("tour-preview") &&
    task.intent.startsWith("[Mission Control See the work tour conversation]"),
};

/**
 * Every tour the daemon will act for.
 *
 * The browser names a tour by id; this table decides what that name may do. An unknown id,
 * or an operation a tour did not declare, is refused before any task is created - so the
 * generalized route family widened the shape of the URL without widening its authority.
 */
export const SERVER_TOURS: Readonly<Record<string, ServerTourDefinition>> = {
  "see-work": {
    id: "see-work",
    operations: { dispatch: SEE_WORK_DEMO, preview: SEE_WORK_PREVIEW },
  },
};

export function serverTour(tourId: string | undefined): ServerTourDefinition | null {
  return tourId && Object.hasOwn(SERVER_TOURS, tourId) ? SERVER_TOURS[tourId]! : null;
}

/** The recipe a tour's task matches, or null when the task does not belong to that tour. */
export function tourRecipeFor(tour: ServerTourDefinition, task: Task): TourTaskRecipe | null {
  return Object.values(tour.operations).find((recipe) => recipe.identifies(task)) ?? null;
}
