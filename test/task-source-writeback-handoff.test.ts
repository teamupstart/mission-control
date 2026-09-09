import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_SOURCE_KINDS,
  TASK_SOURCE_KIND_INFO,
  TaskSourceInstanceSchema,
  TaskSourceWritebackSchema,
  WRITEBACK_ACTIONS,
  WRITEBACK_SIGNALS,
} from "../src/shared/task-source.ts";
import type {
  TaskSourceWritebackStatus,
  WritebackContext,
  WritebackNotice,
  WritebackResult,
} from "../src/shared/task-source.ts";

// The CROSS-PHASE CONTRACT, pinned so the two phases that build on this one cannot be
// broken silently. Phase 1 of the write-back plan owns and freezes everything asserted
// here; Phase 2 (Jira's verbs) and Phase 3 (the operator surface) may only read it.
//
// The point of a test rather than a paragraph is that the failure modes are all quiet.
// A renamed signal orphans undelivered ledger rows written under the old spelling - the
// worker stops recognising them and a comment silently never appears. A reordered or
// dropped `state` leaves rows nobody queries. A changed unique key turns "a re-observed
// pull request costs nothing" into a comment per poller tick. A helper renamed out from
// under Phase 3 is a compile error at best and a panel reading nothing at worst. None of
// those announce themselves, and all of them are one careless edit away.
//
// What this file deliberately does NOT assert: Jira's `canAnnotate` / `canResolve`, which
// are false here and which Phase 2 flips to true in the same commit that implements the
// verbs. Pinning them would make this file fail on Phase 2's merge for no reason - the
// same trap the phased plan forbids Phase 3 from walking into. The pairing between a flag
// and its slot, which stays true either way, is pinned in `task-source-contract.test.ts`.

const home = mkdtempSync(join(tmpdir(), "mission-writeback-handoff-"));
process.env.HARNESS_HOME = join(home, "state");

