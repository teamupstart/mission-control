import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Resolves no state home, so importing it ahead of the home set below is safe.
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

// Startup removes every Warm log that no slot row names, and keeps the ones a slot row does.
// No Warm survives a restart, so at startup "no live operation" is always true. This launches
// the real daemon on a state directory seeded by this file, rather than calling the sweep
// directly, so the startup wiring itself is what is proven.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOT_TIMEOUT_MS = 45_000;
const fixtureRoot = mkdtempSync(join(tmpdir(), "mission-warm-startup-"));
const state = join(fixtureRoot, "state");
mkdirSync(state, { recursive: true });
// This file's own home, set before anything can resolve one, so the seeding below writes the
// daemon's database rather than this worker's disposable one.
process.env.HARNESS_HOME = state;

const { closeDb, openDb } = await import("../src/server/db.ts");
const { WorktreeStore } = await import("../src/server/worktrees/store.ts");
const { WORKTREE_WARM_LOGS_DIR } = await import("../src/server/config.ts");

ensureNativeStateLockAddon();

async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function health(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/api/health" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? null));
    }).on("error", () => resolve(null));
  });
}

test("daemon startup removes the Warm logs no slot row names and keeps the one a slot row names", {
  timeout: BOOT_TIMEOUT_MS + 20_000,
}, async () => {
  assert.equal(WORKTREE_WARM_LOGS_DIR, join(state, "logs", "worktree-warm"));
  mkdirSync(WORKTREE_WARM_LOGS_DIR, { recursive: true });
  const named = join(WORKTREE_WARM_LOGS_DIR, "named-op.log");
  const orphan = join(WORKTREE_WARM_LOGS_DIR, "orphan-op.log");
  const unrelated = join(WORKTREE_WARM_LOGS_DIR, "notes.txt");
  for (const path of [named, orphan, unrelated]) writeFileSync(path, "left by the previous daemon\n");

  // A slot row naming one of them, as a Warm that ran before the restart leaves it.
  const store = new WorktreeStore(openDb());
  const pool = store.ensurePool({
    id: "pool-startup",
    gitCommonDirectory: join(fixtureRoot, "repo", ".git"),
    mainCheckoutRoot: join(fixtureRoot, "repo"),
    poolPath: join(state, "worktree-pools", "repo-0000000000000000"),
    now: 1,
  });
  const slot = store.reserveNew({
    poolId: pool.id,
    maxSlots: 4,
    id: "slot-startup",
    pathForOrdinal: (ordinal) => join(pool.poolPath, String(ordinal), "repo"),
    leaseId: "lease-startup",
    ownerKind: "manual",
    ownerKey: "startup",
    requestedHeadSha: "a".repeat(40),
    now: 1,
  });
  assert.ok(slot);
  openDb().prepare("UPDATE worktree_slots SET deps_log_path = ? WHERE id = ?").run(named, slot.id);
  closeDb();

  const fakeBin = join(fixtureRoot, "fake-external.mjs");
  writeFileSync(fakeBin, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('0.0.0-test');\n");
  chmodSync(fakeBin, 0o700);
  const port = await freeLoopbackPort();
  // This child is the daemon, not a test worker: drop the runner markers and inherited homes,
  // then point it at the state directory seeded above.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["NODE_TEST_CONTEXT", "MISSION_TEST_STATE", "HARNESS_HOME", "FLEET_HOME", "MISSION_HOME"]) delete env[key];
  Object.assign(env, {
    HOME: fixtureRoot,
    CODEX_HOME: join(fixtureRoot, ".codex"),
    MISSION_HOME: state,
    MISSION_PORT: String(port),
    MISSION_WEB_DIR: join(fixtureRoot, "missing-web"),
    MISSION_WORKSPACE_DIRS: join(fixtureRoot, "workspace"),
    MISSION_POLL_MS: "0",
    MISSION_WORKTREE_SWEEP_MS: "0",
    MISSION_CLAUDE_BIN: fakeBin,
    MISSION_CODEX_BIN: fakeBin,
    MISSION_PI_BIN: fakeBin,
    MISSION_GH_BIN: fakeBin,
    MISSION_KEEP_AWAKE_BIN: fakeBin,
    MISSION_CONDUCTOR_BIN: fakeBin,
    AI_CONDUCTOR_REGISTRY: join(fixtureRoot, "conductor-registry.json"),
    MISSION_PRODUCT_ISSUES_REPO: "example/warm-startup-test",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  });
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    // The sweep runs before the daemon serves anything, so a healthy answer means it is done.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let status: number | null = null;
    while (status === null && Date.now() <= deadline) {
      assert.equal(child.exitCode, null, `daemon exited before startup\n${output}`);
      status = await health(port);
      if (status === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, 200, `daemon did not become healthy\n${output}`);

    assert.equal(existsSync(orphan), false, "a Warm log no slot row names is removed at startup");
    assert.equal(existsSync(named), true, "the log a slot row names survives the restart");
    assert.equal(readFileSync(named, "utf8"), "left by the previous daemon\n");
    assert.equal(existsSync(unrelated), true, "only Warm logs are the sweep's to remove");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
