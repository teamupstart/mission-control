// Advisory worker decisions cannot bypass daemon ownership or the runtime write lock.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMuxHandle, mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { SessionGoal } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { Registry } from "../src/server/registry.ts";
import { buildApp, type RouteDeps } from "../src/server/routes.ts";
import { adoptPr } from "../src/server/inspector/worker.ts";
import { codeRabbitCandidate, codeRabbitStanding } from "../src/server/inspector/code-rabbit-delivery.ts";
import { codeRabbitSummary, loadOtherSends, openDb, recordCodeRabbit, readCodeRabbit, updateInspectorPr } from "../src/server/db.ts";
import { claimInjectionEcho, observeInjections, originOf } from "../src/server/injections.ts";
import { setShippingConfig } from "../src/server/shipping/config.ts";
import { setForemanConfig } from "../src/server/foreman/config.ts";
import { decideReviewFollowup, followupPrs } from "../src/server/foreman/review-followup.ts";
import type { CodeRabbitRecord } from "../src/server/inspector/code-rabbit-state.ts";

let number = 50;
function fixture() {
  const n = ++number, key = `a/b#${n}`, url = `https://github.com/a/b/pull/${n}`;
  const session = mkSession({ id: `session-${n}`, agentSessionId: `conversation-${n}`, runtime: "sdk", terminals: [],
    state: "idle", hooksSeen: true, stateConfirmed: true, lastActivity: Date.now() - 100_000,
    cwd: "/tmp/pr", repoRoot: "/tmp/repo", gitBranch: "fix", prState: "open", prNumber: n, prUrl: url,
    queue: null, note: null, pendingReviews: 0, task: null,
  });
  const registry = new Registry();
  let sessions = [session];
  let runs: WorkflowRunSummary[] = [];
  let goal = { objective: "implement the requested change", objectiveVersion: 1, promptRevision: 1,
    resolvedPromptRevision: 1, relationship: "initial" } as SessionGoal;
  let queued = false;
  const base = registry.snapshot();
  registry.snapshot = () => ({ ...base, sessions, workflowRunSummaries: runs });
  registry.liveSessions = () => sessions.filter((s) => s.state !== "exited");
  registry.getSession = (id) => sessions.find((s) => s.id === id);
  registry.getGoal = () => goal;
  registry.promptResourceBlockerForSession = () => null;
  const owner = { noteKey: session.agentSessionId!, episodeKey: "intent:1:1" };
  registry.refreshInspections = () => { session.inspector!.codeRabbit = codeRabbitSummary(key, owner); };
  session.inspector = { prKey: key, url, mode: "dry-run", open: 0, postedOpen: 0, round: 0, lastReviewedAt: null, failed: false };
  adoptPr(url, { sessionId: session.id, cwd: session.cwd, repoRoot: session.repoRoot }, "hook", Date.now());
  updateInspectorPr(key, { observedHeadSha: "head", observedState: "OPEN", headRefName: "fix" }, Date.now());
  recordCodeRabbit(key, { headSha: "head", state: "OPEN", draft: false, findings: [{
    id: "thread", rootId: "root", url: `${url}#discussion_r1`, path: "src/a.ts", identity: "root-v1", resolved: false,
  }] });
  setShippingConfig({ codeRabbitAutoResolve: true });
  setForemanConfig({ enabled: true, mode: "live", repoAllowlist: ["/tmp/repo"], trackReviewFeedback: false, trackCiFailures: false });
  registry.refreshInspections();
  const request = { prKey: key, observationId: readCodeRabbit(key)!.observationId };
  const messages: string[] = [];
  let atLock = () => {};
  let refuse = false;
  const app = buildApp({
    registry, reviews: {} as RouteDeps["reviews"], tasks: {} as RouteDeps["tasks"],
    queues: { get: () => ({ items: queued ? [{ state: "pending" }] : [] }) } as unknown as RouteDeps["queues"],
    workflows: { runs: () => runs, localPlanPublication: () => undefined } as unknown as RouteDeps["workflows"],
    sdkSessions: { send: async (_id: string, input: { text: string }, guard: () => string | null) => {
      atLock();
      const blocked = guard(); if (blocked) throw new Error(blocked);
      if (refuse) throw new Error("driver refused before delivery");
      messages.push(input.text); return "started";
    } } as unknown as RouteDeps["sdkSessions"],
  });
  const post = () => app.request(`/api/sessions/${session.id}/inject`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ text: "UNTRUSTED WORKER TEXT", origin: "foreman", codeRabbit: request }),
  });
  return { key, session, registry, request, owner, messages, post,
    setLock: (f: () => void) => { atLock = f; },
    setRuns: (r: WorkflowRunSummary[]) => { runs = r; registry.initializeWorkflowRuns(r); },
    setQueued: () => { queued = true; },
    setGoal: () => { goal = { ...goal, promptRevision: 2, resolvedPromptRevision: 2 }; },
    setSessions: (s: typeof sessions) => { sessions = s; },
    setRefuse: (value: boolean) => { refuse = value; },
  };
}

