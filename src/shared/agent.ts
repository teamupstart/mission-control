import type { AgentType } from "./types.ts";

/**
 * How each agent PRESENTS itself, in every place a surface has to name one or draw one.
 *
 * One map rather than one per component. There were two, holding different values
 * for the same key - `session-bits.tsx` said "Claude Code" while `TranscriptPanel.tsx`
 * said "claude" - and because both were spelled `AGENT_LABEL`, the disagreement read
 * as drift rather than as the deliberate distinction it is. Naming the registers
 * keeps them from collapsing into each other on the next edit, and gives a new harness
 * one place that will not compile until it has said how it is presented.
 *
 * Was `AGENT_NAMES` while it held only the two names. The colour joined it rather than
 * starting a second `Record<AgentType, …>` beside it in this same module: name and
 * colour are one question ("who is this, to a human?"), asked at the same surfaces, and
 * two records of the same purity over the same domain would be a list to keep in step.
 * It is deliberately NOT on `HarnessCapabilities` - an accent is not something an agent
 * can DO - and deliberately not on the server-side `Harness`, which the browser cannot
 * import.
 */
export interface AgentIdentity {
  /** The product's own name, for chrome that identifies the vendor. */
  label: string;
  /** The turn byline in a transcript, lowercase so it sits beside "you". */
  speaker: string;
  /**
   * The agent's brand colour, as a literal CSS colour - the dot beside its title, and
   * the byline over its half of a transcript.
   *
   * A VALUE, not `var(--claude)`. That distinction is the whole point: a token name
   * would mean a new harness renders an unstyled dot until someone also edits
   * `styles.css`, which is precisely the coupling this phase removes. The stylesheet
   * reads it back through one `--agent-accent` custom property that the components set
   * (`agentAccentStyle`), so there is no per-agent rule anywhere in it.
   *
   * Test: `agent-accent.test.ts`, which fails if a harness id shows up in `styles.css`.
   */
  accent: string;
}

export const AGENT_IDENTITY: Record<AgentType, AgentIdentity> = {
  claude: { label: "Claude Code", speaker: "claude", accent: "#d97757" },
  codex: { label: "Codex", speaker: "codex", accent: "#10a37f" },
};

/**
 * A set of agents said out loud - "Claude Code or Codex", "Claude Code, Codex and Pi".
 *
 * Here rather than at the three panels that need it, because the alternative is what
 * this phase is undoing: sentences that enumerate today's harnesses by hand and quietly
 * go on omitting tomorrow's. The conjunction is the caller's, since "reached by X or Y"
 * and "unaffected: X and Y" are both wanted.
 */
export function agentList(agents: readonly AgentType[], conj: "and" | "or" = "or"): string {
  const names = agents.map((a) => AGENT_IDENTITY[a].label);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} ${conj} ${names.at(-1)}`;
}
