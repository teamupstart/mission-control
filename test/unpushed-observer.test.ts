import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnpushedObserver } from "../src/server/away/unpushed-observer.ts";
import type { UnpushedCommits } from "../src/shared/unpushed.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

// The observer that keeps the git read OFF the away watcher's tick.
//
// Every test here drives it with a fake reader, because the thing worth pinning is the
// BOOKKEEPING - which runs get read, how often, what happens to an answer that never comes -
// and not git's behaviour, which `test/unpushed.test.ts` already covers against real
// repositories. The two seams that make that possible (`read` and `checkoutFor`) exist for
// exactly this reason.

function mkRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    sessionId: "s",
    noteKey: "note",
    status: "waiting_for_new_head",
    phase: "inspector_findings",
    round: 2,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 1,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 0,
    ...over,
  };
}

const AHEAD: UnpushedCommits = {
  state: "ahead",
  commits: 2,
  branch: "fix/thing",
  upstream: "origin/fix/thing",
};

/** A reader that records the paths it was asked about and answers immediately. */
function fakeReader(answer: UnpushedCommits = AHEAD) {
  const asked: (string | null)[] = [];
  return {
    asked,
    read: async (cwd: string | null): Promise<UnpushedCommits> => {
      asked.push(cwd);
      return answer;
    },
  };
}

/** Let the microtask queue drain so a fire-and-forget read can land. */
const settle = () => new Promise((r) => setImmediate(r));

test("observes a parked run's checkout and reports what came back", async () => {
  const reader = fakeReader();
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => 0,
  });

  // Nothing is known synchronously - which is the point, and why the sentence this feeds must
  // stand on its own without it.
  obs.observe([mkRun()]);
  assert.equal(obs.snapshot().size, 0);

  await settle();
  assert.deepEqual(obs.snapshot().get("run"), AHEAD);
  assert.deepEqual(reader.asked, ["/work/tree"]);
});

test("resolves the checkout PER RUN, so a multi-repo task reads each repository", async () => {
  const reader = fakeReader();
  const obs = createUnpushedObserver({
    checkoutFor: (run) => `/work/${run.bindingId}`,
    read: reader.read,
    now: () => 0,
  });
  obs.observe([
    mkRun({ id: "run-a", bindingId: "binding-a" }),
    mkRun({ id: "run-b", bindingId: "binding-b" }),
  ]);
  await settle();
  assert.deepEqual(reader.asked.sort(), ["/work/binding-a", "/work/binding-b"]);
  assert.equal(obs.snapshot().size, 2);
});

test("only waiting_for_new_head is read - the other parked status is not un-parked by a push", async () => {
  const reader = fakeReader();
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => 0,
  });
  obs.observe([
    mkRun({ id: "head", status: "waiting_for_new_head" }),
    mkRun({ id: "session", status: "waiting_for_session" }),
    mkRun({ id: "running", status: "running" }),
  ]);
  await settle();
  assert.deepEqual([...obs.snapshot().keys()], ["head"]);
  assert.equal(reader.asked.length, 1);
});

test("a fresh observation is not re-read on every tick", async () => {
  const reader = fakeReader();
  let clock = 0;
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => clock,
    ttlMs: 60_000,
  });

  obs.observe([mkRun()]);
  await settle();
  // The watcher ticks every 5s. Eleven ticks land at 55s, strictly inside one 60s TTL, and
  // must cost one git read rather than eleven. (The twelfth lands ON the TTL and re-reads,
  // which is the next test.)
  for (let i = 0; i < 11; i++) {
    clock += 5_000;
    obs.observe([mkRun()]);
    await settle();
  }
  assert.equal(clock, 55_000);
  assert.equal(reader.asked.length, 1);
});

test("an observation past its TTL is read again", async () => {
  const reader = fakeReader();
  let clock = 0;
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => clock,
    ttlMs: 60_000,
  });
  obs.observe([mkRun()]);
  await settle();
  clock = 60_000;
  obs.observe([mkRun()]);
  await settle();
  assert.equal(reader.asked.length, 2);
});

test("a slow checkout does not stack reads tick on tick", async () => {
  const asked: string[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/slow",
    read: async (cwd) => {
      asked.push(cwd!);
      await gate;
      return AHEAD;
    },
    now: () => 0,
  });

  // Six ticks while the first read is still hanging. Without the in-flight guard this is six
  // concurrent git conversations against one checkout, growing for as long as it stays slow.
  for (let i = 0; i < 6; i++) {
    obs.observe([mkRun()]);
    await settle();
  }
  assert.equal(asked.length, 1);

  release!();
  await settle();
  assert.deepEqual(obs.snapshot().get("run"), AHEAD);
});

test("a run that un-parks is forgotten rather than left to go stale", async () => {
  const reader = fakeReader();
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => 0,
  });
  obs.observe([mkRun()]);
  await settle();
  assert.equal(obs.snapshot().size, 1);

  // The Inspector observed the head; the run moved on. Its count is not merely stale, it is an
  // answer to a question nobody is asking - and holding it would let it be quoted later.
  obs.observe([mkRun({ status: "running" })]);
  assert.equal(obs.snapshot().size, 0);
});

test("a reader that THROWS claims nothing and does not take the daemon down", async () => {
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: async () => {
      throw new Error("git exploded");
    },
    now: () => 0,
  });
  obs.observe([mkRun()]);
  await settle();
  assert.equal(obs.snapshot().size, 0);
});

test("a throw DROPS a previous answer rather than letting it outlive its checkout", async () => {
  let explode = false;
  let clock = 0;
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: async () => {
      if (explode) throw new Error("git exploded");
      return AHEAD;
    },
    now: () => clock,
    ttlMs: 1_000,
  });
  obs.observe([mkRun()]);
  await settle();
  assert.deepEqual(obs.snapshot().get("run"), AHEAD);

  explode = true;
  clock = 1_000;
  obs.observe([mkRun()]);
  await settle();
  assert.equal(obs.snapshot().has("run"), false);
});

test("a run with no resolvable checkout still gets asked, and unknown is the reader's answer", async () => {
  // `readUnpushedCommits(null)` is the one that returns `no_checkout`; the observer does not
  // second-guess it, so there is exactly one place that decides what a missing path means.
  const asked: (string | null)[] = [];
  const obs = createUnpushedObserver({
    checkoutFor: () => null,
    read: async (cwd) => {
      asked.push(cwd);
      return { state: "unknown", why: "no_checkout" };
    },
    now: () => 0,
  });
  obs.observe([mkRun()]);
  await settle();
  assert.deepEqual(asked, [null]);
  assert.deepEqual(obs.snapshot().get("run"), { state: "unknown", why: "no_checkout" });
});

test("the snapshot is a copy - a later observation cannot rewrite one already read", async () => {
  const reader = fakeReader();
  let clock = 0;
  const obs = createUnpushedObserver({
    checkoutFor: () => "/work/tree",
    read: reader.read,
    now: () => clock,
    ttlMs: 1_000,
  });
  obs.observe([mkRun()]);
  await settle();
  const held = obs.snapshot();

  clock = 1_000;
  obs.observe([mkRun({ status: "running" })]);
  // The caller's map still says what it said when it was taken, so a tick that lands mid-pass
  // cannot change the sentence the pass is already building.
  assert.equal(held.size, 1);
  assert.equal(obs.snapshot().size, 0);
});
