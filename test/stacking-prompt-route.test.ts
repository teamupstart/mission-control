// The stack prompts travel the CodeRabbit follow-up's rails: Foreman decides, the daemon's
// inject route rebuilds the text, re-runs every guard inside the transport, claims before it
// types and settles the claim on the outcome. The operator's manual send uses the same route.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMuxHandle, mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { Session } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { Registry } from "../src/server/registry.ts";
import { buildApp, type RouteDeps } from "../src/server/routes.ts";
import { adoptPr } from "../src/server/inspector/worker.ts";
import { getInspectorPr, readStackPromptClaim, recordInspectorPrLineage, recordStackObservation, updateInspectorPr } from "../src/server/db.ts";
import { setForemanConfig } from "../src/server/foreman/config.ts";
import { stackStandingFor } from "../src/server/stacking/delivery.ts";
import { getForemanConfig } from "../src/server/foreman/config.ts";
import { decideReviewFollowup, followupPrs, followupSessionBlocker, foremanSettleMs } from "../src/server/foreman/review-followup.ts";
import { stackPromptCandidate } from "../src/server/stacking/delivery.ts";
import type { StackObservation } from "../src/shared/stacking.ts";
import { openDb } from "../src/server/db.ts";
import { useStackGitHub, type StackGitHub } from "../src/server/stacking/github.ts";
import type { PrRefs } from "../src/server/inspector/github.ts";

/** A GitHub seam that answers only the parent read the route's recovery recheck makes. */
function parentReads(parent: PrRefs | null): StackGitHub {
  const unused = async () => ({ ok: false as const, error: "unused" });
  return {
    prRefs: async () => (parent ? { ok: true, value: parent } : { ok: false, error: "unreadable" }),
    isAncestor: unused, compare: unused, mergeBase: unused,
    branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
    repositories: async () => [], primaryRepository: async () => null, retarget: unused,
  };
}
const CLOSED_PARENT: PrRefs = { state: "CLOSED", isDraft: false, headSha: "d".repeat(40), headRefName: "feat/parent",
  baseRefName: "main", defaultBranch: "main", mergeCommitSha: null };

const PARENT = "https://github.com/acme/repo/pull/7";
const MERGE = "e".repeat(40);
let number = 200;

function fixture(observation: Partial<StackObservation> = {}) {
  const n = ++number, key = `acme/repo#${n}`, url = `https://github.com/acme/repo/pull/${n}`;
  const session = mkSession({
    id: `session-${n}`, agentSessionId: `conversation-${n}`, runtime: "sdk", terminals: [], state: "idle",
    hooksSeen: true, stateConfirmed: true, lastActivity: Date.now() - 100_000, cwd: "/tmp/child", repoRoot: "/tmp/repo",
    gitBranch: "feat/child", prState: "open", prNumber: n, prUrl: url, queue: null, note: null, pendingReviews: 0,
    task: mkTask({ id: `child-${n}`, status: "running" }) as unknown as Session["task"],
  });
  adoptPr(url, { sessionId: session.id, cwd: session.cwd, repoRoot: session.repoRoot }, "hook", Date.now());
  updateInspectorPr(key, { headRefName: "feat/child", observedHeadSha: "f".repeat(40), observedState: "OPEN" }, Date.now());
  recordInspectorPrLineage(key, { taskId: `child-${n}`, episode: "ep", adoptedAt: 1, parentPrUrl: PARENT, baseSha: "c".repeat(40), history: [] });
  recordStackObservation(key, {
    observedAt: 1, childState: "OPEN", childHeadSha: "f".repeat(40), baseRefName: "main", defaultBranch: "main",
    parentUrl: PARENT, parentState: "MERGED", parentHeadSha: "d".repeat(40), parentHeadRefName: "feat/parent",
    parentMergeCommitSha: MERGE, parentHeadInChild: null, baseBehindBy: null, parentTaskStopped: null,
    parentEpisodeId: "ep-parent", parentTaskId: "parent", retargetError: null, ...observation,
  }, 1);
  const registry = new Registry();
  const sessions = [session];
  let runs: WorkflowRunSummary[] = [];
  const base = registry.snapshot();
  registry.snapshot = () => ({ ...base, sessions, workflowRunSummaries: runs });
  registry.liveSessions = () => sessions.filter((s) => s.state !== "exited");
  registry.getSession = (id) => sessions.find((s) => s.id === id);
  registry.workflowRunSummaries = () => runs;
  registry.promptResourceBlockerForSession = () => null;
  const refresh = () => {
    session.inspector = { prKey: key, url, mode: "live", open: 0, postedOpen: 0, round: 1, lastReviewedAt: null, failed: false,
      stack: stackStandingFor(getInspectorPr(key)!, sessions, getForemanConfig()) };
  };
  const refreshes = { count: 0 };
  registry.refreshInspections = () => { refreshes.count += 1; refresh(); };
  setForemanConfig({ enabled: true, mode: "live", repoAllowlist: ["/tmp/repo"], trackReviewFeedback: false, trackCiFailures: false });
  refresh();
  const messages: string[] = [];
  let lose = false;
  const app = buildApp({
    registry, reviews: {} as RouteDeps["reviews"], tasks: {} as RouteDeps["tasks"],
    queues: { get: () => ({ items: [] }) } as unknown as RouteDeps["queues"],
    workflows: { runs: () => runs, localPlanPublication: () => undefined, reconcileDispatchedTaskWorkflows: () => {} } as unknown as RouteDeps["workflows"],
    sdkSessions: { send: async (_id: string, input: { text: string }, guard: () => string | null) => {
      const blocked = guard(); if (blocked) throw new Error(blocked);
      messages.push(input.text);
      // A lost response: the text landed, the daemon never learned so.
      if (lose) return new Promise(() => {});
      return "started";
    } } as unknown as RouteDeps["sdkSessions"],
  });
  const post = (origin: "foreman" | "human", stack: { prKey: string; kind: string; tip: string | null } = { prKey: key, kind: "restack", tip: MERGE }, to: Session = session) =>
    app.request(`/api/sessions/${to.id}/inject`, {
      method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ text: "UNTRUSTED WORKER TEXT", origin, buffer: false, stack }),
    });
  return { key, session, sessions, messages, post, refresh, app, refreshes, setRuns: (r: WorkflowRunSummary[]) => { runs = r; }, setLose: () => { lose = true; } };
}

