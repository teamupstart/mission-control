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
 * Sized for Haiku emitting one short object from a ~12-turn window.
 *
 * Was 30s, reasoned against the wrong consequence: a goal that takes half a minute has
 * already failed at being a glanceable status line, which is true of the CARD but not of
 * what this call actually gates. An unresolved revision pauses automatic wrap-up and parks a
 * managed ship task with no owner - not a rendering delay. Measured on real headless Haiku
 * goal calls: five for five answered, at 28.2s, 56.9s, 28.3s, 52.0s and 31.2s, so the 30s cap
 * was killing three of five HEALTHY calls mid-flight, and (before `cause`-aware retry below)
 * every one of those got latched as a permanent "unclear" verdict. 120s is roughly 2x the
 * observed 56.9s maximum. Once the retry below is proven out, this cap could come back down -
 * but that would be a second unmeasured guess landing in the same change, so it stays here.
 */
const GOAL_TIMEOUT_MS = Number(envVar("GOAL_TIMEOUT_MS") ?? 120_000);
/**
 * How many times a TRANSPORT failure (spawn/timeout/exit - evidence about the machine, never
 * about the human's instruction) gets retried before this revision falls back to today's
 * fail-closed latch.
 *
 * No new timer: each attempt already rides the per-session `debounce` floor below
 * (`GOAL_REFRESH_MS`), so three attempts cost roughly one and two refresh windows of total
 * wait - an escalating budget for free, without a second scheduling mechanism next to the one
 * the poller already owns.
 */
