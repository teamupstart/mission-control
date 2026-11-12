import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOT_TIMEOUT_MS = 30_000;
const SHUTDOWN_BUDGET_MS = 10_000;

// This spec launches the source daemon directly, so the focused test command does not run npm's
// native build lifecycle. Provision the runtime artifact before exercising daemon startup.
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

function get(port: number, agent: http.Agent): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/health", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    }).on("error", reject);
  });
}

// `holdIdleConnections` is unit-tested on a server of its own. This proves the daemon applies it
// to the server it actually serves from, and that holding idle sockets for 65 s does not hold
// shutdown for 65 s: `shutdown()` awaits `server.close()`, which closes idle connections.
test("the daemon advertises a 65 s keep-alive and still exits promptly with an idle connection open", {
  timeout: BOOT_TIMEOUT_MS + SHUTDOWN_BUDGET_MS + 10_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mission-daemon-keep-alive-"));
  const fakeBin = join(fixtureRoot, "fake-external.mjs");
  await writeFile(fakeBin, "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('0.0.0-test');\n");
  await chmod(fakeBin, 0o700);
  const port = await freeLoopbackPort();

  // This child is the daemon, not a test worker: drop the runner markers and inherited homes,
  // then isolate its state, discovery and every external executable.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["NODE_TEST_CONTEXT", "MISSION_TEST_STATE", "HARNESS_HOME", "FLEET_HOME", "MISSION_HOME"]) delete env[key];
  Object.assign(env, {
    HOME: fixtureRoot,
    CODEX_HOME: join(fixtureRoot, ".codex"),
    MISSION_HOME: join(fixtureRoot, "state"),
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
    MISSION_PRODUCT_ISSUES_REPO: "example/daemon-keep-alive-test",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  });

  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number>((resolve) => child.once("exit", () => resolve(Date.now())));
  const agent = new http.Agent({ keepAlive: true });

  try {
    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let health: http.IncomingMessage | null = null;
    while (!health && Date.now() <= bootDeadline) {
      assert.equal(child.exitCode, null, `daemon exited before startup\n${output}`);
      health = await get(port, agent).catch(() => null);
      if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(health, `daemon did not answer /api/health within ${BOOT_TIMEOUT_MS}ms\n${output}`);
    assert.equal(health.statusCode, 200, output);
    assert.equal(health.headers["keep-alive"], "timeout=65");

    // The health response's socket is back in the agent's pool, open and idle.
    const idle = Object.values(agent.freeSockets).flat();
    assert.equal(idle.length, 1);
    assert.equal(idle[0]!.destroyed, false);

    const signalled = Date.now();
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SHUTDOWN_BUDGET_MS).unref()),
    ]);
    assert.ok(stopped, `daemon still running ${SHUTDOWN_BUDGET_MS}ms after SIGTERM with an idle connection open\n${output}`);
    console.log(`[daemon-keep-alive] keep-alive=${health.headers["keep-alive"]}; exited ${stopped - signalled}ms after SIGTERM`);
  } finally {
    agent.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
