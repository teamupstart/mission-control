import { envVar } from "../config.ts";
import { runJobStructured } from "../llm/jobs.ts";
import { createLimiter, parseModelJson } from "../llm/structured.ts";
import { unref } from "../util/timers.ts";
import { EvaluationDebounce } from "../util/debounce.ts";
import { GOAL_UNSUPPORTED } from "@shared/goal.ts";
import type { Registry } from "../registry.ts";
import type { Session, SessionGoal } from "@shared/types.ts";
import { buildGoalPrompt, GoalSchema } from "./prompt.ts";
import { readGoalWindow } from "./source.ts";

// Tier 2: reconcile each human prompt with the durable session objective, in captured
// revision order, with one headless model call on the cheap tier.
//
// A poller rather than an event listener, on purpose. The trigger is entirely in the data -
// Tier 1 increments `promptRevision` on every new prompt, and this advances
// `resolvedPromptRevision` when it has classified one - so a restart resumes correctly,
// and rapid prompts remain a durable ordered queue across debounce windows and restarts.
//
// There is still no kill switch (Q3). Failure handling is fail-closed, not configuration: if
// the provider is missing, logged out, or slow, the card keeps its last durable objective and
// automatic completion stays paused at the unresolved revision. What IS configurable is which
// provider and which model - the `goal` job in `@shared/llm-jobs.ts`, edited in Settings,
// resolved per call.

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
 * reviewer's 120s: that budget is for Opus reading a 60-turn head+tail window with the whole
 * POLICY, and a
 * goal that takes half a minute has already failed at being a glanceable status line.
 */
const GOAL_TIMEOUT_MS = Number(envVar("GOAL_TIMEOUT_MS") ?? 30_000);
/**
 * Concurrent model runs across every session.
 *
 * Per-caller by construction - `llm/structured.ts` owns no global count because the daemon
 * and the Foreman worker are separate processes and a module cannot cap across that boundary.
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
   * The pending revision whose intent reconciliation last failed, per session.
   *
   * This closes the retry race around the durable `unclear` stamp below. Without either
   * guard, every tick would re-offer the same session and the debounce would faithfully
   * spawn a doomed subprocess every 60s. Keyed on the prompt, so a new instruction always
   * gets a fresh attempt with the newer context. What is paused is one classification, not
   * the session, and no later revision can leapfrog it.
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
        const pending = dueForRefine(registry, s, failedFor);
        if (!pending) continue;
        // Claimed only once everything else says go, because a claim consumes the window
        // whether or not any work follows it.
        if (!debounce.claim(s.id)) continue;
        void refine(registry, s, pending, limit, failedFor);
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
        // The invite table shares the goal table's accumulation shape (a row per key a
        // dispatch ever touched, stranded for good by any rotation the daemon missed),
        // so it prunes on the same tick, window, and live-key safety property.
        const invites = registry.pruneForemanInvites(now - GOAL_PRUNE_AGE_MS);
        if (invites > 0) console.log(`[goal] pruned ${invites} orphaned foreman invite(s)`);
        // And launch presentation markers, which accumulate the same way for the same
        // reason: one row per conversation Mission Control ever launched, stranded for good
        // by every /clear that follows. Same tick, same window, same live-key safety
        // property - a third timer would be a third place to get that property wrong.
        const launches = registry.pruneLaunchTurns(now - GOAL_PRUNE_AGE_MS);
        if (launches > 0) console.log(`[goal] pruned ${launches} orphaned launch marker(s)`);
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

interface PendingRefinement {
  goal: SessionGoal;
  prompt: SessionGoal["pendingPrompts"][number];
}

function failureKey(pending: PendingRefinement): string {
  // Include the current queue tail. A newly captured instruction is new context worth one
  // retry of the blocked head, while identical polls remain suppressed.
  return `${pending.prompt.revision}:${pending.prompt.prompt ?? "<lost>"}:${pending.goal.promptRevision}`;
}

function comparableObjective(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Amendments may extend the completion contract, never rewrite it from scratch. Requiring
 * the prior contract as the explicit prefix makes preservation mechanically checkable
 * instead of trusting a schema-valid model classification to preserve it semantically.
 */
function amendmentPreservesObjective(current: string | null, proposed: string): boolean {
  if (!current) return false;
  const prior = comparableObjective(current);
  const next = comparableObjective(proposed);
  if (!prior || !next.startsWith(prior)) return false;
  const addition = next.slice(prior.length).trim();
  if (!/^(?:[.;,:+-]\s*)?(?:also\b|additionally\b|and\b|plus\b)/.test(addition)) return false;
  return !/(?:\b(?:but|except|instead|drop|remove|omit|ignore|discard|relax|weaken|narrow|replace|supersede|abandon|cancel|undo|retract)\b|\bno longer\b|\bnot required\b|\bneed not\b|\brather than\b)/.test(
    addition,
  );
}