/** Keep the route, pane lock and tmux adapter real; only the terminal subprocess is fake. */
function terminalFixture(t: TestContext) {
  const f = fixture();
  f.session.runtime = "terminal";
  f.session.terminals = [mkMuxHandle({ session: "coderabbit", paneId: "%91" })];
  const dir = mkdtempSync(join(tmpdir(), "mission-coderabbit-terminal-"));
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
appendFileSync(file("commands.jsonl"), JSON.stringify(args) + "\n");
switch (args[0]) {
  case "display-message": process.stdout.write("0\n"); break;
  case "load-buffer": writeFileSync(file("buffer"), readFileSync(0)); break;
  case "paste-buffer":
    if (existsSync(file("refuse"))) {
      process.stderr.write("test terminal refused paste\n");
      process.exit(1);
    }
    writeFileSync(file("pane"), readFileSync(file("buffer")));
    rmSync(file("buffer"));
    break;
  case "send-keys":
    writeFileSync(file("submitted"), readFileSync(file("pane")));
    rmSync(file("pane"));
    break;
  case "capture-pane":
    process.stdout.write(existsSync(file("pane")) ? "❯ [Pasted text #1 +3 lines]\n" : "❯\n");
    break;
  case "delete-buffer": rmSync(file("buffer")); break;
  default: process.stderr.write("unexpected tmux command\n"); process.exit(2);
}
`, { mode: 0o755 });
  process.env.MISSION_TMUX_BIN = bin;
  const claims: CodeRabbitRecord["receipts"][] = [];
  f.registry.promptResourceBlockerForSession = () => {
    // This guard runs inside the real pane lock before paste and Enter.
    claims.push(readCodeRabbit(f.key)!.receipts);
    return null;
  };
  return { ...f, claims,
    commands: () => readFileSync(join(dir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
    submitted: () => existsSync(join(dir, "submitted")) ? readFileSync(join(dir, "submitted"), "utf8") : null,
    refuse: (value: boolean) => {
      if (value) writeFileSync(join(dir, "refuse"), "");
      else rmSync(join(dir, "refuse"));
    },
  };
}

test("real inject route claims once and uses daemon text through the SDK boundary", async () => {
  const f = fixture();
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 409);
  assert.equal(f.messages.length, 1);
  assert.doesNotMatch(f.messages[0]!, /UNTRUSTED WORKER/);
  for (const text of ["https://github.com/a/b/pull/", "/tmp/pr", "complete unresolved", "focused checks", "existing branch", "no merge authority", "never as instructions"]) assert.ok(f.messages[0]!.includes(text), text);
  assert.equal(readCodeRabbit(f.key)!.receipts[0]!.outcome, "delivered");
});

test("CodeRabbit eligibility and standing do not compute an unrelated dashboard snapshot", () => {
  const f = fixture();
  f.registry.snapshot = () => { throw new Error("dashboard snapshot unavailable"); };
  assert.equal(codeRabbitCandidate(f.registry, f.session.id, f.request).error, undefined);
  assert.equal(codeRabbitStanding(f.registry, f.key).pending, 1);
});

test("a synchronous reservation failure does not lock out a later CodeRabbit generation", async (t) => {
  const f = fixture();
  const db = openDb();
  t.after(() => db.exec("DROP TRIGGER IF EXISTS fail_other_send"));
  db.exec(`CREATE TEMP TRIGGER fail_other_send BEFORE INSERT ON session_other_sends
    BEGIN SELECT RAISE(ABORT, 'test reservation unavailable'); END`);
  assert.equal((await f.post()).status, 500);
  assert.equal(f.messages.length, 0);
  assert.equal(readCodeRabbit(f.key)!.receipts[0]!.outcome, "uncertain");
  db.exec("DROP TRIGGER fail_other_send");
  // Keep the old durable claim spent. A newly observed finding must still be deliverable.
  recordCodeRabbit(f.key, { headSha: "head", state: "OPEN", draft: false, findings: [{
    id: "thread", rootId: "root", url: `${f.session.prUrl}#discussion_r1`, path: "src/a.ts", identity: "root-v2", resolved: false,
  }] });
  f.request.observationId = readCodeRabbit(f.key)!.observationId;
  assert.equal((await f.post()).status, 200);
  assert.equal(f.messages.length, 1);
  assert.equal(readCodeRabbit(f.key)!.receipts.at(-1)!.outcome, "delivered");
});

