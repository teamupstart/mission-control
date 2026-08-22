import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem, WorkItemState } from "../src/shared/types.ts";

// Point the daemon's state dir at a throwaway home BEFORE anything reads config,
// so this never touches the real ~/.mission-control db (config.ts resolves the
// state dir at module load, so db must be imported dynamically after).
const home = mkdtempSync(join(tmpdir(), "mission-queue-db-"));
process.env.MISSION_HOME = home;

const {
  openDb,
  upsertQueue,
  getQueueRow,
  listQueueRows,
  deleteQueue,
  upsertQueueItem,
  getQueueItem,
  listQueueItems,
  deleteQueueItem,
  nextQueueSeq,
  rekeyQueue,
  reorderQueueItems,
  listQueueRowsForCwd,
  countOpenQueueItems,
  pruneDeadQueues,
  clearQueue,
  markWorkCycleActive,
  completeWorkCycle,
  bootstrapPromptedConsumedGeneration,
  consumePromptedGeneration,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

let n = 0;
function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  const now = 1000;
  return {
    id: `i${++n}`,
    noteKey: "k1",
    seq: 0,
    intent: "do the thing",
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    completedAt: null,
    ...over,
  };
}

test("a queue row round-trips and upserts in place", () => {
  upsertQueue({
    noteKey: "k1",
    cwd: "/repo",
    branch: "main",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 1,
  });
  assert.equal(getQueueRow("k1")?.cwd, "/repo");

  upsertQueue({
    noteKey: "k1",
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: 55,
    wrapupAnswer: "ship it",
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: 3,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 2,
  });
  const r = getQueueRow("k1");
  assert.equal(r?.branch, "feature");
  assert.equal(r?.wrapupAskedAt, 55);
  assert.equal(r?.promptedLegacyCutoverGeneration, 3);
  assert.equal(listQueueRows().filter((q) => q.noteKey === "k1").length, 1, "no duplicate row");
});