/** The oldest unresolved prompt, or null when there is nothing safe to reconcile. */
function dueForRefine(
  registry: Registry,
  s: Session,
  failedFor: Map<string, string>,
): PendingRefinement | null {
  if (GOAL_UNSUPPORTED[s.agent]) return null;
  const goal = registry.getGoal(s.id);
  if (!goal?.prompt) return null;
  // The revision pair gates completion; the persisted prompt list preserves the content and
  // order behind that gap. The objective's display source cannot represent either fact.
  if (goal.resolvedPromptRevision >= goal.promptRevision) return null;
  const prompt = goal.pendingPrompts[0] ?? {
    // A defensive fail-closed barrier for an in-memory fixture or corrupt row that claims an
    // unresolved gap without its durable prompt queue.
    revision: goal.resolvedPromptRevision + 1,
    prompt: null,
  };
  const pending = { goal, prompt };
  if (failedFor.get(s.id) === failureKey(pending)) return null;
  return pending;
}

async function refine(
  registry: Registry,
  s: Session,
  pending: PendingRefinement,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
  failedFor: Map<string, string>,
): Promise<void> {
  const { goal, prompt } = pending;
  try {
    await limit(async () => {
      if (!prompt.prompt) {
        // A pre-queue build already discarded this revision's text. Nothing can honestly
        // classify it now, so keep the revision unresolved and automation paused.
        failedFor.set(s.id, failureKey(pending));
        const current = registry.getGoal(s.id);
        if (current?.pendingPrompts[0]?.revision === prompt.revision) {
          registry.upsertGoal(s.id, {
            relationship: "unclear",
            rationale:
              "An earlier unresolved instruction was not durably captured; automatic wrap-up remains paused.",
          });
        }
        return;
      }
      const r = await runJobStructured<typeof GoalSchema>(
        "goal",
        buildGoalPrompt({
          session: s,
          currentObjective: goal.objective,
          initial: prompt.revision === 1,
          prompt: prompt.prompt,
          window: readGoalWindow(s),
        }),
        (raw) => parseModelJson(raw, GoalSchema),
        "Goal",
        { timeoutMs: GOAL_TIMEOUT_MS },
      );
      if (r.kind === "failed") {
        // Fail closed for completion: keep the objective, mark the relationship unclear, and
        // leave this revision at the head so no later steering prompt can leapfrog it. The
        // failure key prevents a retry storm until new human context arrives.
        failedFor.set(s.id, failureKey(pending));
        const current = registry.getGoal(s.id);
        if (
          current?.pendingPrompts[0]?.revision === prompt.revision &&
          current.pendingPrompts[0].prompt === prompt.prompt
        ) {
          registry.upsertGoal(s.id, {
            relationship: "unclear",
            rationale: `Intent could not be reconciled: ${r.reason}`,
          });
        }
        console.error(`[goal] ${s.name}: ${r.reason}`);
        return;
      }
      // Newer prompts may arrive while the model is thinking. That is safe: they append after
      // this durable head. Only abandon the result if the head or the objective it was judged
      // against changed, which means another reconciliation won the race.
      const current = registry.getGoal(s.id);
      if (
        current?.pendingPrompts[0]?.revision !== prompt.revision ||
        current.pendingPrompts[0].prompt !== prompt.prompt ||
        current.objectiveVersion !== goal.objectiveVersion
      ) return;

      const initial = prompt.revision === 1;
      let relationship = r.value.relationship;
      if (initial) relationship = "initial";
      else if (relationship === "initial") relationship = "unclear";

      const currentObjective = current.objective ?? current.text ?? null;
      if (
        relationship === "amend" &&
        !amendmentPreservesObjective(currentObjective, r.value.objective)
      ) {
        // A model can choose the right relationship while returning a narrower objective.
        // Keep this revision unresolved at the queue head so later steering cannot make
        // automatic wrap-up eligible against the older or proposed smaller contract.
        failedFor.set(s.id, failureKey(pending));
        registry.upsertGoal(s.id, {
          relationship: "unclear",
          rationale:
            "The proposed amendment did not explicitly preserve the current objective; automatic wrap-up remains paused.",
        });
        return;
      }

      // A steering or unclear classification is not authorised to shrink the completion
      // contract. Amend and replace are the only relationships that may change it.
      const mayChangeObjective =
        relationship === "amend" || relationship === "replace" || relationship === "initial";
      const objective = mayChangeObjective
        ? r.value.objective
        : currentObjective ?? current.prompt;
      const text = mayChangeObjective ? r.value.goal : current.text;
      const objectiveChanged = objective !== current.objective;
      const objectiveVersion =
        relationship === "initial"
          ? Math.max(1, current.objectiveVersion)
          : relationship === "amend" || relationship === "replace"
            ? current.objectiveVersion + (objectiveChanged ? 1 : 0)
            : current.objectiveVersion;

      registry.upsertGoal(s.id, {
        objective,
        text,
        source: "model",
        // While a newer instruction waits, the UI keeps showing that latest captured focus.
        // Resolving an older transition must not make the drawer appear to move backwards.
        focus: current.pendingPrompts.length === 1 ? r.value.focus : current.focus,
        relationship,
        rationale: r.value.reason,
        objectiveVersion,
        resolvedPromptRevision: prompt.revision,
        pendingPrompts: current.pendingPrompts.slice(1),
      });
      failedFor.delete(s.id);
    });
  } catch (err) {
    // `limit` only rejects if the body throws, which `runStructured` promises not to do -
    // but a poller must never die on a surprise, and an unhandled rejection here would take
    // the daemon down rather than one goal.
    console.error("[goal] refine failed:", err);
  }
}
