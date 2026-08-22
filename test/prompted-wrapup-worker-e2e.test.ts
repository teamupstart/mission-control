import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFY_FAILURE_CAP } from "../src/server/foreman/queue-machine.ts";
import { isWrapupPayload } from "../src/shared/queue.ts";
import type { Session, SessionQueue } from "../src/shared/types.ts";
import { mkMuxHandle, mkTaskSummary } from "./helpers/session-fixture.ts";

// The `prompted` wrap-up trigger, driven END TO END: the real worker binary, a stub
// daemon, and a fake `claude`.
//
// WHY THIS EXISTS ALONGSIDE prompted-wrapup.test.ts, which is a much cheaper table
// test. That one covers `decidePromptedWrapup` / `planPromptedWrapup` - the pure
// policy - and it cannot reach any of the properties below, for two reasons:
//
//   1. `processPromptedWrapup` and `processTarget` are unexported, and exporting them
//      to test them would still leave (2).
//   2. The properties at stake are LOOP behaviours, not decisions. "A failed read must
//      not fire twice", "a broken verifier must not spin", "give up after N strikes"
//      are all statements about what a running worker does over WALL-CLOCK TIME across
//      several ticks. A pure function called once cannot be wrong about any of them.
//
// Each of these three regressions shipped and had to be found by hand. What makes them
// catchable here is timing: the worker sleeps IDLE_MS (4s) after a pass that advanced
// nothing and only BETWEEN_MS (400ms) after one that did, so "did this tick honestly
// report getting nowhere" is directly observable as elapsed time.

const WORKER = fileURLToPath(new URL("../src/server/foreman/worker.ts", import.meta.url));
const PROJECT = fileURLToPath(new URL("..", import.meta.url));

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How long to keep the worker alive after the behaviour under test has been observed,
 * before concluding it did not ALSO do something it shouldn't.
 *
 * One full idle cadence plus margin: the worker's loop is `IDLE_MS = 4000`
 * (`src/server/foreman/worker.ts`), so a tick that should not happen would land inside
 * this window. Anything shorter proves only that the next tick had not arrived yet.
 */
const IDLE_SETTLE_MS = 5_500;

/**
 * A stand-in for `claude -p` that records every invocation with a timestamp.
 *
 * The timestamps are the point: the strike-cap test asserts on the GAP between calls,
 * which is the only thing that distinguishes "three unhurried ticks gave up" from "a
 * hot loop burned three model calls in a second".
 *
 * It drains stdin before answering because `runClaudeText` writes the whole prompt
 * there and ends it - a child that exits without reading leaves the parent writing to
 * a closed pipe.
 */
function mkFakeClaude(opts: { fail: boolean; completions?: boolean[] }): { bin: string; log: string } {
  const dir = tmp("fake-claude-");
  const log = join(dir, "calls.log");
  const bin = join(dir, "claude");
  const body = opts.fail
    ? `process.stderr.write("the model is broken"); process.exit(1);`
    : opts.completions
      ? `
  const call = fs.readFileSync(process.env.FAKE_CLAUDE_LOG, "utf8").split("\\n").filter(Boolean).length;
  const completions = ${JSON.stringify(opts.completions)};
  const complete = completions[Math.min(call - 1, completions.length - 1)];
  process.stdout.write(JSON.stringify({ result: JSON.stringify({ complete, summary: complete ? "the ask was satisfied" : "background work is still pending", gaps: [] }) }));`
      : `process.stdout.write(JSON.stringify({ result: JSON.stringify({ complete: true, summary: "the ask was satisfied", gaps: [] }) }));`;
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, Date.now() + "\\n");
  ${body}
});
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  return { bin, log };
}

/** Invocation timestamps, oldest first. */
function claudeCalls(log: string): number[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

// ---- the stub daemon ----

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Stub {
  port: number;
  calls: Recorded[];
  close: () => Promise<void>;
  /** Every recorded call to one route, by `METHOD /path` prefix match. */
  to: (method: string, path: string) => Recorded[];
}

/**
 * The daemon surface the worker actually reaches on this path, and nothing else.
 *
 * `route` gets first refusal on every request, which is how a test injects the one
 * failure it is about (a 500 on the queue read) without having to model the rest.
 */
async function startStub(
  route: (req: IncomingMessage, url: URL, body: string) => { status: number; json: unknown } | null,
): Promise<Stub> {
  const calls: Recorded[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      calls.push({ method: req.method ?? "GET", path: url.pathname, body: parsed });
      const answer = route(req, url, raw);
      const status = answer?.status ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer ? answer.json : null));
    });
  };
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    calls,
    to: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A session the prompted trigger would fire on: Claude, hooked, fresh, settled, with a goal. */