/**
 * The same route on a TERMINAL session: the real pane lock and tmux adapter, with only the
 * tmux binary faked. Its two failure switches are the two outcomes a pane can report that an
 * SDK driver cannot - `refuse` makes the paste fail (nothing reached the pane: a positive
 * non-delivery), `nosubmit` makes the Enter fail after the paste landed (the text is in the
 * composer, unsubmitted: a delivery that settled without being confirmed).
 */
function terminalFixture(t: TestContext) {
  const f = fixture();
  f.session.runtime = "terminal";
  f.session.terminals = [mkMuxHandle({ session: "stacking", paneId: "%92" })];
  f.refresh();
  const dir = mkdtempSync(join(tmpdir(), "mission-stack-terminal-"));
  const bin = join(dir, "tmux.cjs");
  const previous = process.env.MISSION_TMUX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_TMUX_BIN;
    else process.env.MISSION_TMUX_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(bin, `#!${process.execPath}\n` + String.raw`
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const file = (name) => join(__dirname, name);
const args = process.argv.slice(2);
switch (args[0]) {
  case "display-message": process.stdout.write("0\n"); break;
  case "load-buffer": writeFileSync(file("buffer"), readFileSync(0)); break;
  case "paste-buffer":
    if (existsSync(file("refuse"))) { process.stderr.write("test terminal refused paste\n"); process.exit(1); }
    writeFileSync(file("pane"), readFileSync(file("buffer")));
    rmSync(file("buffer"));
    break;
  case "send-keys":
    if (existsSync(file("nosubmit"))) { process.stderr.write("test terminal lost the Enter\n"); process.exit(1); }
    appendFileSync(file("submitted"), readFileSync(file("pane")) + "\n---\n");
    rmSync(file("pane"));
    break;
  case "capture-pane":
    process.stdout.write(existsSync(file("pane")) ? "❯ [Pasted text #1 +3 lines]\n" : "❯\n");
    break;
  case "delete-buffer": if (existsSync(file("buffer"))) rmSync(file("buffer")); break;
  default: process.stderr.write("unexpected tmux command\n"); process.exit(2);
}
`, { mode: 0o755 });
  process.env.MISSION_TMUX_BIN = bin;
  const toggle = (name: string, on: boolean) => {
    if (on) writeFileSync(join(dir, name), "");
    else if (existsSync(join(dir, name))) rmSync(join(dir, name));
  };
  return {
    ...f,
    refusePaste: (on: boolean) => toggle("refuse", on),
    loseEnter: (on: boolean) => toggle("nosubmit", on),
    /** The operator clearing the unsubmitted text out of the composer by hand. */
    clearComposer: () => toggle("pane", false),
    submitted: (): string[] => existsSync(join(dir, "submitted"))
      ? readFileSync(join(dir, "submitted"), "utf8").split("\n---\n").filter(Boolean)
      : [],
  };
}

