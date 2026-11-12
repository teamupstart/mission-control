import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "new-session.mjs");
const fixture = mkdtempSync(join(tmpdir(), "mission-new-session-"));

after(() => rmSync(fixture, { recursive: true, force: true }));

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: readonly string[], port: number): Promise<ScriptResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        ...process.env,
        MISSION_PORT: String(port),
        MISSION_WORKTREE_SKIP_INSTALL: "1",
        TREEHOUSE_LEASE_HOLDER: "legacy-holder-must-not-leak",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()));
}

function gitRepo(name: string): string {
  const path = join(fixture, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "manual session\n");
  execFileSync("git", ["-C", path, "add", "-A"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return realpathSync(path);
}

test("make session acquires, warms, exports native identity, and leaves the lease durable", async () => {
  const worktree = gitRepo("manual-worktree");
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: worktree, leaseId: "manual-lease-1", baseSha: "a".repeat(40) }));
    });
  });
  const port = await listen(server);
  try {
    const result = await runScript([
      "--label",
      "review work",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),path:process.env.MISSION_WORKTREE,lease:process.env.MISSION_WORKTREE_LEASE_ID,legacy:process.env.TREEHOUSE_LEASE_HOLDER}))",
    ], port);

    assert.equal(result.code, 0);
    assert.equal(requests.length, 1, "exiting the command must not implicitly return the lease");
    assert.equal(requests[0]?.path, "/api/worktrees/manual/acquire");
    assert.equal(requests[0]?.body.repositoryPath, root);
    assert.equal(requests[0]?.body.label, "review work");
    assert.match(result.stdout, /preparing worktree/);
    const environment = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    assert.equal(environment.cwd, worktree);
    assert.equal(environment.path, worktree);
    assert.equal(environment.lease, "manual-lease-1");
    assert.equal(environment.legacy, undefined);
    assert.match(result.stderr, /still leased to you/);
    assert.match(result.stderr, /--return-lease manual-lease-1/);
    assert.match(result.stderr, /Settings > Worktrees/);
  } finally {
    await close(server);
  }
});

test("make session returns an exact manual lease by durable ID through either CLI spelling", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await listen(server);
  try {
    assert.equal((await runScript(["--return", "manual-lease-2"], port)).code, 0);
    assert.equal((await runScript(["--return-lease", "manual-lease-2"], port)).code, 0);
    assert.deepEqual(requests, [
      { path: "/api/worktrees/manual/return", body: { leaseId: "manual-lease-2" } },
      { path: "/api/worktrees/manual/return", body: { leaseId: "manual-lease-2" } },
    ]);
  } finally {
    await close(server);
  }
});

test("make session refuses allocation when the daemon is unavailable", async () => {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);

  const result = await runScript([], port);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Mission Control is not running/);
  assert.match(result.stderr, /make up.*make dev.*application/);
  assert.doesNotMatch(result.stderr, /treehouse/);
});

/**
 * A daemon whose pool has a claim: the acquire answers 202, and each poll of the request is
 * answered by the next entry of `polls` (the last one repeats).
 */
function claimingDaemon(polls: ReadonlyArray<{ status: number; body: unknown }>) {
  const requests: Array<{ method: string; path: string; at: number }> = [];
  let served = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ method: request.method ?? "", path: request.url ?? "", at: Date.now() });
      if (request.method === "POST" && request.url === "/api/worktrees/manual/acquire") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ requestId: "request-1", baseSha: "a".repeat(40) }));
        return;
      }
      const answer = polls[Math.min(served, polls.length - 1)]!;
      served += 1;
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  return { server, requests };
}

const PRINT_LEASE = [
  "--",
  process.execPath,
  "-e",
  "console.log(JSON.stringify({cwd:process.cwd(),lease:process.env.MISSION_WORKTREE_LEASE_ID}))",
];