function mkSession(cwd: string, over: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: "s1",
    agent: "claude",
    name: "work",
    runtime: "terminal",
    // A dispatched worktree session, as participate-always semantics modeled it.
    foremanInvite: "dispatch",
    nameSource: "tmux",
    state: "idle",
    cwd,
    gitBranch: "feature",
    gitRoot: cwd,
    repoRoot: cwd,
    pid: 1,
    tty: "ttys001",
    permissionMode: null,
    terminals: [mkMuxHandle({ session: "work", windowName: "w", windowIndex: 0, paneId: "%1" })],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "idle",
    startedAt: now - 600_000,
    firstSeen: now - 600_000,
    lastSeen: now,
    // Settled well past SETTLE_MS, and re-stamped on every read below so it stays that
    // way however long a test runs.
    lastActivity: now - 120_000,
    workCycle: {
      logicalKey: "agent-1",
      generation: 1,
      active: false,
      completedAt: now - 120_000,
      updatedAt: now - 120_000,
    },
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: { text: "Add retry handling.", source: "model", updatedAt: now },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

function mkQueue(cwd: string, over: Partial<SessionQueue> = {}): SessionQueue {
  return {
    noteKey: "agent-1",
    cwd,
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: null,
    promptedEvidence: null,
    promptedActivityAt: null,
    promptedLegacyCutoverGeneration: null,
    promptedConsumedGeneration: null,
    promptedDirectHandoff: null,
    promptedDecision: null,
    updatedAt: 0,
    items: [],
    ...over,
  };
}

const GOAL = "make the uploader retry on a 500";
const goalRecord = {
  noteKey: "agent-1",
  text: GOAL,
  source: "model",
  objective: GOAL,
  prompt: GOAL,
  focus: GOAL,
  relationship: "initial",
  rationale: "This is the session's initial objective.",
  objectiveVersion: 1,
  promptRevision: 1,
  resolvedPromptRevision: 1,
  pendingPrompts: [],
  updatedAt: 0,
};

/**
 * Boot the real worker against a stub daemon, let it run, then stop it.
 *
 * SIGTERM rather than SIGKILL: the worker's shutdown handler kills the headless
 * children it spawned, and a leaked `claude` writing to a log this test then reads
 * would make the assertions flaky rather than just slow.
 */
async function runWorker(
  opts: {
    port: number;
    claudeBin: string;
    claudeLog: string;
    ms: number;
    until?: () => boolean;
  },
): Promise<string> {
  let out = "";
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", WORKER],
    {
      cwd: PROJECT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MISSION_PORT: String(opts.port),
        MISSION_HOME: tmp("mission-pw-e2e-"),
        MISSION_CLAUDE_BIN: opts.claudeBin,
        MISSION_CLAUDE_TRANSPORT: "print",
        FAKE_CLAUDE_LOG: opts.claudeLog,
        // The trigger requires a settled idle session; the fixtures above are two
        // minutes idle, so this only keeps the test honest about which gate it passed.
        FOREMAN_QUEUE_SETTLE_MS: "1000",
        FOREMAN_EVAL_DEBOUNCE_MS: "60000",
      },
    },
  );
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => (out += d));
  child.stderr?.on("data", (d: string) => (out += d));
  const deadline = Date.now() + opts.ms;
  do {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline && !opts.until?.());
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const hard = setTimeout(() => child.kill("SIGKILL"), 3000);
    hard.unref?.();
    child.on("close", () => {
      clearTimeout(hard);
      resolve();
    });
  });
  return out;
}

/** The config every test runs under; `over` picks the trigger and the action. */
function cfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    mode: "dry-run",
    repoAllowlist: [],
    autoApproveAccess: true,
    // `off`, so a triage path that does run spawns exactly one reviewer rather than
    // the two `shadow` would - the claude call count is an assertion here.
    triage: "off",
    maxFixAttempts: 3,
    maxFixRounds: 10,
    wrapupTriggers: ["prompted"],
    wrapup: "ask",
    autoBacklog: false,
    ...over,
  };
}

test("a daemon blip on the queue read never double-fires a wrap-up, and never stalls triage", async () => {
  // The bug this pins: `client.queue()` used to coerce a throw to `null`, and `null` is
  // ALSO the honest answer for "this session has no queue". So a 500 on that one route
  // read as "no queue here", which disarms BOTH of the trigger's double-fire guards -
  // the overlap rule and the once-per-generation consume - and the worker fired a
  // fresh wrap-up every pass. Reverting the fix produced ten shipping actions
  // in nine seconds against a session that had already been shipped once.
  //
  // The second half is the fix's OWN regression: the bail was first written above the
  // needs-you branch, so the same flaky route stalled every human-blocking session on
  // the box, not just the wrap-ups. Triage never needed the queue for anything but
  // optional context, so it must still run.
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const sessions = [
    mkSession(repo),
    mkSession(repo, {
      id: "s2",
      agentSessionId: "agent-2",
      name: "asking",
      state: "awaiting_input",
      activity: "May I write to config.json?",
      lastActivity: Date.now() - 5_000,
    }),
    mkSession(repo, {
      id: "s3",
      agent: "codex",
      agentSessionId: null,
      name: "operator-codex",
      state: "awaiting_input",
      activity: "Run this command?",
      instrumented: false,
      hooksSeen: false,
      lastActivity: Date.now() - 5_000,
      queue: {
        openCount: 1,
        totalCount: 1,
        inFlightState: null,
        inFlightIntent: null,
        round: 0,
        blockingGaps: 0,
        verifiedCount: 0,
        escalatedCount: 0,
        drained: false,
        wrapupAskedAt: null,
        wrapupAnswered: false,
        updatedAt: 0,
      },
    }),
  ];

  const stub = await startStub((req, url) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") return { status: 200, json: cfg() };
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      // Re-stamped per read so "settled idle" stays true for the whole run.
      const now = Date.now();
      return {
        status: 200,
        json: sessions.map((s) => ({
          ...s,
          lastSeen: now,
          lastActivity: s.id === "s1" ? now - 120_000 : now - 5_000,
        })),
      };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    // THE BLIP: the one route under test, broken for the whole run.
    if (p.endsWith("/queue")) return { status: 500, json: { error: "down" } };
    if (p.endsWith("/note")) return { status: 200, json: null };
    if (p.endsWith("/pane")) return { status: 200, json: { text: null } };
    if (p.endsWith("/goal")) return { status: 200, json: { prompt: GOAL, text: GOAL, updatedAt: 0 } };
    // EVERY OTHER PIECE OF EVIDENCE IS HEALTHY, deliberately. The broken queue read has
    // to be the only reason nothing fires - serve a null diff here and the wrap-up dies
    // one step later on missing evidence, which passes this test for the wrong reason
    // and lets the regression back in unnoticed.
    if (p.endsWith("/transcript")) {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p.endsWith("/diff")) {
      return {
        status: 200,
        json: { ok: true, patch: "diff --git a/up.ts b/up.ts\n+retry();\n", truncated: false, headSha: "abc" },
      };
    }
    if (p.endsWith("/standards")) return { status: 200, json: { docs: [], truncated: false } };
    return { status: 200, json: null };
  });

  const out = await runWorker({ port: stub.port, claudeBin: fake.bin, claudeLog: fake.log, ms: 9000 });
  await stub.close();

  // Nothing typed, nothing retired: an unread queue decided nothing at all.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/inject")).length, 0, out);
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/prompted")).length, 0, out);
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/asked")).length, 0, out);
  // ...and it did not decide it over and over. Ten fires in nine seconds was the
  // pre-fix signature; a correctly-bailing tick reports "nothing here" and sleeps
  // IDLE_MS, so nine seconds is a handful of passes at most.
  assert.ok(
    stub.calls.filter((c) => c.path.endsWith("/queue")).length <= 12,
    `queue read spun: ${stub.calls.filter((c) => c.path.endsWith("/queue")).length}\n${out}`,
  );

  // The session with an unanswered question was still triaged. `GET .../note` is
  // `processSession`'s idempotency read and nothing else on this path makes it, so it
  // is the honest witness that triage ran despite the broken queue route.
  assert.ok(
    stub.calls.some((c) => c.method === "GET" && c.path === "/api/sessions/s2/note"),
    `triage stalled behind the queue read\n${out}`,
  );
  assert.equal(
    stub.calls.some((c) => c.path === "/api/sessions/s3/note"),
    false,
    `operator-started Codex crossed the hook boundary\n${out}`,
  );
});

