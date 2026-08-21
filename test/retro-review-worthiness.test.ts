import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision, ServerEvent, Session } from "../src/shared/types.ts";

// A human decision made through a REVIEW makes its session worth retrospecting, exactly as a
// typed correction does.
//
// The gap this closes was measured on a real finished session ("Add keybinding for To review
// button"): the operator answered two dashboard questions, the Inspector reviewed the pull
// request clean, and the card offered no retro at all. Both halves of the offer were right
// about what they could see - the transcript scanner owns typed text, and the answers were
// never text. An `AskUserQuestion` answer and an MCP `request_input` answer both land in the
// JSONL as a pure `tool_result`, which every harness parser drops as machine noise. The
// authoritative record of them is the review row, and nothing was reading it.
//
// So there is one Registry signal with two feeds, rather than a second eligibility rule:
// `retroSummary` still combines one `corrections` flag with the Inspector's findings count,
// and `retroOffer` in the browser still reads only `Session.retro`.
//
// Three properties are pinned here and are each a way this could go wrong:
//
//  - AUTHORSHIP is `isHumanResolvedReview` and nothing weaker. Foreman settles reviews
//    through the very route the dashboard does, and the daemon orphans them with no actor.
//  - ORDER is durable-write, publish, then signal. An answer that was never committed, or
//    never delivered, must not light a control that spends a session's turn.
//  - BOUNDS are per introduced session. The durable half is queried when a session enters the
//    live map and forgotten when its row leaves, never preloaded for the whole review history.