test("Foreman's decision picks the pending stack prompt alone, and the route delivers the daemon's text exactly once", async () => {
  const f = fixture();
  const pr = followupPrs(f.session)[0]!;
  const decision = decideReviewFollowup({
    session: f.session, pr, bucket: "idle", mayActLive: true, workflowOwnsSession: false, mark: null, now: Date.now(),
    cfg: { trackReviewComments: false, trackCiFailures: false, stackPrompts: true, settleMs: 0 },
  });
  assert.equal(decision.kind, "nudge");
  assert.deepEqual(decision.kind === "nudge" && decision.stack, { prKey: f.key, kind: "restack", tip: MERGE });

  const first = await f.post("foreman");
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(f.messages.length, 1);
  assert.doesNotMatch(f.messages[0]!, /UNTRUSTED WORKER TEXT/, "the daemon builds the prompt, never the caller");
  assert.match(f.messages[0]!, /merge `origin\/main` into `feat\/child`/);
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE)?.outcome, "delivered");
  assert.equal(f.session.inspector?.stack?.label, "Restacking onto main");
  // Next tick, next pass: nothing new to send.
  const again = await f.post("foreman");
  assert.equal(again.status, 409);
  assert.equal(f.messages.length, 1);
  const afterDecision = decideReviewFollowup({
    session: f.session, pr: followupPrs(f.session)[0]!, bucket: "idle", mayActLive: true, workflowOwnsSession: false,
    mark: null, now: Date.now(), cfg: { trackReviewComments: false, trackCiFailures: false, stackPrompts: true, settleMs: 0 },
  });
  assert.equal(afterDecision.kind, "skip");
});

test("a response that never comes back leaves the claim uncertain, and Foreman never resends it", async () => {
  const f = fixture();
  f.setLose();
  void f.post("foreman");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.messages.length, 1);
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE)?.outcome, "uncertain");
  f.refresh();
  assert.equal(f.session.inspector?.stack?.label, "Restack prompt delivery uncertain");
  assert.equal((await f.post("foreman")).status, 409);
  assert.equal(f.messages.length, 1);
});

test("the operator's manual send: refused while the session works, delivered once when it is idle", async () => {
  const f = fixture();
  setForemanConfig({ enabled: false });
  f.refresh();
  assert.equal(f.session.inspector?.stack?.label, "Restack needed: Foreman is off");
  assert.equal((await f.post("foreman")).status, 409, "Foreman is off: it sends nothing");
  f.session.state = "working";
  assert.equal((await f.post("human")).status, 409);
  f.session.state = "idle";
  const sent = await f.post("human");
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(f.messages.length, 1);
  assert.equal((await f.post("human")).status, 409, "already delivered");
  // An active workflow owns the session: refused before anything is typed.
  const g = fixture({ parentMergeCommitSha: "9".repeat(40) });
  setForemanConfig({ enabled: false });
  g.setRuns([{ id: "run", status: "running", sessionId: g.session.id, noteKey: "x" } as unknown as WorkflowRunSummary]);
  assert.equal((await g.post("human", { prKey: g.key, kind: "restack", tip: "9".repeat(40) })).status, 409);
  assert.equal(g.messages.length, 0);
  setForemanConfig({ enabled: true });
});

