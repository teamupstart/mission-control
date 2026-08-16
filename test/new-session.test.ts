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