const home = mkdtempSync(join(tmpdir(), "mission-retro-review-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

type RegistryInstance = InstanceType<typeof Registry>;

const OPTIONS: PlanDecision[] = [
  {
    id: "q",
    question: "Which linter?",
    options: [
      { id: "o0", label: "biome" },
      { id: "o1", label: "eslint" },
    ],
  },
];

function mkDiscovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/${id}`,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys015",
    terminals: [],
    startedAt: 0,
  } as DiscoveredSession;
}

/** The reasons on the SESSION PROJECTION - the only retro fact that reaches a browser. */
function reasons(registry: RegistryInstance, id: string): string[] {
  return registry.getSession(id)?.retro?.reasons ?? [];
}

/** A live pane-backed session with one question open on it. */
function asking(id: string, decisions: PlanDecision[] | null = OPTIONS): {
  registry: RegistryInstance;
  reviews: InstanceType<typeof ReviewManager>;
  reviewId: string;
} {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.applyDiscovery([mkDiscovered(id)]);
  const review = reviews.create(id, "input", "Which linter?", "Which linter?", decisions);
  return { registry, reviews, reviewId: review.id };
}

/** Every `session_upsert` the registry emits while `run` executes. */
function upserts(registry: RegistryInstance, run: () => void): Session[] {
  const seen: Session[] = [];
  const off = registry.subscribe((e: ServerEvent) => {
    if (e.type === "session_upsert") seen.push(e.session);
  });
  try {
    run();
  } finally {
    off();
  }
  return seen;
}

// ---- live settlement -------------------------------------------------------------------

test("answering a review yourself makes the session worth retrospecting, and says so", () => {
  const { registry, reviews, reviewId } = asking("rv-answered");
  assert.deepEqual(reasons(registry, "rv-answered"), [], "an unanswered question is not steering");

  const seen = upserts(registry, () => {
    reviews.resolve(reviewId, "answer", "Answered:\n\n• Which linter?\n  → eslint");
  });

  assert.deepEqual(reasons(registry, "rv-answered"), ["corrections"]);
  // Pushed, not merely stored. The dashboard has no second source for this - it reads the
  // session payload and nothing else - so a flag set without an emit would only appear on
  // the next unrelated change to the card.
  assert.deepEqual(
    seen.filter((s) => s.id === "rv-answered").at(-1)?.retro?.reasons,
    ["corrections"],
  );
});

test("approving, rejecting and dismissing are decisions too", () => {
  // Each is a terminal status a PERSON can put a review into, and the conversation already
  // replays all three in their voice. A dismissal is included for the same reason it is
  // included there: closing a question without choosing is a decision the agent was told
  // about, and it is a moment worth cataloguing.
  for (const action of ["approve", "reject", "dismiss"] as const) {
    const id = `rv-${action}`;
    const { registry, reviews, reviewId } = asking(id);
    reviews.resolve(reviewId, action, action === "dismiss" ? null : "because");
    assert.deepEqual(reasons(registry, id), ["corrections"], `${action} is human steering`);
  }
});

test("Foreman's answer is not your steering", () => {
  // Foreman resolves reviews through the same route the dashboard does. Counting its
  // decisions would make an unattended session retro-worthy for deciding things itself,
  // which is precisely the non-goal the plan named.
  const { registry, reviews, reviewId } = asking("rv-foreman");
  reviews.resolve(reviewId, "answer", "biome", "foreman");
  assert.deepEqual(reasons(registry, "rv-foreman"), []);
});

test("a question still on screen is not an answer", () => {
  const { registry } = asking("rv-pending");
  assert.deepEqual(reasons(registry, "rv-pending"), []);
});

test("the daemon orphaning a question is nobody's decision", () => {
  // `orphaned` is the daemon tidying up after a session that went away, written with no
  // actor at all. `isHumanResolvedReview` refuses it, so this refuses it - live, and again
  // when a later daemon reintroduces the same session.
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.applyDiscovery([mkDiscovered("rv-orphan")]);
  reviews.create("rv-orphan", "input", "Which linter?", "Which linter?", OPTIONS);
  // The event the manager orphans on, which is how a real eviction reaches it.
  registry.emit("event", { type: "session_remove", id: "rv-orphan" });
  assert.deepEqual(reasons(registry, "rv-orphan"), [], "settled, but by nobody");

  const rebooted = new Registry();
  rebooted.applyDiscovery([mkDiscovered("rv-orphan")]);
  assert.deepEqual(
    reasons(rebooted, "rv-orphan"),
    [],
    "and the durable row does not restore it either - it names no author",
  );
});

test("an answer recorded after its session went away leaves no durable trace to restore", () => {
  // The dangling case, and the reachable shape of it: `answerDriverRequest` AWAITS the driver
  // taking the answer before recording it, so an eviction timer can fire inside that await and
  // the record would land for a session that has already left.
  //
  // "Not counting it" has to mean more than skipping the live emit. A human-resolved row is
  // durably indistinguishable from an ordinary answer, so any exclusion held in memory would
  // last exactly as long as the process - and the next daemon would read the row back and
  // light the offer for the path the design excludes. So the write is what refuses, and the
  // assertions below are about the TABLE rather than about this registry's memory.
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  assert.equal(registry.getSession("rv-dangling"), undefined, "no row for this session");

  assert.throws(
    () =>
      reviews.record({
        sessionId: "rv-dangling",
        kind: "input",
        title: "Which linter?",
        body: "Which linter?",
        decisions: OPTIONS,
        selections: [{ decisionId: "q", selected: ["o1"], other: null }],
        response: "Answered:\n\n• Which linter?\n  → eslint",
        resolvedBy: "human",
        at: 1_700_000_000_000,
      }),
    /no longer registered/,
    "an answer with no conversation to join is refused, and the caller logs it",
  );
  assert.equal(
    openDb().prepare(`SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?`).get("rv-dangling")?.n,
    0,
    "nothing was written, so there is nothing for any daemon to read back",
  );

  registry.applyDiscovery([mkDiscovered("rv-dangling")]);
  assert.deepEqual(reasons(registry, "rv-dangling"), [], "the session discovered afterwards");
  // And the case the in-memory version could not cover: a NEW registry, which is what a daemon
  // restart is. This is the assertion that fails for any fix that remembers rather than refuses.
  const rebooted = new Registry();
  rebooted.applyDiscovery([mkDiscovered("rv-dangling")]);
  assert.deepEqual(reasons(rebooted, "rv-dangling"), [], "and after a restart");
});

test("a review settled while the session was live still survives eviction and rediscovery", () => {
  // The other side of the same rule, and the reason the refusal is about OWNERSHIP rather than
  // about reviews in general. This answer was given to a session that was there to receive it,
  // so it is that session's steering for good - through the eviction a missed sweep causes, and
  // through the restart the cases below cover. A fix that excluded too much fails here.
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.applyDiscovery([mkDiscovered("rv-owned")]);
  const review = reviews.create("rv-owned", "input", "Which linter?", "Which linter?", OPTIONS);
  reviews.resolve(review.id, "answer", "eslint");
  assert.deepEqual(reasons(registry, "rv-owned"), ["corrections"]);

  registry.applyDiscovery([]);
  registry.applyDiscovery([mkDiscovered("rv-owned")]);
  assert.deepEqual(reasons(registry, "rv-owned"), ["corrections"], "restored, not withdrawn");
});

test("a driver answer taken while the session is live is recorded and counts", () => {
  // The refusal above must be a statement about the MISSING session and nothing else: the same
  // call, with the row present, is the ordinary SDK answer this feature exists for.
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.registerSdkSession({ id: "sdk:rv-live", agent: "claude", name: "e", cwd: "/wt/live" });
  const recorded = reviews.record({
    sessionId: "sdk:rv-live",
    kind: "input",
    title: "Which linter?",
    body: "Which linter?",
    decisions: OPTIONS,
    selections: [{ decisionId: "q", selected: ["o1"], other: null }],
    response: "Answered:\n\n• Which linter?\n  → eslint",
    resolvedBy: "human",
    at: 1_700_000_000_000,
  });
  assert.equal(recorded.status, "answered");
  assert.equal(recorded.resolvedBy, "human");
  assert.deepEqual(reasons(registry, "sdk:rv-live"), ["corrections"]);
});

// ---- restart restoration ---------------------------------------------------------------

test("a fresh registry restores worthiness for a reintroduced pane-backed session", () => {
  // The restart. In-memory attribution does not survive a daemon restart and the transcript
  // cannot recover this answer at all, so without the durable read the offer would be
  // withdrawn from a session that had genuinely been steered.
  const first = new Registry();
  const reviews = new ReviewManager(first);
  first.applyDiscovery([mkDiscovered("rv-restart")]);
  const review = reviews.create("rv-restart", "input", "Which linter?", "Which linter?", OPTIONS);
  reviews.resolve(review.id, "answer", "eslint");
  assert.deepEqual(reasons(first, "rv-restart"), ["corrections"]);

  const rebooted = new Registry();
  // On the FIRST payload the session ever emits, not on some later change to it: a card that
  // acquired the offer only once something unrelated moved would look like a flake.
  const seen = upserts(rebooted, () => rebooted.applyDiscovery([mkDiscovered("rv-restart")]));
  assert.deepEqual(seen.at(0)?.retro?.reasons, ["corrections"]);
  assert.deepEqual(reasons(rebooted, "rv-restart"), ["corrections"]);
});

test("a driver-run session is restored through its own door", () => {
  // The SDK door never passes through discovery, and it is the door that matters most here:
  // a driver session keeps Claude's native `AskUserQuestion`, so its steering evidence exists
  // ONLY as a review row.
  const first = new Registry();
  const reviews = new ReviewManager(first);
  first.registerSdkSession({ id: "sdk:rv-1", agent: "claude", name: "embedded", cwd: "/wt/sdk1" });
  reviews.record({
    sessionId: "sdk:rv-1",
    kind: "input",
    title: "Which linter?",
    body: "Which linter?",
    decisions: OPTIONS,
    selections: [{ decisionId: "q", selected: ["o1"], other: null }],
    response: "Answered:\n\n• Which linter?\n  → eslint",
    resolvedBy: "human",
    at: 1_700_000_000_000,
  });
  assert.deepEqual(reasons(first, "sdk:rv-1"), ["corrections"], "born-settled counts live");

  const rebooted = new Registry();
  const restored = rebooted.registerSdkSession({
    id: "sdk:rv-1",
    agent: "claude",
    name: "embedded",
    cwd: "/wt/sdk1",
  });
  assert.deepEqual(restored.retro?.reasons, ["corrections"], "and again after a restart");
});

test("Foreman's durable answer is not restored as steering either", () => {
  const first = new Registry();
  const reviews = new ReviewManager(first);
  first.applyDiscovery([mkDiscovered("rv-restart-foreman")]);
  const review = reviews.create(
    "rv-restart-foreman",
    "input",
    "Which linter?",
    "Which linter?",
    OPTIONS,
  );
  reviews.resolve(review.id, "answer", "biome", "foreman");

  const rebooted = new Registry();
  rebooted.applyDiscovery([mkDiscovered("rv-restart-foreman")]);
  assert.deepEqual(reasons(rebooted, "rv-restart-foreman"), []);
});

test("the durable read happens once per introduced session, not once per sweep", () => {
  // The bound. Discovery sweeps every few seconds for every pane-backed session on the
  // machine, and this read must not ride along - the signal is one-way and sticky, so a
  // repeat could only ever return what the first already answered.
  //
  // Asserted from the outside rather than by counting calls: a row written behind the
  // registry's back after the session was introduced is invisible to it, which is only true
  // if no later sweep re-queries. The live path (`ReviewManager`) is how a real answer
  // arrives, and it needs no query at all.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered("rv-bounded")]);
  assert.deepEqual(reasons(registry, "rv-bounded"), []);

  openDb()
    .prepare(
      `INSERT INTO reviews
         (id, session_id, kind, title, body, status, response, decisions, selections, resolved_by, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("rv-behind-back", "rv-bounded", "input", "t", "b", "answered", "said so", null, null, "human", 1000, 2000);

  registry.applyDiscovery([mkDiscovered("rv-bounded")]);
  registry.applyDiscovery([mkDiscovered("rv-bounded")]);
  assert.deepEqual(
    reasons(registry, "rv-bounded"),
    [],
    "no sweep re-reads the table for a session it already holds",
  );
});

// ---- cleanup ---------------------------------------------------------------------------

test("eviction forgets the signal, so a long-lived daemon does not accrete it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.applyDiscovery([mkDiscovered("rv-evicted")]);
  const review = reviews.create("rv-evicted", "input", "Which linter?", "Which linter?", OPTIONS);
  reviews.resolve(review.id, "answer", "eslint");
  assert.deepEqual(reasons(registry, "rv-evicted"), ["corrections"]);

  // The one way a session leaves: unseen by a completed sweep, then the eviction timer.
  registry.applyDiscovery([]);
  t.mock.timers.tick(9000);
  assert.equal(registry.getSession("rv-evicted"), undefined, "the row was removed");

  // Same proof as the dangling case: with the durable evidence gone, a reintroduced session
  // is worthy only if something was left behind in memory.
  openDb().prepare(`DELETE FROM reviews WHERE session_id = ?`).run("rv-evicted");
  registry.applyDiscovery([mkDiscovered("rv-evicted")]);
  assert.deepEqual(reasons(registry, "rv-evicted"), []);
});

// ---- the other feed ---------------------------------------------------------------------

test("the transcript feed still works, and the two do not double-count", () => {
  // `retro-worthiness.test.ts` owns the scanner; this owns the meeting point. One reason is
  // emitted however many ways the session was steered, because `RetroSummary.reasons` is a
  // list of KINDS of evidence and both of these are the same kind.
  const { registry, reviews, reviewId } = asking("rv-both");
  registry.recordRetroCorrections("rv-both");
  assert.deepEqual(reasons(registry, "rv-both"), ["corrections"]);
  reviews.resolve(reviewId, "answer", "eslint");
  assert.deepEqual(reasons(registry, "rv-both"), ["corrections"]);
});
