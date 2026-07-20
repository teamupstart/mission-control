import type { AgentType } from "./types.ts";

/**
 * What each agent is CALLED, in every place a surface has to name one.
 *
 * One map rather than one per component. There were two, holding different values
 * for the same key - `session-bits.tsx` said "Claude Code" while `TranscriptPanel.tsx`
 * said "claude" - and because both were spelled `AGENT_LABEL`, the disagreement read
 * as drift rather than as the deliberate distinction it is. Naming the two registers
 * keeps them from collapsing into each other on the next edit, and gives a new harness
 * one place that will not compile until it has said what to call itself.
 *
 * Both fields, because neither derives from the other: the transcript byline for
 * Claude Code is "claude", not "claude code".
 */
export interface AgentNames {
  /** The product's own name, for chrome that identifies the vendor. */
  label: string;
  /** The turn byline in a transcript, lowercase so it sits beside "you". */
  speaker: string;
}

export const AGENT_NAMES: Record<AgentType, AgentNames> = {
  claude: { label: "Claude Code", speaker: "claude" },
  codex: { label: "Codex", speaker: "codex" },
};
