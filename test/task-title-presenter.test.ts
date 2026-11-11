import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { ReviewItem, ServerEvent, SessionBlocker, TranscriptMessage } from "../src/shared/types.ts";

// Throwaway state dir, set before anything opens the DB - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-task-title-presenter-"));
process.env.HARNESS_HOME = home;
const { upsertTask } = await import("../src/server/db.ts");
const { TaskTitlePresenter, distinctLabels } = await import("../src/server/task-titles.ts");
const { streamRegistryEvents } = await import("../src/server/sse.ts");
type Registry = import("../src/server/registry.ts").Registry;
after(() => rmSync(home, { recursive: true, force: true }));

// What an agent writes reaches the browser with every task id shown as the task's title -
// one the registry holds live, and one finished long enough ago to live only in the durable
// table. What is stored, and what agents and Foreman read, keeps the agent's own words.

const LIVE = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const TWIN = "44444444-4444-4444-8444-444444444444";
upsertTask(mkTask({ id: ARCHIVED, title: "Retire the old table", status: "done" }));
// Two live tasks that share a title, which is allowed: titles are not unique.
const live = { getTask: (id: string) => (id === LIVE || id === TWIN ? { title: "Add the schema" } : undefined) };
const presenter = () => new TaskTitlePresenter(live);

const blocker = (over: Partial<SessionBlocker> = {}): SessionBlocker => ({
  id: "b1", kind: "dependency", reason: "nothing", waitingOn: "nothing", resumeWhen: "later",
  details: null, referenceUrl: null, startedAt: 1, updatedAt: 1, checkedAt: null, reply: null,
  ...over,
} as SessionBlocker);

const review = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "r1", sessionId: "s1", kind: "input", title: "Question", body: "", status: "pending",
  response: null, createdAt: 1, resolvedAt: null, ...over,
} as ReviewItem);

test("text names live and archived tasks and leaves every other id-shaped token as written", () => {
  assert.equal(
    presenter().text(`After ${LIVE} and ${ARCHIVED}, not ${STRANGER}.`),
    `After "Add the schema" and "Retire the old table", not ${STRANGER}.`,
  );
  assert.equal(presenter().text("no ids"), "no ids");
  assert.equal(
    presenter().text(`Capitalised: ${LIVE.toUpperCase()} and ${ARCHIVED.toUpperCase()}.`),
    `Capitalised: "Add the schema" and "Retire the old table".`,
    "a live and an archived task are both found by their stored lowercase id",
  );
});

test("a session's status line and blocker are titled on a copy, never on the registry's object", () => {
  const original = mkSession({
    activity: `waiting for ${LIVE}`,
    blocker: blocker({ reason: `${ARCHIVED} must land`, waitingOn: LIVE, details: `see ${ARCHIVED}` }),
  });
  const shown = presenter().session(original);
  assert.equal(shown.activity, `waiting for "Add the schema"`);
  assert.equal(shown.blocker?.reason, `"Retire the old table" must land`);
  assert.equal(shown.blocker?.waitingOn, `"Add the schema"`);
  assert.equal(shown.blocker?.details, `see "Retire the old table"`);
  assert.equal(original.activity, `waiting for ${LIVE}`, "the stored session keeps the agent's words");
  const quiet = mkSession({ activity: "Editing a file", blocker: null });
  assert.equal(presenter().session(quiet), quiet, "nothing to name, nothing copied");
});

test("a review's title, prose and choices are titled, colliding labels numbered; a diff body is not", () => {
  const shown = presenter().review(review({
    kind: "plan-decisions",
    title: `Order ${LIVE}?`,
    body: `${ARCHIVED} is done.`,
    decisions: [
      {
        id: "d1",
        question: `Which goes before ${LIVE}?`,
        options: [
          { id: "o1", label: `Start ${ARCHIVED}`, detail: `then ${LIVE}` },
          { id: "o2", label: "Neither" },
        ],
      },
      {
        id: "d2",
        question: "Pick one",
        options: [{ id: "x", label: LIVE }, { id: "y", label: `"Add the schema"` }],
      },
    ],
  }));
  assert.equal(shown.title, `Order "Add the schema"?`);
  assert.equal(shown.body, `"Retire the old table" is done.`);
  assert.equal(shown.decisions?.[0]?.question, `Which goes before "Add the schema"?`);
  assert.deepEqual(shown.decisions?.[0]?.options[0], {
    id: "o1", label: `Start "Retire the old table"`, detail: `then "Add the schema"`,
  });
  assert.deepEqual(
    shown.decisions?.[1]?.options.map((option) => option.label),
    [`"Add the schema" (2)`, `"Add the schema"`],
    "the id is titled, numbered so the two choices stay distinct, and the agent's own label is kept",
  );
  assert.deepEqual(shown.decisions?.[1]?.options.map((option) => option.id), ["x", "y"]);

  const diff = review({ kind: "diff", title: `Ship ${LIVE}`, body: `+const id = "${LIVE}";` });
  const shownDiff = presenter().review(diff);
  assert.equal(shownDiff.title, `Ship "Add the schema"`);
  assert.equal(shownDiff.body, diff.body, "an id in a patch is code under review");
});