test("a legacy prompted guard without an activity watermark records a cutover ceiling", () => {
  const legacy = mkdtempSync(join(tmpdir(), "mission-prompted-evidence-upgrade-"));
  const env = { ...process.env, MISSION_HOME: legacy };
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdirSync } from "node:fs";
       import { join } from "node:path";
       import { DatabaseSync } from "node:sqlite";
       mkdirSync(process.env.MISSION_HOME, { recursive: true });
       const d = new DatabaseSync(join(process.env.MISSION_HOME, "harness.db"));
       d.exec("CREATE TABLE foreman_queues (note_key TEXT PRIMARY KEY, cwd TEXT, branch TEXT, wrapup_asked_at INTEGER, wrapup_answer TEXT, prompted_goal TEXT, updated_at INTEGER NOT NULL)");
       const insert = d.prepare("INSERT INTO foreman_queues VALUES (?, ?, ?, ?, ?, ?, ?)");
       insert.run("legacy", "/repo", "feature", null, null, "intent:1:1", 30);
       insert.run("legacy-null", "/repo", "feature", null, null, null, 30);
       d.close();`,
    ],
    { env, cwd: process.cwd(), encoding: "utf8" },
  );

  const read = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const db = await import("./src/server/db.ts");
       db.openDb();
       db.markWorkCycleActive("legacy", 20);
       db.completeWorkCycle("legacy", 21, 21);
       db.markWorkCycleActive("legacy-null", 20);
       db.completeWorkCycle("legacy-null", 21, 21);
       const matched = db.bootstrapPromptedConsumedGeneration("legacy", "intent:1:1");
       const repeated = db.bootstrapPromptedConsumedGeneration("legacy", "intent:1:1");
       const unguarded = db.bootstrapPromptedConsumedGeneration("legacy-null", "intent:1:1");
       console.log(JSON.stringify({ matched, repeated, unguarded, legacy: db.getQueueRow("legacy"), legacyNull: db.getQueueRow("legacy-null") }));`,
    ],
    { env, cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  const result = JSON.parse(read.split("\n").at(-1)!) as {
    matched: boolean;
    repeated: boolean;
    unguarded: boolean;
    legacy: {
      promptedGoal: string | null;
      promptedLegacyCutoverGeneration: number | null;
      promptedConsumedGeneration: number | null;
      promptedDirectHandoff: unknown;
    };
    legacyNull: {
      promptedLegacyCutoverGeneration: number | null;
      promptedConsumedGeneration: number | null;
    };
  };
  assert.equal(result.matched, true);
  assert.equal(result.repeated, false, "bootstrap is idempotent");
  assert.equal(result.unguarded, false, "a null legacy guard stays eligible");
  assert.equal(result.legacy.promptedGoal, "intent:1:1", "legacy data remains readable");
  assert.equal(result.legacy.promptedConsumedGeneration, null, "ambiguous work is not called consumed");
  assert.equal(result.legacy.promptedLegacyCutoverGeneration, 1, "the current cycle fails closed");
  assert.equal(result.legacyNull.promptedLegacyCutoverGeneration, null);
  assert.equal(result.legacyNull.promptedConsumedGeneration, null);
  // The direct-shipping latch columns arrive by ALTER on a table that predates them, so
  // an upgraded row must read as "no handoff recorded" rather than failing the write or
  // inventing one. That is the truthful answer: this row was written before Foreman could
  // record a handoff, and the exact-payload Goal guard remains its compatibility backstop.
  assert.equal(result.legacy.promptedDirectHandoff, null, "an upgraded row records no handoff");
  const restarted = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const db = await import("./src/server/db.ts");
       console.log(JSON.stringify(db.getQueueRow("legacy")));`,
    ],
    { env, cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  const afterRestart = JSON.parse(restarted.split("\n").at(-1)!) as {
    promptedLegacyCutoverGeneration: number | null;
    promptedConsumedGeneration: number | null;
  };
  assert.equal(afterRestart.promptedConsumedGeneration, null);
  assert.equal(afterRestart.promptedLegacyCutoverGeneration, 1, "restart preserves the cutover ceiling");
  rmSync(legacy, { recursive: true, force: true });
});

test("a matching legacy watermark bootstraps only the completion it observed", () => {
  const key = "prompted-known-bootstrap";
  markWorkCycleActive(key, 20);
  completeWorkCycle(key, 21, 21);
  upsertQueue({
    noteKey: key,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: "intent:1:1",
    promptedEvidence: "generation-1-proof",
    promptedActivityAt: 21,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 22,
  });

  assert.equal(bootstrapPromptedConsumedGeneration(key, "intent:1:1"), true);
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 1);
  assert.equal(getQueueRow(key)?.promptedLegacyCutoverGeneration, null);
});

test("an ambiguous legacy ceiling blocks its cycle but naturally allows the next", () => {
  const key = "prompted-ambiguous-bootstrap";
  markWorkCycleActive(key, 20);
  completeWorkCycle(key, 21, 21);
  upsertQueue({
    noteKey: key,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: "intent:1:1",
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 50,
  });

  assert.equal(bootstrapPromptedConsumedGeneration(key, "intent:1:1"), true);
  assert.equal(getQueueRow(key)?.promptedLegacyCutoverGeneration, 1);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 1,
      ask: false,
      directHandoff: null,
      decision: null,
      now: 51,
    }),
    false,
    "the ambiguous current cycle cannot be claimed",
  );

  markWorkCycleActive(key, 52);
  completeWorkCycle(key, 53, 53);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 2,
      ask: false,
      directHandoff: null,
      decision: null,
      now: 54,
    }),
    true,
    "a later completed cycle re-arms without a legacy prompt reset",
  );
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 2);
});

test("the direct-shipping handoff is stamped by the consume, and only by it", () => {
  const key = "prompted-direct-handoff";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);

  // A consumption that makes no handoff records none. Both Workflow claims and every
  // ask/hold/retire path go through here, so this is the default and it must stay clean:
  // latching on a handoff that never happened would permanently disarm the trigger.
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 1, ask: false, directHandoff: null, decision: null, now: 12 }),
    true,
  );
  assert.equal(getQueueRow(key)?.promptedDirectHandoff, null);

  // The direct shipping path stamps the latch and consumes the generation in ONE
  // statement. Mark-before-inject is a property of this transaction: Foreman calls it
  // before it types, and never retries the injection afterwards.
  markWorkCycleActive(key, 13);
  completeWorkCycle(key, 14, 14);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 2,
      ask: false,
      directHandoff: { kind: "direct-ship", episodeKey: "intent:1:1" },
      decision: null,
      now: 15,
    }),
    true,
  );
  assert.deepEqual(getQueueRow(key)?.promptedDirectHandoff, {
    kind: "direct-ship",
    episodeKey: "intent:1:1",
    generation: 2,
  });

  // The shipping instruction's own settled turn completes generation 3. This layer is a
  // compare-and-set on the GENERATION and nothing else, so it accepts that consumption -
  // suppressing the episode is `decidePromptedWrapup`'s job, above, and duplicating it
  // here would also block the legitimate later consumers (a Workflow claim, a retire).
  // What this layer owes is that consuming does not ERASE the latch: that would erase
  // the record of an instruction already typed into the pane, and the next tick would
  // type it again.
  markWorkCycleActive(key, 16);
  completeWorkCycle(key, 17, 17);
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 3, ask: false, directHandoff: null, decision: null, now: 18 }),
    true,
  );
  assert.deepEqual(
    getQueueRow(key)?.promptedDirectHandoff,
    { kind: "direct-ship", episodeKey: "intent:1:1", generation: 2 },
    "a later consumption must never erase a recorded handoff",
  );
});

test("a failed direct consume records no handoff at all", () => {
  // The other half of mark-before-inject: if the mark does not land, Foreman aborts and
  // types nothing. A row that recorded the handoff anyway would disarm a session that
  // was never shipped, and the human Ship it? fallback would never be offered either.
  const key = "prompted-direct-refused";
  markWorkCycleActive(key, 20);
  completeWorkCycle(key, 21, 21);
  upsertQueueItem(mkItem({ id: "direct-blocked", noteKey: key }));
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 1,
      ask: false,
      directHandoff: { kind: "direct-ship", episodeKey: "intent:1:1" },
      decision: null,
      now: 22,
    }),
    false,
    "drain precedence still refuses the write",
  );
  assert.equal(getQueueRow(key)?.promptedDirectHandoff ?? null, null);
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration ?? null, null);
});

test("a re-attached queue never carries another conversation's handoff", () => {
  // Episode keys are per-conversation counters (`intent:<objectiveVersion>:<promptRevision>`),
  // so a source row's `intent:1:1` would collide with the target conversation's own first
  // episode and silently disarm prompted completion on work it never shipped.
  const from = "rekey-handoff-from";
  markWorkCycleActive(from, 30);
  completeWorkCycle(from, 31, 31);
  assert.equal(
    consumePromptedGeneration({
      noteKey: from,
      sessionCwd: "/repo",
      generation: 1,
      ask: false,
      directHandoff: { kind: "direct-ship", episodeKey: "intent:1:1" },
      decision: null,
      now: 32,
    }),
    true,
  );
  const row = getQueueRow(from);
  assert.equal(row?.promptedDirectHandoff?.kind, "direct-ship");

  rekeyQueue(
    from,
    { ...row!, noteKey: "rekey-handoff-to", promptedDirectHandoff: null, promptedDecision: null, updatedAt: 33 },
    [],
  );
  assert.equal(getQueueRow("rekey-handoff-to")?.promptedDirectHandoff ?? null, null);
});

test("prompted consumption is an exact-generation compare-and-set with an atomic ask", () => {
  const key = "prompted-cas";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);

  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 1, ask: false, directHandoff: null, decision: null, now: 12 }),
    true,
  );
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 1);
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 1, ask: false, directHandoff: null, decision: null, now: 13 }),
    false,
    "the same generation cannot be consumed twice",
  );

  markWorkCycleActive(key, 14);
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 1, ask: true, directHandoff: null, decision: null, now: 15 }),
    false,
    "a stale result cannot consume while newer work is active",
  );
  completeWorkCycle(key, 16, 16);
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 2, ask: true, directHandoff: null, decision: null, now: 17 }),
    true,
  );
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 2);
  assert.equal(getQueueRow(key)?.wrapupAskedAt, 17, "the ask and generation share one write");

  markWorkCycleActive(key, 18);
  completeWorkCycle(key, 19, 19);
  upsertQueueItem(mkItem({ id: "prompted-queued", noteKey: key }));
  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 3, ask: false, directHandoff: null, decision: null, now: 20 }),
    false,
    "queued work keeps drain precedence at the write boundary",
  );
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 2);

  assert.equal(
    bootstrapPromptedConsumedGeneration(key, "intent:1:1"),
    false,
    "the legacy bootstrap cannot overwrite a consumed generation",
  );
});

test("legacy prompted bootstrap refuses an active work cycle with an older completion", () => {
  const key = "prompted-active-bootstrap";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);
  markWorkCycleActive(key, 12);
  completeWorkCycle(key, 13, 13);
  markWorkCycleActive(key, 14);
  upsertQueue({
    noteKey: key,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: "intent:1:1",
    promptedEvidence: "old-proof",
    promptedActivityAt: 13,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 14,
  });

  assert.equal(bootstrapPromptedConsumedGeneration(key, "intent:1:1"), false);
  assert.equal(
    getQueueRow(key)?.promptedConsumedGeneration,
    null,
    "an older completedAt cannot make in-progress work look consumed",
  );
});

test("legacy prompted bootstrap does not consume a completion newer than its boundary", () => {
  const key = "prompted-newer-bootstrap";
  markWorkCycleActive(key, 20);
  completeWorkCycle(key, 21, 21);
  upsertQueue({
    noteKey: key,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: "intent:1:1",
    promptedEvidence: "generation-1-proof",
    promptedActivityAt: 21,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 22,
  });
  markWorkCycleActive(key, 23);
  completeWorkCycle(key, 24, 24);

  assert.equal(bootstrapPromptedConsumedGeneration(key, "intent:1:1"), false);
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, null);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 2,
      ask: false,
      directHandoff: null,
      decision: null,
      now: 25,
    }),
    true,
    "the newer completion remains eligible for normal generation consumption",
  );
});

test("prompted consumption never moves a consumed generation backward", () => {
  const key = "prompted-monotonic";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);
  upsertQueue({
    noteKey: key,
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: 2,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 12,
  });

  assert.equal(
    consumePromptedGeneration({ noteKey: key, sessionCwd: "/repo", generation: 1, ask: false, directHandoff: null, decision: null, now: 13 }),
    false,
  );
  assert.equal(getQueueRow(key)?.promptedConsumedGeneration, 2);
});

test("an item round-trips with its gaps, and upsert updates in place", () => {
  const item = mkItem({
    id: "gapped",
    gaps: [
      {
        id: "g1",
        severity: "blocking",
        kind: "untested",
        path: "src/a.ts",
        detail: "no test covers the new branch",
        fix: "add a test",
        strikes: 2,
        firstSeenRound: 0,
      },
    ],
  });
  upsertQueueItem(item);
  const back = getQueueItem("gapped");
  assert.equal(back?.gaps.length, 1);
  assert.equal(back?.gaps[0]?.strikes, 2);
  assert.equal(back?.gaps[0]?.severity, "blocking");

  upsertQueueItem({ ...item, state: "verified", gaps: [] });
  assert.equal(getQueueItem("gapped")?.state, "verified");
  assert.equal(getQueueItem("gapped")?.gaps.length, 0);
  assert.equal(listQueueItems("k1").filter((i) => i.id === "gapped").length, 1);
});

test("items list in authored order, and nextQueueSeq appends after the last", () => {
  const key = "order-key";
  upsertQueueItem(mkItem({ id: "b", noteKey: key, seq: 1, intent: "second" }));
  upsertQueueItem(mkItem({ id: "a", noteKey: key, seq: 0, intent: "first" }));
  upsertQueueItem(mkItem({ id: "c", noteKey: key, seq: 2, intent: "third" }));
  assert.deepEqual(
    listQueueItems(key).map((i) => i.id),
    ["a", "b", "c"],
  );
  assert.equal(nextQueueSeq(key), 3);
  assert.equal(nextQueueSeq("never-used"), 0, "an empty queue starts at 0");
});

test("queues are isolated per key: one key's items never leak into another's", () => {
  upsertQueueItem(mkItem({ id: "mine", noteKey: "iso-a" }));
  upsertQueueItem(mkItem({ id: "yours", noteKey: "iso-b" }));
  assert.deepEqual(
    listQueueItems("iso-a").map((i) => i.id),
    ["mine"],
  );
  assert.deepEqual(
    listQueueItems("iso-b").map((i) => i.id),
    ["yours"],
  );
});

test("reorder renumbers the whole list in one transaction", () => {
  const key = "reorder-key";
  upsertQueueItem(mkItem({ id: "r1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "r2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "r3", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["r3", "r1", "r2"], 5000);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["r3", "r1", "r2"],
  );
  // Contiguous from 0 - the authored order is the queue's whole contract, so it
  // must never be left with gaps or collisions.
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1, 2],
  );
});

test("reorder leaves an item the client didn't list AFTER the reordered block", () => {
  // A concurrent add races the drop: the new item isn't in the client's id list,
  // so it must keep a stable position rather than colliding at seq 0.
  const key = "reorder-race";
  upsertQueueItem(mkItem({ id: "x1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "x2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "late", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["x2", "x1"], 6000);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["x2", "x1", "late"],
  );
  assert.equal(items.at(-1)?.seq, 2, "the unlisted item lands right after the block");
});

test("reorder of a PARTIAL list still leaves every unlisted item after the block", () => {
  // The case the "unlisted items are handled" claim actually rests on, and the one
  // the test above passes vacuously: an unlisted row that would COLLIDE. The route
  // only validates that each id it was given is known - it never requires the whole
  // list - so a subset reorder is legal, and here `x1` sits at the very seq the
  // reordered head is about to take. Two rows at seq 0 hands `nextSendable`'s
  // strict `<` to arbitrary row order, i.e. which work instruction gets typed
  // becomes luck. Every seq below is distinct on purpose.
  const key = "reorder-partial";
  upsertQueueItem(mkItem({ id: "p1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "p2", noteKey: key, seq: 1 }));
  upsertQueueItem(mkItem({ id: "p3", noteKey: key, seq: 2 }));

  reorderQueueItems(key, ["p2"], 6500);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["p2", "p1", "p3"],
    "the listed item leads; the unlisted ones follow in their authored order",
  );
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1, 2],
    "contiguous and collision-free - the head must never be decided by a tie",
  );
});

test("reorder with an empty id list is a no-op, not a renumber to nothing", () => {
  const key = "reorder-empty";
  upsertQueueItem(mkItem({ id: "e1", noteKey: key, seq: 0 }));
  upsertQueueItem(mkItem({ id: "e2", noteKey: key, seq: 1 }));

  reorderQueueItems(key, [], 6600);

  const items = listQueueItems(key);
  assert.deepEqual(
    items.map((i) => i.id),
    ["e1", "e2"],
  );
  assert.deepEqual(
    items.map((i) => i.seq),
    [0, 1],
  );
});

// The single-flight index is the one constraint the whole design rests on: the
// stakes of two in-flight items in one queue are a duplicated WORK INSTRUCTION
// typed into a live agent, which can duplicate commits or re-run migrations. It
// is enforced by the DB rather than by hope, so prove the DB actually rejects it.
const IN_FLIGHT: WorkItemState[] = ["sending", "awaiting_pickup", "in_progress", "verifying"];

test("the single-flight index rejects a second in-flight item in one queue", () => {
  const key = "flight-key";
  upsertQueueItem(mkItem({ id: "f1", noteKey: key, seq: 0, state: "in_progress" }));
  assert.throws(
    () => upsertQueueItem(mkItem({ id: "f2", noteKey: key, seq: 1, state: "sending" })),
    /UNIQUE|constraint/i,
    "a second in-flight item must be rejected by the DB",
  );
});

test("every in-flight state collides with every other one", () => {
  for (const a of IN_FLIGHT) {
    for (const b of IN_FLIGHT) {
      const key = `pair-${a}-${b}`;
      upsertQueueItem(mkItem({ noteKey: key, seq: 0, state: a }));
      assert.throws(
        () => upsertQueueItem(mkItem({ noteKey: key, seq: 1, state: b })),
        /UNIQUE|constraint/i,
        `${a} + ${b} must not coexist`,
      );
    }
  }
});

test("the index constrains one queue only - two queues each run their own item", () => {
  upsertQueueItem(mkItem({ id: "q1-flight", noteKey: "sep-a", state: "in_progress" }));
  upsertQueueItem(mkItem({ id: "q2-flight", noteKey: "sep-b", state: "in_progress" }));
  assert.equal(getQueueItem("q1-flight")?.state, "in_progress");
  assert.equal(getQueueItem("q2-flight")?.state, "in_progress");
});

test("waiting and terminal items are unconstrained - only the cycle is single-flight", () => {
  const key = "many-key";
  upsertQueueItem(mkItem({ noteKey: key, seq: 0, state: "queued" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 1, state: "queued" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 2, state: "proposed" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 3, state: "verified" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 4, state: "escalated" }));
  upsertQueueItem(mkItem({ noteKey: key, seq: 5, state: "cancelled" }));
  // ...plus exactly one in flight alongside them all.
  upsertQueueItem(mkItem({ noteKey: key, seq: 6, state: "verifying" }));
  assert.equal(listQueueItems(key).length, 7);
});

test("an item leaving the cycle releases the index for the next one", () => {
  // This is what makes the queue advance at all: item N finishes, item N+1 starts.
  const key = "release-key";
  upsertQueueItem(mkItem({ id: "rel1", noteKey: key, seq: 0, state: "verifying" }));
  upsertQueueItem({ ...getQueueItem("rel1")!, state: "verified" });
  upsertQueueItem(mkItem({ id: "rel2", noteKey: key, seq: 1, state: "sending" }));
  assert.equal(getQueueItem("rel2")?.state, "sending");
});

test("deleting an item and a queue row leaves nothing behind", () => {
  upsertQueue({
    noteKey: "gone",
    cwd: "/x",
    branch: null,
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 1,
  });
  upsertQueueItem(mkItem({ id: "doomed", noteKey: "gone" }));
  deleteQueueItem("doomed");
  deleteQueue("gone");
  assert.equal(getQueueItem("doomed"), undefined);
  assert.equal(getQueueRow("gone"), undefined);
});

test("the single-flight index is rebuilt when its predicate drifts from the shared constant", () => {
  // Deriving the index SQL from IN_FLIGHT_ITEM_STATES only makes the enforcement
  // agree with its readers on a FRESH db - `CREATE UNIQUE INDEX IF NOT EXISTS`
  // leaves an existing index alone. So a db written by an older build would keep
  // enforcing the OLD predicate while both TypeScript readers used the new one: the
  // same silent drift the shared constant exists to prevent, just deferred to
  // upgrade time. The stakes are two items in flight in one queue, i.e. a duplicated
  // work instruction typed into a live agent.
  //
  // Across two PROCESSES on one db file, because that's the only way the repair can
  // actually happen: openDb caches its handle, so migrate runs once per start.
  const drifted = mkdtempSync(join(tmpdir(), "mission-drift-"));
  const run = (src: string): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", src], {
      env: { ...process.env, MISSION_HOME: drifted },
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();

  const READ = `const d = (await import("./src/server/db.ts")).openDb();
    console.log(d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'").get().sql);`;

  // A fresh db derives the full in-flight set from the constant.
  assert.match(run(READ), /'verifying'/);

  // Rewrite it the way an older build would have left it, then start again.
  run(`const d = (await import("./src/server/db.ts")).openDb();
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec("CREATE UNIQUE INDEX one_inflight_per_queue ON foreman_queue_items(note_key) WHERE state IN ('sending','awaiting_pickup','in_progress');");`);

  assert.match(run(READ), /'verifying'/, "the next start rebuilds it from the constant");

  // And the repaired index really enforces the state it regained: a second
  // `verifying` item in one queue is rejected by the db, not merely by hope.
  const guard = run(`const db = await import("./src/server/db.ts");
    db.openDb();
    db.upsertQueue({ noteKey: "drift", cwd: null, branch: null, wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 0 });
    const mk = (id, seq) => ({ id, noteKey: "drift", seq, intent: "i", state: "verifying", round: 0,
      baseSha: null, transcriptAnchor: null, gaps: [], sendAttempts: 0, verifyFailures: 0,
      escalationReason: null, lastVerdict: null, approvedAt: null, proposedPayload: null,
      recoveredAt: null, revision: 0, createdAt: 0, updatedAt: 0, sentAt: null, completedAt: null });
    db.upsertQueueItem(mk("d1", 0));
    try { db.upsertQueueItem(mk("d2", 1)); console.log("ACCEPTED"); }
    catch { console.log("REJECTED"); }`);
  assert.equal(guard, "REJECTED", "two items must never be in flight in one queue");

  rmSync(drifted, { recursive: true, force: true });
});