test("a changed-file chat retires before verification or shipping", async () => {
  const repo = tmp("pw-chat-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo, {
    task: mkTaskSummary({ kind: "chat", workflowId: null }),
  });
  let queue = mkQueue(repo);
  let retired = false;

  const stub = await startStub((_req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return {
        status: 200,
        json: [{ ...session, lastSeen: now, lastActivity: now - 120_000 }],
      };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: goalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/notes.txt b/notes.txt\n+conversation note\n",
          truncated: false,
          headSha: "chat-head",
        },
      };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as {
        goal: string;
        evidenceMarker: string;
        activityAt: number;
      };
      queue = {
        ...queue,
        promptedGoal: body.goal,
        promptedEvidence: body.evidenceMarker,
        promptedActivityAt: body.activityAt,
        updatedAt: Date.now(),
      };
      retired = true;
      return { status: 200, json: { ok: true } };
    }
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    // `until` ends this the moment the retire lands, so the ceiling only decides how long a
    // real hang takes to report. At 5s it was 1.3s of headroom over a run that takes 2.7 to
    // 3.7s on an idle machine, and it duly failed on a loaded one - reporting "the chat was
    // never retired" for a worker that simply had not got there yet. Every sibling case in
    // this file already sits at 20s or more.
    ms: 20_000,
    until: () => retired,
  });
  await stub.close();

  assert.equal(retired, true, out);
  assert.equal(stub.to("GET", "/api/sessions/s1/diff").length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/workflow-completion").length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/inject").length, 0, out);
  assert.equal(claudeCalls(fake.log).length, 0, out);
});

test("an explicit chat Workflow reaches ordinary verification and claims that Workflow", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo, {
    task: mkTaskSummary({ kind: "chat", workflowId: "workflow-review" }),
  });
  const stopAt = Date.now() - 120_000;
  // The row the worker's generation consume writes into. Serving it back proves the
  // durable lifecycle guard, rather than a short run, prevents a duplicate claim.
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: stopAt }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") {
      return { status: 200, json: goalRecord };
    }
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: "abc123",
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: {
          messages: [{ role: "user", text: GOAL, tools: [] }, { role: "assistant", text: "Added a retry.", tools: [] }],
          truncated: false,
        },
      };
    }
    if (p === "/api/sessions/s1/workflow-completion") {
      // The real daemon consumes the work-cycle generation in the same transaction that
      // claims completion. Mirror that durable effect for later worker ticks.
      const body = JSON.parse(raw) as { expectedWorkCycle: { generation: number } };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.expectedWorkCycle.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
      };
      return {
        status: 200,
        json: { claimed: true, runId: "run-review", submissionId: "sub-1", state: "started" },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
      };
      return { status: 200, json: { ok: true } };
    }
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: { ok: true } };
    if (p === "/api/sessions/s1/inject") return { status: 200, json: { ok: true } };
    return { status: 200, json: null };
  });

  const out = await runWorker({ port: stub.port, claudeBin: fake.bin, claudeLog: fake.log, ms: 12000 });
  await stub.close();

  const injects = stub.calls.filter((c) => c.path.endsWith("/inject"));
  const retires = stub.calls.filter((c) => c.path.endsWith("/wrapup/prompted"));
  const claims = stub.calls.filter((c) => c.path.endsWith("/workflow-completion"));
  assert.equal(claims.length, 1, `expected exactly one workflow claim\n${out}`);
  assert.equal(injects.length, 0, `Straight to PR ran beside the claimed Workflow\n${out}`);
  assert.equal(retires.length, 0, `retired outside the daemon's claim transaction\n${out}`);
  assert.equal(
    (claims[0]?.body as { fallbackWorkflow?: string } | undefined)?.fallbackWorkflow,
    undefined,
    `the worker named a workflow on its completion claim\n${out}`,
  );

  // The claim is downstream of Foreman's proof reads and verifier. It is not an eager
  // setting-side effect fired on every idle conversation.
  const transcript = stub.calls.find((c) => c.path === "/api/sessions/s1/transcript");
  assert.ok(transcript);
  assert.ok(
    stub.calls.indexOf(transcript) < stub.calls.indexOf(claims[0]!),
    `claimed before gathering completion evidence\n${out}`,
  );

  // The claimed path raises no Ship it? recovery card: the workflow owns this completion.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/asked")).length, 0, out);
  assert.equal(claudeCalls(fake.log).length, 1, `verified more than once\n${out}`);
  assert.equal(
    stub.to("GET", "/api/sessions/s1/diff").length,
    1,
    `the retired Stop kept gathering a full diff on idle ticks\n${out}`,
  );
  assert.equal(
    stub.to("GET", "/api/sessions/s1/transcript/size").length,
    1,
    `the retired Stop kept gathering transcript evidence on idle ticks\n${out}`,
  );
});

test("an empty diff consumes its generation without calling the verifier", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  let consumedAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") return { status: 200, json: cfg() };
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      return { status: 200, json: [{ ...session, lastSeen: Date.now() }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: goalRecord };
    if (p === "/api/sessions/s1/diff") {
      return { status: 200, json: { ok: true, patch: "", truncated: false, headSha: "abc" } };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = { ...queue, promptedConsumedGeneration: body.generation, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() };
      consumedAt = Date.now();
      return { status: 200, json: queue };
    }
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 20_000,
    until: () => consumedAt !== 0 && Date.now() - consumedAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  assert.equal(queue.promptedConsumedGeneration, 1, out);
  assert.equal(claudeCalls(fake.log).length, 0, `empty work spent a verifier call\n${out}`);
  assert.equal(stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted").length, 1, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/workflow-completion").length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/inject").length, 0, out);
});

