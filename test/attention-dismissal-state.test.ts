/**
 * What is at stake: two dismissals made back to back both stay dismissed, whatever order the
 * daemon's answers arrive in.
 *
 * The defect this pins shut: each dismissal's response carried the whole stored set and the
 * dashboard adopted it. Dismiss A, then B; the daemon stores A, then B; B's answer ({A, B})
 * lands, then A's older one ({A}) lands and replaces it - and B is back in the inbox though the
 * daemon holds it, with no further change event left to prompt a repair.
 *
 * And the same row dismissed twice: dismiss it, watch it come back reporting something new,
 * dismiss it again. The daemon keeps whichever write it stores last, so if the first write was
 * delayed past the second it overwrote the newer dismissal and the newer problem came back. The
 * write queue sends a row's writes one after another; the tests after it pin that.
 *
 * The queue cannot see another window, so the daemon refuses a write made without seeing a newer
 * revision of its row (`attention-dismissals-http.test.ts` pins that refusal). What the dashboard
 * owes it is an honest basis: the newest revision it has seen, never lowered, and read when the
 * write is SENT - the last tests pin that, because a basis read at click time would make a
 * window's second dismissal of a row look stale against its own first.
 *
 * Driven one event at a time against `lib/attention-dismissal-state.ts`, the module the hook
 * delegates every ordering decision to, so each interleaving is exact rather than a timing the
 * test hopes for. `e2e/specs/attention-inbox-dismiss.spec.ts` reproduces the same race in a
 * browser against the real daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionDismissal, AttentionDismissalKey } from "../src/shared/protocol.ts";
import {
  applyDismissalRead,
  beginDismissalWrite,
  createDismissalSender,
  createDismissalWriteQueue,
  createRevisionLedger,
  effectiveDismissals,
  INITIAL_DISMISSAL_STATE,
  readRetryDelay,
  settleDismissalWrite,
  shouldRetryRead,
  type AttentionDismissalState,
} from "../src/web/lib/attention-dismissal-state.ts";

const A: AttentionDismissalKey = { itemId: "pipeline-commission:c-1", occurrence: "aaaaaaaa" };
const B: AttentionDismissalKey = { itemId: "blocked:s-1", occurrence: "bbbbbbbb" };
const row = (key: AttentionDismissalKey, at = 1): AttentionDismissal => ({ ...key, dismissedAt: at, revision: at });
const hidden = (state: AttentionDismissalState) => [...effectiveDismissals(state).keys()].sort();
const BOTH = [B.itemId, A.itemId].sort();

test("two dismissals answered out of order both stay dismissed", () => {
  let s = INITIAL_DISMISSAL_STATE;
  s = applyDismissalRead(s, 1, []);                 // the dashboard's first read: nothing stored
  s = beginDismissalWrite(s, [A], 1);
  s = beginDismissalWrite(s, [B], 2);
  assert.deepEqual(hidden(s), BOTH, "both rows leave at the click");

  // The daemon stores A, then B. B's answer arrives FIRST; the dashboard reads after it.
  s = settleDismissalWrite(s, [B], 2, true, 1);
  s = applyDismissalRead(s, 2, [row(A), row(B)]);
  assert.deepEqual(hidden(s), BOTH);

  // A's answer arrives LAST. Under the old hook this was a stored set of {A} replacing {A, B}.
  s = settleDismissalWrite(s, [A], 1, true, 2);
  assert.deepEqual(hidden(s), BOTH, "the older answer must not bring B back");
  s = applyDismissalRead(s, 3, [row(A), row(B)]);
  assert.deepEqual(hidden(s), BOTH);
  assert.equal(s.pending.size, 0, "a read started after both answers confirms both");
});

test("a read that started before a write was stored cannot bring its row back", () => {
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 1, []);
  s = beginDismissalWrite(s, [A], 1);
  // Read 2 starts (say, another window's change event) and the daemon answers it before A is
  // stored; A's write is then answered, and read 2's stale answer lands only now.
  s = settleDismissalWrite(s, [A], 1, true, 2);
  s = applyDismissalRead(s, 2, []);
  assert.deepEqual(hidden(s), [A.itemId], "a read started before the answer does not confirm it");
  // The read the hook starts after the answer does.
  s = applyDismissalRead(s, 3, [row(A)]);
  assert.deepEqual(hidden(s), [A.itemId]);
  assert.equal(s.pending.size, 0);
});

test("reads apply in the order they started; an older answer landing late is ignored", () => {
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 2, [row(A), row(B)]);
  s = applyDismissalRead(s, 1, [row(A)]);
  assert.deepEqual(hidden(s), BOTH);
  assert.equal(s.appliedRead, 2);
});

test("a refused dismissal brings its row back at once, and leaves the other alone", () => {
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 1, []);
  s = beginDismissalWrite(s, [A], 1);
  s = beginDismissalWrite(s, [B], 2);
  s = settleDismissalWrite(s, [A], 1, false, 1);
  assert.deepEqual(hidden(s), [B.itemId]);
});

test("an older write's answer does not settle a newer dismissal of the same row", () => {
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 1, []);
  s = beginDismissalWrite(s, [A], 1);
  const reworded = { ...A, occurrence: "cccccccc" };
  s = beginDismissalWrite(s, [reworded], 2);
  s = settleDismissalWrite(s, [A], 1, false, 1);
  assert.equal(effectiveDismissals(s).get(A.itemId), "cccccccc", "the newer click still holds");
});

test("a read replaces the stored copy whole: a row it no longer carries is no longer hidden", () => {
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 1, [row(A), row(B)]);
  s = applyDismissalRead(s, 2, [row(B)]);
  assert.deepEqual(hidden(s), [B.itemId]);
});

// ---- the write queue: one row's writes reach the daemon in the order they were made ----

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A daemon that keeps whichever write of a row it stores last - which is what the real upsert
 * does - and whose answers the test releases one at a time.
 */