test("a broken-stack action goes through the same route, only from the operator, only when offered", async (t) => {
  t.after(useStackGitHub(parentReads(CLOSED_PARENT)));
  const f = fixture({ parentState: "CLOSED", parentMergeCommitSha: null });
  const move = { prKey: f.key, kind: "move-onto-main", tip: null };
  assert.equal((await f.post("foreman", move)).status, 409, "actions are the operator's");
  assert.equal((await f.post("human", { prKey: f.key, kind: "reopen-against-main", tip: null })).status, 409, "not offered for an open child");
  const sent = await f.post("human", move);
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.match(f.messages[0]!, /Cherry-pick only this task's own commits/);
  assert.match(f.messages[0]!, /Do NOT force-push/);
});

test("a settled but unconfirmed delivery stays uncertain; Foreman never resends it, and the operator's send delivers it once", async (t) => {
  const f = terminalFixture(t);
  // The paste lands but the Enter is lost: the route settles, and cannot say the prompt landed.
  f.loseEnter(true);
  const lost = await f.post("foreman");
  assert.equal(lost.status, 500);
  const body = await lost.json() as { ok: boolean; pasted: boolean };
  assert.deepEqual({ ok: body.ok, pasted: body.pasted }, { ok: false, pasted: true });
  assert.deepEqual(f.submitted(), [], "nothing was submitted");
  const uncertain = readStackPromptClaim(f.key, "restack", MERGE);
  assert.equal(uncertain?.outcome, "uncertain", "not released: the text may still be sitting in the composer");
  f.refresh();
  assert.equal(f.session.inspector?.stack?.label, "Restack prompt delivery uncertain");
  assert.equal(f.session.inspector?.stack?.prompt?.status, "uncertain");
  // Foreman never retries it, on any later pass.
  assert.equal((await f.post("foreman")).status, 409);
  assert.deepEqual(f.submitted(), []);

  // The operator clears the composer and presses Send restack prompt: the explicit re-arm.
  f.clearComposer();
  f.loseEnter(false);
  const manual = await f.post("human");
  assert.equal(manual.status, 200, await manual.clone().text());
  const submitted = f.submitted();
  assert.equal(submitted.length, 1, "delivered exactly once");
  assert.match(submitted[0]!, /merge `origin\/main` into `feat\/child`/);
  const delivered = readStackPromptClaim(f.key, "restack", MERGE);
  assert.equal(delivered?.outcome, "delivered");
  assert.notEqual(delivered?.claimId, uncertain?.claimId, "the uncertain claim was finished and a new one taken");
  f.refresh();
  assert.equal(f.session.inspector?.stack?.label, "Restacking onto main");
  // ...and only once: a second press is refused and types nothing.
  assert.equal((await f.post("human")).status, 409);
  assert.equal(f.submitted().length, 1);
});

test("a confirmed refusal at the pane releases the claim, delivers nothing, and a later send succeeds", async (t) => {
  const f = terminalFixture(t);
  f.refusePaste(true);
  const refused = await f.post("foreman");
  assert.equal(refused.status, 500);
  const body = await refused.json() as { ok: boolean; pasted: boolean };
  assert.deepEqual({ ok: body.ok, pasted: body.pasted }, { ok: false, pasted: false });
  assert.deepEqual(f.submitted(), [], "nothing reached the session");
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE), null, "a positive non-delivery releases the claim");
  f.refresh();
  assert.equal(f.session.inspector?.stack?.prompt?.status, "pending", "pending again, not uncertain");
  assert.equal(f.session.inspector?.stack?.label, "Restacking onto main");

  // The pane takes the next attempt: Foreman's next pass delivers it, once.
  f.refusePaste(false);
  const retried = await f.post("foreman");
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(f.submitted().length, 1);
  assert.match(f.submitted()[0]!, /merge `origin\/main` into `feat\/child`/);
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE)?.outcome, "delivered");
  assert.equal((await f.post("foreman")).status, 409);
  assert.equal(f.submitted().length, 1);
});

test("two live sessions owning one child: neither receives the prompt, neither claims it, and the row says no one owns it", async () => {
  const f = fixture();
  // A second live session running the same child task (a duplicate resume, say), idle and
  // carrying the same pull request: ownership is ambiguous, so the daemon types into neither.
  const twin = { ...f.session, id: `${f.session.id}-twin`, agentSessionId: `${f.session.agentSessionId}-twin` } as Session;
  f.sessions.push(twin);
  f.refresh();
  const standing = f.session.inspector?.stack;
  assert.equal(standing?.sessionId, null, "no single owner");
  assert.notEqual(standing?.prompt?.status, "pending", "Foreman is not offered it");
  assert.equal(standing?.label, "Restack needed: no session");
  for (const to of [f.session, twin]) {
    for (const origin of ["foreman", "human"] as const) {
      const res = await f.post(origin, undefined, to);
      assert.equal(res.status, 409, `${origin} send to ${to.id}`);
      assert.equal((await res.json() as { pasted: boolean }).pasted, false);
    }
  }
  assert.deepEqual(f.messages, [], "nothing reached either session");
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE), null, "and nothing was claimed");
  // Once one of them goes away the remaining owner gets it, exactly once.
  f.sessions.splice(f.sessions.indexOf(twin), 1);
  f.refresh();
  assert.equal((await f.post("foreman")).status, 200);
  assert.equal(f.messages.length, 1);
  assert.equal(readStackPromptClaim(f.key, "restack", MERGE)?.outcome, "delivered");
});