test("distinct labels: a titled label is numbered past every label already taken, never shown as an id", () => {
  const original = [LIVE, TWIN, "Add the schema (2)", "Something else"];
  const titled = original.map((label) => presenter().text(label));
  assert.deepEqual(titled.slice(0, 2), [`"Add the schema"`, `"Add the schema"`], "two tasks, one title");
  assert.deepEqual(distinctLabels(original, titled), [
    `"Add the schema"`,
    `"Add the schema" (2)`,
    "Add the schema (2)",
    "Something else",
  ]);
  const keys = distinctLabels(original, titled).map((label) => label.trim().toLowerCase());
  assert.equal(new Set(keys).size, keys.length, "the card can tell every choice apart");
  // Case and surrounding space are how the card compares labels, so they are how this does too.
  assert.deepEqual(distinctLabels([LIVE, ` "add THE schema" `], [`"Add the schema"`, ` "add THE schema" `]), [
    `"Add the schema" (2)`,
    ` "add THE schema" `,
  ]);
});

test("Foreman's plan prose names any saved task it cites, not only the backlog it planned", () => {
  const plan = {
    entries: [
      { taskId: "a", dependsOn: [], reason: `Unblocks ${LIVE}.` },
      { taskId: "b", dependsOn: ["a"], reason: null },
    ],
    // A task the backlog never listed, cited because another task's intent mentions it.
    note: `${LIVE} goes first; it replaces ${ARCHIVED}.`,
    generatedAt: 1,
  };
  const shown = presenter().plan(plan);
  assert.equal(shown?.entries[0]?.reason, `Unblocks "Add the schema".`);
  assert.equal(shown?.entries[1], plan.entries[1]);
  assert.equal(shown?.note, `"Add the schema" goes first; it replaces "Retire the old table".`);
  assert.deepEqual(shown?.entries[1]?.dependsOn, ["a"], "the plan's ids themselves are untouched");
  assert.equal(plan.note, `${LIVE} goes first; it replaces ${ARCHIVED}.`, "the stored plan is untouched");
  assert.equal(presenter().plan(null), null);
});

test("only an agent's turns are titled; the human's are shown as typed", () => {
  const turn = (id: string, role: TranscriptMessage["role"], text: string): TranscriptMessage =>
    ({ id, role, text, tools: [], ts: 0 });
  const messages = [turn("u", "user", `What about ${LIVE}?`), turn("a", "assistant", `${LIVE} waits.`)];
  const shown = presenter().transcript(messages);
  assert.equal(shown[0], messages[0]);
  assert.equal(shown[1]?.text, `"Add the schema" waits.`);
  assert.equal(shown[1]?.id, "a");
  const quiet = [turn("b", "assistant", "Done.")];
  assert.equal(presenter().transcript(quiet), quiet);
});

test("the dashboard's event stream carries titled sessions and reviews, in its snapshot and its events", async () => {
  const session = mkSession({ id: "s1", activity: `blocked on ${ARCHIVED}` });
  const pending = review({ title: `Approve ${LIVE}?` });
  let listener: ((event: ServerEvent) => void) | null = null;
  const registry = {
    getTask: live.getTask,
    snapshot: () => ({ sessions: [session], reviews: [pending] }),
    subscribe: (fn: (event: ServerEvent) => void) => {
      listener = fn;
      return () => {};
    },
  } as unknown as Registry;
  const delivered: ServerEvent[] = [];
  let aborted = false;
  let abort: (() => void) | null = null;
  await streamRegistryEvents(registry, {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      abort = callback;
    },
    async writeSSE(message) {
      delivered.push(JSON.parse(message.data) as ServerEvent);
      if (delivered.length === 1) listener?.({ type: "session_upsert", session: { ...session, activity: `now ${LIVE}` } });
      else {
        aborted = true;
        abort?.();
      }
    },
  });
  const [snapshot, upsert] = delivered;
  assert.equal(snapshot?.type, "snapshot");
  if (snapshot?.type === "snapshot") {
    assert.equal(snapshot.sessions[0]?.activity, `blocked on "Retire the old table"`);
    assert.equal(snapshot.reviews[0]?.title, `Approve "Add the schema"?`);
  }
  assert.equal(upsert?.type === "session_upsert" ? upsert.session.activity : null, `now "Add the schema"`);
  assert.equal(session.activity, `blocked on ${ARCHIVED}`, "the registry's session is untouched");
});