test("a single-flight rebuild that CANNOT succeed keeps the old index and still opens", () => {
  // The failure path of the rebuild above, which the success-path test can't reach.
  // Widening the predicate can surface rows that already violate it - that's worth
  // reporting, but not worth refusing to open the db over.
  //
  // DDL is transactional in SQLite, and that is load-bearing here rather than tidy.
  // Without a transaction the DROP commits on its own: the CREATE then fails on the
  // violating rows, the catch logs, and the table is left with NO index at all. So
  // single-flight enforcement is silently gone AND the next openDb() runs
  // `CREATE UNIQUE INDEX IF NOT EXISTS` against those same rows with nothing to make
  // it a no-op, throws uncaught, and the daemon never starts again - the exact
  // bricking the catch was written to prevent.
  //
  // Hence THREE starts: the bug is invisible on the start that drops the index and
  // only bites on the one after it.
  const stuck = mkdtempSync(join(tmpdir(), "mission-stuck-"));
  const run = (src: string): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", src], {
      env: { ...process.env, MISSION_HOME: stuck },
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();

  const READ = `const d = (await import("./src/server/db.ts")).openDb();
    const r = d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'").get();
    console.log(r ? r.sql : "NO INDEX");`;

  // Start 1: narrow the index the way an older build left it, then seed two
  // `verifying` items in ONE queue. That's legal under the narrow predicate and a
  // violation of the widened one, so the next start's rebuild cannot succeed.
  run(`const db = await import("./src/server/db.ts");
    const d = db.openDb();
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec("CREATE UNIQUE INDEX one_inflight_per_queue ON foreman_queue_items(note_key) WHERE state IN ('sending','awaiting_pickup','in_progress');");
    db.upsertQueue({ noteKey: "stuck", cwd: null, branch: null, wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 0 });
    const mk = (id, seq) => ({ id, noteKey: "stuck", seq, intent: "i", state: "verifying", round: 0,
      baseSha: null, transcriptAnchor: null, gaps: [], sendAttempts: 0, verifyFailures: 0,
      escalationReason: null, lastVerdict: null, approvedAt: null, proposedPayload: null,
      recoveredAt: null, revision: 0, createdAt: 0, updatedAt: 0, sentAt: null, completedAt: null });
    db.upsertQueueItem(mk("k1", 0));
    db.upsertQueueItem(mk("k2", 1));`);

  // Start 2: the rebuild is attempted and fails. The db must still open, and the old
  // index must still be there enforcing what it can.
  const second = run(READ);
  assert.notEqual(second, "NO INDEX", "a failed rebuild must not leave the table unindexed");
  assert.doesNotMatch(second, /'verifying'/, "the old, narrower index is kept");

  // Start 3: the one that actually catches it. An uncommitted DROP leaves openDb's
  // own CREATE UNIQUE INDEX to throw here, and the daemon never starts again.
  assert.doesNotThrow(
    () => run(READ),
    "a db whose rebuild failed must still open on every subsequent start",
  );

  rmSync(stuck, { recursive: true, force: true });
});

