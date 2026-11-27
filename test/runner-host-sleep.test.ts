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
// subprocess runners get fake CLIs and the SDK runners get fake SDKs. By default none of them
// answers; `answerAfterMs` makes each answer once that long has passed. Both binaries are
// resolved from the environment, so they are in place before the imports below.
const home = mkdtempSync(join(tmpdir(), "runner-host-sleep-"));
after(() => rmSync(home, { recursive: true, force: true }));

/** When set, every fake answers this long after its call starts; otherwise it never answers. */
let answerAfterMs: number | null = null;
const ANSWER = "answered after the sleep";
const answerAfterFile = join(home, "answer-after-seconds");

function setAnswerAfter(ms: number | null): void {
  answerAfterMs = ms;
  if (ms === null) rmSync(answerAfterFile, { force: true });
  else writeFileSync(answerAfterFile, String(ms / 1_000));
}

/** A fake CLI that hangs, or prints `answer` and exits 0 once the answer delay has passed. */
function fakeCli(name: string, answer: string): { bin: string; pidFile: string } {
  const bin = join(home, name);
  const pidFile = join(home, `${name}.pid`);
  writeFileSync(bin, `#!/bin/sh
printf '%s' "$$" > "${pidFile}"
cat > /dev/null
if [ -f "${answerAfterFile}" ]; then
  sleep "$(cat "${answerAfterFile}")"
  cat <<'ANSWER'
${answer}
ANSWER
  exit 0
fi
exec sleep 30
`);
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}
const codexCli = fakeCli("codex", [
  '{"type":"thread.started","thread_id":"thread-sleep"}',
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"${ANSWER}"}}`,
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n"));
const claudeCli = fakeCli("claude", `{"type":"result","subtype":"success","is_error":false,"result":"${ANSWER}"}`);
process.env.MISSION_CODEX_BIN = codexCli.bin;
process.env.MISSION_CLAUDE_BIN = claudeCli.bin;

const { codexRunner, configureCodexRunnerTransport } = await import("../src/server/llm/codex.ts");
const { runCodexSdkOneShot } = await import("../src/server/llm/codex-sdk.ts");
const { runClaudeSdkOneShot } = await import("../src/server/llm/claude-sdk.ts");
const { runClaudeText } = await import("../src/server/claude-cli.ts");
const { configureHostSuspendClock } = await import("../src/server/host-suspend.ts");

const restoreTransport = configureCodexRunnerTransport(() => "exec");
after(restoreTransport);

/**
 * The timeout every runner is given, and the sleep the scripted host takes during it. The sleep
 * is long next to the timeout so a loaded CI runner cannot close the gap between the wall-clock
 * deadline and the awake one.
 */
const TIMEOUT_MS = 400;
const SLEPT_MS = 1_000;

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
  /** Its work was cancelled: the SDK abort fired. Subprocess runners report false here. */
  cancelled(): boolean;
}

function subprocessCase(name: string, cli: { pidFile: string }, timedOut: RegExp, run: () => Promise<unknown>): RunnerCase {
  return {
    name, timedOut,
    start: () => {
      rmSync(cli.pidFile, { force: true });
      return run();
    },
    live: () => pidAlive(cli.pidFile),
    // A subprocess call resolves only on a clean exit 0, which a killed process never makes.
    cancelled: () => false,
  };
}

let codexSdkSignal: AbortSignal | undefined;
let claudeSdkController: AbortController | undefined;

/** Resolves after the answer delay, or never when there is none. */
function afterAnswerDelay(): Promise<void> {
  const delay = answerAfterMs;
  return delay === null ? new Promise<never>(() => {}) : new Promise((resolve) => setTimeout(resolve, delay));
}

/** An SDK stream that yields one result frame after the answer delay, or hangs until aborted. */
function claudeQuery(): ClaudeSdkOneShotQuery {
  let sent = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined };
          await afterAnswerDelay();
          sent = true;
          return {
            done: false,
            value: {
              type: "result", subtype: "success", is_error: false, result: ANSWER,
              session_id: "19de2f1f-c04d-4cfd-a218-719095efe008",
            } as ClaudeSdkMessage,
          };
        },
      };
    },
  };
}
const claudeSdkDeps: ClaudeSdkOneShotDeps = {
  executable: async () => "/fake/bin/claude",
  env: () => ({ PATH: "/usr/bin" }),
  query: async ({ options }) => {
    claudeSdkController = options.abortController;
    return claudeQuery();
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
              return new Promise((resolve, reject) => {
                turnOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                void afterAnswerDelay().then(() => resolve({ finalResponse: ANSWER, usage: null }));
              });
            },
          }),
        }),
      });
    },
    live: () => codexSdkSignal !== undefined && !codexSdkSignal.aborted,
    cancelled: () => codexSdkSignal?.aborted ?? false,
  },
  {
    name: "Claude Agent SDK",
    timedOut: /Claude Agent SDK one-shot timed out/,
    start: () => {
      claudeSdkController = undefined;
      return runClaudeSdkOneShot("review this", { timeoutMs: TIMEOUT_MS }, claudeSdkDeps);
    },
    live: () => claudeSdkController !== undefined && !claudeSdkController.signal.aborted,
    cancelled: () => claudeSdkController?.signal.aborted ?? false,
  },
];

interface Outcome {
  /** From the moment the runner armed its timeout, which excludes locating and spawning. */
  elapsed: number;
  error: unknown;
  /** Whether the call was still unsettled when the wall-clock deadline had passed. */
  pendingAtWallDeadline: boolean;
  liveAtWallDeadline: boolean;
}

/**
 * Script a host that slept for `sleptMs` while the call ran, with a timer clock that kept
 * counting through the sleep, the behavior #1734's wake-aligned timeouts suggest. The timeout
 * marks this clock when it arms, so its first mark is when the deadline started; `armedAt`
 * reads it back.
 */
function scriptSleep(sleptMs: number): { restore: () => void; armedAt: () => number | null } {
  let armedAt: number | null = null;
  const restore = configureHostSuspendClock({
    mark: () => {
      const now = Date.now();
      armedAt ??= now;
      return { at: now, suspendedMs: 0 };
    },
    suspendedMsSince: (since) => Math.min(sleptMs, Date.now() - since.at),
  });
  return { restore, armedAt: () => armedAt };
}

async function runThrough(runner: RunnerCase, sleptMs: number): Promise<Outcome> {
  const sleep = scriptSleep(sleptMs);
  const restore = sleep.restore;
  try {
    let settled = false;
    let settledAt = 0;
    const call = runner.start().then(
      () => { throw new Error(`${runner.name} answered, but its fake never does`); },
      (error: unknown) => {
        settled = true;
        settledAt = Date.now();
        return error;
      },
    );
    await eventually(() => sleep.armedAt() !== null || settled, `${runner.name} armed its timeout`);
    const armedAt = sleep.armedAt();
    // A subprocess runner arms its timeout as it spawns, before the fake has run a line, so on a
    // loaded machine its pid can appear after the deadline. Wait for the work to exist first:
    // "still running" is only a claim about work that started.
    await eventually(() => runner.live() || settled, `${runner.name} started its work`);
    // Just past the deadline a wall-clock timer would have used.
    const wallDeadline = armedAt! + TIMEOUT_MS + 60;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wallDeadline - Date.now())));
    const pendingAtWallDeadline = !settled;
    const liveAtWallDeadline = runner.live();
    const error = await call;
    return { elapsed: settledAt - armedAt!, error, pendingAtWallDeadline, liveAtWallDeadline };
  } finally {
    restore();
  }
}

for (const runner of RUNNERS) {
  test(`${runner.name}: with no host sleep the timeout fires on schedule and stops the work`, async () => {
    const outcome = await runThrough(runner, 0);
    assert.match(String(outcome.error), runner.timedOut);
    // Well short of the awake budget the sleeping case below must wait for.
    assert.ok(
      outcome.elapsed >= TIMEOUT_MS - 20 && outcome.elapsed < TIMEOUT_MS + SLEPT_MS - 200,
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
    assert.ok(outcome.elapsed < TIMEOUT_MS + SLEPT_MS + 3_000, `timed out after ${outcome.elapsed} ms, far past its awake budget`);
    // Cleanup is the timeout's other half: the process is killed, or the SDK turn aborted.
    await eventually(() => !runner.live(), `${runner.name} work stopped after the timeout`);
  });

  test(`${runner.name}: a call the host slept through can still answer after the wall-clock deadline`, async (t) => {
    // The answer lands past where a wall-clock timeout would already have fired (TIMEOUT_MS),
    // and well inside the awake budget the sleep left the call (TIMEOUT_MS + SLEPT_MS).
    setAnswerAfter(TIMEOUT_MS + 500);
    t.after(() => setAnswerAfter(null));
    const sleep = scriptSleep(SLEPT_MS);
    try {
      const started = Date.now();
      const value = await runner.start();
      const answeredAt = Date.now();
      const armedAt = sleep.armedAt();
      assert.ok(armedAt !== null, `${runner.name} never armed its timeout`);
      assert.ok(
        answeredAt - armedAt > TIMEOUT_MS + 60,
        `answered ${answeredAt - armedAt} ms after arming, before the wall-clock deadline it must outlast`,
      );
      assert.ok(answeredAt - started < TIMEOUT_MS + SLEPT_MS, "answered after the awake budget too");
      assert.match(JSON.stringify(value), new RegExp(ANSWER));
      assert.equal(runner.cancelled(), false, "a call that answered must not have been cancelled");
      // Nothing fires later: the timeout was cleared when the call settled.
      await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + SLEPT_MS - (Date.now() - armedAt) + 100));
      assert.equal(runner.cancelled(), false, "the cleared timeout must not cancel the work afterwards");
    } finally {
      sleep.restore();
    }
  });
}
