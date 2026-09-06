import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectSettingsBackupValue,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
} from "../src/shared/settings-backups.ts";
import {
  validateSettingsBackupDomains,
  verifySettingsBackupDigest,
} from "../src/server/settings-backups/format.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOOT_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

// This spec launches the source daemon directly, so the focused test command does not run npm's
// native build lifecycle. Provision the runtime artifact before exercising daemon startup.
ensureNativeStateLockAddon();

type HealthResponse = { service?: unknown; pid?: unknown; version?: unknown };

async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close(() => reject(new Error("could not read the probe socket's assigned port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    stream?.on("error", () => {});
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(escalate);
  }
}

async function dailySnapshotFilename(root: string): Promise<string | null> {
  try {
    const names = await readdir(root);
    return names.find((name) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name)) ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

test("daemon startup creates and verifies today's v1 logical settings snapshot", {
  timeout: BOOT_TIMEOUT_MS + SNAPSHOT_TIMEOUT_MS + 10_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mission-settings-backup-daemon-"));
  const stateHome = join(fixtureRoot, "state");
  const fakeBin = join(fixtureRoot, "fake-external.mjs");
  await writeFile(
    fakeBin,
    "#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('0.0.0-test');\n",
    { mode: 0o700 },
  );
  await chmod(fakeBin, 0o700);
  const port = await freeLoopbackPort();

  // This child is the daemon, not a test worker. Remove the inherited runner markers and
  // state aliases before giving it one explicit disposable MISSION_HOME. Discovery and every
  // external executable are also isolated so this proof cannot adopt operator sessions, read
  // operator catalogs, publish remotely, or start a real model process.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "NODE_TEST_CONTEXT",
    "MISSION_TEST_STATE",
    "HARNESS_HOME",
    "FLEET_HOME",
    "MISSION_HOME",
  ]) delete env[key];
  Object.assign(env, {
    HOME: fixtureRoot,
    CODEX_HOME: join(fixtureRoot, ".codex"),
    MISSION_HOME: stateHome,
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
    MISSION_PRODUCT_ISSUES_REPO: "example/settings-backup-test",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/index.ts"],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.once("exit", (code, signal) => (exited = { code, signal }));

  try {
    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let health: HealthResponse | null = null;
    while (Date.now() <= bootDeadline) {
      if (exited) {
        assert.fail(`daemon exited before startup: ${JSON.stringify(exited)}\n${output}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
      if (response?.ok) {
        health = await response.json() as HealthResponse;
        assert.equal(health?.service, "mission-control", output);
        assert.equal(health?.pid, child.pid, "the health responder was not the spawned daemon");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    assert.ok(health, `daemon did not answer /api/health within ${BOOT_TIMEOUT_MS}ms\n${output}`);

    const backupRoot = join(stateHome, "backups", "settings");
    const snapshotDeadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    let filename: string | null = null;
    while (Date.now() <= snapshotDeadline && filename === null) {
      if (exited) {
        assert.fail(`daemon exited before publishing its daily snapshot: ${JSON.stringify(exited)}\n${output}`);
      }
      filename = await dailySnapshotFilename(backupRoot);
      if (filename === null) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    assert.ok(filename, `daemon published no daily snapshot under ${backupRoot}\n${output}`);

    const raw = await readFile(join(backupRoot, filename), "utf8");
    const compatibility = inspectSettingsBackupValue(JSON.parse(raw));
    if (compatibility.status !== "ready") {
      assert.fail(`daemon snapshot was ${compatibility.status}: ${compatibility.reason}`);
    }
    const { snapshot } = compatibility;
    assert.equal(snapshot.format, SETTINGS_BACKUP_FORMAT);
    assert.equal(snapshot.formatVersion, SETTINGS_BACKUP_FORMAT_VERSION);
    assert.equal(snapshot.kind, "daily");
    assert.equal(filename, `${snapshot.id}.json`);
    assert.equal(verifySettingsBackupDigest(snapshot), true);
    validateSettingsBackupDomains(snapshot);

    console.log(
      `[settings-backup-daemon] health pid=${health.pid}; verified ${filename} `
      + `format=v${snapshot.formatVersion} domains=${snapshot.domains.length}`,
    );
  } finally {
    await stopChild(child);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
