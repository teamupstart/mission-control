import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COPY_FEEDBACK_HOLD_MS,
  COPY_FEEDBACK_LABEL,
  createCopyFeedback,
  type CopyFeedbackState,
} from "../src/web/lib/clipboard.ts";

/**
 * The controller behind `useCopyFeedback`, driven directly.
 *
 * `useCopyFeedback` is a binding over this and adds no behaviour of its own, which is
 * deliberate: this repository renders with `renderToStaticMarkup` and has no jsdom, so a
 * hook's effects and timers are unreachable from a test. Everything the six migrated copy
 * controls depend on - the timer discipline, the ordering around an await, what happens
 * after teardown - lives here where it can be asserted.
 */

/** A promise this test resolves by hand, so an await can be held open across an assertion. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  return { promise, release };
}

interface Harness {
  states: CopyFeedbackState[];
  /** The state a component would be rendering right now. */
  latest: () => CopyFeedbackState;
  writes: string[];
  /** Armed timers, in the order they were armed. `null` once fired or cleared. */
  timers: Array<{ run: () => void; ms: number } | null>;
  cleared: number[];
  /** Fire an armed timer the way the event loop would. */
  fire: (handle: number) => void;
}

function harness(options: {
  write?: (text: string) => Promise<unknown>;
  holdMs?: () => number;
} = {}): Harness & { controller: ReturnType<typeof createCopyFeedback> } {
  const states: CopyFeedbackState[] = [];
  const writes: string[] = [];
  const timers: Array<{ run: () => void; ms: number } | null> = [];
  const cleared: number[] = [];
  const controller = createCopyFeedback({
    publish: (state) => { states.push(state); },
    holdMs: options.holdMs,
    write: options.write ?? (async (text: string) => { writes.push(text); }),
    setTimer: (run, ms) => timers.push({ run, ms }) - 1,
    clearTimer: (handle) => { cleared.push(handle); timers[handle] = null; },
  });
  return {
    controller,
    states,
    latest: () => states.at(-1) ?? { copied: false, error: null },
    writes,
    timers,
    cleared,
    fire: (handle) => {
      const timer = timers[handle];
      assert.ok(timer, `timer ${handle} is not armed`);
      timers[handle] = null;
      timer.run();
    },
  };
}

test("a copy writes the text, confirms, and gives the confirmation back after the hold", async () => {
  const h = harness();

  await h.controller.copy("run-7f3a");

  assert.deepEqual(h.writes, ["run-7f3a"]);
  assert.deepEqual(h.latest(), { copied: true, error: null });
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]?.ms, COPY_FEEDBACK_HOLD_MS);

  h.fire(0);
  assert.deepEqual(h.latest(), { copied: false, error: null });
});

test("the label the whole app confirms with is the undecorated one", () => {
  // Phase 1 normalised two `"Copied ✓"` variants away. Phase 2's menu confirms with the same
  // constant, so a later surface cannot reintroduce a third spelling without editing this.
  assert.equal(COPY_FEEDBACK_LABEL, "Copied");
});

test("an async producer is awaited before anything is written or confirmed", async () => {
  const order: string[] = [];
  const produced = deferred();
  const h = harness({ write: async (text) => { order.push(`write:${text}`); } });

  const running = h.controller.copy(async () => {
    order.push("produce");
    await produced.promise;
    return "the fetched report";
  });

  // The producer is in flight: nothing has been written and nothing claims to be copied.
  assert.deepEqual(order, ["produce"]);
  assert.equal(h.latest().copied, false);

  produced.release();
  await running;

  assert.deepEqual(order, ["produce", "write:the fetched report"]);
  assert.deepEqual(h.latest(), { copied: true, error: null });
});

test("a rejected write leaves the control uncopied and hands the reason to the caller", async () => {
  const h = harness({
    write: async () => { throw new Error("The browser refused the clipboard copy"); },
  });

  await h.controller.copy("guidance markdown");

  assert.deepEqual(h.latest(), {
    copied: false,
    error: "The browser refused the clipboard copy",
  });
  // No hold to expire, so no timer: a failure is not a confirmation that ages out.
  assert.equal(h.timers.length, 0);
});

test("a producer that throws fails the copy rather than copying nothing", async () => {
  // `ReportPanel` fetches `/api/report.md` before it has anything to copy. A failed fetch and a
  // blocked clipboard used to be indistinguishable and both invisible; both are errors now.
  const h = harness();

  await h.controller.copy(async () => { throw new Error("Failed to fetch"); });

  assert.deepEqual(h.latest(), { copied: false, error: "Failed to fetch" });
  assert.deepEqual(h.writes, []);
});

