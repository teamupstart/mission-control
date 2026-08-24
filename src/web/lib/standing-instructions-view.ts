import {
  harnessOffersRuntime,
  standingInstructionsChannel,
} from "@shared/harness-capabilities.ts";
import type { StandingInstructionsMechanism } from "@shared/standing-instructions.ts";
import { AGENT_TYPES, SESSION_RUNTIMES } from "@shared/types.ts";
import type { AgentType, SessionRuntime } from "@shared/types.ts";

// How a standing-instructions delivery is put into words, and which sessions it reaches.
//
// Presentation, deliberately in `src/web/lib` rather than in `src/shared`: the mechanism
// VOCABULARY is a persisted wire contract and lives beside the store, but the English for
// it is this dashboard's, and `src/shared` is wire contracts and browser-safe shared logic
// only. Three surfaces read this one module - the settings panel's reach block, the
// dispatch note and the session chip - so the sentence an operator is told at the point of
// writing a rule and the sentence they are told at the point it is sent cannot drift.

/** What a mechanism is called, and the exact seam that carries it. */
export interface MechanismProse {
  /** The kind of channel, in the words a person would use. */
  channel: string;
  /** The precise seam, named so an operator can go and look for it. */
  detail: string;
  /**
   * Whether the text ever appears in the conversation.
   *
   * The reason a marker names the mechanism at all: on Claude the block rides the system
   * prompt and never enters the transcript, so a marker that only said "sent" would send
   * an operator searching a conversation for something that was never in it.
   */
  inTranscript: boolean;
}

export const MECHANISM_PROSE: Record<StandingInstructionsMechanism, MechanismProse> = {
  none: {
    channel: "nothing is sent",
    detail: "no repository in this launch has standing instructions",
    inTranscript: false,
  },
  "prompt-prefix": {
    channel: "prompt text",
    detail: "composed above turn one",
    inTranscript: true,
  },
  "claude-append-system-prompt": {
    channel: "system prompt",
    detail: "--append-system-prompt",
    inTranscript: false,
  },
  "claude-sdk-system-prompt-append": {
    channel: "system prompt",
    detail: "systemPrompt.append",
    inTranscript: false,
  },
  "codex-developer-instructions": {
    channel: "developer instructions",
    detail: "developerInstructions",
    inTranscript: false,
  },
};

/** One `✓` line of the reach block: a harness · runtime pair and the channel it uses. */
export interface ReachPair {
  agent: AgentType;
  runtime: SessionRuntime;
  /** `claude · terminal`, as the row labels it. */
  label: string;
  mechanism: StandingInstructionsMechanism;
  prose: MechanismProse;
}

/**
 * Every harness · runtime pair a standing instruction reaches, and how.
 *
 * DERIVED from the harness registry rather than typed out, which is a deliberate deviation
 * from the phase file's five hand-written rows. The registry is already the single source
 * for whether a pair has an out-of-band channel - `composeStandingInstructions` reads
 * `standingInstructionsChannel` for exactly this question at launch - so deriving the block
 * here means the panel cannot claim a reach the launch does not deliver. Ship a harness, or
 * give an existing one a new runtime, and the row appears with the right mechanism instead
 * of the block quietly going stale, which is the specific way a reach block becomes the
 * "trusted and wrong" thing it exists to prevent.
 *
 * `?? "prompt-prefix"` mirrors the composer exactly: a pair with no channel of its own is
 * prefixed into turn one, and is reached, not excluded.
 */
export function reachPairs(): ReachPair[] {
  const rows: ReachPair[] = [];
  for (const agent of AGENT_TYPES) {
    for (const runtime of SESSION_RUNTIMES) {
      if (!harnessOffersRuntime(agent, runtime)) continue;
      const mechanism = standingInstructionsChannel(agent, runtime) ?? "prompt-prefix";
      rows.push({
        agent,
        runtime,
        label: `${agent} · ${runtime}`,
        mechanism,
        prose: MECHANISM_PROSE[mechanism],
      });
    }
  }
  return rows;
}

/**
 * The rows that are NOT a harness pair, and are as required as the ones that are.
 *
 * Each renders an approved product boundary rather than a gap, which is why both `✗` rows
 * are shipped strings and not an omission. Without the review-prompts row the panel reads
 * as though a rule written here also governs the Inspector's review of the resulting pull
 * request - so an operator who writes "never run E2E tests locally" would be entitled to
 * expect the Inspector not to flag their absence, and would be wrong.
 *
 * The `⏱` row is about WHEN rather than WHERE, which is why it is a row and not a footnote:
 * an operator who edits a rule with five sessions open needs to know before they go looking
 * that none of the five changed. A live process's system prompt cannot be rewritten, so the
 * alternative was never "edits reach running sessions".
 */
export const REACH_EXCLUSIONS = [
  {
    glyph: "✗",
    subject: "sessions started outside Mission Control",
    note: "not reachable - Mission Control launches only",
  },
  {
    glyph: "✗",
    subject: "Foreman / Inspector / Persona review prompts",
    note: "not in scope - sessions only",
  },
  {
    glyph: "⏱",
    subject: "sessions already running",
    note: "keep what they launched with - an edit reaches the next session",
  },
] as const;

/** `291 characters · as a system prompt`, the marker's one line. */
export function deliverySummary(text: string, mechanism: StandingInstructionsMechanism): string {
  const prose = MECHANISM_PROSE[mechanism];
  const n = text.length;
  return `${n.toLocaleString()} character${n === 1 ? "" : "s"} · as ${prose.channel}`;
}
