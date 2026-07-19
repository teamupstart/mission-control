import type { Session, SessionQueue } from "@shared/types.ts";
import type { ReportBucket } from "@shared/session.ts";
import { autoWrapupPayload, isWrapupPayload, wrapupTriggerOn } from "@shared/queue.ts";
import type { WrapupMode, WrapupTrigger } from "@shared/queue.ts";
import { hasPane, settledIdle } from "./queue-machine.ts";
import type { QueueVerdict } from "./queue-machine.ts";

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
  /**
   * The session's captured goal PROMPT - the human's last substantive ask, verbatim.
   *
   * Passed in rather than read off `session.goal`, and that is not plumbing
   * convenience: the card summary carries only the refiner's derived SENTENCE, which
   * a debounced Haiku call rewrites minutes after the prompt that produced it. Keying
   * the once-per-episode guard on a value that changes on its own would re-arm this
   * trigger without a human doing anything - firing a second wrap-up at a session
   * whose only change was a model rewording its own summary. The verbatim prompt moves
   * when, and only when, someone types.
   *
   * It is also the better `intent` for the verifier: the exact words of the ask beat a
   * one-line paraphrase of them when the question is "was this actually satisfied".
   */
  goalPrompt: string | null;
  cfg: PromptedConfig;
  now: number;
}

/** Step 1's answer: spend a model call on this session, or say why not. */
export type PromptedCandidate =
  /** Not a candidate. `why` is for the log - every skip is explicable. */
  | { kind: "skip"; why: string }
  /**
   * Worth verifying. Carries the goal both as the verifier's `intent` and as the
   * episode key the result gets stamped under, so the two cannot come from different
   * reads of a session that moved in between.
   */
  | { kind: "check"; goal: string };

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
  const { session, bucket, queue, goalPrompt, cfg, now } = input;

  // 1. The trigger is off. First because it is the cheapest and because an unarmed
  //    trigger must reach no other branch - including the ones that WRITE.
  if (!wrapupTriggerOn(cfg.triggers, "prompted")) {
    return { kind: "skip", why: "the prompted trigger is off" };
  }

  // 2. Only Claude sessions, and only live ones. Codex sessions have no hooks, no
  //    goal capture and no queue; an exited session has nothing left to type into.
  if (session.agent !== "claude") return { kind: "skip", why: "not a Claude session" };
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
  //    waiting on an answer is stopped, not finished - typing `/no-mistakes` at it
  //    would answer its question with an unrelated instruction. Triage owns this
  //    session until it doesn't.
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

  // 8. No captured goal means no human ask on record, and therefore nothing to verify
  //    the work AGAINST. `captureGoalPrompt` stores one on every substantive
  //    `UserPromptSubmit`, so this is a session that has taken no real prompt yet -
  //    scaffolding turns and `/clear` only. There is no "prompted work" to complete.
  const goal = goalPrompt?.trim();
  if (!goal) return { kind: "skip", why: "no captured goal to verify against" };

  // 9. THE LOOP GUARD. The goal is one of our own wrap-up instructions, which means
  //    the last prompt this session took was typed by Foreman: we fired, `/no-mistakes`
  //    landed as a `UserPromptSubmit`, goal capture stored it, and the run has now
  //    finished and parked. Firing again here is the infinite loop - see
  //    `isWrapupPayload`, which exists for this line.
  if (isWrapupPayload(goal)) {
    return { kind: "skip", why: "the last prompt was Foreman's own wrap-up" };
  }

  // 10. THE RE-ARM. This episode has already been decided - fired, or verified and
  //     held - and nothing has changed since: the session is idle, so the goal is the
  //     same goal, and re-verifying would spend a `claude -p` per tick to re-learn an
  //     unchanged answer. A new prompt from the human moves the goal and re-arms this.
  if (queue?.promptedGoal === goal) {
    return { kind: "skip", why: "already wrapped up this prompt" };
  }

  return { kind: "check", goal };
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
 * about it will change until the human prompts again, and when they do, the new goal
 * re-arms this from the top.
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