const db = await import("../src/server/db.ts");
const registry = await import("../src/server/task-sources/index.ts");
const writeback = await import("../src/server/task-sources/writeback.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// ---- the persisted vocabularies ----
//
// APPEND-ONLY, in the same way `TASK_SOURCE_KINDS` is: these strings are written into
// `task_source_writeback` rows and are half of the key a delivery is de-duplicated on.

test("the write-back signals are exactly the two Phase 1 froze, in order", () => {
  assert.deepEqual([...WRITEBACK_SIGNALS], ["pr-opened", "task-completed"]);
});

test("the write-back actions are exactly the two Phase 1 froze, in order", () => {
  assert.deepEqual([...WRITEBACK_ACTIONS], ["annotate", "resolve"]);
});

// Five, and each is a different thing a caller must do next - not degrees of failure. A
// sixth is an append; a rename or a removal strands rows nobody queries.
test("the ledger states are exactly the five Phase 1 froze, in order", () => {
  assert.deepEqual(
    [...db.WRITEBACK_STATES],
    ["pending", "delivered", "failed", "unknown", "cancelled"],
  );
});

// ---- the ledger's shape ----

test("the ledger carries exactly the columns Phase 1 froze", () => {
  const columns = (
    db.openDb().prepare(`PRAGMA table_info(task_source_writeback)`).all() as unknown as Array<{
      name: string;
      notnull: number;
    }>
  ).map((c) => c.name);
  assert.deepEqual(columns.sort(), [
    "action",
    "attempts",
    "created_at",
    "dedupe_key",
    "external_id",
    "id",
    "last_detail",
    "last_error",
    "next_at",
    "payload",
    "signal",
    "source_id",
    "state",
    "task_id",
    "updated_at",
  ]);
});

// The identity guarantee. Both key columns of the pair that could have been nullable are
// NOT NULL, because SQLite treats NULLs as DISTINCT inside a unique index - a nullable half
// would make the ON CONFLICT never fire and the same comment be enqueued twice.
test("the ledger's key columns are NOT NULL, which the ON CONFLICT depends on", () => {
  const rows = db.openDb().prepare(`PRAGMA table_info(task_source_writeback)`).all() as unknown as
    Array<{ name: string; notnull: number }>;
  const notNull = new Map(rows.map((r) => [r.name, r.notnull === 1]));
  for (const column of ["source_id", "external_id", "signal", "action", "dedupe_key", "payload"]) {
    assert.equal(notNull.get(column), true, `${column} must be NOT NULL`);
  }
  // Provenance, never joined on, and deliberately nullable: a row outlives its task.
  assert.equal(notNull.get("task_id"), false, "task_id must stay nullable - a row outlives its task");
});

test("the identity index is unique and over exactly the five key columns, in order", () => {
  const d = db.openDb();
  const indexes = d.prepare(`PRAGMA index_list(task_source_writeback)`).all() as unknown as Array<{
    name: string;
    unique: number;
  }>;
  const identity = indexes.find((i) => i.name === "idx_writeback_identity");
  assert.ok(identity, "the identity index is gone - every re-observation would duplicate");
  assert.equal(identity.unique, 1, "the identity index is no longer UNIQUE");

  const columns = (
    d.prepare(`PRAGMA index_info(idx_writeback_identity)`).all() as unknown as Array<{
      name: string;
    }>
  ).map((c) => c.name);
  assert.deepEqual(columns, ["source_id", "external_id", "signal", "action", "dedupe_key"]);

  assert.ok(
    indexes.some((i) => i.name === "idx_writeback_due"),
    "the due index is gone - every tick would scan the whole ledger",
  );
});

// ---- what `dedupe_key` holds, per signal ----
//
// Named in the handoff because Phase 2's Jira verbs and Phase 3's retry control both reason
// about what one delivery IS. The completion instant is the load-bearing half: keyed on the
// task id alone, a reopened-then-genuinely-recompleted task collides with its own first
// cycle and is dropped in silence by ON CONFLICT DO NOTHING.

const notice = (over: Partial<WritebackNotice> = {}): WritebackNotice => ({
  signal: "task-completed",
  action: "annotate",
  externalId: "acme/demo#7",
  externalUrl: null,
  taskTitle: "T",
  prUrl: "https://github.com/acme/demo/pull/9",
  repoRoot: "/repo",
  outcome: null,
  observedAt: 1,
  ...over,
});

test("a pr-opened delivery is keyed on the pull request url", () => {
  assert.equal(
    writeback.dedupeKeyFor(notice({ signal: "pr-opened" }), { id: "t1", completedAt: 5 }),
    "https://github.com/acme/demo/pull/9",
  );
});

test("a task-completed delivery is keyed on the task id AND the instant it completed", () => {
  assert.equal(writeback.dedupeKeyFor(notice(), { id: "t1", completedAt: 5 }), "t1:5");
  assert.notEqual(
    writeback.dedupeKeyFor(notice(), { id: "t1", completedAt: 5 }),
    writeback.dedupeKeyFor(notice(), { id: "t1", completedAt: 9 }),
    "two completion cycles of one task collapsed into one delivery",
  );
});

// ---- the notice's own fields ----
//
// A SNAPSHOT the ledger stores as JSON and a later process reads back, so removing a field
// silently empties it for every row already on disk.

test("the notice carries exactly the fields Phase 1 froze", () => {
  assert.deepEqual(Object.keys(notice()).sort(), [
    "action",
    "externalId",
    "externalUrl",
    "observedAt",
    "outcome",
    "prUrl",
    "repoRoot",
    "signal",
    "taskTitle",
  ]);
});

// ---- per-source consent ----

test("the consent schema is three switches, and every one defaults off", () => {
  const parsed = TaskSourceWritebackSchema.parse({});
  assert.deepEqual(parsed, { onPrOpened: false, onCompleted: false, resolve: false });
  assert.deepEqual(Object.keys(parsed).sort(), ["onCompleted", "onPrOpened", "resolve"]);
});

// A blob written by a build that predates this gains the three `false`s on read. That is
// what makes the feature invisible to every existing installation, and it is a Zod default
// over `app_config` rather than a migration - so a stored source with no `writeback` key at
// all must still parse.
test("a stored source written before this feature reads back with consent withheld", () => {
  const parsed = TaskSourceInstanceSchema.parse({
    id: "s1",
    kind: "github-issues",
    repoRoot: "/repo",
  });
  assert.deepEqual(parsed.writeback, {
    onPrOpened: false,
    onCompleted: false,
    resolve: false,
  });
});

// ---- the only way to reach an implementation ----
//
// Named in the handoff as the four accessors, so no call site outside the registry tests
// `inst.kind` - which is how a third kind ends up capable everywhere except the one branch
// somebody forgot.

test("the four registry accessors Phase 2 and Phase 3 reach through are exported", () => {
  for (const name of ["canAnnotateTo", "canResolveTo", "annotateWith", "resolveWith"] as const) {
    assert.equal(typeof registry[name], "function", `${name} is no longer exported`);
  }
});

// Every kind declares both capabilities, whatever their current value. A `Record<TaskSourceKind,
// …>` is what stops a new kind arriving silently unable to write back and the UI finding out
// by calling.
test("every kind declares both write-back capabilities", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    const info = TASK_SOURCE_KIND_INFO[kind];
    assert.equal(typeof info.canAnnotate, "boolean", `${kind} does not declare canAnnotate`);
    assert.equal(typeof info.canResolve, "boolean", `${kind} does not declare canResolve`);
  }
});

