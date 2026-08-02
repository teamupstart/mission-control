import type { Session, SessionGoal, SessionQueue } from "@shared/types.ts";
import { resolvedSessionIntent } from "@shared/goal.ts";
import type { ReportBucket } from "@shared/session.ts";
import { autoWrapupPayload, isWrapupPayload, wrapupTriggerOn } from "@shared/queue.ts";
import type { WrapupMode, WrapupTrigger } from "@shared/queue.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { VERIFY_FAILURE_CAP, hasPane } from "./queue-machine.ts";
import { settledIdle } from "@shared/session.ts";
import type { QueueVerdict } from "./queue-machine.ts";
import { automaticWrapupBlock } from "./wrapup-eligibility.ts";

// The `prompted` wrap-up trigger's decision core: the human typed straight into the
// pane, the agent worked, and it has parked - is this session finished, and should
// Foreman ship it?
//
// Zero I/O and `now` always injected, exactly like queue-machine.ts, so the whole
// policy is unit-testable as a table and the worker holds none of it.
//
// WHY THIS IS A SEPARATE MODULE, AND A TWO-STEP ONE
//
// The drain trigger can decide in a single pure pass because every item it fires on
// was ALREADY judged: an item only reaches `verified` through the verifier. This
// trigger has no item and therefore no verdict, so "the session is idle" is all it
// starts with - and idle is not finished. An agent that stopped to think, that
// answered a question without touching code, or that gave up halfway all look
// identical to a settled `Stop` hook.
//
// So the decision splits around the one thing that can tell those apart, a `claude -p`
// over the diff:
//
//   1. `decidePromptedWrapup` - cheap, pure, and STRICT. Is this session even a
//      candidate worth spending a model call on? Everything that can be known without
//      one is decided here.
//   2. the worker gathers evidence and runs the SAME verifier the queue uses.
//   3. `planPromptedWrapup` - pure again. Given the verdict, ask or type or hold.
//
// This mirrors `decideQueueTick` -> `runVerify` -> `planFromVerify`, deliberately: the
// queue already established that shape, and a second shape for the same question would
// be a second place for the gates to drift.

/** The knobs this trigger reads. A projection of ForemanConfig, like QueueConfig. */
export interface PromptedConfig {
  /** Which moments are armed. This trigger does nothing unless `prompted` is among them. */
  triggers: readonly WrapupTrigger[];
  /** What to send when it fires. */
  wrapup: WrapupMode;
  /** How long a session must sit idle before its work counts as settled. */
  settleMs: number;
}

export interface PromptedInput {
  session: Session;
  /** The session's bucket, computed cross-session (a parked gate needs the other sessions). */
  bucket: ReportBucket;
  /**
   * The FULL queue for this session's checkout, or null when it has none. The full
   * one, not the card summary: this needs `promptedGoal`, which the summary omits.
   */
  queue: SessionQueue | null;
  /** Full reconciled intent. The card summary deliberately omits its completion contract. */
  intent: SessionGoal | null;
  cfg: PromptedConfig;
  now: number;
}

/** Step 1's answer: spend a model call on this session, or say why not. */
export type PromptedCandidate =
  /** Not a candidate. `why` is for the log - every skip is explicable. */
  | { kind: "skip"; why: string }
  /** A finished non-shipping episode to retire without verification or a wrap-up action. */
  | { kind: "retire"; episodeKey: string; why: string }
  /**
   * Worth verifying. Carries the goal both as the verifier's `intent` and as the
   * episode key the result gets stamped under, so the two cannot come from different
   * reads of a session that moved in between.
   */
  | {
      kind: "check";
      /** Opaque once-per-prompt guard. */
      episodeKey: string;
      /** Durable completion contract. */
      objective: string;
      /** Latest steering instruction, never a replacement completion target. */
      focus: string | null;
      objectiveVersion: number;
      promptRevision: number;
    };