test("direct wrap-up consumes the expected generation before injecting", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  let injectedAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      return { status: 200, json: [{ ...session, lastSeen: Date.now() }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: goalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: { ok: true, patch: "diff --git a/up.ts b/up.ts\n+retry();\n", truncated: false, headSha: "abc" },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/workflow-completion") {
      return { status: 200, json: { claimed: false, reason: "no_binding" } };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = { ...queue, promptedConsumedGeneration: body.generation, promptedDirectHandoff: null, promptedDecision: null, updatedAt: Date.now() };
      return { status: 200, json: queue };
    }
    if (p === "/api/sessions/s1/inject") {
      injectedAt = Date.now();
      return { status: 200, json: { ok: true } };
    }
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: queue };
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 20_000,
    until: () => injectedAt !== 0 && Date.now() - injectedAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  const consume = stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted");
  const inject = stub.to("POST", "/api/sessions/s1/inject");
  assert.equal(consume.length, 1, out);
  assert.equal(inject.length, 1, out);
  assert.ok(stub.calls.indexOf(consume[0]!) < stub.calls.indexOf(inject[0]!), "injected before consume");
  assert.equal(queue.promptedConsumedGeneration, 1);
  assert.equal(claudeCalls(fake.log).length, 1, out);
});

test("a direct handoff whose instruction never lands stops claiming it did", async () => {
  // Mark-before-inject cannot be undone: the latch is durable before anything types,
  // because a retried direct injection is the double push. So when the injection fails,
  // the stored reason is the only thing that can still tell the truth. It has to stop
  // saying the agent was handed the work - a later reader that believes it skips a session
  // that is in fact still sitting on the Ship it? card this same path raises.
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  let injectAttempts = 0;
  const undelivered: { logicalKey: string; generation: number }[] = [];

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      return { status: 200, json: [{ ...session, lastSeen: Date.now() }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: goalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: { ok: true, patch: "diff --git a/up.ts b/up.ts\n+retry();\n", truncated: false, headSha: "abc" },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/workflow-completion") {
      return { status: 200, json: { claimed: false, reason: "no_binding" } };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number; decision: { outcome: string } | null };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: null,
        promptedDecision: body.decision
          ? {
            logicalKey: queue.noteKey,
            generation: body.generation,
            outcome: body.decision.outcome as never,
            summary: "",
            gaps: [],
            decidedAt: Date.now(),
          }
          : null,
        updatedAt: Date.now(),
      };
      return { status: 200, json: queue };
    }
    // The failure this is all about. A daemon that cannot type into the session.
    if (p === "/api/sessions/s1/inject") {
      injectAttempts += 1;
      return { status: 500, json: { error: "the session went away" } };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted/undelivered") {
      const body = JSON.parse(raw) as { logicalKey: string; generation: number };
      undelivered.push(body);
      queue = {
        ...queue,
        promptedDecision: queue.promptedDecision
          ? { ...queue.promptedDecision, outcome: "direct_handoff_undelivered" }
          : null,
        updatedAt: Date.now(),
      };
      return { status: 200, json: queue };
    }
    if (p === "/api/sessions/s1/queue/wrapup/asked") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: queue };
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 20_000,
    until: () => undelivered.length > 0,
  });
  await stub.close();

  const consume = stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted");
  assert.equal(consume.length, 1, out);
  assert.equal(
    (consume[0]!.body as { decision: { outcome: string } }).decision.outcome,
    "direct_handoff",
    `the handoff was not recorded before the instruction was typed\n${out}`,
  );
  // Never retried. A retry IS the double push, and that is true whether or not the first
  // attempt actually reached the agent - which is exactly what a 500 leaves unknown.
  assert.equal(injectAttempts, 1, `the failed injection was retried\n${out}`);
  // The card, which is the actual recovery: the same text, one click away.
  assert.equal(stub.to("POST", "/api/sessions/s1/queue/wrapup/asked").length, 1, out);
  // And the correction, naming the generation it corrects.
  assert.deepEqual(undelivered, [{ logicalKey: queue.noteKey, generation: 1 }], out);
  assert.equal(queue.promptedDecision?.outcome, "direct_handoff_undelivered", out);
  // The generation stays consumed. Correcting the reason must never re-arm the trigger,
  // or the next tick types the instruction the failure was ambiguous about.
  assert.equal(queue.promptedConsumedGeneration, 1, out);
});

