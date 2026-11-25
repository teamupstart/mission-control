import { createContext, useContext } from "react";
import {
  agentDisplayName,
  agentNameColor,
  agentNameLabel,
  sessionDisplayNameInput,
  type ResidentNameSource,
} from "@shared/display-name.ts";
import { INBOX_FLAG } from "@shared/inbox.ts";
import { VOICE_FLAG } from "@shared/voice.ts";
import type { ResidentMarkerColorId } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";

/**
 * The live resident runs, provided once by App, so every surface that names an agent joins a
 * session to its resident the same way.
 */
export const ResidentNamesContext = createContext<readonly ResidentNameSource[]>([]);

/** A name as a surface draws it: the text, and the board colour it is drawn in, if any. */
export interface AgentNameView {
  name: string;
  colorId: ResidentMarkerColorId | null;
}

export type NamedSession = Pick<Session, "name"> & {
  task?: Pick<NonNullable<Session["task"]>, "id" | "title" | "kind" | "callSign"> | null;
};

/**
 * The name one surface prints for a session. `legacy` is exactly what that surface printed
 * before the `inbox` flag, and it is what the flag off still prints; the flag on prints
 * `agentDisplayName`, in a resident's board colour when a resident name won. `spokenNames` is
 * the `voice` flag: off, a call sign or reference name does not name the agent.
 */
export function agentNameView(
  session: NamedSession,
  legacy: string,
  enabled: boolean,
  runs: readonly ResidentNameSource[],
  spokenNames = false,
): AgentNameView {
  if (!enabled) return { name: legacy, colorId: null };
  const input = sessionDisplayNameInput(session, runs, spokenNames);
  const display = agentDisplayName(input);
  return { name: agentNameLabel(display), colorId: agentNameColor(input, display) };
}

/** `agentNameView` for a component, from the `inbox` and `voice` flags and `ResidentNamesContext`. */
export function useAgentName(session: NamedSession, legacy: string): AgentNameView {
  const enabled = useFeatureFlag(INBOX_FLAG);
  const spokenNames = useFeatureFlag(VOICE_FLAG);
  const runs = useContext(ResidentNamesContext);
  return agentNameView(session, legacy, enabled, runs, spokenNames);
}

/** Whether the `inbox` naming rule is on, for a surface that only adds a name while it is. */
export function useAgentNamesEnabled(): boolean {
  return useFeatureFlag(INBOX_FLAG);
}

/**
 * Whether cards show each control's spoken form. Off until the voice plan turns it on; every
 * `SpokenHint` reads it, so turning it on is one provider.
 */
export const VoiceHintsContext = createContext(false);