export function promptedIntentKey(intent: SessionGoal): string {
  return resolvedSessionIntent(intent)?.episodeKey ??
    `intent:${intent.objectiveVersion}:${intent.promptRevision}`;
}

/**
 * Is this session a candidate for a prompted wrap-up? Every branch is an early
 * return and the order is the policy.
 *
 * Strictness here is not politeness about tokens, though it is that too. Each gate
 * below is a case where firing would be WRONG, and the model call cannot save us from
 * any of them - it judges whether the work is done, not whether it was Foreman's to
 * finish.
 */
export function decidePromptedWrapup(input: PromptedInput): PromptedCandidate {
  const { session, bucket, queue, intent, cfg, now } = input;

  // 1. The trigger is off. First because it is the cheapest and because an unarmed
  //    trigger must reach no other branch - including the ones that WRITE.
  if (!wrapupTriggerOn(cfg.triggers, "prompted")) {
    return { kind: "skip", why: "the prompted trigger is off" };
  }

  // 2. Only a harness Foreman can actually drive, and only a live session. No
  //    `workQueue` capability means no hooks, no goal capture and no queue - there is
  //    nothing here to judge finished; an exited session has nothing left to type into.
  if (!capabilitiesFor(session.agent).workQueue) {
    return { kind: "skip", why: `${AGENT_IDENTITY[session.agent].label} sessions can't hold a queue` };
  }
  if (session.state === "exited") return { kind: "skip", why: "the session exited" };

  // 3. THE OVERLAP RULE: a checkout with a work queue belongs to the drain trigger,
  //    full stop. Both triggers can be armed at once, and on a queued session they
  //    would otherwise both fire - two wrap-ups racing to push one branch, which is
  //    the exact harm `auto-wrapup`'s mark-before-type ordering exists to prevent,
  //    arriving by a door that ordering cannot close (the two guards are different
  //    fields, so neither retires the other).
  //
  //    Gated on ITEMS, not on the row's existence: `ensureQueue` writes a row for any
  //    session the moment anything touches its wrap-up state - including this trigger
  //    itself - so "has a row" would be true for every session this ever fired on and
  //    would disarm it permanently after one use.
  if (queue && queue.items.length > 0) {
    return { kind: "skip", why: "this checkout has a work queue - the drain trigger owns it" };
  }

  // 4. Something needs a human. `needs-you` means an unanswered question, and an agent
  //    waiting on an answer is stopped, not finished. Triage owns this session until it doesn't.
  if (bucket === "needs-you") return { kind: "skip", why: "the session needs a human" };
  if (session.state === "awaiting_input") {
    return { kind: "skip", why: "the session is waiting on input" };
  }

  // 5. No hooks, ever: no completion signal exists for this session, so its `idle` is
  //    the rebuild default rather than a claim anyone made. `hooksSeen`, NOT
  //    `instrumented` - the same distinction step 3 of `decideQueueTick` documents at
  //    length: `instrumented` is a 30-minute freshness window, and a healthy session
  //    that simply went quiet (which is EXACTLY what a finished one looks like) flips
  //    it false.
  if (!session.hooksSeen) return { kind: "skip", why: "the session is not hook-instrumented" };

  // 6. ...but freshness is still required before ACTING, and here it is required
  //    outright rather than degraded to an ask. This is where this trigger is stricter
  //    than the drain one, on purpose.
  //
  //    On drain there is a real event - the last item went terminal - so a stale
  //    overlay still leaves something true to tell the human about, and step 5 of
  //    `decideQueueTick` degrades to `ask-wrapup`. Here the "event" IS the freshness:
  //    with no recent signal there is no evidence the agent ever stopped, and the card
  //    would be asking "shall I ship this?" about a session that may have been mid-turn
  //    for an hour. An ask nobody can answer correctly is worse than silence.
  if (!session.instrumented) return { kind: "skip", why: "no recent signal from this session" };
  if (!settledIdle(session, now, cfg.settleMs)) return { kind: "skip", why: "still working" };

  // 7. Nowhere to type. Unlike the queue - which escalates an undeliverable item so it
  //    doesn't sit forever - there is nothing here to escalate: no item, no promise
  //    made to anyone. Say nothing.
  if (!hasPane(session)) return { kind: "skip", why: "no pane to type into" };

  // 8. No durable objective means there is no completion contract to verify. A newest prompt
  //    still being reconciled is equally ineligible: shipping against the previous objective
  //    would race the very decision that says whether the human replaced it.
  const resolvedIntent = resolvedSessionIntent(intent);
  if (!intent || !resolvedIntent) {
    return { kind: "skip", why: "the latest instruction has unresolved intent" };
  }
  const objective = resolvedIntent.objective;

  // 9. THE LOOP GUARD. The goal is one of our own wrap-up instructions, which means
  //    the last prompt this session took was typed by Foreman, goal capture stored it,
  //    and the run has now finished. Firing again here is the infinite loop - see
  //    `isWrapupPayload`, which exists for this line.
  if (intent.prompt && isWrapupPayload(intent.prompt.trim())) {
    return { kind: "skip", why: "the last prompt was Foreman's own wrap-up" };
  }

  // 10. THE RE-ARM. This episode has already been decided - fired, or verified and
  //     held - and nothing has changed since: the session is idle, so the goal is the
  //     same goal, and re-verifying would spend a `claude -p` per tick to re-learn an
  //     unchanged answer. A newly reconciled human prompt advances the intent key and
  //     re-arms this.
  const episodeKey = resolvedIntent.episodeKey;
  if (queue?.promptedGoal === episodeKey) {
    return { kind: "skip", why: "already wrapped up this prompt" };
  }

  // A scout or an explicit review-artifact objective is complete when its report or design
  // output is ready, not when it has become a PR. Retire the episode without spending a
  // verifier call: no verdict can make an ineligible completion safe to hand to a Workflow
  // or the direct shipping prompt.
  const block = automaticWrapupBlock({
    taskKind: session.task?.kind ?? null,
    objective,
  });
  if (block) return { kind: "retire", episodeKey, why: block.reason };

  return {
    kind: "check",
    episodeKey,
    objective,
    focus: intent.prompt,
    objectiveVersion: resolvedIntent.objectiveVersion,
    promptRevision: resolvedIntent.promptRevision,
  };
}