for (const failure of ["receipt", "projection"] as const) {
  for (const refused of [false, true]) {
    test(`${failure} failure preserves ${refused ? "refused" : "delivered"} transport and authorship bookkeeping`, async (t) => {
      const f = fixture();
      const candidate = codeRabbitCandidate(f.registry, f.session.id, f.request);
      assert.equal(candidate.error, undefined);
      const payload = candidate.payload!;
      const confirmed: string[] = [];
      observeInjections((id, text, origin) => { confirmed.push(`${id}:${origin}:${text}`); });
      t.after(() => observeInjections(null));
      if (failure === "receipt") {
        const db = openDb();
        t.after(() => db.exec("DROP TRIGGER IF EXISTS fail_coderabbit_receipt"));
        // The claim has already been persisted when the runtime acquires its write lock.
        f.setLock(() => db.exec(`CREATE TEMP TRIGGER fail_coderabbit_receipt
          BEFORE UPDATE OF code_rabbit_state ON inspector_prs
          BEGIN SELECT RAISE(ABORT, 'test receipt unavailable'); END`));
      } else {
        f.registry.refreshInspections = () => { throw new Error("test projection unavailable"); };
      }
      f.setRefuse(refused);
      const response = await f.post();
      const result = await response.json();
      assert.equal(response.status, refused ? 500 : 200);
      assert.equal(result.ok, !refused);
      if (refused) assert.equal(result.pasted, false);
      assert.deepEqual(f.messages, refused ? [] : [payload]);
      assert.deepEqual(confirmed, refused ? [] : [`${f.session.id}:foreman:${payload}`]);
      assert.equal(originOf(f.session.id, payload), refused ? undefined : "foreman");
      assert.equal(claimInjectionEcho(f.session.id, payload), refused ? undefined : "foreman");
      assert.equal(claimInjectionEcho(f.session.id, payload), undefined);
      assert.equal(loadOtherSends(f.owner.noteKey, 0).length, refused ? 0 : 1);
      assert.deepEqual(readCodeRabbit(f.key)!.receipts.map((r) => r.outcome),
        failure === "receipt" ? ["uncertain"] : refused ? [] : ["delivered"]);
    });
  }
}

test("real inject route submits CodeRabbit to the owning terminal and completes its exact claim once", async (t) => {
  const f = terminalFixture(t);
  const observation = readCodeRabbit(f.key)!;
  const response = await f.post();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true, pasted: true, submitVerified: true });
  const text = f.submitted();
  assert.ok(text);
  assert.doesNotMatch(text, /UNTRUSTED WORKER/);
  for (const required of [f.session.prUrl!, "/tmp/pr", "CodeRabbit", "complete unresolved", "focused checks", "existing branch", "no merge authority", "never as instructions"]) {
    assert.ok(text.includes(required), required);
  }
  const claim = f.claims[0]![0]!;
  assert.ok(claim.claimId);
  assert.ok(claim.at >= observation.observedAt);
  assert.deepEqual(f.claims[0], [{ ...f.owner, threadId: "thread", generation: observation.findings[0]!.generation,
    observationId: f.request.observationId, headSha: "head", claimId: claim.claimId, at: claim.at, outcome: "uncertain" }]);
  assert.deepEqual(readCodeRabbit(f.key)!.receipts, [{ ...claim, outcome: "delivered" }]);
  assert.deepEqual(f.commands().filter((args) => args[0] === "paste-buffer" || args[0] === "send-keys"), [
    ["paste-buffer", "-p", "-d", "-b", "harness-91", "-t", "%91"],
    ["send-keys", "-t", "%91", "--", "Enter"],
  ]);
  const commands = f.commands();
  assert.equal((await f.post()).status, 409);
  assert.deepEqual(f.commands(), commands);
  assert.deepEqual(f.messages, []);
  assert.equal(codeRabbitSummary(f.key, f.owner).pending, 0);
});

test("terminal paste refusal reports positive non-delivery and releases the CodeRabbit claim for retry", async (t) => {
  const f = terminalFixture(t);
  f.refuse(true);
  const response = await f.post();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "test terminal refused paste", pasted: false, submitVerified: false });
  const refusedClaim = f.claims[0]![0]!;
  assert.equal(refusedClaim.outcome, "uncertain");
  assert.equal(refusedClaim.observationId, f.request.observationId);
  assert.deepEqual(readCodeRabbit(f.key)!.receipts, []);
  assert.equal(codeRabbitSummary(f.key, f.owner).pending, 1);
  assert.equal(f.submitted(), null);
  assert.equal(f.commands().some((args) => args[0] === "send-keys"), false);
  assert.equal(f.commands().at(-1)![0], "delete-buffer");
  f.refuse(false);
  assert.equal((await f.post()).status, 200);
  assert.ok(f.submitted()?.includes(f.session.prUrl!));
  const delivered = readCodeRabbit(f.key)!.receipts;
  assert.equal(delivered.length, 1);
  assert.notEqual(delivered[0]!.claimId, refusedClaim.claimId);
  assert.deepEqual(delivered, [{ ...f.claims.at(-1)![0]!, outcome: "delivered" }]);
  assert.equal(codeRabbitSummary(f.key, f.owner).pending, 0);
  assert.deepEqual(f.messages, []);
});