test("a failure with no message still says something", async () => {
  const h = harness({ write: async () => { throw new Error("   "); } });

  await h.controller.copy("text");

  assert.equal(h.latest().error, "The copy did not complete");
});

test("a second copy clears the first one's timer before arming its own", async () => {
  // The defect this replaces: `WorkflowRuns` armed a bare `setTimeout` per click, so the
  // earliest one cleared the label while the reader was still looking at a later copy.
  const h = harness();

  await h.controller.copy("first");
  await h.controller.copy("second");

  assert.deepEqual(h.cleared, [0], "the first timer was not cleared");
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[0], null);
  assert.deepEqual(h.latest(), { copied: true, error: null });

  // Only the surviving timer can end the confirmation.
  h.fire(1);
  assert.deepEqual(h.latest(), { copied: false, error: null });
});

test("a second copy does not flicker the confirmation off and on again", async () => {
  const h = harness();
  await h.controller.copy("first");
  const before = h.states.length;

  await h.controller.copy("second");

  // Nothing published by the second copy reads as uncopied. Dropping the flag up front would
  // blink the button back to its resting label for a frame on a double click, and the first
  // copy's text is genuinely still on the clipboard until the second one lands.
  assert.deepEqual(h.states.slice(before).filter((state) => !state.copied), []);
  assert.deepEqual(h.latest(), { copied: true, error: null });
});

test("a publish that would change nothing is skipped", async () => {
  // `WorkflowLadder` calls `reset()` from its `[run.id]` effect, which also runs on mount. The
  // `useState(false)` this replaced was bailed out of by React when set to the value it already
  // held, and a fresh object every time would have turned that into a render per mount.
  const h = harness();
  h.controller.reset();
  assert.deepEqual(h.states, []);

  await h.controller.copy("text");
  assert.equal(h.states.length, 1);
  h.controller.reset();
  assert.equal(h.states.length, 2);
  h.controller.reset();
  assert.equal(h.states.length, 2);
});

test("a stale error is dropped the moment a retry starts", async () => {
  let fail = true;
  const h = harness({
    write: async () => { if (fail) throw new Error("Write permission denied."); },
  });
  await h.controller.copy("text");
  assert.equal(h.latest().error, "Write permission denied.");

  fail = false;
  const slow = deferred();
  const running = h.controller.copy(async () => { await slow.promise; return "text"; });

  // While the retry is in flight the old sentence is already gone - it describes an attempt
  // the reader has just superseded.
  assert.deepEqual(h.latest(), { copied: false, error: null });
  slow.release();
  await running;
  assert.deepEqual(h.latest(), { copied: true, error: null });
});

test("a slow copy overtaken by a newer one neither confirms nor arms a timer", async () => {
  const gates: Array<() => void> = [];
  const h = harness({
    write: (text) => new Promise((resolve) => {
      gates.push(() => resolve(undefined));
      h.writes.push(text);
    }),
  });

  const first = h.controller.copy("slow");
  const second = h.controller.copy("fast");
  // The newer click resolves first, which is the interleaving a real double click produces
  // when the two writes take different amounts of time.
  gates[1]?.();
  await second;
  assert.deepEqual(h.latest(), { copied: true, error: null });
  assert.equal(h.timers.filter(Boolean).length, 1);

  gates[0]?.();
  await first;
  // The overtaken copy publishes nothing: no second confirmation, and no second timer to
  // clear the live one early.
  assert.deepEqual(h.latest(), { copied: true, error: null });
  assert.equal(h.timers.length, 1);
});

test("copy resolves with the settled surface state, so one error slot can route it", async () => {
  // `WorkflowRuns`, `WorkflowLadder` and `PersonaEditor` each own a single error line that many
  // unrelated actions write to. Reading the sentence off the return keeps that last-write-wins,
  // where rendering the hook's `error` beside it would make two sources compete for one line.
  const ok = harness();
  assert.deepEqual(await ok.controller.copy("text"), { copied: true, error: null });

  const bad = harness({ write: async () => { throw new Error("Write permission denied."); } });
  assert.deepEqual(await bad.controller.copy("text"), {
    copied: false,
    error: "Write permission denied.",
  });
});

