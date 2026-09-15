import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The DAEMON's half of the Foreman invite rule
// (docs/plans/foreman-invite/phase-2-foreman-enforcement.md, contract C6).
//
// The worker gates itself on the sessions snapshot, and those gates are unit-tested where
// the machines live (queue-machine, review-followup, backlog-machine). This file tests the
// backstop UNDER them: the daemon refusing a Foreman-marked write regardless of what the
// worker believed. It exists because the worker's gate is a decision made from a snapshot
// that can be stale by the time the POST lands - an invite withdrawn mid-pass, a worker
// built before this rule, a bug - and every one of those failures ends in the same place,
// which is text appearing in a pane belonging to somebody who never asked for it.
//
// The rule has an exact shape and both halves matter: `by`/`origin` of "foreman" into a
// session whose `foremanInvite` is null is refused, and NOTHING ELSE IS. A human typing
// into their own uninvited session is precisely the case this must never break, and it is
// asserted beside every refusal rather than in a test of its own, so a regression that
// widens the gate cannot pass by being read as a narrower one.

const home = mkdtempSync(join(tmpdir(), "mission-foreman-enforce-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { foremanTriageAuthorized } = await import("../src/server/foreman/authorization.ts");
const { tickTargets } = await import("../src/server/foreman/queue-machine.ts");
const { foremanStatus } = await import("../src/server/foreman/config.ts");

type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

let seq = 0;

/** One discovered terminal session - uninvited, which is what discovery produces. */
function discover(registry: InstanceType<typeof Registry>): Session {
  const n = ++seq;
  const d = {
    syntheticId: `proc:ttys10${n}:${n}:0`,
    agent: "claude",
    name: "personal chat",
    nameSource: "process",
    cwd: `/home/me/notes-${n}`,
    gitBranch: "main",
    pid: 4000 + n,
    tty: `ttys10${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${n}` })],
    startedAt: 0,
  } as DiscoveredSession;
  registry.applyDiscovery([d]);
  const s = registry.getSession(d.syntheticId);
  assert.ok(s, "discovery should register the session");
  return s;
}

function harness(): {
  registry: InstanceType<typeof Registry>;
  reviews: InstanceType<typeof ReviewManager>;
  app: ReturnType<typeof buildApp>;
} {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const app = buildApp({ registry, reviews, tasks: {} as TaskManager, queues: {} as QueueManager });
  return { registry, reviews, app };
}

async function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

// ---- the three typing routes ----

test("/inject refuses foreman-origin text into an uninvited session", async () => {
  const { registry, app } = harness();
  const s = discover(registry);
  assert.equal(s.foremanInvite, null, "a discovered session starts uninvited");

  const refused = await post(app, `/api/sessions/${s.id}/inject`, {
    text: "Please open a pull request for this work.",
    origin: "foreman",
  });
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { error: string; pasted: boolean };
  assert.match(body.error, /not invited/);
  // /inject's standing contract: EVERY refusal states whether text was pasted, because a
  // missing field reads as "may have landed" and terminally escalates the work item
  // instead of taking the clean re-queue. A 403 is the one case we know for certain.
  assert.equal(body.pasted, false, "a refusal must say nothing was typed");

  // Invited: the gate is passed, so the request reaches delivery and fails on the absent
  // pane instead. Asserting "not 403" rather than a success keeps this about the gate.
  registry.setForemanInvite(s.id, "dispatch");
  const allowed = await post(app, `/api/sessions/${s.id}/inject`, {
    text: "Please open a pull request for this work.",
    origin: "foreman",
  });
  assert.notEqual(allowed.status, 403, "an invited session is not refused by the backstop");
});