test("rekeyQueue moves a whole queue onto a new key", () => {
  upsertQueue({ noteKey: "rk-from", cwd: "/r", branch: "b", wrapupAskedAt: 7, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 1 });
  const a = mkItem({ noteKey: "rk-from", seq: 0, intent: "first" });
  const b = mkItem({ noteKey: "rk-from", seq: 1, intent: "second" });
  upsertQueueItem(a);
  upsertQueueItem(b);

  rekeyQueue(
    "rk-from",
    { noteKey: "rk-to", cwd: "/r", branch: "b", wrapupAskedAt: 7, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 2 },
    [
      { ...a, noteKey: "rk-to", seq: 0 },
      { ...b, noteKey: "rk-to", seq: 1 },
    ],
  );

  assert.equal(getQueueRow("rk-from"), undefined, "the source row is gone");
  assert.deepEqual(listQueueItems("rk-from"), []);
  assert.deepEqual(
    listQueueItems("rk-to").map((i) => i.intent),
    ["first", "second"],
    "in authored order, on the new key",
  );
});

test("rekeyQueue ROLLS BACK a half-applied move - the batch is never split", () => {
  // The whole reason this is one transaction. Statement-by-statement, a throw partway
  // leaves some items re-keyed under a queue row that may already be deleted and the
  // rest on the old key: a split no reader models, and one the re-attach button can't
  // repair, since the hint it keys off is computed from the very rows that got moved.
  upsertQueue({ noteKey: "rb-from", cwd: "/r", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 1 });
  const good = mkItem({ noteKey: "rb-from", seq: 0, intent: "keep me" });
  const also = mkItem({ noteKey: "rb-from", seq: 1, intent: "and me" });
  upsertQueueItem(good);
  upsertQueueItem(also);

  // The second write is rejected by SQLite (intent is NOT NULL) AFTER the first has
  // already been re-keyed - the exact "died partway" shape.
  assert.throws(() =>
    rekeyQueue(
      "rb-from",
      { noteKey: "rb-to", cwd: "/r", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: 2 },
      [
        { ...good, noteKey: "rb-to", seq: 0 },
        { ...also, noteKey: "rb-to", seq: 1, intent: null as unknown as string },
      ],
    ),
  );

  assert.ok(getQueueRow("rb-from"), "the source queue row survives");
  assert.equal(getQueueRow("rb-to"), undefined, "and no half-built target row is left behind");
  assert.deepEqual(
    listQueueItems("rb-from").map((i) => i.intent),
    ["keep me", "and me"],
    "every item is still on the source key - all of it, or none of it",
  );
  assert.deepEqual(listQueueItems("rb-to"), [], "nothing leaked onto the target");
});