test("a direct shipping handoff fires once per human episode, and re-arms on the next", async () => {
  // THE REPORTED LOOP, end to end and across every real boundary it crossed.
  //
  // Human episode `intent:1:1` completes generation 1. Foreman verifies, consumes that
  // generation, records the direct handoff and types the Straight-to-PR instruction. The
  // agent then commits, pushes, opens a PR and follows CI - and PARKS, which completes
  // generation 2 under COMPLETELY UNCHANGED human intent, because the injected payload
  // arrives with origin `foreman` and is correctly excluded from the human-owned Goal.
  //
  // Every guard that existed before this fix is honestly re-armed at that point: the
  // generation moved, the intent did not, and the Goal text is the human's ask rather
  // than Foreman's payload, so the exact-payload loop guard finds nothing to match. The
  // trigger fired again and pushed a second time. The latch is what stops it, and the
  // last phase here proves it stops only THIS episode: a later accepted human prompt
  // resolving to `intent:2:2` must ship again.
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  // `intent:1:1` until the human types again, at which point `intent:2:2`.
  let episode: 1 | 2 = 1;
  // The durable work-cycle generation. The injected instruction advances it, exactly as
  // the agent's shipping turn does in production.
  let generation = 1;
  let completedAt = Date.now() - 120_000;
  const injectedPayloads: string[] = [];
  let firstInjectAt = 0;
  let secondInjectAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      return {
        status: 200,
        json: [{
          ...session,
          lastSeen: Date.now(),
          lastActivity: completedAt,
          workCycle: {
            logicalKey: "agent-1",
            generation,
            active: false,
            completedAt,
            updatedAt: completedAt,
          },
        }],
      };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") {
      // THE POINT OF #660, preserved: the Goal is the HUMAN's, in both episodes. The
      // Foreman payload injected below never becomes the objective, so nothing here can
      // be recognised by comparing Goal text against the wrap-up payload.
      return {
        status: 200,
        json: episode === 1
          ? goalRecord
          : {
              ...goalRecord,
              prompt: "now also add a metrics counter",
              focus: "Add a metrics counter",
              objective: `${GOAL} and add a metrics counter`,
              relationship: "amend",
              objectiveVersion: 2,
              promptRevision: 2,
              resolvedPromptRevision: 2,
            },
      };
    }
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: `sha-${generation}`,
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: generation * 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/workflow-completion") {
      return { status: 200, json: { claimed: false, reason: "no_binding" } };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number; directHandoff?: string | null };
      // The daemon's compare-and-consume boundary, modeled faithfully: the handoff is
      // stamped in the SAME write that consumes the generation, and a later consumption
      // never erases it.
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: body.directHandoff === "direct-ship"
          ? {
              kind: "direct-ship",
              episodeKey: `intent:${episode}:${episode}`,
              generation: body.generation,
            }
          : queue.promptedDirectHandoff,
        updatedAt: Date.now(),
      };
      return { status: 200, json: queue };
    }
    if (p === "/api/sessions/s1/inject") {
      injectedPayloads.push((JSON.parse(raw) as { text?: string }).text ?? "");
      if (injectedPayloads.length === 1) firstInjectAt = Date.now();
      else secondInjectAt = Date.now();
      // The instruction commits, pushes, opens the PR and follows CI, then the session
      // parks: a NEW completed generation, under unchanged human intent. This is the
      // turn every generation-keyed guard legitimately re-arms on.
      completedAt = Date.now();
      generation += 1;
      return { status: 200, json: { ok: true } };
    }
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: queue };
    return { status: 200, json: null };
  });

  // Phase one: ship once, then hold the worker open for a full idle cadence with the
  // shipping response's completed generation sitting there, armed as far as every other
  // guard is concerned. A second inject in this window is the bug.
  const first = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 25_000,
    until: () => firstInjectAt !== 0 && Date.now() - firstInjectAt >= IDLE_SETTLE_MS,
  });

  assert.equal(injectedPayloads.length, 1, `the direct instruction was typed twice\n${first}`);
  assert.equal(isWrapupPayload(injectedPayloads[0]!.trim()), true, first);
  assert.equal(generation, 2, "the injected instruction must complete a later generation");
  assert.deepEqual(
    queue.promptedDirectHandoff,
    { kind: "direct-ship", episodeKey: "intent:1:1", generation: 1 },
    "the handoff must be recorded against the intent episode that authorized it",
  );

  const consume = stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted");
  assert.equal(consume.length, 1, first);
  assert.equal(
    (consume[0]!.body as { directHandoff?: string }).directHandoff,
    "direct-ship",
    "the shipping consume must ask for the handoff stamp",
  );
  assert.ok(
    stub.calls.indexOf(consume[0]!) <
      stub.calls.indexOf(stub.to("POST", "/api/sessions/s1/inject")[0]!),
    "the handoff must be durable BEFORE anything types",
  );
  // The expensive half of the loop, and the one an operator actually pays for: the
  // second tick must not re-verify either. The latch is read in the pure decision,
  // above every evidence read and the model call.
  assert.equal(claudeCalls(fake.log).length, 1, `the shipping turn re-entered the verifier\n${first}`);
  assert.equal(stub.to("GET", "/api/sessions/s1/diff").length, 1, first);

  // Phase two: the human types again. That advances promptRevision, so the resolved
  // episode becomes `intent:2:2` - and completion re-arms with nothing clearing the
  // stored handoff. A restart is folded in here on purpose: the worker below is a fresh
  // process reading the same durable row, which is the only state that carries over.
  episode = 2;
  completedAt = Date.now();
  generation += 1;
  const second = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 25_000,
    until: () => secondInjectAt !== 0 && Date.now() - secondInjectAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  assert.equal(
    injectedPayloads.length,
    2,
    `a new human episode did not re-arm direct shipping\n${second}`,
  );
  assert.deepEqual(
    queue.promptedDirectHandoff,
    { kind: "direct-ship", episodeKey: "intent:2:2", generation: 3 },
    "the second handoff must latch its own episode",
  );
});

