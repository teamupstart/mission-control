import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: a decision the operator made, missing from the log they made it in.
//
// A session dispatched to a TERMINAL has Claude's `AskUserQuestion` taken away and asks
// through `request_input` instead, which is a review - a durable row the conversation
// replays as a gold "you answered" card. A session on the SDK runtime keeps the built-in
// deliberately, and answering one used to resolve the blocked callback and nothing else.
// No row, and no cover from the transcript either: the answer reaches the JSONL as a user
// turn that is purely a `tool_result`, which every harness parser drops as machine noise.
// So the same question, asked by the same agent about the same work, was a permanent record
// on one runtime and a silence on the other.
//
// These assert the record now written, in the shape the conversation already reads: enough
// to redraw the form (every option, not just the chosen one), attributed to whoever
// actually answered, and left off entirely for the asks that are not questions.

const home = mkdtempSync(join(tmpdir(), "mission-driver-question-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;

const { answeredQuestion } = await import("../src/server/sdk/answered-question.ts");
const { driverDialog } = await import("../src/server/sdk/dialog.ts");
const { dialogMarker } = await import("../src/server/foreman/pending.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { loadHumanResolvedReviews, openDb } = await import("../src/server/db.ts");
const { isHumanResolvedReview } = await import("../src/shared/review-item.ts");

type Registry_ = InstanceType<typeof Registry>;
type PaneDialog = import("../src/shared/types.ts").PaneDialog;
type SessionRequest = import("../src/server/harness/types.ts").SessionRequest;
type SessionRequestAnswer = import("../src/server/harness/types.ts").SessionRequestAnswer;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const FORM: SessionRequest = {
  id: "req-form",
  kind: "question",
  prompt: "Claude has some questions.",
  options: [],
  questions: [
    {
      question: "Which linter?",
      options: [
        { number: 1, label: "biome", detail: "lint + format in one binary" },
        { number: 2, label: "eslint" },
      ],
    },
    {
      question: "Which checks?",
      multiSelect: true,
      options: [
        { number: 1, label: "types" },
        { number: 2, label: "tests" },
      ],
    },
  ],
};

/** A single ask, as `projectRequest` builds one: the prompt IS the question. */
const SINGLE: SessionRequest = {
  id: "req-one",
  kind: "question",
  prompt: "Which linter?",
  options: [
    { number: 1, label: "biome" },
    { number: 2, label: "eslint" },
  ],
  questions: [
    {
      question: "Which linter?",
      options: [
        { number: 1, label: "biome" },
        { number: 2, label: "eslint" },
      ],
    },
  ],
};

/**
 * The same ask with no `questions` at all - the shape a request built from `options` alone
 * takes. Kept because the projection has to read the rows from wherever they are: a driver
 * that offers a question without breaking it into `questions` must still be recordable.
 */
const SINGLE_BARE: SessionRequest = {
  id: "req-bare",
  kind: "question",
  prompt: "Which linter?",
  options: [
    { number: 1, label: "biome" },
    { number: 2, label: "eslint" },
  ],
};

const PERMISSION: SessionRequest = {
  id: "req-perm",
  kind: "permission",
  prompt: "Claude wants to run `rm -rf build`",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
};

// ---- the projection, on its own ----------------------------------------------------

/**
 * The dialog a driver request is published as - through production's own projection.
 *
 * `driverDialog` and not a hand-rolled literal, because what this asserts is a round trip:
 * the request is projected into a dialog for the card, the card's answer is verified against
 * that same dialog, and the record is built from it. A fixture written by hand here could
 * drift from what the registry actually publishes and this would keep passing.
 */
function dialogFor(request: SessionRequest): PaneDialog {
  return driverDialog(request);
}

const formAnswer: SessionRequestAnswer = {
  kind: "form",
  answers: [
    { question: "Which linter?", labels: ["eslint"] },
    { question: "Which checks?", labels: ["types", "tests"] },
  ],
};

test("a submitted form projects into the questions AND what was passed over", () => {
  const record = answeredQuestion(dialogFor(FORM), formAnswer);
  assert.ok(record);
  // Every option, not just the chosen one. The card's whole reason for drawing the form
  // rather than the response string is that a reader wants to know what the choice WAS.
  assert.deepEqual(
    record.decisions.map((d) => [d.question, d.options.map((o) => o.label)]),
    [
      ["Which linter?", ["biome", "eslint"]],
      ["Which checks?", ["types", "tests"]],
    ],
  );
  assert.equal(record.decisions[0]!.multiSelect, undefined, "a single-select stays radios");
  assert.equal(record.decisions[1]!.multiSelect, true, "a multi-select stays checkboxes");
  assert.equal(record.decisions[0]!.options[0]!.detail, "lint + format in one binary");
  assert.deepEqual(record.selections, [
    { decisionId: "q1", selected: ["q1o2"], other: null },
    { decisionId: "q2", selected: ["q2o1", "q2o2"], other: null },
  ]);
  assert.equal(record.title, "Claude has some questions.");
  assert.match(record.response, /^Answered:/, "not 'Plan decisions submitted' - no plan exists");
  assert.match(record.response, /→ types, tests/);
});

test("selections name options by id, so a relabelled question still replays", () => {
  // Ids are positional and minted here; the wire matches by label because that is what was
  // clicked. Whichever the agent rewrites later, the stored row still says which row it was.
  const record = answeredQuestion(dialogFor(FORM), formAnswer);
  const ids = record!.decisions.flatMap((d) => d.options.map((o) => o.id));
  assert.deepEqual(ids, ["q1o1", "q1o2", "q2o1", "q2o2"]);
  assert.equal(new Set(ids).size, ids.length, "unique within the row");
});

test("free text is kept as the answer, not dropped as 'nothing chosen'", () => {
  const record = answeredQuestion(dialogFor(FORM), {
    kind: "form",
    answers: [
      { question: "Which linter?", labels: [], text: "  oxlint, actually  " },
      { question: "Which checks?", labels: ["types"] },
    ],
  });
  assert.ok(record);
  assert.deepEqual(record.selections[0], { decisionId: "q1", selected: [], other: "oxlint, actually" });
  // `allowOther` is what lets the formatter print it at all - the driver form offers a text
  // box under every question, so every decision has to admit one.
  assert.equal(record.decisions[0]!.allowOther, true);
  assert.match(record.response, /Other: oxlint, actually/);
});

test("a single-ask question records the one row it offered", () => {
  const record = answeredQuestion(dialogFor(SINGLE), {
    kind: "option",
    number: 2,
    label: "eslint",
  });
  assert.ok(record);
  assert.deepEqual(record.decisions.map((d) => d.question), ["Which linter?"]);
  assert.deepEqual(record.selections, [{ decisionId: "q1", selected: ["q1o2"], other: null }]);
  assert.equal(record.title, "Which linter?");
  assert.equal(record.body, "Which linter?", "title and body agree, so the card says it once");

  // And the same ask with its rows only on `options` records identically.
  const bare = answeredQuestion(dialogFor(SINGLE_BARE), {
    kind: "option",
    number: 2,
    label: "eslint",
  });
  assert.deepEqual(bare?.selections, record.selections);
  assert.deepEqual(bare?.decisions, record.decisions);
});

test("everything that is not a driver question records nothing", () => {
  const option: SessionRequestAnswer = { kind: "option", number: 1, label: "Yes" };
  assert.equal(answeredQuestion(dialogFor(PERMISSION), option), null, "a permission prompt");
  assert.equal(answeredQuestion(null, option), null, "no dialog at all");
  assert.equal(
    // A pane cannot classify itself, so a screen never claims to be a question.
    answeredQuestion({ options: [{ number: 1, label: "Yes" }], highlighted: 0 }, option),
    null,
    "a dialog read off a pane",
  );
  assert.equal(
    answeredQuestion(dialogFor(SINGLE), { kind: "text", text: "whatever you think" }),
    null,
    "prose, which names no question it answers",
  );
});

test("an answer that chose nothing is not written down as a decision", () => {
  // Refused upstream by `driverFormAnswer`, so this is the belt to that brace: an empty
  // record would draw a gold card with every row unmarked, which reads as a dismissal.
  assert.equal(
    answeredQuestion(dialogFor(SINGLE), { kind: "option", number: 1, label: "gone" }),
    null,
    "a label the request no longer offers",
  );
  assert.equal(
    answeredQuestion(dialogFor(FORM), {
      kind: "form",
      answers: [{ question: "Which linter?", labels: [] }],
    }),
    null,
    "a form submission with nothing in it",
  );
});

// ---- through the route, which is where the record is actually written ----------------

function mkApp(registry: Registry_, reviews: InstanceType<typeof ReviewManager>, supervisor: SdkSupervisor) {
  return buildApp({
    registry,
    reviews,
    tasks: {} as unknown as TaskManager,
    queues: {} as unknown as QueueManager,
    sdkSessions: supervisor,
  });
}

/** A supervisor that accepts every answer, so the route reaches its record step. */
function fakeSupervisor(): SdkSupervisor {
  return {
    handleFor: () => ({}),
    async answer() {},
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
}

let seq = 0;
function seed(request: SessionRequest): {
  registry: Registry_;
  reviews: InstanceType<typeof ReviewManager>;
  app: ReturnType<typeof buildApp>;
  id: string;
} {
  const id = `sdk:q${++seq}`;
  const registry = new Registry();
  registry.registerSdkSession({ id, agent: "claude", name: "Add a toggle", cwd: `/wt/${id}` });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: `agent-${seq}`,
    transcriptPath: null,
    modelId: null,
    pid: null,
  });
  registry.applyDriverEvent(id, { kind: "request", request });
  const reviews = new ReviewManager(registry);
  return { registry, reviews, app: mkApp(registry, reviews, fakeSupervisor()), id };
}

/**
 * The retro reasons the card is currently carrying for this session.
 *
 * Read off the session PROJECTION rather than off any internal flag, because that is the
 * only thing the dashboard ever sees: `retroOffer` consumes `Session.retro` and nothing
 * else. An answered driver question has to reach it, since the answer exists nowhere a
 * transcript scan can find it - the JSONL records it as a pure `tool_result`, which every
 * harness parser drops.
 */
function retroReasons(registry: Registry_, id: string): string[] {
  return registry.getSession(id)?.retro?.reasons ?? [];
}

test("answering a driver form leaves the conversation a record of it", async () => {
  const { app, registry, id } = seed(FORM);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: ["eslint"] },
        { question: "Which checks?", labels: ["types"] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  // Read back through the SAME query the conversation's durable half uses, so this proves
  // the row survives a restart rather than only that something was inserted.
  const stored = loadHumanResolvedReviews(id);
  assert.equal(stored.length, 1, "one answer, in this session's conversation");
  const answer = stored[0]!;
  assert.equal(answer.kind, "input");
  assert.equal(answer.status, "answered");
  assert.equal(answer.resolvedBy, "human");
  assert.ok(isHumanResolvedReview(answer), "and the live half agrees with the stored one");
  assert.ok(answer.resolvedAt, "stamped, so the merge can place it where you answered");
  assert.ok(
    answer.resolvedAt <= Date.now(),
    "with the reading taken when you spoke, not after the agent was let go",
  );
  assert.deepEqual(
    answer.decisions?.map((d) => d.question),
    ["Which linter?", "Which checks?"],
  );
  assert.deepEqual(answer.selections, [
    { decisionId: "q1", selected: ["q1o2"], other: null },
    { decisionId: "q2", selected: ["q2o1"], other: null },
  ]);

  // And the same record makes the session worth retrospecting. Steering the work is steering
  // it whichever channel carried the words, and this is the channel a transcript cannot see -
  // the session this shipped for answered two dashboard questions, was reviewed clean, and
  // was offered no retro at all.
  assert.deepEqual(retroReasons(registry, id), ["corrections"]);
});

test("the record is born settled - it never flashes up as a form to answer", async () => {
  // Routing this through create-then-resolve would publish a PENDING review for an instant:
  // long enough to bump the badge and pop the modal over whatever the operator was reading,
  // offering them a question that is already answered and already gone.
  const { app, registry, id } = seed(FORM);
  const pending: string[] = [];
  registry.subscribe((e) => {
    if (e.type === "review_upsert") pending.push(e.review.status);
  });
  await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ answers: [
      { question: "Which linter?", labels: ["biome"] },
      { question: "Which checks?", labels: ["tests"] },
    ] }),
  });
  assert.deepEqual(pending, ["answered"], "one event, already terminal");
  assert.deepEqual(registry.pendingReviews(id), [], "and nothing is waiting on the operator");
});