const MAX_TRANSPORT_ATTEMPTS = 3;
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
   * Sessions with a refinement already inside the limiter or provider call.
   *
   * The debounce is a launch-rate floor, not an in-flight lock. A provider call that lasts
   * longer than that floor leaves the same durable prompt due on a later poll, which used to
   * launch a duplicate call for the same session. The durable compare-and-set discarded the
   * second result, but it could not unspend the second model run. Keep concurrency across
   * different sessions while admitting only one refinement per session at a time.
   */
  const refining = new Set<string>();
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
  /**
   * In-flight retry count for a TRANSPORT failure, per session, keyed the same way as
   * `failedFor` so a new instruction resets it exactly as it resets that latch.
   *
   * Cleaned up for dead sessions on the same sweep as `failedFor`, for the same reason: an
   * evicted session's id must not accumulate here forever. In-memory on purpose, same trade
   * as `failedFor` - a daemon restart forgets the count and starts a fresh three attempts,
   * which is the cheap, correct side of that trade.
   */
  const transportAttempts = new Map<string, { key: string; attempts: number }>();

  const tick = (): void => {
    if (stopped) return;
    try {
      const live = registry.liveSessions();
      for (const s of live) {
        const pending = dueForRefine(registry, s, failedFor);
        if (!pending) continue;
        if (refining.has(s.id)) continue;
        // Claimed only once everything else says go, because a claim consumes the window
        // whether or not any work follows it.
        if (!debounce.claim(s.id)) continue;
        refining.add(s.id);
        void refine(
          registry,
          s,
          pending,
          limit,
          failedFor,
          transportAttempts,
          () => stopped,
        ).finally(() => refining.delete(s.id));
      }
      const liveIds = new Set(live.map((x) => x.id));
      for (const id of failedFor.keys()) if (!liveIds.has(id)) failedFor.delete(id);
      for (const id of transportAttempts.keys()) if (!liveIds.has(id)) transportAttempts.delete(id);
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
        // And the launch standing-instruction snapshots, which accumulate identically -
        // one row per session that ever received one, up to 8,000 characters each. Same
        // tick, same window, same live-key safety property.
        const standing = registry.pruneStandingInstructions(now - GOAL_PRUNE_AGE_MS);
        if (standing > 0)
          console.log(`[goal] pruned ${standing} orphaned standing-instruction snapshot(s)`);
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
  transportAttempts: Map<string, { key: string; attempts: number }>,
  isStopped: () => boolean,
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
        {
          timeoutMs: GOAL_TIMEOUT_MS,
          // The observer exists precisely so a caller with a durable lifecycle can refuse the
          // JSON-syntax retry after its owner has stopped. Without one, `cause: "cancelled"`
          // is unreachable from this call site and the branch below is dead code: shutdown
          // arrives as a killed child, which is indistinguishable from a real transport
          // failure at the provider boundary. `finish` has nothing to record here - the
          // `llm_calls` ledger belongs to callers that write rows.
          observer: { start: () => !isStopped(), finish: () => {} },
        },
      );
      if (r.kind === "failed") {
        if (r.cause === "cancelled") {
          // The daemon is stopping mid-attempt (or stopped just before this one started).
          // Nothing here is evidence about the instruction OR the provider, so nothing is
          // written and nothing latches: the next poll - this daemon once it is back up,
          // or the next one - finds the same unresolved revision and tries again clean.
          return;
        }
        if (r.cause === "transport") {
          // A spawn/timeout/exit failure is evidence about the MACHINE, never about the
          // human's instruction, so it must not be stamped as an "unclear" verdict - that
          // value means the instruction itself was ambiguous, and `resolvedSessionIntent`
          // treats it as a durable answer. Retry a bounded number of times instead, riding
          // the per-session debounce floor below for spacing rather than owning a second
          // timer.
          //
          // Except when the refiner itself has already been stopped. Daemon shutdown runs
          // `stopGoalRefiner()` and THEN `killLiveLlmRuns()` (see `server/index.ts`), so a
          // call that was in flight across those two lines comes back as a killed child -
          // a transport failure by every signal the provider boundary can offer, and
          // actually a cancellation. No observer can catch that one: it is not between
          // attempts, it is inside one. Counting it would spend a retry the next daemon has
          // to repeat, and on the third such kill it would persist "the classifier could not
          // be reached" about a machine that was merely turned off.
          if (isStopped()) return;
          const key = failureKey(pending);
          const prior = transportAttempts.get(s.id);
          const attempts = (prior?.key === key ? prior.attempts : 0) + 1;
          if (attempts < MAX_TRANSPORT_ATTEMPTS) {
            transportAttempts.set(s.id, { key, attempts });
            console.error(
              `[goal] ${s.name}: transport attempt ${attempts}/${MAX_TRANSPORT_ATTEMPTS} failed, retrying: ${r.reason}`,
            );
            return;
          }
          // Retries exhausted. Fail closed like any other failure - keep the objective and
          // leave this revision at the head - but the persisted text must name the real
          // cause rather than claim ambiguity. `relationship` is left untouched (never set
          // to "unclear" here): the dashboard already renders this session as "resolving"
          // while any revision is unresolved and never surfaces `rationale` in that state,
          // so there is no card that would otherwise show a stale relationship either.
          transportAttempts.delete(s.id);
          failedFor.set(s.id, key);
          const current = registry.getGoal(s.id);
          if (
            current?.pendingPrompts[0]?.revision === prompt.revision &&
            current.pendingPrompts[0].prompt === prompt.prompt
          ) {
            registry.upsertGoal(s.id, {
              rationale: `The classifier could not be reached after ${MAX_TRANSPORT_ATTEMPTS} attempts: ${r.reason}`,
            });
          }
          console.error(`[goal] ${s.name}: ${r.reason}`);
          return;
        }
        // cause === "parse": the model answered, but nothing it said validated. That IS a
        // real signal about the reply, so today's fail-closed behaviour stands unchanged.
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

      registry.resolveGoal(s.id, {
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
      }, prompt.prompt);
      failedFor.delete(s.id);
      transportAttempts.delete(s.id);
    });
  } catch (err) {
    // `limit` only rejects if the body throws, which `runStructured` promises not to do -
    // but a poller must never die on a surprise, and an unhandled rejection here would take
    // the daemon down rather than one goal.
    console.error("[goal] refine failed:", err);
  }
}