test("an incomplete prompted hold re-arms on a task-notification turn and claims one workflow", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false, completions: [false, true] });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  let phase: "first-stop" | "task-notification" | "later-stop" = "first-stop";
  const firstStopAt = Date.now() - 120_000;
  let laterStopAt = 0;
  let claimedAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      if (phase === "task-notification") {
        // Claude reports the background result through UserPromptSubmit, so lifecycle
        // state resumes even though scaffolding.ts correctly rejects it as a human goal.
        phase = "later-stop";
        laterStopAt = now;
        return {
          status: 200,
          json: [{
            ...session,
            state: "working",
            activity: "<task-notification><status>completed</status></task-notification>",
            lastSeen: now,
            lastActivity: now,
            workCycle: {
              logicalKey: "agent-1",
              generation: 2,
              active: true,
              completedAt: firstStopAt,
              updatedAt: now,
            },
          }],
        };
      }
      return {
        status: 200,
        json: [{
          ...session,
          state: "idle",
          activity: "idle",
          lastSeen: now,
          // Hook activity is a durable event timestamp, not a sliding clock. Keeping the
          // later Stop fixed proves the claimed boundary stays quiet on subsequent ticks.
          lastActivity: phase === "first-stop" ? firstStopAt : laterStopAt,
          workCycle: {
            logicalKey: "agent-1",
            generation: phase === "first-stop" ? 1 : 2,
            active: false,
            completedAt: phase === "first-stop" ? firstStopAt : laterStopAt,
            updatedAt: phase === "first-stop" ? firstStopAt : laterStopAt,
          },
        }],
      };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") {
      // The intent never advances. That is the production behavior under test: the
      // task-notification is automation, not a replacement objective from the human.
      return { status: 200, json: goalRecord };
    }
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: "abc123",
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") {
      return { status: 200, json: { size: phase === "first-stop" ? 100 : 200 } };
    }
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: {
          messages: phase === "first-stop"
            ? [{ role: "user", text: GOAL, tools: [] }, { role: "assistant", text: "Started the change.", tools: [] }]
            : [
                { role: "user", text: GOAL, tools: [] },
                { role: "assistant", text: "Started the change.", tools: [] },
                { role: "assistant", text: "The background work finished; the retry is complete.", tools: [] },
              ],
          truncated: false,
        },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
      };
      phase = "task-notification";
      return { status: 200, json: queue };
    }
    if (p === "/api/sessions/s1/workflow-completion") {
      const body = JSON.parse(raw) as { expectedWorkCycle: { generation: number } };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.expectedWorkCycle.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
      };
      claimedAt = Date.now();
      return {
        status: 200,
        json: { claimed: true, runId: "run-review", submissionId: "sub-1", state: "started" },
      };
    }
    if (p === "/api/sessions/s1/inject") return { status: 200, json: { ok: true } };
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 30_000,
    until: () => claimedAt !== 0 && Date.now() - claimedAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  const holds = stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted");
  const claims = stub.to("POST", "/api/sessions/s1/workflow-completion");
  assert.equal(holds.length, 1, `the incomplete Stop was not retired exactly once\n${out}`);
  assert.equal(claims.length, 1, `the later Stop did not claim exactly one binding\n${out}`);
  assert.equal(
    (holds[0]!.body as { generation?: number }).generation,
    1,
    "the held guard must consume the completed generation it examined",
  );
  assert.equal(
    (claims[0]!.body as { expectedWorkCycle?: { generation: number } }).expectedWorkCycle?.generation,
    2,
    "the workflow claim must consume the later completed generation",
  );
  assert.equal(claudeCalls(fake.log).length, 2, `unchanged evidence re-entered the verifier\n${out}`);
  assert.equal(
    stub.to("GET", "/api/sessions/s1/diff").length,
    2,
    `idle ticks gathered more than the two settled completion boundaries\n${out}`,
  );
  assert.equal(
    stub.to("GET", "/api/sessions/s1/transcript/size").length,
    2,
    `idle ticks gathered extra transcript anchors\n${out}`,
  );
  assert.equal(queue.promptedConsumedGeneration, 2, "the later generation is durably consumed");
  assert.equal(
    stub.calls.filter((call) => call.path.endsWith("/inject")).length,
    0,
    `Straight to PR raced the existing Foreman-complete binding\n${out}`,
  );
});

test("work restarting during verification discards the verdict without consuming either generation", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  const completedAt = Date.now() - 120_000;
  let restarted = false;
  let verifierStartedAt = 0;
  const queue = mkQueue(repo);

  const stub = await startStub((req, url) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") return { status: 200, json: cfg() };
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return {
        status: 200,
        json: [{
          ...session,
          state: restarted ? "working" : "idle",
          activity: restarted ? "running Bash" : "idle",
          lastSeen: now,
          lastActivity: restarted ? now : completedAt,
          workCycle: restarted
            ? { logicalKey: "agent-1", generation: 2, active: true, completedAt, updatedAt: now }
            : session.workCycle,
        }],
      };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: goalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: { ok: true, patch: "diff --git a/up.ts b/up.ts\n+retry();\n", truncated: false, headSha: "abc" },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") {
      // This read is immediately before the verifier call. Model a hook that starts
      // generation 2 while the verifier is evaluating generation 1.
      restarted = true;
      verifierStartedAt = Date.now();
      return { status: 200, json: { docs: [], truncated: false } };
    }
    return { status: 200, json: null };
  });

  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 20_000,
    until: () => verifierStartedAt !== 0 && Date.now() - verifierStartedAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  assert.equal(claudeCalls(fake.log).length, 1, `the stale generation was re-verified\n${out}`);
  assert.equal(stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted").length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/workflow-completion").length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/inject").length, 0, out);
  assert.equal(queue.promptedConsumedGeneration, null, "neither generation was consumed");
});

test("a Manual binding blocks Straight to PR and a failed card write stays retryable", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  const stopAt = Date.now() - 120_000;
  let queue = mkQueue(repo);
  let promptedWrites = 0;
  /** When the retry landed, so the worker can be given a full idle cadence past it. */
  let retriedAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: stopAt }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") {
      return { status: 200, json: goalRecord };
    }
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: "abc123",
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: {
          messages: [{ role: "user", text: GOAL, tools: [] }, { role: "assistant", text: "Added a retry.", tools: [] }],
          truncated: false,
        },
      };
    }
    if (p === "/api/sessions/s1/workflow-completion") {
      return { status: 200, json: { claimed: false, reason: "manual_trigger" } };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      promptedWrites += 1;
      if (promptedWrites === 1) return { status: 500, json: { error: "temporary write failure" } };
      if (promptedWrites === 2) retriedAt = Date.now();
      const body = JSON.parse(raw) as {
        generation: number;
        ask?: boolean;
      };
      assert.equal(body.ask, true, "the guard and Ship it? card must share one write");
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
        wrapupAskedAt: Date.now(),
        wrapupAnswer: null,
      };
      return { status: 200, json: queue };
    }
    if (p === "/api/sessions/s1/queue/wrapup/asked") {
      return { status: 500, json: { error: "the split card endpoint must not be used" } };
    }
    return { status: 200, json: null };
  });

  // Waits FOR the retry rather than for a stopwatch. The old 9s budget had to cover a Node
  // + tsx boot, the lease, one tick to fail the write, a full `IDLE_MS` (4s) sleep, and then
  // the retry - roughly two seconds of slack on an idle machine and none on a busy one, so a
  // retry that was merely LATE was reported as a retry that never happened. The deadline is
  // now a backstop, and the run still outlives the retry by a full idle cadence, which is the
  // window a third write would have to appear in for `=== 2` to mean "exactly once".
  const out = await runWorker({
    port: stub.port,
    claudeBin: fake.bin,
    claudeLog: fake.log,
    ms: 30_000,
    until: () => retriedAt !== 0 && Date.now() - retriedAt >= IDLE_SETTLE_MS,
  });
  await stub.close();

  assert.equal(promptedWrites, 2, `the failed atomic handoff was not retried once\n${out}`);
  assert.equal(
    stub.calls.filter((call) => call.path.endsWith("/wrapup/asked")).length,
    0,
    `used the non-atomic card endpoint\n${out}`,
  );
  assert.equal(queue.promptedConsumedGeneration, 1, `the successful retry did not consume the generation\n${out}`);
  assert.ok(queue.wrapupAskedAt, `the successful retry did not raise the Ship it? card\n${out}`);
  assert.equal(
    stub.calls.filter((call) => call.path.endsWith("/inject")).length,
    0,
    `Straight to PR ran beside a bound Workflow\n${out}`,
  );
  assert.equal(claudeCalls(fake.log).length, 2, `the failed handoff did not retry exactly once\n${out}`);
});