// ---- retention + the indexed cwd lookup ----
//
// Nothing pruned these rows, so they accumulated for the DB's lifetime - and every
// `/clear` mints a new note key, hence a new row. Two hot paths read the table
// several times a second on the single synchronous handle that also serves hook
// ingest and SSE, so the floor rose with use and never came back down.

function seedRow(key: string, cwd: string, updatedAt: number): void {
  upsertQueue({ noteKey: key, cwd, branch: "b", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt });
}

test("listQueueRowsForCwd returns only that cwd's queues", () => {
  seedRow("cwd-a1", "/repo-a", 5000);
  seedRow("cwd-a2", "/repo-a", 6000);
  seedRow("cwd-b1", "/repo-b", 7000);

  const a = listQueueRowsForCwd("/repo-a").map((r) => r.noteKey).sort();
  assert.deepEqual(a, ["cwd-a1", "cwd-a2"]);
  assert.deepEqual(listQueueRowsForCwd("/repo-b").map((r) => r.noteKey), ["cwd-b1"]);
  assert.deepEqual(listQueueRowsForCwd("/nowhere"), []);
});

test("countOpenQueueItems counts the non-terminal items and hydrates nothing", () => {
  seedRow("count-1", "/c", 1000);
  upsertQueueItem(mkItem({ noteKey: "count-1", seq: 0, state: "queued" }));
  upsertQueueItem(mkItem({ noteKey: "count-1", seq: 1, state: "verifying" }));
  upsertQueueItem(mkItem({ noteKey: "count-1", seq: 2, state: "verified" }));
  upsertQueueItem(mkItem({ noteKey: "count-1", seq: 3, state: "escalated" }));
  upsertQueueItem(mkItem({ noteKey: "count-1", seq: 4, state: "cancelled" }));

  assert.equal(countOpenQueueItems("count-1"), 2);
  assert.equal(countOpenQueueItems("no-such-queue"), 0);
});