test("an overtaken failure never hands its stale refusal to a caller", async () => {
  /*
   * The defect this contract exists for. Neither copy button disables while a copy is in
   * flight, so a click stalled on a permission prompt can settle AFTER a later click that went
   * straight through. When the loser reported its own failure, the page wrote that refusal into
   * its shared error line while the generation-guarded flag beside it already said `Copied` -
   * a success confirmation and a contradicting error for one action, at once.
   */
  const gates: Array<(fail: boolean) => void> = [];
  const h = harness({
    write: () => new Promise((resolve, reject) => {
      gates.push((fail) => (fail ? reject(new Error("stale refusal")) : resolve(undefined)));
    }),
  });

  const slow = h.controller.copy("slow");
  const fast = h.controller.copy("fast");
  gates[1]?.(false);
  await fast;
  gates[0]?.(true);

  // What every call site does with this value: `if (error !== null) setError(...)`. There is
  // nothing to write, which is the point - the surface succeeded.
  assert.deepEqual(await slow, { copied: true, error: null });
  assert.deepEqual(h.latest(), { copied: true, error: null });
});

test("an overtaken success reports the surface rather than itself", async () => {
  // The mirror of the case above, and the reason the rule is stated once for both arms: the
  // loser wrote, but the reader is looking at the copy that finished last.
  const gates: Array<(fail: boolean) => void> = [];
  const h = harness({
    write: () => new Promise((resolve, reject) => {
      gates.push((fail) => (fail ? reject(new Error("the browser refused")) : resolve(undefined)));
    }),
  });

  const slow = h.controller.copy("slow");
  const fast = h.controller.copy("fast");
  gates[1]?.(true);
  await fast;
  gates[0]?.(false);

  assert.deepEqual(await slow, { copied: false, error: "the browser refused" });
  assert.deepEqual(h.latest(), { copied: false, error: "the browser refused" });
});

test("a copy overtaken by reset reports the cleared surface, not its own failure", async () => {
  // `resetOn` fires when the subject changes. A copy of the PREVIOUS subject settling after
  // that must not put its refusal on the surface now describing a different one.
  const slow = deferred();
  const h = harness({ write: async () => { await slow.promise; throw new Error("stale refusal"); } });

  const running = h.controller.copy("the previous run's feedback");
  h.controller.reset();
  slow.release();

  assert.deepEqual(await running, { copied: false, error: null });
  assert.deepEqual(h.latest(), { copied: false, error: null });
});

test("reset clears the confirmation, the error and the armed timer", async () => {
  const h = harness();
  await h.controller.copy("branch-name");
  assert.equal(h.latest().copied, true);

  h.controller.reset();

  assert.deepEqual(h.latest(), { copied: false, error: null });
  assert.deepEqual(h.cleared, [0]);
});

test("reset stops a copy already in flight from confirming onto the new subject", async () => {
  // `WorkflowLadder` resets on `run.id`. A copy still resolving from the previous run must not
  // flip `Copied` on the run that replaced it.
  const slow = deferred();
  const h = harness({ write: () => slow.promise });

  const running = h.controller.copy("the previous run's feedback");
  h.controller.reset();
  slow.release();
  await running;

  assert.deepEqual(h.latest(), { copied: false, error: null });
  assert.equal(h.timers.length, 0, "the stale copy armed a hold on the new subject");
});

test("dispose clears the armed timer and silences every later publish", async () => {
  const h = harness();
  await h.controller.copy("text");
  const seen = h.states.length;

  h.controller.dispose();

  assert.deepEqual(h.cleared, [0]);
  // The unmounted-tree write the bare `setTimeout` sites could make is unrepresentable: a copy
  // resolving after teardown publishes nothing at all.
  await h.controller.copy("later");
  h.controller.reset();
  assert.equal(h.states.length, seen);
});

test("a copy still in flight when the surface goes away arms no timer behind it", async () => {
  // `dispose()` can only disarm what is armed when it runs. A copy awaiting its write when the
  // reader closed the panel would otherwise arm a fresh hold with nothing left to clear it -
  // and under `node --test` that alone keeps the event loop alive past teardown.
  const slow = deferred();
  const h = harness({ write: () => slow.promise });

  const running = h.controller.copy("text");
  h.controller.dispose();
  slow.release();
  await running;

  assert.deepEqual(h.timers, []);
  assert.deepEqual(h.states, []);
});

test("dispose is idempotent, because StrictMode tears a hook down twice", () => {
  const h = harness();
  h.controller.dispose();
  h.controller.dispose();
  assert.deepEqual(h.cleared, []);
});

test("the hold is read when the timer is armed, not when the controller is built", async () => {
  let hold = 1600;
  const h = harness({ holdMs: () => hold });

  await h.controller.copy("first");
  assert.equal(h.timers[0]?.ms, 1600);

  hold = 250;
  await h.controller.copy("second");
  assert.equal(h.timers[1]?.ms, 250);
});