test("a broken verifier gives up after the strike cap, at one strike per unhurried tick", async () => {
  // Two regressions in one run, because they are the same mistake seen from both ends:
  //
  //  - A failed verify used to return `advanced: true`. The loop reads that as "there
  //    is work here", skips its IDLE_MS sleep and comes straight back after BETWEEN_MS
  //    - so a broken verifier burned a `claude -p` every 400ms. The elapsed-time
  //    assertion is what catches it: pre-fix, the cap was reached in 4.6s.
  //  - Without `PromptedFailureTracker` the retries were unbounded, so it never gave up
  //    at all. The exact-count assertion is what catches that one.
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: true });
  const session = mkSession(repo);
  const stopAt = Date.now() - 120_000;
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") return { status: 200, json: cfg() };
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: stopAt }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") {
      return { status: 200, json: goalRecord };
    }
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: { ok: true, patch: "diff --git a/up.ts b/up.ts\n+retry();\n", truncated: false, headSha: "abc" },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDirectHandoff: null,
        promptedDecision: null,
        updatedAt: Date.now(),
      };
      return { status: 200, json: { ok: true } };
    }
    return { status: 200, json: null };
  });

  // Long enough for the cap (three ticks ~4s apart) plus room for a fourth that must
  // not happen.
  const out = await runWorker({ port: stub.port, claudeBin: fake.bin, claudeLog: fake.log, ms: 20000 });
  await stub.close();

  const calls = claudeCalls(fake.log);
  assert.equal(
    calls.length,
    VERIFY_FAILURE_CAP,
    `expected exactly ${VERIFY_FAILURE_CAP} attempts, got ${calls.length}\n${out}`,
  );
  // Each strike is its own unhurried tick. The pre-fix hot loop packed all three into
  // well under a second, so this is the assertion that fails when the `advanced` flag
  // starts lying again.
  const spread = calls[calls.length - 1]! - calls[0]!;
  assert.ok(spread > 5000, `strikes were not spaced by IDLE_MS (spread ${spread}ms)\n${out}`);

  // At the cap the episode is retired durably, so a worker restart does not start the
  // whole thing over.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/prompted")).length, 1, out);
  // Nothing was typed on the way: a verifier that never answered is not a verdict.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/inject")).length, 0, out);

  // And the retirement says WHY, in the one word that keeps a later recovery honest:
  // `verification_failed`, never `held`. A hold is a model's verdict that the work is
  // unfinished; this is the verifier infrastructure giving up, and nobody judged this
  // work at all - so there are no gaps to send back and none are recorded.
  const decision = (stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted")[0]?.body as {
    decision?: { outcome: string; gaps: unknown[] };
  }).decision;
  assert.equal(decision?.outcome, "verification_failed", out);
  assert.deepEqual(decision?.gaps ?? [], [], out);
});

/**
 * A `claude -p` stand-in that judges the PROMPT, the way the real verifier judges the
 * objective it is given.
 *
 * This is what makes the reported deadlock reproducible without a model: the objective it
 * is asked about demands a pull request, so the answer is "incomplete, no PR" UNLESS the
 * prompt also carries the trusted boundary saying Mission Control deferred that work. Run
 * against a build with no contract, the ship regression test below fails exactly the way
 * the incident did - one silent hold, no workflow run, generation spent.
 */
function mkBoundaryAwareClaude(): { bin: string; log: string; prompt: string } {
  const dir = tmp("fake-claude-boundary-");
  const log = join(dir, "calls.log");
  const prompt = join(dir, "prompt.txt");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const text = Buffer.concat(chunks).toString("utf8");
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, Date.now() + "\\n");
  fs.writeFileSync(${JSON.stringify(prompt)}, text);
  const deferred = text.includes("Trusted completion boundary")
    && text.includes("creating or updating a pull request");
  process.stdout.write(JSON.stringify({ result: JSON.stringify(deferred
    ? { complete: true, summary: "the retry is implemented and tested", gaps: [] }
    : {
        complete: false,
        summary: "the objective asks for a pull request and none was opened",
        gaps: [{
          id: "no-pull-request",
          severity: "blocking",
          kind: "incomplete",
          path: "",
          detail: "the objective asks for a reviewable pull request and none exists",
          fix: "open the pull request",
        }],
      }) }));
});
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  return { bin, log, prompt };
}

/** The PR-demanding objective a dispatched ship task actually carries. */
const SHIP_GOAL = "make the uploader retry on a 500, then open a reviewable pull request";
const shipGoalRecord = { ...goalRecord, objective: SHIP_GOAL, prompt: SHIP_GOAL, focus: SHIP_GOAL };

