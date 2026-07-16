import { envVar } from "../config.ts";
import { createLimiter, parseModelJson, runStructured } from "../claude-cli.ts";
import { unref } from "../util/timers.ts";
import { EvaluationDebounce } from "../util/debounce.ts";
import { GOAL_UNSUPPORTED } from "@shared/goal.ts";
import type { Registry } from "../registry.ts";
import type { Session, SessionGoal } from "@shared/types.ts";
import { buildGoalPrompt, GoalSchema } from "./prompt.ts";
import { goalSourceFor } from "./source.ts";

// Tier 2: rewrite each session's raw prompt into the sentence its card shows, with one
// headless `claude -p` on Haiku.
//
// A poller rather than an event listener, on purpose. The trigger is entirely in the data -
// Tier 1 stamps `source: "heuristic"` on every new prompt, and this stamps `"model"` when it
// has summarised one - so a restart resumes correctly with no in-memory state to rebuild,
// and rapid prompts collapse into one refresh instead of queueing a call each.
//
// Nothing here is configurable (Q3: no kill switch). The silent fallback is error handling,
// not configuration: if `claude` is missing, logged out, or slow, the card quietly keeps its
// Tier 1 goal and nothing breaks.

/** How often to look for a goal needing refinement. Cheap: a map lookup per live session. */
const GOAL_POLL_MS = Number(envVar("GOAL_POLL_MS") ?? 5000);
/**
 * Per-session floor between refinements. A session answering prompts in quick succession
 * would otherwise spawn a subprocess per prompt; the first sighting is always due
 * immediately, so a new session's goal still lands within a poll tick.
 */
const GOAL_REFRESH_MS = Number(envVar("GOAL_REFRESH_MS") ?? 60_000);
/**
 * Sized for Haiku emitting one short object from a ~12-turn window. Deliberately not the
 * reviewer's 120s: that budget is for Opus reading 48 turns with the whole POLICY, and a
 * goal that takes half a minute has already failed at being a glanceable status line.
 */
const GOAL_TIMEOUT_MS = Number(envVar("GOAL_TIMEOUT_MS") ?? 30_000);
/** Tier 2's model. Named explicitly: omitting `--model` inherits the CLI's default, which is
 *  both the priciest and the least predictable choice. */
const GOAL_MODEL = envVar("GOAL_MODEL") ?? "claude-haiku-4-5";
/**
 * Concurrent `claude -p` runs across every session.
 *
 * Per-caller by construction - `claude-cli.ts` owns no global count because the daemon and
 * the Foreman worker are separate processes and a module cannot cap across that boundary.
 * This is the daemon's own ceiling: a 20-card dashboard all answering prompts at once must not
 * fork 20 subprocesses.
 */
const GOAL_CONCURRENCY = 2;
/**
 * How often to sweep orphaned goals, and how stale one must be to go.
 *
 * Hourly like the transcript pruner, and for the same reason: this is storage hygiene, not a
 * deadline. A week rather than the transcripts' day because a goal is far cheaper to keep and
 * an orphan is not always garbage - a `/clear` rotates the note key and strands the old row
 * while the human is still working in that session, and a daemon restart re-reads the table.
 * Seven days is comfortably past the point where anything could still want the row back.
 */
const GOAL_PRUNE_INTERVAL_MS = Number(envVar("GOAL_PRUNE_INTERVAL_MS") ?? 60 * 60 * 1000);
const GOAL_PRUNE_AGE_MS = Number(envVar("GOAL_PRUNE_AGE_MS") ?? 7 * 24 * 60 * 60 * 1000);

