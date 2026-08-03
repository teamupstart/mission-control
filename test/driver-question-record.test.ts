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
  return buildApp(
    registry,
    reviews,
    {} as unknown as TaskManager,
    {} as unknown as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
  );
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

test("answering a driver form leaves the conversation a record of it", async () => {
  const { app, id } = seed(FORM);
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
  const { app, id } = seed(FORM);
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
});

test("answering a permission prompt records nothing at all", async () => {
  // An auto-mode session answers dozens of these an hour, and none of them chose between
  // anything - the next turn states the outcome. Recording them would bury the log.
  const { app, id } = seed(PERMISSION);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/select-option`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "Yes" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(loadHumanResolvedReviews(id), []);
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

test("a refused answer records nothing, because nothing was answered", async () => {
  const { app, id } = seed(FORM);
  const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/submit-options`, {
    method: "POST",
    headers: HEADERS,
    // Half a form. `driverFormAnswer` refuses it, so the agent never heard anything - and a
    // record here would be the log asserting a decision that was never delivered.
    body: JSON.stringify({ answers: [{ question: "Which linter?", labels: ["biome"] }] }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(loadHumanResolvedReviews(id), []);
});