test("a ship objective that demands a PR still completes at the delivered boundary, and claims one workflow", async () => {
  // THE REPORTED DEADLOCK, end to end. Every dispatched ship task is told to stop before
  // commit, push, PR and CI; its objective still says "open a reviewable pull request".
  // Before the trusted boundary reached the verifier, the verdict was a correct-by-its-own-
  // lights "incomplete", the hold spent the completed generation, no run was ever created,
  // and every later tick skipped the generation as already handled.
  const repo = tmp("pw-repo-");
  const fake = mkBoundaryAwareClaude();
  const session = mkSession(repo, {
    task: mkTaskSummary({ kind: "ship", workflowId: "workflow-review" }),
  });
  const stopAt = Date.now() - 120_000;
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: stopAt }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: shipGoalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: "abc123",
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: {
          messages: [{ role: "user", text: SHIP_GOAL, tools: [] }],
          truncated: false,
        },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/workflow-completion") {
      const body = JSON.parse(raw) as { expectedWorkCycle: { generation: number } };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.expectedWorkCycle.generation,
        // The real daemon writes `workflow_claimed` inside this same transaction; the
        // stub mirrors the durable effect so later ticks see a spent generation.
        promptedDecision: {
          logicalKey: "agent-1",
          generation: body.expectedWorkCycle.generation,
          outcome: "workflow_claimed",
          summary: "claimed",
          gaps: [],
          decidedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      return {
        status: 200,
        json: { claimed: true, runId: "run-review", submissionId: "sub-1", state: "started" },
      };
    }
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as { generation: number };
      queue = { ...queue, promptedConsumedGeneration: body.generation, updatedAt: Date.now() };
      return { status: 200, json: { ok: true } };
    }
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: { ok: true } };
    if (p === "/api/sessions/s1/inject") return { status: 200, json: { ok: true } };
    return { status: 200, json: null };
  });

  const out = await runWorker({ port: stub.port, claudeBin: fake.bin, claudeLog: fake.log, ms: 12000 });
  await stub.close();

  // The boundary is delivered as POLICY, above the untrusted evidence, and it is resolved
  // from the durable task kind - not read out of the transcript, which carries none of it.
  const prompt = readFileSync(fake.prompt, "utf8");
  const boundary = prompt.indexOf("## Trusted completion boundary");
  assert.ok(boundary > 0, `the verifier never saw the ship completion boundary\n${out}`);
  assert.ok(
    boundary < prompt.indexOf("BEGIN UNTRUSTED EVIDENCE"),
    `the boundary was rendered as evidence rather than as policy\n${out}`,
  );
  assert.ok(prompt.includes(SHIP_GOAL), "the objective is unchanged - it is not rewritten");

  const claims = stub.to("POST", "/api/sessions/s1/workflow-completion");
  assert.equal(claims.length, 1, `expected exactly one workflow claim\n${out}`);
  assert.equal(
    stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted").length,
    0,
    `the generation was spent outside the claim transaction\n${out}`,
  );
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/inject")).length, 0, out);
  assert.equal(claudeCalls(fake.log).length, 1, `verified more than once\n${out}`);
});

test("a genuinely unfinished ship task still holds, and the hold's reason survives the consume", async () => {
  // The other half of the boundary: deferring the pull request must not defer anything
  // else. This verifier answers incomplete for a reason that has nothing to do with the
  // PR, so the hold stands - and now says what it believed was missing, which is the state
  // the incident had no record of.
  const repo = tmp("pw-repo-");
  const dir = tmp("fake-claude-incomplete-");
  const log = join(dir, "calls.log");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, Date.now() + "\\n");
  process.stdout.write(JSON.stringify({ result: JSON.stringify({
    complete: false,
    summary: "the retry path has no test",
    gaps: [
      { id: "retry-untested", severity: "blocking", kind: "untested", path: "src/up.ts",
        detail: "no test covers the 500 retry", fix: "add a focused test" },
      { id: "naming-nit", severity: "advisory", kind: "standards", path: "src/up.ts",
        detail: "the helper could be named better", fix: "rename it" },
    ],
  }) }));
});
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, "");

  const session = mkSession(repo, { task: mkTaskSummary({ kind: "ship", workflowId: null }) });
  const stopAt = Date.now() - 120_000;
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "pr" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: stopAt }] };
    }
    if (p === "/api/reviews") return { status: 200, json: [] };
    if (p === "/api/queues") return { status: 200, json: [] };
    if (p === "/api/sessions/s1/queue") return { status: 200, json: queue };
    if (p === "/api/sessions/s1/goal") return { status: 200, json: shipGoalRecord };
    if (p === "/api/sessions/s1/diff") {
      return {
        status: 200,
        json: {
          ok: true,
          patch: "diff --git a/up.ts b/up.ts\n+retry();\n",
          truncated: false,
          headSha: "abc123",
        },
      };
    }
    if (p === "/api/sessions/s1/transcript/size") return { status: 200, json: { size: 100 } };
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: SHIP_GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      const body = JSON.parse(raw) as {
        generation: number;
        decision?: { outcome: string; summary: string; gaps: { id: string }[] };
      };
      queue = {
        ...queue,
        promptedConsumedGeneration: body.generation,
        promptedDecision: body.decision
          ? {
            logicalKey: "agent-1",
            generation: body.generation,
            outcome: body.decision.outcome as "held",
            summary: body.decision.summary,
            gaps: body.decision.gaps as { id: string; path: string; detail: string }[],
            decidedAt: Date.now(),
          }
          : null,
        updatedAt: Date.now(),
      };
      return { status: 200, json: { ok: true } };
    }
    if (p === "/api/sessions/s1/queue/wrapup") return { status: 200, json: { ok: true } };
    if (p === "/api/sessions/s1/inject") return { status: 200, json: { ok: true } };
    return { status: 200, json: null };
  });

  const out = await runWorker({ port: stub.port, claudeBin: bin, claudeLog: log, ms: 12000 });
  await stub.close();

  const consumes = stub.to("POST", "/api/sessions/s1/queue/wrapup/prompted");
  assert.equal(consumes.length, 1, `expected exactly one consumed generation\n${out}`);
  const decision = (consumes[0]!.body as {
    decision?: { outcome: string; summary: string; gaps: { id: string; detail: string }[] };
  }).decision;
  assert.equal(decision?.outcome, "held", out);
  assert.ok(decision?.summary, "a hold with no reason is the state this phase removes");
  // BLOCKING gaps only: an advisory nit is by definition something the request did not
  // depend on, and storing one would put "rename this" in front of a later recovery as a
  // reason the task is stuck.
  assert.deepEqual(decision?.gaps.map((g) => g.id), ["retry-untested"], out);

  // Still quiet. This phase records the reason; it types nothing back.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/inject")).length, 0, out);
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/asked")).length, 0, out);
  assert.equal(stub.to("POST", "/api/sessions/s1/workflow-completion").length, 0, out);
});