function fakeDaemon() {
  const stored = new Map<string, string>();
  const received: string[] = [];
  const answers: { keys: readonly AttentionDismissalKey[]; answer: ReturnType<typeof deferred<{ ok: boolean }>> }[] = [];
  const send = (keys: readonly AttentionDismissalKey[]) => {
    const answer = deferred<{ ok: boolean }>();
    received.push(keys.map((key) => `${key.itemId}=${key.occurrence}`).join(","));
    answers.push({ keys, answer });
    return answer.promise;
  };
  /** Store write `index` now, and answer it. */
  const store = (index: number, ok = true) => {
    const { keys, answer } = answers[index]!;
    if (ok) for (const key of keys) stored.set(key.itemId, key.occurrence);
    answer.resolve({ ok });
  };
  return { stored, received, send, store };
}

test("a row dismissed again is not sent until its earlier dismissal is answered", async () => {
  const daemon = fakeDaemon();
  const enqueue = createDismissalWriteQueue(daemon.send);
  const first = { itemId: "blocked:s-1", occurrence: "bash" };
  const second = { itemId: "blocked:s-1", occurrence: "edit" };
  const one = enqueue([first]);
  const two = enqueue([second]);
  await settle();
  assert.deepEqual(daemon.received, ["blocked:s-1=bash"], "the newer dismissal waits for the older one");

  daemon.store(0);
  await one;
  await settle();
  assert.deepEqual(daemon.received, ["blocked:s-1=bash", "blocked:s-1=edit"]);
  daemon.store(1);
  await two;
  assert.equal(daemon.stored.get("blocked:s-1"), "edit", "the daemon keeps the newer dismissal");
});

test("the reviewer's ordering: the older write cannot overwrite the newer dismissal", async () => {
  // Dismiss problem A; the commission reports problem B before A is stored; dismiss B. However
  // long A's write is held, B's is only sent after it, so B is what the daemon keeps - and the
  // read the dashboard takes after B's answer confirms it, leaving nothing to come back.
  const daemon = fakeDaemon();
  const enqueue = createDismissalWriteQueue(daemon.send);
  const a = { itemId: "pipeline-commission:c-1", occurrence: "aaaaaaaa" };
  const b = { itemId: "pipeline-commission:c-1", occurrence: "bbbbbbbb" };
  let s = applyDismissalRead(INITIAL_DISMISSAL_STATE, 1, []);
  s = beginDismissalWrite(s, [a], 1);
  const one = enqueue([a]);
  s = beginDismissalWrite(s, [b], 2);
  const two = enqueue([b]);
  await settle();
  assert.equal(daemon.received.length, 1);

  daemon.store(0);
  s = settleDismissalWrite(s, [a], 1, (await one).ok, 1);
  await settle();
  daemon.store(1);
  s = settleDismissalWrite(s, [b], 2, (await two).ok, 1);
  s = applyDismissalRead(s, 2, [{ ...b, dismissedAt: 2, revision: 2 }]);
  assert.equal(daemon.stored.get(b.itemId), "bbbbbbbb");
  assert.equal(effectiveDismissals(s).get(b.itemId), "bbbbbbbb");
  assert.equal(s.pending.size, 0);
});