test("make session polls a 202 acquire every two seconds, printing the step and elapsed time, until granted", async () => {
  const worktree = gitRepo("claimed-worktree");
  const step = { step: 1, stepCount: 2, command: "yarn install --immutable", elapsedMs: 1_000 };
  const { server, requests } = claimingDaemon([
    { status: 200, body: { requestId: "request-1", state: "claiming", elapsedMs: 400, step: null } },
    { status: 200, body: { requestId: "request-1", state: "claiming", elapsedMs: 2_400, step } },
    {
      status: 200,
      body: {
        requestId: "request-1",
        state: "granted",
        elapsedMs: 75_000,
        lease: { path: worktree, leaseId: "manual-lease-claimed", baseSha: "a".repeat(40) },
        claimWarning: {
          step: 2,
          stepCount: 2,
          command: "yarn rebuild",
          reason: "exited with code 1",
          tail: "building esbuild\nYN0009: build failed\n",
          truncatedBytes: 0,
        },
      },
    },
  ]);
  const port = await listen(server);
  try {
    const result = await runScript(PRINT_LEASE, port);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map((entry) => `${entry.method} ${entry.path}`), [
      "POST /api/worktrees/manual/acquire",
      "GET /api/worktrees/manual/requests/request-1",
      "GET /api/worktrees/manual/requests/request-1",
      "GET /api/worktrees/manual/requests/request-1",
    ]);
    const polls = requests.slice(1).map((entry) => entry.at);
    for (let i = 1; i < polls.length; i++) {
      assert.ok(polls[i]! - polls[i - 1]! >= 1_900, `polls two seconds apart, got ${polls[i]! - polls[i - 1]!} ms`);
    }
    assert.match(result.stderr, /preparing the worktree · 0:00 elapsed/);
    assert.match(result.stderr, /installing dependencies: step 1 of 2 \(yarn install --immutable\) · 0:02 elapsed/);
    assert.match(result.stderr, /the dependency claim failed: step 2 of 2 \(yarn rebuild\) exited with code 1/);
    assert.match(result.stderr, /^ {3}YN0009: build failed$/m);
    assert.match(result.stderr, /The worktree is yours anyway/);
    const environment = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    assert.equal(environment.cwd, worktree);
    assert.equal(environment.lease, "manual-lease-claimed");
  } finally {
    await close(server);
  }
});

test("make session reports a failed 202 acquire with the daemon's reason", async () => {
  const { server } = claimingDaemon([
    {
      status: 200,
      body: {
        requestId: "request-1",
        state: "failed",
        elapsedMs: 10,
        outcome: "notAcquired",
        reason: "native pool capacity 2 is exhausted",
      },
    },
  ]);
  const port = await listen(server);
  try {
    const result = await runScript(PRINT_LEASE, port);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /native pool capacity 2 is exhausted/);
    assert.equal(result.stdout, "", "nothing was launched");
  } finally {
    await close(server);
  }
});

test("make session reports a 404 after a 202 as a daemon restart during the claim", async () => {
  const { server } = claimingDaemon([
    { status: 200, body: { requestId: "request-1", state: "claiming", elapsedMs: 10, step: null } },
    { status: 404, body: { error: "manual acquire request was not found" } },
  ]);
  const port = await listen(server);
  try {
    const result = await runScript(PRINT_LEASE, port);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Mission Control restarted while it was installing this worktree's dependencies/);
    assert.match(result.stderr, /run make session again/);
    assert.equal(result.stdout, "", "nothing was launched");
  } finally {
    await close(server);
  }
});

// Bounded, because the regression this guards against is a poll that never returns.
test("make session abandons a status poll the daemon accepts but never answers, and polls again", { timeout: 45_000 }, async () => {
  const worktree = gitRepo("stalled-poll-worktree");
  const polls: Array<{ at: number; abandoned: boolean }> = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ requestId: "request-1", baseSha: "a".repeat(40) }));
        return;
      }
      const poll = { at: Date.now(), abandoned: false };
      polls.push(poll);
      response.on("close", () => { poll.abandoned = !response.writableEnded; });
      if (polls.length === 1) return; // Accepted, never answered: no headers at all.
      if (polls.length === 2) {
        // Headers, then a body that never finishes.
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"requestId":"request-1","state":');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        requestId: "request-1",
        state: "granted",
        elapsedMs: 20_000,
        lease: { path: worktree, leaseId: "manual-lease-after-stall", baseSha: "a".repeat(40) },
      }));
    });
  });
  const port = await listen(server);
  try {
    const result = await runScript(PRINT_LEASE, port);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(polls.length, 3, "each stalled poll was given up on and the next one sent");
    assert.deepEqual(polls.map((poll) => poll.abandoned), [true, true, false]);
    for (const i of [1, 2]) {
      const gap = polls[i]!.at - polls[i - 1]!.at;
      // The five-second poll deadline, then the two-second interval: bounded, never left open.
      assert.ok(gap >= 6_500 && gap < 12_000, `poll ${i + 1} followed a stalled poll after ${gap} ms`);
    }
    const environment = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    assert.equal(environment.lease, "manual-lease-after-stall");
    // A body cut off by the deadline is no answer at all, never an empty "still preparing" one.
    assert.doesNotMatch(result.stderr, /preparing the worktree/);
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});