/** Step 3's answer, once the verifier has judged the work. */
export type PromptedPlan =
  /** Complete, but the human decides: mark the moment so the Ship it? card renders. */
  | { kind: "ask-wrapup"; goal: string }
  /** Complete, automated, and cleared to type. Carries the exact payload. */
  | { kind: "auto-wrapup"; goal: string; payload: string }
  /** Not finished (or we could not tell). Type nothing; retire the episode. */
  | { kind: "hold"; goal: string; why: string };

/**
 * What a verdict means for a prompted session.
 *
 * Note what is NOT here: a fix round. The queue answers an incomplete verdict by
 * typing the gaps back at the agent, because it commissioned that work and owns it.
 * This trigger commissioned nothing - it is a bystander to a conversation between a
 * human and their agent - so its only honest move on "not finished" is to stay out of
 * the way. Sending gap text into a session whose human is mid-thought would be Foreman
 * interrupting to relay a critique nobody asked for.
 *
 * `hold` still RETIRES the episode (the caller stamps `promptedGoal` for it, same as a
 * fire). The alternative is re-verifying an idle session every tick forever: nothing
 * about it will change until the human prompts again, and once that instruction is
 * reconciled its new intent episode re-arms this from the top.
 */
export function planPromptedWrapup(
  goal: string,
  verdict: QueueVerdict,
  cfg: PromptedConfig,
  /** Whether Foreman is cleared to type here (live + allowlisted) - the same gate a send passes. */
  mayActLive: boolean,
): PromptedPlan {
  // The verifier's primary axis. `complete: false` is the agent's work being
  // unfinished, which is the human's business and not ours.
  if (!verdict.complete) {
    return { kind: "hold", goal, why: verdict.summary || "the work looks unfinished" };
  }

  // Complete, but with something blocking still open, is a verdict contradicting
  // itself - the same shape `planFromVerify` refuses to act on, and for the same
  // reason. There it retries because an item is waiting on an answer; here nothing is
  // waiting, so it simply declines. Declining is free and shipping on a self-
  // contradictory verdict is not.
  const blocking = verdict.gaps.filter((g) => g.severity === "blocking");
  if (blocking.length > 0) {
    return {
      kind: "hold",
      goal,
      why: `complete, but ${blocking.length} blocking gap(s) remain: ${blocking[0]?.detail ?? ""}`,
    };
  }

  const payload = autoWrapupPayload(cfg.wrapup);

  // Nothing to automate (`ask`), or Foreman may not type here. Same fallback as the
  // drain path and the same argument: the instruction PUSHES, so a dry-run that typed
  // it would be a dry-run that shipped. The Wrapup card IS the proposal - it prefills
  // this exact text and puts it one click away - which is why dry-run degrades to the
  // ask rather than to anything that writes.
  if (!payload || !mayActLive) return { kind: "ask-wrapup", goal };

  return { kind: "auto-wrapup", goal, payload };
}