test("pruneDeadQueues drops a FINISHED, session-less, aged-out queue and its items", () => {
  seedRow("dead-1", "/gone", 1000);
  const item = mkItem({ noteKey: "dead-1", state: "verified" });
  upsertQueueItem(item);

  // Asserted on identity rather than a returned count: this DB is shared across the
  // file, so a count would be measuring the other tests' rows too.
  pruneDeadQueues(new Set(), 5000);
  assert.equal(getQueueRow("dead-1"), undefined);
  assert.equal(getQueueItem(item.id), undefined, "its items go with it");
});

test("pruneDeadQueues NEVER drops a queue with open work, however old", () => {
  // The whole point of the re-attach affordance: the orphan sweep deliberately leaves
  // `queued` items intact so a human can resume them. A retention policy that ate
  // those would be a bug wearing a safety hat.
  seedRow("backlog-1", "/left", 1);
  upsertQueueItem(mkItem({ noteKey: "backlog-1", state: "queued" }));
  seedRow("draft-1", "/left", 1);
  upsertQueueItem(mkItem({ noteKey: "draft-1", state: "proposed" }));

  pruneDeadQueues(new Set(), Date.now());
  assert.ok(getQueueRow("backlog-1"), "an untouched backlog is not garbage");
  assert.ok(getQueueRow("draft-1"), "nor is a draft awaiting an Approve");
});

test("pruneDeadQueues NEVER drops a LIVE session's queue, drained or not", () => {
  // A drained queue on a session you are still sitting in is the card's own history,
  // and the wrap-up ask hangs off that row.
  seedRow("live-1", "/here", 1);
  upsertQueueItem(mkItem({ noteKey: "live-1", state: "verified" }));

  pruneDeadQueues(new Set(["live-1"]), Date.now());
  assert.ok(getQueueRow("live-1"));

  // ...and once that session is gone, the same row is collectable.
  pruneDeadQueues(new Set(), Date.now());
  assert.equal(getQueueRow("live-1"), undefined);
});

test("pruneDeadQueues leaves a recently-touched queue alone", () => {
  seedRow("recent-1", "/fresh", 9000);
  upsertQueueItem(mkItem({ noteKey: "recent-1", state: "verified" }));

  pruneDeadQueues(new Set(), 5000);
  assert.ok(getQueueRow("recent-1"), "inside the retention window");
});

