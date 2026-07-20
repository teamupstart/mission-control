import type { Session } from "@shared/types.ts";
import { sessionMessages } from "../harness/index.ts";
import type { TranscriptWindow } from "../harness/types.ts";

// How the daemon reads what a session is working on.
//
// This was a `Record<AgentType, GoalSource>` with one reader per agent, of which Claude's
// called `resolveTranscriptPath` and Codex's returned null - which is the harness's
// `transcript.messages` capability, spelled a second time. The second spelling is the
// thing worth deleting: a harness that gained a message reader would have had to remember
// to also come here, and the failure of forgetting is a card that stays blank with
// nothing pointing at why.
//
// So there is one reader now, and the only per-agent decision left is the one the harness
// itself declares. The other half of the seam is `GOAL_UNSUPPORTED` (shared/goal.ts),
// which is what a card says when it can never be filled in; `harness-transcript.test.ts`
// pins that an agent claiming no goals is one whose harness reads no messages.

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
 * A bounded window of the session's recent conversation, or null when there is nothing
 * readable - no transcript yet, a file that vanished, or a harness whose record carries no
 * turns at all. Null means "summarise from the prompt alone", never an error.
 *
 * Tier 1 needs nothing from here: it runs off the prompt the hook already delivered, and
 * an agent without hooks simply never reaches it.
 */
export function readGoalWindow(s: Session): TranscriptWindow | null {
  const t = sessionMessages(s);
  if (!t) return null;
  const w = t.read.window(t.path, GOAL_HEAD_TURNS, GOAL_TAIL_TURNS);
  return w.messages.length > 0 ? w : null;
}