test("different rows are never held behind each other", async () => {
  const daemon = fakeDaemon();
  const enqueue = createDismissalWriteQueue(daemon.send);
  void enqueue([{ itemId: "blocked:s-1", occurrence: "" }]);
  void enqueue([{ itemId: "blocked:s-2", occurrence: "" }]);
  await settle();
  assert.deepEqual(daemon.received, ["blocked:s-1=", "blocked:s-2="]);
});

test("a refused or failed earlier write still lets the later one through", async () => {
  const daemon = fakeDaemon();
  const enqueue = createDismissalWriteQueue(daemon.send);
  const key = { itemId: "blocked:s-1", occurrence: "x" };
  const refused = enqueue([key]);
  const later = enqueue([{ ...key, occurrence: "y" }]);
  await settle();
  daemon.store(0, false);
  assert.deepEqual(await refused, { ok: false });
  await settle();
  daemon.store(1);
  await later;
  assert.equal(daemon.stored.get(key.itemId), "y");

  const throwing = createDismissalWriteQueue(async (keys: readonly AttentionDismissalKey[]) => {
    if (keys[0]!.occurrence === "boom") throw new Error("network down");
    return keys[0]!.occurrence;
  });
  await assert.rejects(throwing([{ ...key, occurrence: "boom" }]));
  assert.equal(await throwing([{ ...key, occurrence: "after" }]), "after");
});

test("a write naming several rows waits for each of their earlier writes", async () => {
  const daemon = fakeDaemon();
  const enqueue = createDismissalWriteQueue(daemon.send);
  void enqueue([{ itemId: "review:r-1", occurrence: "" }]);
  void enqueue([{ itemId: "review:r-2", occurrence: "" }]);
  void enqueue([{ itemId: "review:r-1", occurrence: "" }, { itemId: "review:r-2", occurrence: "" }]);
  await settle();
  assert.equal(daemon.received.length, 2);
  daemon.store(0);
  await settle();
  assert.equal(daemon.received.length, 2, "still waiting on review:r-2's earlier write");
  daemon.store(1);
  await settle();
  assert.equal(daemon.received.length, 3);
});

// ---- the revision ledger: the basis each write is sent with ----

test("the ledger keeps the newest revision of each row it has seen, and never lowers it", () => {
  const ledger = createRevisionLedger();
  assert.equal(ledger.basisFor("blocked:s-1"), 0, "a row this window has never seen");
  ledger.learn([{ itemId: "blocked:s-1", revision: 7 }]);
  // A read that started before this window's own write was stored can carry an older one.
  ledger.learn([{ itemId: "blocked:s-1", revision: 4 }]);
  assert.equal(ledger.basisFor("blocked:s-1"), 7);
  ledger.learn([{ itemId: "blocked:s-1", revision: 9 }, { itemId: "blocked:s-2", revision: 3 }]);
  assert.equal(ledger.basisFor("blocked:s-1"), 9);
  assert.equal(ledger.basisFor("blocked:s-2"), 3);
});

/**
 * A daemon applying the real rule - refuse a write whose basis is behind the stored revision,
 * all or nothing, every accepted key taking a fresh revision - that stores each write the
 * moment it RECEIVES it and answers only when the test says so. That split is what lets another
 * window act between this window's write being stored and this window hearing back.
 */
function revisionDaemon() {
  const rows = new Map<string, { occurrence: string; revision: number }>();
  let next = 0;
  const bases: number[] = [];
  const answers: (() => void)[] = [];
  const receive = (writes: readonly { itemId: string; occurrence: string; basis: number }[]) => {
    bases.push(...writes.map((write) => write.basis));
    if (writes.some((write) => (rows.get(write.itemId)?.revision ?? 0) > write.basis)) {
      return { ok: false as const };
    }
    const accepted = writes.map((write) => {
      const revision = ++next;
      rows.set(write.itemId, { occurrence: write.occurrence, revision });
      return { itemId: write.itemId, revision };
    });
    return { ok: true as const, accepted };
  };
  /** This window's transport: stored on receipt, answered when `answerNext` is called. */
  const post = (writes: readonly { itemId: string; occurrence: string; basis: number }[]) => {
    const answer = receive(writes);
    return new Promise<typeof answer>((resolve) => answers.push(() => resolve(answer)));
  };
  return { rows, bases, receive, post, answerNext: () => answers.shift()!() };
}

