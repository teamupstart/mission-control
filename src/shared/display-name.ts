// One rule for what an agent is called, on every surface that names one.
//
// Browser-safe: no `node:` import may reach this module. The input is plain values, never a
// live session, so a surface that outlives its session (a stored report) can name its agent
// from what it kept.

import { residentMarkerColor, type ResidentMarkerColorId, type ResidentRunSummary } from "./residents.ts";
import type { Session } from "./types.ts";

/**
 * What an agent might be called, highest rank first:
 *
 *  1. `callSign` - a session's call sign, or `resident.referenceName`, a resident's reference
 *     name. Both are seams: the voice plan adds the fields, and until then they are unset.
 *  2. `resident.name` - a resident's profile name.
 *  3. `taskTitle` - the title of the task the session is working on, typed or generated.
 *  4. `sessionName` - the session's own name.
 */
export interface AgentDisplayNameInput {
  callSign?: string | null;
  resident?: {
    referenceName?: string | null;
    name: string;
    colorId: ResidentMarkerColorId;
  } | null;
  taskTitle?: string | null;
  sessionName?: string | null;
}

/** Which rank supplied the name. */
export type AgentDisplayNameSource =
  | "call-sign"
  | "reference-name"
  | "resident"
  | "task-title"
  | "session-name"
  | "fallback";

export interface AgentDisplayName {
  name: string;
  source: AgentDisplayNameSource;
  /** Whether a person may say this name to address the agent: only the first two ranks. */
  spoken: boolean;
}

/** What an agent is called when nothing names it. */
export const AGENT_NAME_FALLBACK = "a session";

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The display name, by the rank order on `AgentDisplayNameInput`. */
export function agentDisplayName(input: AgentDisplayNameInput): AgentDisplayName {
  const ranked: [string | null | undefined, AgentDisplayNameSource, boolean][] = [
    [input.callSign, "call-sign", true],
    [input.resident?.referenceName, "reference-name", true],
    [input.resident?.name, "resident", true],
    [input.taskTitle, "task-title", false],
    [input.sessionName, "session-name", false],
  ];
  for (const [value, source, spoken] of ranked) {
    const name = present(value);
    if (name) return { name, source, spoken };
  }
  return { name: AGENT_NAME_FALLBACK, source: "fallback", spoken: false };
}

/** What the resolver reads from a live resident run: its task and its pinned name and colour. */
export type ResidentNameSource = Pick<ResidentRunSummary, "taskId"> & {
  settings: {
    identity: Pick<ResidentRunSummary["settings"]["identity"], "name">;
    board: Pick<ResidentRunSummary["settings"]["board"], "colorId">;
  };
};

/**
 * The resolver's input for a live session, joined to its resident run through the session's
 * task the way the board joins it (`residentMarksBySession`).
 */
export function sessionDisplayNameInput(
  session: Pick<Session, "name"> & { task?: Pick<NonNullable<Session["task"]>, "id" | "title"> | null },
  runs: readonly ResidentNameSource[],
): AgentDisplayNameInput {
  const taskId = session.task?.id;
  const run = taskId ? runs.find((candidate) => candidate.taskId === taskId) : undefined;
  return {
    resident: run
      ? { name: run.settings.identity.name, colorId: residentMarkerColor(run.settings.board.colorId) }
      : null,
    taskTitle: session.task?.title ?? null,
    sessionName: session.name,
  };
}

/** The board colour a name is drawn in: a resident's, when one of its names won. */
export function agentNameColor(input: AgentDisplayNameInput, display: AgentDisplayName): ResidentMarkerColorId | null {
  return input.resident && (display.source === "resident" || display.source === "reference-name")
    ? input.resident.colorId
    : null;
}
