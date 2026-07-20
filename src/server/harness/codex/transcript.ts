import type { Session } from "@shared/types.ts";
import type { TranscriptSpec } from "../types.ts";
import { findRolloutForSession, readRolloutMeta } from "./rollout.ts";

// Codex's transcript capability: runtime metadata, and no messages.
//
// `messages: null` is the whole point of this file. A rollout carries the model, the
// reasoning effort and a cumulative token count - enough for the card's runtime row -
// and nothing that can be rendered as conversation. Answering a window read with `[]`
// would say "this session has said nothing", which no caller can distinguish from the
// truth, so the capability declines instead: the transcript pane, the Foreman's Tier 1
// window and the goal refiner all take their existing "no transcript" path.
//
// When a rollout message reader is written it lands here, as `messages`, and
// `GOAL_UNSUPPORTED.codex` (`@shared/goal.ts`) drops to null in the same change -
// `harness-transcript.test.ts` pins that those two agree.

/**
 * How long to wait before re-scanning the filesystem for a session that hasn't matched
 * a rollout yet. A rollout is found by walking a dated directory tree, so unlike
 * Claude's two `existsSync` calls it is not something to redo every tick.
 */
const RESCAN_MS = 30_000;

/** A cached lookup for one session (path null = looked, none yet). */
interface RolloutBinding {
  cwd: string;
  path: string | null;
  triedAt: number;
}

/**
 * The cache lives HERE, not in the poller.
 *
 * It was born in `runtime-meta.ts`, which meant the generic loop over every live session
 * carried a `Map<string, CodexBinding>` and a Codex-specific rescan constant. That is the
 * shape this migration exists to remove: a third harness that also has to search for its
 * file would have added a second map beside it, and the poller would have become the
 * place every vendor keeps its state.
 */
const bindings = new Map<string, RolloutBinding>();

/**
 * The rollout path for a session, cached. A found path is reused until the session's cwd
 * changes; a miss is retried only every `RESCAN_MS`, so a rollout-less session doesn't
 * trigger a filesystem walk every tick.
 */
function locate(s: Session): string | null {
  if (!s.cwd) return null;
  const now = Date.now();
  const hit = bindings.get(s.id);
  if (hit && hit.cwd === s.cwd && (hit.path !== null || now - hit.triedAt < RESCAN_MS)) {
    return hit.path;
  }
  const path = findRolloutForSession(s);
  bindings.set(s.id, { cwd: s.cwd, path, triedAt: now });
  return path;
}

export const codexTranscript: TranscriptSpec = {
  metaSource: "codex-rollout",
  locate,
  // No activity: a rollout's records aren't turns, so there is nothing to read an
  // idle/working state off. Codex sessions fall back to the pane, as they do today.
  passiveRead: (path) => ({ meta: readRolloutMeta(path), activity: null }),
  messages: null,
  retain: (live) => {
    for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id);
  },
};