test("a parent with new commits: Foreman's catch-up reaches the one idle owner through the route, once", async () => {
  const PARENT_HEAD_2 = "2".repeat(40);
  // The parent is open and pushed again; its new head is not in the child's history.
  const f = fixture({
    baseRefName: "feat/parent", parentState: "OPEN", parentHeadSha: PARENT_HEAD_2,
    parentMergeCommitSha: null, parentHeadInChild: false, baseBehindBy: 2,
  });
  const standing = f.session.inspector?.stack;
  assert.equal(standing?.state, "parent-moved");
  assert.deepEqual(standing?.prompt, { kind: "catch-up", tip: PARENT_HEAD_2, status: "pending" });
  assert.equal(standing?.sessionId, f.session.id);

  // Foreman's decision picks it, keyed to the parent's new head.
  const decision = decideReviewFollowup({
    session: f.session, pr: followupPrs(f.session)[0]!, bucket: "idle", mayActLive: true, workflowOwnsSession: false,
    mark: null, now: Date.now(), cfg: { trackReviewComments: false, trackCiFailures: false, stackPrompts: true, settleMs: 0 },
  });
  assert.equal(decision.kind, "nudge");
  assert.deepEqual(decision.kind === "nudge" && decision.stack, { prKey: f.key, kind: "catch-up", tip: PARENT_HEAD_2 });

  const request = { prKey: f.key, kind: "catch-up", tip: PARENT_HEAD_2 };
  const sent = await f.post("foreman", request);
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(f.messages.length, 1);
  assert.doesNotMatch(f.messages[0]!, /UNTRUSTED WORKER TEXT/, "the daemon builds the prompt, never the caller");
  assert.match(f.messages[0]!, /merge `origin\/feat\/parent` into `feat\/child`/, "the parent-branch merge instruction");
  assert.match(f.messages[0]!, /Do NOT force-push and do NOT rebase/);
  assert.match(f.messages[0]!, /Do NOT open a new pull request/);
  assert.equal(readStackPromptClaim(f.key, "catch-up", PARENT_HEAD_2)?.outcome, "delivered");
  assert.equal(f.session.inspector?.stack?.label, "Catching up with #7");

  // A duplicate is refused and types nothing; a stale tip is refused too.
  assert.equal((await f.post("foreman", request)).status, 409);
  assert.equal((await f.post("foreman", { ...request, tip: "d".repeat(40) })).status, 409);
  assert.equal(f.messages.length, 1);
});

test("Foreman's decision and the daemon's recheck read ONE session rule and ONE settle interval", async () => {
  const f = fixture();
  const previous = process.env.FOREMAN_QUEUE_SETTLE_MS;
  try {
    const decide = (now: number) => decideReviewFollowup({
      session: f.session, pr: followupPrs(f.session)[0]!, bucket: "idle", mayActLive: true, workflowOwnsSession: false,
      mark: null, now, cfg: { trackReviewComments: false, trackCiFailures: false, stackPrompts: true, settleMs: foremanSettleMs() },
    });
    const recheck = (now: number) => stackPromptCandidate(
      { liveSessions: () => [f.session], getSession: () => f.session, workflowRunSummaries: () => [] },
      f.session.id, { prKey: f.key, kind: "restack", tip: MERGE }, "foreman", getInspectorPr(f.key), getForemanConfig(), false, now,
    );
    // The session went idle 30s ago. Under a 60s settle window neither will type...
    f.session.lastActivity = 1_000_000;
    process.env.FOREMAN_QUEUE_SETTLE_MS = "60000";
    const blocked = followupSessionBlocker({ session: f.session, bucket: "idle", mayActLive: true, workflowOwnsSession: false,
      now: 1_030_000, settleMs: foremanSettleMs() });
    assert.equal(blocked, "still working");
    const early = decide(1_030_000);
    assert.equal(early.kind === "skip" && early.why, "still working");
    assert.equal(recheck(1_030_000).error, "still working", "the daemon refuses for the same reason");
    // ...and under a 10s window both agree it may.
    process.env.FOREMAN_QUEUE_SETTLE_MS = "10000";
    assert.equal(decide(1_030_000).kind, "nudge");
    assert.equal(recheck(1_030_000).error, undefined);
    // Every other session gate is the same function too: an uninvited session.
    const uninvited = { ...f.session, foremanInvite: null } as Session;
    assert.equal(followupSessionBlocker({ session: uninvited, bucket: "idle", mayActLive: true, workflowOwnsSession: false,
      now: 1_030_000, settleMs: 0 }), "Foreman is not invited into this session");
  } finally {
    if (previous === undefined) delete process.env.FOREMAN_QUEUE_SETTLE_MS;
    else process.env.FOREMAN_QUEUE_SETTLE_MS = previous;
  }
});