export function startGoalRefiner(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Rides the existing 5s poll rather than owning a timer, so it inherits the tick's
   * stop/restart and error handling. `0` means "never swept", so the first tick past
   * `sessionsObserved` prunes - the sweep that matters, since a daemon that has just restarted is
   * holding every orphan the table ever accumulated.
   */
  let lastPrune = 0;
  const limit = createLimiter(GOAL_CONCURRENCY);
  const debounce = new EvaluationDebounce(GOAL_REFRESH_MS);
  /**
   * The prompt whose refinement last failed, per session.
   *
   * This is the whole of the no-retry-storm rule (Q3). Without it a failing `claude` leaves
   * `source: "heuristic"` set forever, so every tick would re-offer the same session and the
   * debounce would faithfully spawn a doomed subprocess every 60s for as long as the session
   * lives. Keyed on the PROMPT, so a new instruction always gets a fresh attempt - what is
   * abandoned is one summary, not the session.
   *
   * In-memory on purpose: a daemon restart retrying once per session is the cheap, correct
   * side of that trade, and it is how a transient outage eventually heals.
   */
  const failedFor = new Map<string, string>();

  const tick = (): void => {
    if (stopped) return;
    try {
      const live = registry.liveSessions();
      for (const s of live) {
        const goal = dueForRefine(registry, s, failedFor);
        if (!goal) continue;
        // Claimed only once everything else says go, because a claim consumes the window
        // whether or not any work follows it.
        if (!debounce.claim(s.id)) continue;
        void refine(registry, s, goal, limit, failedFor);
      }
      const liveIds = new Set(live.map((x) => x.id));
      for (const id of failedFor.keys()) if (!liveIds.has(id)) failedFor.delete(id);
      const now = Date.now();
      // `sessionsObserved` before the window, not inside it: this tick runs before the poller's
      // first sweep has returned, and claiming the hour on a sweep the registry is going to
      // refuse would push the boot prune - the one that matters - a full hour out.
      if (registry.sessionsObserved() && now - lastPrune >= GOAL_PRUNE_INTERVAL_MS) {
        lastPrune = now;
        const n = registry.pruneGoals(now - GOAL_PRUNE_AGE_MS);
        if (n > 0) console.log(`[goal] pruned ${n} orphaned goal(s)`);
      }
    } catch (err) {
      console.error("[goal] poll failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, GOAL_POLL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** The goal to refine for this session, or null when there's nothing to do. */
function dueForRefine(
  registry: Registry,
  s: Session,
  failedFor: Map<string, string>,
): SessionGoal | null {
  if (GOAL_UNSUPPORTED[s.agent]) return null;
  const goal = registry.getGoal(s.id);
  if (!goal?.prompt) return null;
  // `source` IS the queue: Tier 1 sets "heuristic" on each new prompt, and a success below
  // sets "model". So "already summarised, nothing new since" needs no extra state.
  if (goal.source === "model") return null;
  if (failedFor.get(s.id) === goal.prompt) return null;
  return goal;
}

async function refine(
  registry: Registry,
  s: Session,
  goal: SessionGoal,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  failedFor: Map<string, string>,
): Promise<void> {
  try {
    await limit(async () => {
      const r = await runStructured<typeof GoalSchema>(
        buildGoalPrompt({
          session: s,
          // The sentence being upgraded, so "unchanged" is available as an answer.
          currentGoal: goal.text,
          prompt: goal.prompt,
          window: goalSourceFor(s.agent).readWindow(s),
        }),
        (raw) => parseModelJson(raw, GoalSchema),
        "Goal",
        { model: GOAL_MODEL, timeoutMs: GOAL_TIMEOUT_MS },
      );
      if (r.kind === "failed") {
        // Silent by design: the card keeps its Tier 1 goal and the human sees a slightly
        // rougher sentence, not an error. Logged once per prompt, never per tick.
        failedFor.set(s.id, goal.prompt!);
        console.error(`[goal] ${s.name}: ${r.reason}`);
        return;
      }
      // The prompt may have moved on while the model was thinking - the human sent another
      // instruction mid-call. Writing now would stamp "model" on a summary of the PREVIOUS
      // ask and, worse, `source` would then say this prompt was refined when it wasn't, so
      // the newer one would never be picked up. Drop it; the next tick summarises the new one.
      const current = registry.getGoal(s.id);
      if (current?.prompt !== goal.prompt) return;
      registry.upsertGoal(s.id, { text: r.value.goal, source: "model" });
    });
  } catch (err) {
    // `limit` only rejects if the body throws, which `runStructured` promises not to do -
    // but a poller must never die on a surprise, and an unhandled rejection here would take
    // the daemon down rather than one goal.
    console.error("[goal] refine failed:", err);
  }
}