test("a window's second dismissal of a row is sent with the revision its first one was stored at", async () => {
  const daemon = revisionDaemon();
  const send = createDismissalSender(daemon.post, createRevisionLedger());
  // Two clicks before either is answered: the second waits, then claims the first's revision.
  const first = send([{ itemId: "blocked:s-1", occurrence: "bash" }]);
  const second = send([{ itemId: "blocked:s-1", occurrence: "edit" }]);
  await settle();
  daemon.answerNext();
  assert.equal((await first).ok, true);
  await settle();
  daemon.answerNext();
  assert.equal((await second).ok, true, "this window never refuses its own previous dismissal");
  assert.deepEqual(daemon.bases, [0, 1]);
  assert.equal(daemon.rows.get("blocked:s-1")?.occurrence, "edit");
});

test("a queued click is not upgraded by another window's dismissal made while it waited", async () => {
  // The Inspector's ordering. This window dismisses "bash"; it is stored but not yet answered.
  // The row changes and this window clicks again ("edit") - queued behind the first. The row
  // changes once more and ANOTHER window, having read this window's first dismissal, dismisses
  // "write". This window then reads that newer revision while its second click still waits.
  const daemon = revisionDaemon();
  const seen = createRevisionLedger();
  const send = createDismissalSender(daemon.post, seen);
  const first = send([{ itemId: "blocked:s-1", occurrence: "bash" }]);
  const second = send([{ itemId: "blocked:s-1", occurrence: "edit" }]);
  await settle();
  const firstRevision = daemon.rows.get("blocked:s-1")!.revision;

  const otherWindow = daemon.receive([{ itemId: "blocked:s-1", occurrence: "write", basis: firstRevision }]);
  assert.equal(otherWindow.ok, true);
  seen.learn([{ itemId: "blocked:s-1", revision: daemon.rows.get("blocked:s-1")!.revision }]);

  daemon.answerNext();
  assert.equal((await first).ok, true);
  await settle();
  daemon.answerNext();
  assert.equal((await second).ok, false, "the older click is refused, not accepted over the newer one");
  assert.deepEqual(daemon.bases.slice(-1), [firstRevision], "its basis is its own first write, not the other window's");
  assert.equal(daemon.rows.get("blocked:s-1")?.occurrence, "write", "the newer dismissal stands");
});

test("a click made after seeing another window's dismissal is the newer decision, and is accepted", async () => {
  const daemon = revisionDaemon();
  const seen = createRevisionLedger();
  const send = createDismissalSender(daemon.post, seen);
  const otherWindow = daemon.receive([{ itemId: "blocked:s-1", occurrence: "write", basis: 0 }]);
  assert.equal(otherWindow.ok, true);
  seen.learn(otherWindow.ok ? otherWindow.accepted : []);
  const mine = send([{ itemId: "blocked:s-1", occurrence: "read" }]);
  await settle();
  daemon.answerNext();
  assert.equal((await mine).ok, true);
  assert.equal(daemon.rows.get("blocked:s-1")?.occurrence, "read");
});

test("a failed read is retried soon, then less often, and never left for good", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(readRetryDelay), [500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
});

test("a failed read is retried - the first one or a later refresh - unless a newer answer already landed", () => {
  // The first read failed and nothing is known yet.
  assert.equal(shouldRetryRead(1, 0, false), true);
  // A refresh another window's dismissal prompted failed after earlier reads succeeded: retry it,
  // or this window never learns of that dismissal until some unrelated event.
  assert.equal(shouldRetryRead(5, 4, false), true);
  // A read that started after this one has already been applied: nothing was lost.
  assert.equal(shouldRetryRead(5, 6, false), false);
  // A retry is already waiting, and it reads afresh when it runs.
  assert.equal(shouldRetryRead(5, 4, true), false);
});