/**
 * Consecutive FAILED ATTEMPTS per session, alongside the episode they belong to, and the
 * cap that ends one. The queue path bounds the same thing with `failVerify` and the
 * item's durable `verifyFailures`; this path has no item to hold a count, so it keeps
 * one here - in memory, exactly like `ReviewFailureTracker`, and for the same reason: a
 * newly reconciled human prompt changes the intent episode key, which is precisely when
 * the strikes should reset.
 *
 * WHAT COUNTS AS AN ATTEMPT is the load-bearing part, and it is deliberately wider than
 * "the verifier failed". An episode stays armed until `promptedGoal` is stamped, so the
 * two ways a tick can spend real work and leave the episode exactly where it found it
 * are a failed verify AND a failed retire stamp. Counting only the first bounds only the
 * cheaper loop: a daemon 500ing on the retire endpoint re-runs the whole evidence gather
 * plus a `claude -p` every tick, and a counter that reset on each successful verdict
 * would never see it. "This tick got nowhere" is the honest unit, and both failures are
 * that - which is why the count is cleared only by `onRetired`, the one event that makes
 * the next tick cheap (it is what `decidePromptedWrapup` step 10 reads to skip).
 *
 * Keyed by SESSION with the episode key stored beside it rather than by session+episode,
 * so the re-arm falls out of the comparison instead of needing a sweep, and the map holds
 * one entry per session rather than one per episode ever seen.
 */
export class PromptedFailureTracker {
  private bySession = new Map<string, { goal: string; failures: number }>();

  /** Strikes against THIS episode - a different goal is a different episode, hence zero. */
  strikes(sessionId: string, goal: string): number {
    const seen = this.bySession.get(sessionId);
    return seen && seen.goal === goal ? seen.failures : 0;
  }

  /** Record one attempt that got nowhere; answer how many in a row that makes. */
  onFailure(sessionId: string, goal: string): number {
    const failures = this.strikes(sessionId, goal) + 1;
    this.bySession.set(sessionId, { goal, failures });
    return failures;
  }

  /** The episode is retired, so the next tick is cheap: forget the strikes. */
  onRetired(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /**
   * Has Foreman given up on this episode? Read BEFORE any evidence is gathered - a check
   * further down the tick would still pay for the work the cap exists to prevent.
   */
  gaveUp(sessionId: string, goal: string): boolean {
    return this.strikes(sessionId, goal) >= VERIFY_FAILURE_CAP;
  }
}
