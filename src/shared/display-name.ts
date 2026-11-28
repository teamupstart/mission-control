// One rule for what an agent is called, on every surface that names one.
//
// Browser-safe: no `node:` import may reach this module. The input is plain values, never a
// live session, so a surface that outlives its session (a stored report) can name its agent
// from what it kept.

import { residentMarkerColor, type ResidentMarkerColorId, type ResidentRunSummary } from "./residents.ts";
import type { Session } from "./types.ts";
import { normalizeSpokenName, quotedReferenceName, taskKindTakesCallSign } from "./voice-names.ts";

/**
 * What an agent might be called, highest rank first:
 *
 *  1. `callSign` - a session's call sign (`Task.callSign`), or `resident.referenceName`, a
 *     resident's reference name (`identity.referenceName`). Both are names the operator chose
 *     to say, from the voice plan's names phase, and count only while the `voice` flag is on
 *     (`sessionDisplayNameInput`'s `spokenNames`).
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

export function agentNameLabel(display: AgentDisplayName): string {
  return display.source === "reference-name" ? quotedReferenceName(display.name) : display.name;
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

/**
 * A name in two parts, for a surface that prints both: `display` says what the agent is (a
 * resident's profile name, else its task title, else its session name) and `spoken` is the name
 * the operator says to address it (a call sign, else a resident's reference name), or null.
 *
 * `agentDisplayName` lets a spoken name stand in for the title, which leaves a surface showing
 * only "Granite"; this keeps the title and carries the spoken name beside it. A spoken name that
 * merely repeats the title is dropped, so nothing is printed twice.
 */
export interface AgentNamePair {
  display: AgentDisplayName;
  spoken: string | null;
}

export function agentNamePair(input: AgentDisplayNameInput): AgentNamePair {
  // The spoken part is whatever `agentDisplayName` ranks first when that is one of voice's names,
  // so the inbox badge follows the one precedence every other surface uses.
  const ranked = agentDisplayName(input);
  const spoken = ranked.source === "call-sign" || ranked.source === "reference-name" ? ranked.name : null;
  const display = agentDisplayName({
    ...input,
    callSign: null,
    resident: input.resident ? { ...input.resident, referenceName: null } : null,
  });
  return {
    display,
    spoken: spoken && normalizeSpokenName(spoken) !== normalizeSpokenName(display.name) ? spoken : null,
  };
}

/**
 * What the resolver reads from a live resident run: its task, its pinned name and colour, and
 * its reference name (see `withCurrentReferenceNames`).
 */
export type ResidentNameSource = Pick<ResidentRunSummary, "taskId"> & {
  currentProfileName?: string;
  settings: {
    identity: Pick<ResidentRunSummary["settings"]["identity"], "name" | "referenceName">;
    board: Pick<ResidentRunSummary["settings"]["board"], "colorId">;
  };
};

/**
 * The live runs as name sources, each carrying its profile's CURRENT reference name rather than
 * the one its pinned revision holds.
 *
 * A reference name is a spoken name, not a launch setting: nothing is provisioned from it, and
 * the voice roster reads it from the profile as it stands. Reading it the same way here keeps
 * the name a card prints the name the operator says, from the moment it is saved, without a
 * relaunch. With voice off the profile name stays pinned to the run. A run whose profile is not in
 * `profiles` keeps its pinned revision's reference name.
 */
export function withCurrentReferenceNames(
  runs: readonly (ResidentNameSource & Pick<ResidentRunSummary, "profileId">)[],
  profiles: readonly { id: string; settings: { identity: { name: string; referenceName?: string } } }[],
): ResidentNameSource[] {
  if (profiles.length === 0) return [...runs];
  const current = new Map(profiles.map((profile) => [profile.id, profile.settings.identity]));
  return runs.map((run) => {
    const profile = current.get(run.profileId);
    if (!profile) return run;
    const { referenceName } = profile;
    if (referenceName === run.settings.identity.referenceName && profile.name === run.settings.identity.name) return run;
    const { referenceName: _pinned, ...identity } = run.settings.identity;
    return {
      ...run,
      currentProfileName: profile.name,
      settings: { ...run.settings, identity: referenceName ? { ...identity, referenceName } : identity },
    };
  });
}

/**
 * The call sign a session answers to, or null. A resident's task never takes one
 * (`taskKindTakesCallSign`), so a stray one on it names nothing.
 */
export function sessionCallSign(
  session: { task?: Pick<NonNullable<Session["task"]>, "kind" | "callSign"> | null },
): string | null {
  return session.task && taskKindTakesCallSign(session.task.kind) ? present(session.task.callSign) : null;
}

/**
 * The resolver's input for a live session, joined to its resident run through the session's
 * task the way the board joins it (`residentMarksBySession`).
 *
 * `spokenNames` is the `voice` flag. Call signs and reference names are voice's names, so they
 * name an agent only while it is on: off, a saved one is kept but the ranks below it answer, as
 * they did before voice. Off by default, so a caller that does not say reads as before voice.
 *
 * A resident's task never names it by a call sign (`taskKindTakesCallSign`), the rule the voice
 * roster applies: the card prints a name the operator can say, its reference or profile name.
 */
export function sessionDisplayNameInput(
  session: Pick<Session, "name"> & { task?: Pick<NonNullable<Session["task"]>, "id" | "title" | "kind" | "callSign"> | null },
  runs: readonly ResidentNameSource[],
  spokenNames = false,
): AgentDisplayNameInput {
  const taskId = session.task?.id;
  const run = taskId ? runs.find((candidate) => candidate.taskId === taskId) : undefined;
  return {
    callSign: spokenNames ? sessionCallSign(session) : null,
    resident: run
      ? {
          referenceName: spokenNames ? run.settings.identity.referenceName ?? null : null,
          name: spokenNames ? run.currentProfileName ?? run.settings.identity.name : run.settings.identity.name,
          colorId: residentMarkerColor(run.settings.board.colorId),
        }
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