test("Foreman's answer is recorded as Foreman's, and stays out of your conversation", async () => {
  // It is already in the log as its own episode card. Crediting it here too would show the
  // same moment twice, the second time as though you had chosen it yourself.
  const { app, registry, id } = seed(FORM);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      by: "foreman",
      answers: [
        { question: "Which linter?", labels: ["biome"] },
        { question: "Which checks?", labels: ["tests"] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(loadHumanResolvedReviews(id), [], "not in the human's conversation");
  assert.deepEqual(
    retroReasons(registry, id),
    [],
    "and not human steering either - an automated decision teaches the repository nothing",
  );
});

test("answering a permission prompt records nothing at all", async () => {
  // An auto-mode session answers dozens of these an hour, and none of them chose between
  // anything - the next turn states the outcome. Recording them would bury the log.
  const { app, registry, id } = seed(PERMISSION);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/select-option`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "Yes" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(loadHumanResolvedReviews(id), []);
  assert.deepEqual(retroReasons(registry, id), [], "clicking Yes on a prompt is not steering");
});

test("a question re-presented after a first answer records BOTH rounds", async () => {
  // The shape a real session took: the operator answered entirely in free text ("I can't see
  // the mockups, open them for me and re-prompt"), the agent did that and asked the SAME
  // questions again, and they picked. Two decisions, minutes apart, and the log owes the
  // reader both - the first is the one that explains why the second exists.
  //
  // Worth its own test because the plausible ways to get this wrong all look reasonable:
  // keying the record on the request id, the note key, or the question text would have made
  // round two overwrite round one and left the conversation claiming the operator answered
  // once.
  const { app, registry, id } = seed(FORM);
  const path = `/api/sessions/${encodeURIComponent(id)}/submit-options`;

  const first = await app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: [], text: "I can't see the options - show me first" },
        { question: "Which checks?", labels: [], text: "I can't see the options - show me first" },
      ],
    }),
  });
  assert.equal(first.status, 200, await first.clone().text());

  // The agent takes the answer, does the work, and asks again. A new request id, the same
  // questions - which is exactly what makes the two rows hard to tell apart if anything but
  // the row's own identity is doing the distinguishing.
  registry.applyDriverEvent(id, { kind: "request_resolved", requestId: FORM.id });
  registry.applyDriverEvent(id, { kind: "request", request: { ...FORM, id: "req-form-again" } });

  const second = await app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: ["eslint"] },
        { question: "Which checks?", labels: ["types", "tests"] },
      ],
    }),
  });
  assert.equal(second.status, 200, await second.clone().text());

  const stored = loadHumanResolvedReviews(id);
  assert.equal(stored.length, 2, "both rounds are in the conversation");
  assert.notEqual(stored[0]!.id, stored[1]!.id, "two records, not one overwritten twice");
  assert.ok(
    stored[0]!.resolvedAt! <= stored[1]!.resolvedAt!,
    "oldest first, the order they were read in",
  );
  // What each round actually said, so a swap or a duplicate cannot pass.
  assert.deepEqual(stored[0]!.selections, [
    { decisionId: "q1", selected: [], other: "I can't see the options - show me first" },
    { decisionId: "q2", selected: [], other: "I can't see the options - show me first" },
  ]);
  assert.deepEqual(stored[1]!.selections, [
    { decisionId: "q1", selected: ["q1o2"], other: null },
    { decisionId: "q2", selected: ["q2o1", "q2o2"], other: null },
  ]);
});

test("a half-written record leaves no row at all, not one that half exists", async () => {
  // Two writers land this row - `insertReview` for the columns it shares with a `create`,
  // `updateReviewStatus` for the settle columns - and a failure between them used to commit
  // the first without the second.
  //
  // What that left is worth stating exactly, because it is NOT a pending review:
  // `insertReview` writes the status off the item and the item is already `answered`, so the
  // orphan reads `answered` with a null `resolved_by` and null `selections`. Neither reader
  // surfaces it - `loadPendingReviews` filters on `pending`, `loadHumanResolvedReviews`
  // requires `resolved_by = 'human'` - so it is inert today, which is exactly why the
  // assertion below is on the TABLE rather than on either of them. Its harmlessness is a
  // property of two queries in another module, not of this write, and the first reader that
  // asks for `status = 'answered'` without asking who answered inherits it.
  //
  // The second write is failed for real rather than mocked: `updateReviewStatus` serializes
  // `selections`, and a BigInt is a value `JSON.stringify` refuses. That throws from exactly
  // where a disk error would, and `decisions` still serializes, so the INSERT lands first -
  // which is the ordering the hazard needs.
  const { registry, reviews, id } = seed(FORM);
  assert.throws(() =>
    reviews.record({
      sessionId: id,
      kind: "input",
      title: "t",
      body: "b",
      decisions: [{ id: "q1", question: "Which linter?", options: [{ id: "q1o1", label: "biome" }] }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selections: [{ decisionId: "q1", selected: [], other: 1n as any }],
      response: "r",
      resolvedBy: "human",
      at: 1_700_000_000_000,
    }),
  );

  const rows = openDb()
    .prepare(`SELECT status, resolved_by FROM reviews WHERE session_id = ?`)
    .all(id) as unknown as Array<{ status: string; resolved_by: string | null }>;
  assert.deepEqual(rows, [], "the insert was rolled back with the update that failed");
  assert.deepEqual(loadHumanResolvedReviews(id), [], "and no answer reached the conversation");
  assert.deepEqual(
    retroReasons(registry, id),
    [],
    "nor the retro offer: the signal is raised after the commit, never before it",
  );
});

test("a refused answer records nothing, because nothing was answered", async () => {
  const { app, registry, id } = seed(FORM);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    // Half a form. `driverFormAnswer` refuses it, so the agent never heard anything - and a
    // record here would be the log asserting a decision that was never delivered.
    body: JSON.stringify({ answers: [{ question: "Which linter?", labels: ["biome"] }] }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(loadHumanResolvedReviews(id), []);
  assert.deepEqual(
    retroReasons(registry, id),
    [],
    "an undelivered answer must not light the offer either",
  );
});

// ---- and the Foreman note the answer makes spent -------------------------------------
//
// The same route, asked a second question: what happens to the "needs your decision" banner
// Foreman pinned on the ask you just answered? It used to stay, with a live Approve on it,
// until someone clicked Dismiss - and on this surface the marker is a `dialog:` digest rather
// than a `review:` id, so the dashboard could not even tell the note had gone stale. It drew
// a working Approve & send whose click would have injected Foreman's prose into a session
// that already had its answer.

/** Pin an escalated Foreman note on the ask this session is showing, the way the worker does. */
function escalate(registry: Registry_, id: string): string {
  const marker = dialogMarker(dialogFor(FORM));
  registry.recordEpisode(
    id,
    {
      marker,
      situation: "structured-request",
      surface: "terminal",
      question: "running AskUserQuestion",
      recommendation: "Choose biome - it is already in the toolchain.",
      disposition: "escalated",
    },
    1000,
  );
  registry.upsertNote(
    id,
    {
      purpose: "Which linter this repo should adopt.",
      recommendation: "Choose biome - it is already in the toolchain.",
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: marker,
    },
    1000,
  );
  return marker;
}

test("submitting the form retires the Foreman note pinned on that ask", async () => {
  const { app, registry, id } = seed(FORM);
  escalate(registry, id);

  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      // Deliberately not what Foreman recommended: the note is retired because the question
      // is closed, not because the human happened to agree with it.
      answers: [
        { question: "Which linter?", labels: ["eslint"] },
        { question: "Which checks?", labels: ["types"] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const note = registry.getNote(id)!;
  assert.equal(note.disposition, "skipped", "so the strip unmounts on `noteAwaitsYou`");
  assert.equal(note.lastAction, "you answered this yourself");
  assert.equal(note.recommendation, null, "there is nothing left for Approve to send");
});

test("a refused answer leaves the note alone - the question is still open", async () => {
  // The mirror of the case above it. Nothing was delivered and the agent is still blocked, so
  // the decision Foreman escalated is still owed. Retiring on the attempt rather than on the
  // outcome would clear the banner for a question that is still on the card.
  const { app, registry, id } = seed(FORM);
  escalate(registry, id);

  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ answers: [{ question: "Which linter?", labels: ["biome"] }] }),
  });
  assert.equal(res.status, 409);

  assert.equal(registry.getNote(id)!.disposition, "escalated");
});

test("Foreman answering the form itself is not recorded as your decision", async () => {
  // Foreman's own send. `applyVerdict` writes the note after this returns, so retiring it
  // here would race that write and file a delivered answer as one the human threw away.
  const { app, registry, id } = seed(FORM);
  escalate(registry, id);

  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      by: "foreman",
      answers: [
        { question: "Which linter?", labels: ["eslint"] },
        { question: "Which checks?", labels: ["types"] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const note = registry.getNote(id)!;
  assert.equal(note.disposition, "escalated", "left for Foreman's own write to settle");
  assert.equal(note.lastAction, "escalated for your decision");
});

test("selecting a row retires it too, not only submitting a form", async () => {
  // The other answer route. Both are ways of closing the ask on screen, and a fix that only
  // covered the multi-question form would leave every single-question ask stranded.
  const { app, registry, id } = seed(SINGLE);
  const marker = dialogMarker(dialogFor(SINGLE));
  registry.upsertNote(
    id,
    {
      recommendation: "Postgres - the fixtures already assume it.",
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: marker,
    },
    1000,
  );

  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/select-option`, {
    method: "POST",
    headers: HEADERS,
    // Row 2 - the projection verifies the label against the number, so they have to agree.
    body: JSON.stringify({ number: 2, label: "eslint" }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  assert.equal(registry.getNote(id)!.disposition, "skipped");
});

test("a note about a different ask survives answering this one", async () => {
  // The safety half, at the route. This escalation is about something other than the question
  // on screen - Foreman raised it with no reply channel - and it is a decision the human still
  // owes. Answering the form must not silently throw it away.
  const { app, registry, id } = seed(FORM);
  registry.upsertNote(
    id,
    {
      recommendation: "Stop this session - it has been retrying for an hour.",
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: "state:awaiting_input:41",
    },
    1000,
  );

  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: ["eslint"] },
        { question: "Which checks?", labels: ["types"] },
      ],
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const note = registry.getNote(id)!;
  assert.equal(note.disposition, "escalated", "still yours to decide");
  assert.equal(note.recommendation, "Stop this session - it has been retrying for an hour.");
});
