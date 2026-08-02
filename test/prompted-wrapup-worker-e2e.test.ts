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
import type { Session, SessionQueue } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

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
function mkFakeClaude(opts: { fail: boolean }): { bin: string; log: string } {
  const dir = tmp("fake-claude-");
  const log = join(dir, "calls.log");
  const bin = join(dir, "claude");
  const body = opts.fail
    ? `process.stderr.write("the model is broken"); process.exit(1);`
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
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: { text: "Add retry handling.", source: "model", updatedAt: now },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
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
    updatedAt: 0,
    items: [],
    ...over,
  };
}

const GOAL = "make the uploader retry on a 500";
const INTENT_KEY = "intent:1:1";
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
  // the overlap rule and the once-per-episode `promptedGoal` - and the worker fired a
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

test("a verified prompt binds the review workflow exactly once without typing a command", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  // The row the worker's own `markPromptedWrapup` writes into. Serving it back is what
  // arms the once-per-episode guard, so "fires exactly once" is a real assertion about
  // the re-arm rather than an artefact of a short run.
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "workflow" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: now - 120_000 }] };
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
      // The real daemon retires the prompted guard in the same transaction that claims
      // the completion. Mirror that durable effect so later worker ticks see the episode
      // as spent and prove this path does not request a second run.
      queue = { ...queue, promptedGoal: INTENT_KEY };
      return {
        status: 200,
        json: { claimed: true, runId: "run-review", submissionId: "sub-1", state: "started" },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      queue = { ...queue, promptedGoal: (JSON.parse(raw) as { goal: string }).goal };
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
  assert.equal(injects.length, 0, `typed the skill after the workflow claimed completion\n${out}`);
  assert.equal(retires.length, 0, `retired outside the daemon's claim transaction\n${out}`);
  assert.equal(
    (claims[0]?.body as { fallbackWorkflow?: string } | undefined)?.fallbackWorkflow,
    "builtin-review",
    out,
  );

  // The binding request is downstream of Foreman's proof reads and verifier. It is not
  // an eager setting-side effect on every idle unbound conversation.
  const transcript = stub.calls.find((c) => c.path === "/api/sessions/s1/transcript");
  assert.ok(transcript);
  assert.ok(
    stub.calls.indexOf(transcript) < stub.calls.indexOf(claims[0]!),
    `claimed before gathering completion evidence\n${out}`,
  );

  // The claimed path raises no Ship it? recovery card: the workflow owns this completion.
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/wrapup/asked")).length, 0, out);
  assert.equal(claudeCalls(fake.log).length, 1, `verified more than once\n${out}`);
});

test("a failed Manual-binding card write leaves the prompted completion retryable", async () => {
  const repo = tmp("pw-repo-");
  const fake = mkFakeClaude({ fail: false });
  const session = mkSession(repo);
  let queue = mkQueue(repo);
  let promptedWrites = 0;
  /** When the retry landed, so the worker can be given a full idle cadence past it. */
  let retriedAt = 0;

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") {
      return { status: 200, json: cfg({ mode: "live", repoAllowlist: [repo], wrapup: "workflow" }) };
    }
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: now - 120_000 }] };
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
      const body = JSON.parse(raw) as { goal: string; ask?: boolean };
      assert.equal(body.ask, true, "the guard and Ship it? card must share one write");
      queue = {
        ...queue,
        promptedGoal: body.goal,
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
  assert.equal(queue.promptedGoal, INTENT_KEY, `the successful retry did not retire the episode\n${out}`);
  assert.ok(queue.wrapupAskedAt, `the successful retry did not raise the Ship it? card\n${out}`);
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
  let queue = mkQueue(repo);

  const stub = await startStub((req, url, raw) => {
    const p = url.pathname;
    if (p === "/api/foreman/config") return { status: 200, json: cfg() };
    if (p === "/api/foreman/heartbeat") return { status: 200, json: { leader: true } };
    if (p === "/api/sessions") {
      const now = Date.now();
      return { status: 200, json: [{ ...session, lastSeen: now, lastActivity: now - 120_000 }] };
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
    if (p === "/api/sessions/s1/transcript") {
      return {
        status: 200,
        json: { messages: [{ role: "user", text: GOAL, tools: [] }], truncated: false },
      };
    }
    if (p === "/api/sessions/s1/standards") return { status: 200, json: { docs: [], truncated: false } };
    if (p === "/api/sessions/s1/queue/wrapup/prompted") {
      queue = { ...queue, promptedGoal: (JSON.parse(raw) as { goal: string }).goal };
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
});
