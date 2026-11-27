import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkOneShotQuery,
} from "../src/server/harness/claude/sdk-types.ts";

// Every model runner whose timeout became awake-time (issue #1734), driven through a sleep it
// cannot cause: the host-suspend clock is scripted, everything else is the real runner. The
// subprocess runners get fake CLIs that never answer; the SDK runners get fake SDKs that never
// answer. Both binaries are resolved from the environment, so they are in place before the
// imports below.
const home = mkdtempSync(join(tmpdir(), "runner-host-sleep-"));
after(() => rmSync(home, { recursive: true, force: true }));

function hangingCli(name: string): { bin: string; pidFile: string } {
  const bin = join(home, name);
  const pidFile = join(home, `${name}.pid`);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$$" > "${pidFile}"\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}
const codexCli = hangingCli("codex");
const claudeCli = hangingCli("claude");
process.env.MISSION_CODEX_BIN = codexCli.bin;
process.env.MISSION_CLAUDE_BIN = claudeCli.bin;

const { codexRunner, configureCodexRunnerTransport } = await import("../src/server/llm/codex.ts");
const { runCodexSdkOneShot } = await import("../src/server/llm/codex-sdk.ts");
const { runClaudeSdkOneShot } = await import("../src/server/llm/claude-sdk.ts");
const { runClaudeText } = await import("../src/server/claude-cli.ts");
const { configureHostSuspendClock } = await import("../src/server/host-suspend.ts");

const restoreTransport = configureCodexRunnerTransport(() => "exec");
after(restoreTransport);

/** The timeout every runner is given, and the sleep the scripted host takes during it. */
const TIMEOUT_MS = 400;
const SLEPT_MS = 250;

function pidAlive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > 3_000) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One runner under test: how to start a call that never answers, and how to see it is live. */
interface RunnerCase {
  name: string;
  timedOut: RegExp;
  /** Start one call bounded by TIMEOUT_MS. */
  start(): Promise<unknown>;
  /** The call's work is still running: its process lives, or its cancellation has not fired. */
  live(): boolean;
}

function subprocessCase(name: string, cli: { pidFile: string }, timedOut: RegExp, run: () => Promise<unknown>): RunnerCase {
  return {
    name, timedOut,
    start: () => {
      rmSync(cli.pidFile, { force: true });
      return run();
    },
    live: () => pidAlive(cli.pidFile),
  };
}

let codexSdkSignal: AbortSignal | undefined;
let claudeSdkController: AbortController | undefined;

/** An SDK stream that never yields a frame: the turn hangs until it is aborted. */
const hangingClaudeQuery: ClaudeSdkOneShotQuery = {
  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return { next: () => new Promise<never>(() => {}) };
  },
};
const claudeSdkDeps: ClaudeSdkOneShotDeps = {
  executable: async () => "/fake/bin/claude",
  env: () => ({ PATH: "/usr/bin" }),
  query: async ({ options }) => {
    claudeSdkController = options.abortController;
    return hangingClaudeQuery;
  },
};

const RUNNERS: RunnerCase[] = [
  subprocessCase("codex exec", codexCli, /codex exec timed out/, () =>
    codexRunner.run("review this", { timeoutMs: TIMEOUT_MS })),
  subprocessCase("claude -p", claudeCli, /claude -p timed out/, () =>
    runClaudeText("review this", { timeoutMs: TIMEOUT_MS })),
  {
    name: "Codex SDK",
    timedOut: /codex sdk run timed out/,
    start: () => {
      codexSdkSignal = undefined;
      return runCodexSdkOneShot("review this", "/bin/codex", { timeoutMs: TIMEOUT_MS }, {
        createClient: () => ({
          startThread: () => ({
            id: "thread-sleep",
            run: (_prompt, turnOptions) => {
              codexSdkSignal = turnOptions?.signal;
              return new Promise((_resolve, reject) => {
                turnOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              });
            },
          }),
        }),
      });
    },
    live: () => codexSdkSignal !== undefined && !codexSdkSignal.aborted,
  },
  {
    name: "Claude Agent SDK",
    timedOut: /Claude Agent SDK one-shot timed out/,
    start: () => {
      claudeSdkController = undefined;
      return runClaudeSdkOneShot("review this", { timeoutMs: TIMEOUT_MS }, claudeSdkDeps);
    },
    live: () => claudeSdkController !== undefined && !claudeSdkController.signal.aborted,
  },
];

interface Outcome {
  elapsed: number;
  error: unknown;
  /** Whether the call was still unsettled when the wall-clock deadline had passed. */
  pendingAtWallDeadline: boolean;
  liveAtWallDeadline: boolean;
}

async function runThrough(runner: RunnerCase, sleptMs: number): Promise<Outcome> {
  // The host slept for `sleptMs` while the call ran, and the timer kept counting (macOS).
  const restore = configureHostSuspendClock({
    mark: Date.now,
    suspendedMsSince: (since) => Math.min(sleptMs, Date.now() - since),
  });
  try {
    const started = performance.now();
    let settled = false;
    const call = runner.start().then(
      () => { throw new Error(`${runner.name} answered, but its fake never does`); },
      (error: unknown) => {
        settled = true;
        return { elapsed: performance.now() - started, error };
      },
    );
    await eventually(() => runner.live() || settled, `${runner.name} started its work`);
    // Just past the deadline a wall-clock timer would have used.
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + 60 - (performance.now() - started)));
    const pendingAtWallDeadline = !settled;
    const liveAtWallDeadline = runner.live();
    const result = await call;
    return { ...result, pendingAtWallDeadline, liveAtWallDeadline };
  } finally {
    restore();
  }
}

for (const runner of RUNNERS) {
  test(`${runner.name}: with no host sleep the timeout fires on schedule and stops the work`, async () => {
    const outcome = await runThrough(runner, 0);
    assert.match(String(outcome.error), runner.timedOut);
    // Measured from the call, so it includes spawn time; still well short of the awake budget
    // the sleeping case below must wait for.
    assert.ok(
      outcome.elapsed >= TIMEOUT_MS - 20 && outcome.elapsed < TIMEOUT_MS + SLEPT_MS - 50,
      `timed out after ${outcome.elapsed} ms`,
    );
    await eventually(() => !runner.live(), `${runner.name} work stopped after the timeout`);
  });

  test(`${runner.name}: a call the host slept through survives the wall-clock deadline, then times out on its awake budget`, async () => {
    const outcome = await runThrough(runner, SLEPT_MS);
    assert.equal(outcome.pendingAtWallDeadline, true, "the call must not time out on wake");
    assert.equal(outcome.liveAtWallDeadline, true, "its work must still be running at the wall-clock deadline");
    assert.match(String(outcome.error), runner.timedOut);
    assert.ok(outcome.elapsed >= TIMEOUT_MS + SLEPT_MS - 20, `timed out after ${outcome.elapsed} ms, before its awake budget`);
    assert.ok(outcome.elapsed < TIMEOUT_MS + SLEPT_MS + 1_500, `timed out after ${outcome.elapsed} ms, far past its awake budget`);
    // Cleanup is the timeout's other half: the process is killed, or the SDK turn aborted.
    await eventually(() => !runner.live(), `${runner.name} work stopped after the timeout`);
  });
}