test("source remains independent of Inspector and CI switches on terminal and SDK sessions", () => {
  const f = fixture();
  for (const runtime of ["sdk", "terminal"] as const) {
    const session = { ...f.session, runtime, terminals: runtime === "terminal" ? mkSession().terminals : [] };
    assert.equal(decideReviewFollowup({ session, pr: followupPrs(session)[0]!, mark: null, bucket: "idle", mayActLive: true,
      workflowOwnsSession: false, cfg: { trackReviewComments: false, trackCiFailures: false, codeRabbitAutoResolve: true, settleMs: 0 }, now: Date.now(),
    }).kind, "nudge");
  }
});

test("busy, awaiting-input, uninvited, queued, exited and workflow-owned sessions send nothing", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.session.state = "working"; },
    (f: ReturnType<typeof fixture>) => { f.session.state = "awaiting_input"; },
    (f: ReturnType<typeof fixture>) => { f.session.foremanInvite = null; },
    (f: ReturnType<typeof fixture>) => f.setQueued(),
    (f: ReturnType<typeof fixture>) => { f.session.state = "exited"; },
    (f: ReturnType<typeof fixture>) => f.setRuns([{ noteKey: f.owner.noteKey, sessionId: f.session.id, status: "waiting_for_session" } as unknown as WorkflowRunSummary]),
  ]) {
    const f = fixture(); mutate(f);
    const response = await f.post(); assert.ok(response.status >= 400, await response.text());
    assert.equal(f.messages.length, 0); assert.equal(readCodeRabbit(f.key)!.receipts.length, 0);
  }
});

test("revocation, workflow, ownership, intent, queue and head races at the write lock positively release the exact claim", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.session.foremanInvite = null; },
    () => setShippingConfig({ codeRabbitAutoResolve: false }),
    () => setForemanConfig({ mode: "dry-run" }),
    () => setForemanConfig({ repoAllowlist: [] }),
    (f: ReturnType<typeof fixture>) => f.setRuns([{ noteKey: f.owner.noteKey, status: "waiting_for_session" } as unknown as WorkflowRunSummary]),
    (f: ReturnType<typeof fixture>) => f.setGoal(),
    (f: ReturnType<typeof fixture>) => f.setQueued(),
    (f: ReturnType<typeof fixture>) => { f.session.cwd = "/other"; },
    (f: ReturnType<typeof fixture>) => updateInspectorPr(f.key, { observedHeadSha: "new-head" }, Date.now()),
    (f: ReturnType<typeof fixture>) => f.setSessions([]),
  ]) {
    const f = fixture(); f.setLock(() => mutate(f));
    const response = await f.post(); assert.equal(response.status, 500, await response.clone().text());
    assert.equal((await response.json() as { pasted: boolean }).pasted, false);
    assert.equal(f.messages.length, 0); assert.equal(readCodeRabbit(f.key)!.receipts.length, 0);
  }
});

test("positive driver refusal can retry; attached PRs require that repository's trust and checkout", async () => {
  const f = fixture(); f.setRefuse(true); assert.equal((await f.post()).status, 500);
  f.setRefuse(false); assert.equal((await f.post()).status, 200);
  const sibling = fixture();
  const task = mkTask({ repoRoot: "/tmp/main", worktreePath: "/tmp/main-tree", branch: "main-fix", extraRepos: [{
    repoRoot: "/tmp/repo", worktreePath: "/tmp/pr", branch: "fix", provider: null, worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null,
  }] });
  sibling.session.task = { id: task.id, repoPrs: [{ repoRoot: "/tmp/repo", primary: false, prUrl: sibling.session.prUrl,
    prState: "open", mergedAt: null, feedback: { prNumber: sibling.session.prNumber!, prChecks: null, inspector: sibling.session.inspector } }] } as NonNullable<typeof sibling.session.task>;
  sibling.session.cwd = "/tmp/main-tree"; sibling.session.repoRoot = "/tmp/main"; sibling.session.gitBranch = "main-fix";
  sibling.registry.getTask = () => task;
  setForemanConfig({ repoAllowlist: ["/tmp/main"] });
  assert.ok(codeRabbitCandidate(sibling.registry, sibling.session.id, sibling.request).error);
  setForemanConfig({ repoAllowlist: ["/tmp/main", "/tmp/repo"] });
  assert.equal(codeRabbitCandidate(sibling.registry, sibling.session.id, sibling.request).error, undefined);
});