test("pruneDeadQueues collects an EMPTY row at any age, but keeps one holding wrap-up state", () => {
  // `ensureQueue` mints a row for any session whose wrap-up state is merely touched, and
  // the `prompted` trigger touches every session it ever considers - including the hold
  // and empty-diff outcomes that never produce a queue. A row with no items and none of
  // the three wrap-up fields set holds nothing anyone can resume, answer or re-arm, so
  // there is nothing for the retention window to protect.
  seedRow("empty-1", "/churn", Date.now());
  pruneDeadQueues(new Set(), 1);
  assert.equal(getQueueRow("empty-1"), undefined, "an itemless, stateless row is not history");

  // ...but each guard field alone is state worth keeping: an unanswered Ship it? card,
  // a human's answer, a legacy prompt guard, or a conservative migration ceiling.
  upsertQueue({ noteKey: "keep-ask", cwd: "/k", branch: "b", wrapupAskedAt: 500, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() });
  upsertQueue({ noteKey: "keep-answer", cwd: "/k", branch: "b", wrapupAskedAt: null, wrapupAnswer: "ship directly", promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() });
  upsertQueue({ noteKey: "keep-goal", cwd: "/k", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: "ship the uploader", promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: null, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() });
  upsertQueue({ noteKey: "keep-cutover", cwd: "/k", branch: "b", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, promptedEvidence: null, promptedActivityAt: null, promptedLegacyCutoverGeneration: 1, promptedConsumedGeneration: null, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() });

  pruneDeadQueues(new Set(), 1);
  assert.ok(getQueueRow("keep-ask"), "an unanswered ask still has to render");
  assert.ok(getQueueRow("keep-answer"), "an answer is the human's, not ours to drop");
  assert.ok(getQueueRow("keep-goal"), "dropping the guard re-arms the trigger on an idle session");
  assert.ok(getQueueRow("keep-cutover"), "dropping the cutover ceiling can replay legacy work");

  // And a LIVE session's empty row is untouchable, because `ensureQueue` plus the stamp
  // that follows it are two writes - between them the row is legitimately empty.
  seedRow("empty-live", "/here", Date.now());
  pruneDeadQueues(new Set(["empty-live"]), 1);
  assert.ok(getQueueRow("empty-live"), "never collect the row a live session is mid-write on");
});

test("clearQueue drops the row and EVERY item - open and in-flight alike", () => {
  // Where pruneDeadQueues refuses open work, the reset's clear takes it all: the
  // task these items were authored for is gone.
  seedRow("clr-1", "/wipe", 9000);
  const waiting = mkItem({ noteKey: "clr-1", state: "queued" });
  const draft = mkItem({ noteKey: "clr-1", state: "proposed" });
  const flight = mkItem({ noteKey: "clr-1", state: "in_progress" });
  const done = mkItem({ noteKey: "clr-1", state: "verified" });
  [waiting, draft, flight, done].forEach(upsertQueueItem);

  assert.equal(clearQueue("clr-1"), true, "reports it cleared something");
  assert.equal(getQueueRow("clr-1"), undefined, "the row is gone");
  assert.deepEqual(listQueueItems("clr-1"), [], "and so is every item, in-flight included");
});

test("clearQueue is a no-op on a key that holds no queue", () => {
  assert.equal(clearQueue("never-existed"), false);
});

test("clearQueue is scoped to its key - a sibling queue is untouched", () => {
  seedRow("clr-mine", "/shared", 9000);
  upsertQueueItem(mkItem({ id: "keep", noteKey: "clr-other", state: "queued" }));
  seedRow("clr-other", "/shared", 9000);

  clearQueue("clr-mine");
  assert.ok(getQueueRow("clr-other"), "the neighbour's row survives");
  assert.equal(getQueueItem("keep")?.state, "queued", "and its items");
});

test("a prompted decision is written by the consume, replaced by the next one, and cleared by a caller with none", () => {
  const key = "prompted-decision";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);

  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 1,
      ask: false,
      directHandoff: null,
      decision: {
        outcome: "held",
        summary: "the retry path has no test",
        gaps: [{ id: "retry-untested", path: "src/up.ts", detail: "no test covers the 500 retry" }],
      },
      now: 12,
    }),
    true,
  );
  // The stored key and generation are the ones this statement SPENT, not anything the
  // caller labelled it with - that is what lets a reader treat placement as proof.
  assert.deepEqual(getQueueRow(key)?.promptedDecision, {
    logicalKey: key,
    generation: 1,
    outcome: "held",
    summary: "the retry path has no test",
    gaps: [{ id: "retry-untested", path: "src/up.ts", detail: "no test covers the 500 retry" }],
    decidedAt: 12,
  });

  // A later generation REPLACES the reason atomically. Preserving the older one would
  // describe work this session has since finished.
  markWorkCycleActive(key, 13);
  completeWorkCycle(key, 14, 14);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 2,
      ask: false,
      directHandoff: { kind: "direct-ship", episodeKey: "intent:1:1" },
      decision: { outcome: "direct_handoff", summary: "shipping directly", gaps: [] },
      now: 15,
    }),
    true,
  );
  const shipped = getQueueRow(key);
  assert.equal(shipped?.promptedDecision?.outcome, "direct_handoff");
  assert.equal(shipped?.promptedDecision?.generation, 2);
  assert.deepEqual(shipped?.promptedDecision?.gaps, [], "the older hold's gaps did not survive");
  assert.equal(shipped?.promptedDirectHandoff?.kind, "direct-ship", "the latch is unaffected");

  // A REFUSED consume writes neither. The reason rides inside the same compare-and-set, so
  // a stale generation cannot relabel a decision it did not spend.
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 2,
      ask: false,
      directHandoff: null,
      decision: { outcome: "empty", summary: "stale caller", gaps: [] },
      now: 15.5,
    }),
    false,
  );
  assert.equal(getQueueRow(key)?.promptedDecision?.summary, "shipping directly");

  // A wire caller from a build that predates the field CLEARS the reason rather than
  // leaving one that claims to describe the generation this write just replaced.
  markWorkCycleActive(key, 16);
  completeWorkCycle(key, 17, 17);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 3,
      ask: false,
      directHandoff: null,
      decision: null,
      now: 18,
    }),
    true,
  );
  const cleared = getQueueRow(key);
  assert.equal(cleared?.promptedConsumedGeneration, 3);
  assert.equal(cleared?.promptedDecision, null, "no reason outlives its generation");
  assert.equal(
    cleared?.promptedDirectHandoff?.generation,
    2,
    "clearing the reason must not erase an instruction that was already typed",
  );
});