test("/send refuses a foreman DRAFT into an uninvited session", async () => {
  // The path the phase plan's route list missed, and it is a real one: the worker splits
  // one delivery across two routes - `sendText(submit: true)` delegates to /inject, while
  // `submit: false` (a draft the model asked to leave in the composer, and the model
  // chooses that per answer) keeps /send deliberately so it spends no Enter. Gating only
  // the submitted half leaves Foreman's words sitting in a stranger's composer, which is
  // the same intrusion arriving one keystroke short.
  const { registry, app } = harness();
  const s = discover(registry);

  const refused = await post(app, `/api/sessions/${s.id}/send`, {
    text: "I would answer this with option 2.",
    submit: false,
    origin: "foreman",
  });
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /not invited/);

  // The dashboard composer sends no origin at all and must keep working: the schema
  // defaults to the human, and a human typing into their own session is never gated.
  const human = await post(app, `/api/sessions/${s.id}/send`, {
    text: "my own message",
    submit: false,
  });
  assert.notEqual(human.status, 403);
});

test("/inject never gates a human or a workflow, invited or not", async () => {
  // The case this must never break. A person typing into their own personal Claude chat
  // through the dashboard composer is the whole reason that session is uninvited.
  const { registry, app } = harness();
  const s = discover(registry);
  for (const origin of ["human", "workflow"] as const) {
    const r = await post(app, `/api/sessions/${s.id}/inject`, { text: "hello", origin });
    assert.notEqual(r.status, 403, `${origin} writes are never invite-gated`);
  }
});

test("/inject refuses Foreman while the dashboard composer is active but never gates the human", async () => {
  const { registry, app } = harness();
  const s = discover(registry);
  registry.setForemanInvite(s.id, "dispatch");

  const activity = await post(app, `/api/sessions/${s.id}/composer-activity`, {
    clientId: "dashboard-tab-a",
    focused: true,
    typed: false,
  });
  assert.equal(activity.status, 200);

  const refused = await post(app, `/api/sessions/${s.id}/inject`, {
    text: "Foreman should wait.",
    origin: "foreman",
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "Foreman is waiting while the user composes a reply",
    pasted: false,
  });

  const human = await post(app, `/api/sessions/${s.id}/inject`, {
    text: "My message still goes through the human path.",
    origin: "human",
  });
  assert.notEqual(human.status, 409);
});

test("/select-option and /submit-options refuse a foreman answer into an uninvited session", async () => {
  // Answering a menu is typing too - it presses a key in somebody's pane and commits them
  // to a choice. 403 rather than this route's usual 409: a 409 says "the pane declined,
  // try again when it settles", and this refusal is neither about the pane nor going to
  // change on one.
  const { registry, app } = harness();
  const s = discover(registry);

  const select = await post(app, `/api/sessions/${s.id}/select-option`, {
    number: 1,
    label: "Yes, allow",
    by: "foreman",
  });
  assert.equal(select.status, 403);
  assert.match(((await select.json()) as { error: string }).error, /not invited/);

  const submit = await post(app, `/api/sessions/${s.id}/submit-options`, {
    options: [{ number: 1, label: "Yes, allow", checked: true }],
    by: "foreman",
  });
  assert.equal(submit.status, 403);
  assert.match(((await submit.json()) as { error: string }).error, /not invited/);

  // Human answers on the same session reach the pane logic and are refused (or not) on
  // its own terms - never on the invite.
  for (const path of ["select-option", "submit-options"]) {
    const body = path === "select-option"
      ? { number: 1, label: "Yes, allow" }
      : { options: [{ number: 1, label: "Yes, allow", checked: true }] };
    const r = await post(app, `/api/sessions/${s.id}/${path}`, body);
    assert.notEqual(r.status, 403, `a human ${path} is never invite-gated`);
  }
});

test("the submit-options backstop runs before the body-shape refusal", async () => {
  // Ordering matters for what the caller learns: a shape complaint would tell a worker to
  // retry with the other body, when the answer is that it should not be writing here at
  // all. Driver answers into a pane-backed session is the shape mismatch that would
  // otherwise 409 first.
  const { registry, app } = harness();
  const s = discover(registry);
  const r = await post(app, `/api/sessions/${s.id}/submit-options`, {
    answers: [{ question: "Which?", labels: ["Yes"] }],
    by: "foreman",
  });
  assert.equal(r.status, 403);
});

