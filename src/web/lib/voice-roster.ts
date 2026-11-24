import { createContext } from "react";
import type { ResidentProfile } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import type { SpokenName } from "@shared/voice-names.ts";

// The dashboard's half of the voice roster (contract C): the roster the daemon publishes in the
// voice state, handed to the fields that check a new name against it, and the joins Voice
// settings draws from it.

export const NO_SPOKEN_NAMES: readonly SpokenName[] = Object.freeze([]);

/**
 * `VoiceState.roster`, provided once by App. Empty while voice is off, so a field drawn then
 * checks a name on its own words alone.
 */
export const VoiceRosterContext = createContext<readonly SpokenName[]>(NO_SPOKEN_NAMES);

/** The roster without one agent's own entry, so a name is never warned against itself. */
export function rosterWithout(roster: readonly SpokenName[], key: string | null): readonly SpokenName[] {
  return key === null ? roster : roster.filter((entry) => entry.key !== key);
}

/**
 * Live sessions no spoken name reaches: not running a task with a call sign and not a running
 * resident. They are answered through an open card by starting with "reply".
 */
export function sessionsWithoutSpokenName(sessions: readonly Session[], roster: readonly SpokenName[]): number {
  const addressed = new Set(roster.flatMap((entry) => (entry.state === "running" && entry.sessionId ? [entry.sessionId] : [])));
  return sessions.filter((session) => session.state !== "exited" && !addressed.has(session.id)).length;
}

/**
 * What a roster row calls the agent besides its spoken name: a resident's profile name, a
 * session's task title.
 */
export function rosterAgentName(entry: SpokenName, profiles: readonly Pick<ResidentProfile, "id" | "name">[]): string {
  if (entry.kind === "resident") {
    const profileId = entry.key.slice("resident:".length);
    return profiles.find((profile) => profile.id === profileId)?.name ?? entry.name;
  }
  return entry.role || entry.name;
}

/** How a roster state reads in a table. */
export const SPOKEN_NAME_STATE_LABEL: Record<SpokenName["state"], string> = {
  running: "Running",
  hibernated: "Hibernated",
  "not-running": "Not running",
};
