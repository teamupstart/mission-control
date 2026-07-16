import type { AgentType, Session } from "@shared/types.ts";
import { readTranscriptWindow, resolveTranscriptPath } from "../transcript.ts";
import type { TranscriptWindow } from "../transcript.ts";

// How the daemon reads what a session is working on, one implementation per agent type.
//
// Split out rather than inlined because Codex support is a stated "not now, but will" - so
// adding it must be dropping a reader in here, not restructuring the refiner. The other half
// of that seam is `GOAL_UNSUPPORTED` in shared/goal.ts, which is what a card says until this
// module can answer for an agent.

/** The opening turns: the goal a human set is stated up front, and this keeps it in view
 *  even after the session has run long past it. */
const GOAL_HEAD_TURNS = 6;
/**
 * The recent turns. Deliberately smaller than the reviewer's 48: this call summarises intent
 * in one sentence, not "what happened", and every extra turn is Haiku input on a call that
 * may run once a minute per card. The head is what carries the goal; the tail is only there
 * so a session that has MOVED ON is described by what it moved to.
 */
const GOAL_TAIL_TURNS = 12;

/**
 * A per-agent reader of the material Tier 2 summarises.
 *
 * Only the window varies by agent. Tier 1 needs no entry here: it runs off the prompt the
 * hook already delivered, and an agent without hooks simply never reaches it.
 */
export interface GoalSource {
  /**
   * A bounded window of the session's recent conversation, or null when there is nothing
   * readable - no transcript yet, a file that vanished, or an agent we cannot read at all.
   * Null means "summarise from the prompt alone", never an error.
   */
  readWindow(s: Session): TranscriptWindow | null;
}

const claudeSource: GoalSource = {
  readWindow(s) {
    const path = resolveTranscriptPath(s);
    if (!path) return null;
    const w = readTranscriptWindow(path, GOAL_HEAD_TURNS, GOAL_TAIL_TURNS);
    return w.messages.length > 0 ? w : null;
  },
};

const codexSource: GoalSource = {
  // Not a placeholder for its own sake - this is exactly where a rollout message reader
  // lands, and until one exists `GOAL_UNSUPPORTED.codex` is what the card says. Returning
  // null rather than guessing is the point: no rollout file has ever existed on this
  // machine, so any parsing written now would be unverified fiction.
  readWindow: () => null,
};

const SOURCES: Record<AgentType, GoalSource> = {
  claude: claudeSource,
  codex: codexSource,
};

export function goalSourceFor(agent: AgentType): GoalSource {
  return SOURCES[agent];
}