// ---- review resolution ----

test("review resolve refuses a foreman verdict on an uninvited session's review", async () => {
  const { registry, reviews, app } = harness();
  const s = discover(registry);
  const review = reviews.create(s.id, "input", "Which approach?", "a or b");

  const refused = await post(app, `/api/reviews/${review.id}/resolve`, {
    action: "answer",
    response: "a",
    by: "foreman",
  });
  assert.equal(refused.status, 403);
  assert.equal(registry.getReview(review.id)?.status, "pending", "the review is untouched");

  // A human answering their own session's question is never gated.
  const human = await post(app, `/api/reviews/${review.id}/resolve`, {
    action: "answer",
    response: "a",
  });
  assert.equal(human.status, 200);
  assert.equal(registry.getReview(review.id)?.status, "answered");
});

test("review resolve allows a foreman verdict once the session is invited", async () => {
  const { registry, reviews, app } = harness();
  const s = discover(registry);
  registry.setForemanInvite(s.id, "dispatch");
  const review = reviews.create(s.id, "input", "Which approach?", "a or b");
  const r = await post(app, `/api/reviews/${review.id}/resolve`, {
    action: "answer",
    response: "a",
    by: "foreman",
  });
  assert.equal(r.status, 200);
  assert.equal(registry.getReview(review.id)?.status, "answered");
});

test("a review whose session is gone still resolves - there is no pane left to protect", async () => {
  // The deliberate narrowing: refused only on a POSITIVE answer (the session is here and
  // uninvited). An unresolvable owner makes this bookkeeping that settles a dangling row,
  // and refusing it would strand the review rather than protect anybody.
  const { registry, reviews, app } = harness();
  const review = reviews.create("proc:long-gone:1:0", "input", "Still there?", "?");
  const r = await post(app, `/api/reviews/${review.id}/resolve`, {
    action: "answer",
    response: "yes",
    by: "foreman",
  });
  assert.equal(r.status, 200);
});

// ---- the badge and the worker must agree ----

test("the queue-depth badge and tickTargets both ignore an uninvited needs-you session", () => {
  // `countNeedsYou` (behind the dashboard's queue-depth badge) and `tickTargets` (what the
  // worker actually processes) share `foremanTriageAuthorized` precisely so this can never
  // drift. A badge reading "1 waiting" for a session the worker will never touch is a
  // number nobody can act on and a standing accusation that the worker is stuck.
  //
  // Real registry sessions, not literals: the badge reads `registry.snapshot()`, so a
  // fixture would test the assertion rather than the wiring. Both are plain discovered
  // Claude terminals - which is the point. Claude installs its hooks MACHINE-wide, so both
  // satisfy `foremanAutomationAuthorized` on identical evidence; the invite is the only
  // thing that tells them apart, and before this phase neither could be told apart at all.
  const registry = new Registry();
  const personal = discover(registry);
  const ours = discover(registry);
  registry.setForemanInvite(ours.id, "dispatch");

  // A pending review each - what `reportBucket` reads as needs-you.
  const reviews = new ReviewManager(registry);
  reviews.create(personal.id, "input", "Which approach?", "a or b");
  reviews.create(ours.id, "input", "Which approach?", "a or b");

  const fleet = registry.snapshot().sessions;
  assert.equal(fleet.length, 2);
  for (const s of fleet) assert.equal(s.pendingReviews, 1, "both are needs-you");

  assert.equal(foremanTriageAuthorized(registry.getSession(personal.id)!, fleet), false);
  assert.equal(foremanTriageAuthorized(registry.getSession(ours.id)!, fleet), true);

  assert.deepEqual(
    tickTargets(fleet, ["drain"]).map((s) => s.id),
    [ours.id],
    "the worker looks only at the invited one",
  );
  assert.equal(
    foremanStatus(registry).queueDepth,
    1,
    "and the badge counts the same one, and only that one",
  );
});