test("unreadable prompted decision state reads as absent, and never as fresh work", () => {
  const key = "prompted-decision-broken";
  markWorkCycleActive(key, 10);
  completeWorkCycle(key, 11, 11);
  assert.equal(
    consumePromptedGeneration({
      noteKey: key,
      sessionCwd: "/repo",
      generation: 1,
      ask: false,
      directHandoff: null,
      decision: { outcome: "retired", summary: "nothing to ship", gaps: [] },
      now: 12,
    }),
    true,
  );

  const poison = (payload: string | null): void => {
    openDb().prepare(`UPDATE foreman_queues SET prompted_decision = ? WHERE note_key = ?`)
      .run(payload, key);
  };
  const cases: [string, string][] = [
    ["invalid JSON", "{not json"],
    ["not an object", `"held"`],
    // The vocabulary is append-only, so a NEWER build's outcome lands here. It must read
    // as unknown rather than as the nearest value this build happens to have.
    ["unknown outcome", JSON.stringify({ logicalKey: key, generation: 1, outcome: "escalated", summary: "", gaps: [], decidedAt: 1 })],
    ["another key's decision", JSON.stringify({ logicalKey: "somewhere-else", generation: 1, outcome: "held", summary: "", gaps: [], decidedAt: 1 })],
    ["a generation that was never consumed", JSON.stringify({ logicalKey: key, generation: 7, outcome: "held", summary: "", gaps: [], decidedAt: 1 })],
    ["no decision time", JSON.stringify({ logicalKey: key, generation: 1, outcome: "held", summary: "", gaps: [] })],
  ];
  for (const [why, payload] of cases) {
    poison(payload);
    const row = getQueueRow(key);
    assert.equal(row?.promptedDecision, null, `${why} should read as no actionable decision`);
    // The whole point of failing closed HERE: the generation stays consumed, so nothing
    // replays a spent turn merely because its reason could not be interpreted.
    assert.equal(row?.promptedConsumedGeneration, 1, `${why} must not re-arm the generation`);
  }

  // Bounds are re-applied on READ, because a write bound only ever held for payloads this
  // build wrote.
  poison(JSON.stringify({
    logicalKey: key,
    generation: 1,
    outcome: "held",
    summary: "x".repeat(9000),
    gaps: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, path: "p", detail: "y".repeat(9000) })),
    decidedAt: 1,
  }));
  const bounded = getQueueRow(key)?.promptedDecision;
  assert.equal(bounded?.summary.length, 2000);
  assert.equal(bounded?.gaps.length, 3);
  assert.equal(bounded?.gaps[0]?.detail.length, 600);

  // An ordinary row refresh re-serializes from the READ model, so it cannot launder an
  // unreadable payload back into storage.
  poison("{not json");
  const refreshed = getQueueRow(key)!;
  upsertQueue({ ...refreshed, branch: "renamed", updatedAt: 99 });
  assert.equal(getQueueRow(key)?.promptedDecision, null);
});

test("a database that predates the decision column upgrades, reads null, and stays consumed", () => {
  const legacy = mkdtempSync(join(tmpdir(), "mission-prompted-decision-upgrade-"));
  const env = { ...process.env, MISSION_HOME: legacy };
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdirSync } from "node:fs";
       import { join } from "node:path";
       import { DatabaseSync } from "node:sqlite";
       mkdirSync(process.env.MISSION_HOME, { recursive: true });
       const d = new DatabaseSync(join(process.env.MISSION_HOME, "harness.db"));
       d.exec("CREATE TABLE foreman_queues (note_key TEXT PRIMARY KEY, cwd TEXT, branch TEXT, wrapup_asked_at INTEGER, wrapup_answer TEXT, prompted_goal TEXT, prompted_consumed_generation INTEGER, updated_at INTEGER NOT NULL)");
       d.prepare("INSERT INTO foreman_queues VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("old", "/repo", "feature", null, null, null, 4, 30);
       d.close();`,
    ],
    { env, cwd: process.cwd(), encoding: "utf8" },
  );

  const read = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `const db = await import("./src/server/db.ts");
       db.openDb();
       const legacyRow = db.getQueueRow("old");
       db.markWorkCycleActive("fresh", 40);
       db.completeWorkCycle("fresh", 41, 41);
       const wrote = db.consumePromptedGeneration({
         noteKey: "fresh", sessionCwd: "/repo", generation: 1, ask: false, directHandoff: null,
         decision: { outcome: "verification_failed", summary: "verify failed 3x", gaps: [] },
         now: 42,
       });
       console.log(JSON.stringify({ legacyRow, wrote, fresh: db.getQueueRow("fresh") }));`,
    ],
    { env, cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  const result = JSON.parse(read.split("\n").at(-1)!) as {
    legacyRow: { promptedConsumedGeneration: number | null; promptedDecision: unknown };
    wrote: boolean;
    fresh: { promptedDecision: { outcome: string; generation: number } | null };
  };
  // The ALTER lands on a table that already exists, so an upgraded row must open rather
  // than failing every queue write - and it reads as "consumed, reason unknown", which is
  // the truthful answer for a row written before anyone recorded one.
  assert.equal(result.legacyRow.promptedDecision, null);
  assert.equal(result.legacyRow.promptedConsumedGeneration, 4, "a legacy row is not fresh work");
  assert.equal(result.wrote, true);
  assert.equal(result.fresh.promptedDecision?.outcome, "verification_failed");
  assert.equal(result.fresh.promptedDecision?.generation, 1);
  rmSync(legacy, { recursive: true, force: true });
});