test("a recovery action is refused, and nothing typed, when the parent changed since the offer was made", async (t) => {
  const f = fixture({ parentState: "CLOSED", parentMergeCommitSha: null });
  const move = { prKey: f.key, kind: "move-onto-main", tip: null };
  // The parent was reopened since the last check.
  t.after(useStackGitHub(parentReads({ ...CLOSED_PARENT, state: "OPEN" })));
  const changed = await f.post("human", move);
  assert.equal(changed.status, 409);
  assert.match((await changed.json() as { error: string }).error, /#7 changed since it was last checked/);
  // GitHub cannot be read for it: refused too.
  t.after(useStackGitHub(parentReads(null)));
  const unreadable = await f.post("human", move);
  assert.equal(unreadable.status, 409);
  assert.match((await unreadable.json() as { error: string }).error, /could not be read from GitHub/);
  assert.deepEqual(f.messages, [], "nothing reached the session");
});

test("one row whose stack standing cannot be computed does not take the merge-queue listing down", async () => {
  const f = fixture();
  const db = openDb();
  // The claims table is unreadable, so a row that needs a prompt throws when its standing is computed.
  db.exec("ALTER TABLE stack_prompt_claims RENAME TO stack_prompt_claims_hidden");
  try {
    const res = await f.app.request("/api/inspector/prs", { headers: { host: "127.0.0.1:7317" } });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = await res.json() as Array<{ key: string; stackStanding: unknown }>;
    const row = rows.find((candidate) => candidate.key === f.key);
    assert.ok(row, "the row is still listed");
    assert.equal(row!.stackStanding, null, "with no standing, rather than a 500 for every row");
  } finally {
    db.exec("ALTER TABLE stack_prompt_claims_hidden RENAME TO stack_prompt_claims");
  }
});

test("saving Foreman's config refreshes the cached stack standings at once", async () => {
  const f = fixture();
  setForemanConfig({ enabled: false });
  f.refresh();
  assert.equal(f.session.inspector?.stack?.prompt?.status, "foreman-off");
  const before = f.refreshes.count;
  const res = await f.app.request("/api/foreman/config", {
    method: "PUT", headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, mode: "live", repoAllowlist: ["/tmp/repo"] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(f.refreshes.count > before, "the route refreshed the cached standings");
  assert.equal(f.session.inspector?.stack?.prompt?.status, "pending", "Foreman reads it as its own to send, without waiting a sweep");
});

test("a recovery action is claimed: delivered once, never sent again for the same stack state", async (t) => {
  t.after(useStackGitHub(parentReads(CLOSED_PARENT)));
  const f = fixture({ parentState: "CLOSED", parentMergeCommitSha: null });
  const move = { prKey: f.key, kind: "move-onto-main", tip: null };
  const first = await f.post("human", move);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(f.messages.length, 1);
  f.refresh();
  assert.deepEqual(f.session.inspector?.stack?.sentActions, ["move-onto-main"], "shown as sent");
  // A second click before the session has acted: refused, and nothing more is typed - it would
  // ask for a second replacement pull request.
  const second = await f.post("human", move);
  assert.equal(second.status, 409);
  assert.match((await second.json() as { error: string }).error, /already sent/);
  assert.equal(f.messages.length, 1);
  // The stack state changes (the parent was reopened, then closed under a new branch): a new
  // key, so the action is offered and accepted again.
  recordStackObservation(f.key, { ...getInspectorPr(f.key)!.stack!.observation!, parentHeadRefName: "feat/parent-v2" }, 2);
  t.after(useStackGitHub(parentReads({ ...CLOSED_PARENT, headRefName: "feat/parent-v2" })));
  f.refresh();
  assert.deepEqual(f.session.inspector?.stack?.sentActions, []);
  assert.equal((await f.post("human", move)).status, 200);
  assert.equal(f.messages.length, 2);
});
