import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

const root = mkdtempSync(join(tmpdir(), "mission-daemon-owner-"));
const repo = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();
// A source-loaded daemon can legitimately wait behind the full suite's eight workers. Keep
// short waits for refusal/holder signals, but give successful process startup its own budget.
const CHILD_START_TIMEOUT_MS = 60_000;

// A direct single-file test does not run npm's build lifecycle. Provision the runtime artifact
// this spec exercises so the focused command proves source checkout behavior on its own.
ensureNativeStateLockAddon();

after(async () => {
  await Promise.all([...children].map((child) => stopDaemon(child)));
  rmSync(root, { recursive: true, force: true });
});

type RunningDaemon = {
  child: ChildProcess;
  exit: Promise<[number | null, NodeJS.Signals | null]>;
  output: () => string;
};

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function daemonEnv(home: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MISSION_HOME: home,
    MISSION_PORT: String(port),
    MISSION_POLL_MS: "0",
    MISSION_SCOUT_RECONCILE_MS: "0",
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.MISSION_TEST_STATE;
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  return env;
}

function startDaemon(home: string, port: number): RunningDaemon {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/index.ts"],
    {
      cwd: repo,
      env: daemonEnv(home, port),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  child.once("exit", () => children.delete(child));
  return { child, exit, output: () => output };
}

function startOwnershipHolder(home: string, port: number): RunningDaemon {
  const script = `
    const { acquireStateOwnership } = await import("./src/server/state-ownership.ts");
    const ownership = acquireStateOwnership();
    console.log("ownership-held");
    process.on("SIGTERM", () => { ownership.release(); process.exit(0); });
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: repo,
      env: daemonEnv(home, port),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  child.once("exit", () => children.delete(child));
  return { child, exit, output: () => output };
}

async function waitFor(
  daemon: RunningDaemon,
  predicate: (output: string) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(daemon.output())) return;
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      assert.fail(`${description}; daemon exited early\n${daemon.output()}`);
    }
    await delay(25);
  }
  assert.fail(`${description}; timed out\n${daemon.output()}`);
}

async function waitForListening(daemon: RunningDaemon): Promise<void> {
  await waitFor(
    daemon,
    (output) => output.includes("[mission-control] listening on"),
    "daemon did not listen",
    CHILD_START_TIMEOUT_MS,
  );
}

async function stopDaemon(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

test("a second daemon cannot own the same state home through a different port", async () => {
  const home = join(root, "contended");
  const firstPort = await unusedPort();
  const secondPort = await unusedPort();
  const first = startDaemon(home, firstPort);
  await waitForListening(first);

  const second = startDaemon(home, secondPort);
  const deadline = Date.now() + 15_000;
  while (
    second.child.exitCode === null &&
    second.child.signalCode === null &&
    !second.output().includes("[mission-control] listening on") &&
    Date.now() < deadline
  ) {
    await delay(25);
  }
  if (second.output().includes("[mission-control] listening on")) {
    await stopDaemon(second.child);
    assert.fail(`the contending daemon opened the state database and listened\n${second.output()}`);
  }
  assert.ok(
    second.child.exitCode !== null || second.child.signalCode !== null,
    `the contending daemon neither refused ownership nor listened\n${second.output()}`,
  );
  const [code, signal] = await second.exit;

  assert.equal(signal, null, second.output());
  assert.notEqual(code, 0, second.output());
  assert.match(second.output(), /state home is already owned by another Mission Control daemon/i);
  assert.match(second.output(), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(second.output(), new RegExp(`port ${firstPort}`));
  assert.doesNotMatch(second.output(), new RegExp(`listening.+${secondPort}`));

  await stopDaemon(first.child);
});

test("ordinary restart works and stale ownership recovers after a crash", async () => {
  const home = join(root, "crashed");
  const first = startDaemon(home, await unusedPort());
  await waitForListening(first);
  await stopDaemon(first.child, "SIGKILL");

  assert.equal(existsSync(join(home, "daemon.lock")), true, "the durable ownership record vanished");

  const replacement = startDaemon(home, await unusedPort());
  await waitForListening(replacement);
  await stopDaemon(replacement.child);

  const restarted = startDaemon(home, await unusedPort());
  await waitForListening(restarted);
  await stopDaemon(restarted.child);
});

test("ownership contention refuses startup before the state database is touched", async () => {
  const home = join(root, "untouched");
  const holder = startOwnershipHolder(home, await unusedPort());
  await waitFor(holder, (output) => output.includes("ownership-held"), "ownership holder did not start");
  assert.equal(existsSync(join(home, "harness.db")), false);

  const contender = startDaemon(home, await unusedPort());
  const [code, signal] = await contender.exit;

  assert.equal(signal, null, contender.output());
  assert.notEqual(code, 0, contender.output());
  assert.match(contender.output(), /state home is already owned by another Mission Control daemon/i);
  assert.equal(
    existsSync(join(home, "harness.db")),
    false,
    "the refused daemon created or migrated the state database",
  );
  await stopDaemon(holder.child);
});

test("daemons with independent state homes can run concurrently", async () => {
  const first = startDaemon(join(root, "independent-a"), await unusedPort());
  const second = startDaemon(join(root, "independent-b"), await unusedPort());

  await Promise.all([waitForListening(first), waitForListening(second)]);

  await Promise.all([stopDaemon(first.child), stopDaemon(second.child)]);
});