// ---- the ledger helpers Phase 3 puts its view and its two routes on top of ----
//
// Landed in Phase 1 deliberately: `src/server/db.ts` has exactly one owner in this feature,
// and all three are plain SQL over a table this phase owns. Phase 3 must not reach into it.

test("the three queue helpers Phase 3 consumes are exported with their agreed shapes", () => {
  assert.equal(typeof db.countWritebacks, "function");
  assert.equal(typeof db.retryWritebacks, "function");
  assert.equal(typeof db.discardWritebacks, "function");

  // The status shape the panel renders from, for a source that owes nothing.
  const empty: TaskSourceWritebackStatus = db.countWritebacks("nobody");
  assert.deepEqual(empty, {
    sourceId: "nobody",
    pending: 0,
    failed: 0,
    unknown: 0,
    delivered: 0,
    lastError: null,
    lastDeliveredAt: null,
  });

  // Both take the source id, and retry takes the second, explicit flag that separates a
  // safe retry from an operator asserting they have looked upstream.
  assert.equal(db.retryWritebacks("nobody", false), 0);
  assert.equal(db.retryWritebacks("nobody", true), 0);
  assert.equal(db.discardWritebacks("nobody"), 0);
});

// ---- the two seams the daemon wires ----

test("the registry announces linked pull requests, and the task manager takes an enqueuer", () => {
  const reg = new Registry();
  assert.equal(typeof reg.onTaskPrLinked, "function", "onTaskPrLinked is no longer on the Registry");
  // Returns an unsubscribe, like every sibling signal.
  assert.equal(typeof reg.onTaskPrLinked(() => {}), "function");

  const tasks = new TaskManager(reg);
  assert.equal(
    typeof tasks.registerWritebackEnqueuer,
    "function",
    "the TaskManager seam is gone - completions would reach no ledger",
  );
});

// ---- the verb signatures Phase 2 implements against ----
//
// Compile-time more than run-time: this is the shape `jira.ts` will be written to, and a
// silent change to it is a Phase 2 that does not build.
test("a kind's write-back verbs take a config, a notice and a context", async () => {
  const seen: Array<[WritebackNotice, WritebackContext]> = [];
  const impl = async (
    _config: unknown,
    n: WritebackNotice,
    ctx: WritebackContext,
  ): Promise<WritebackResult> => {
    seen.push([n, ctx]);
    return { error: null, outcomeUnknown: false, detail: "did it" };
  };
  const ctx: WritebackContext = {
    sourceId: "s1",
    repoRoot: "/repo",
    signal: new AbortController().signal,
  };
  const result = await impl({}, notice(), ctx);
  assert.deepEqual(result, { error: null, outcomeUnknown: false, detail: "did it" });
  assert.equal(seen.length, 1);
  // The context a write-back is lent is the sweep's, which is what keeps the two from
  // drifting - see `WritebackContext`.
  assert.deepEqual(Object.keys(seen[0]![1]).sort(), ["repoRoot", "signal", "sourceId"]);
});
