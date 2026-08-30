import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { run } from "../../util/exec.ts";
import { resolveBinSpec } from "../bin.ts";
import { sdkSubprocessEnv } from "../claude/sdk-deps.ts";
import { codexBin } from "./bin.ts";
import type { AppServerTransport } from "./app-server/client.ts";

// The ONE module that starts a `codex app-server` process.
//
// Everything else in the Codex driver is written against `AppServerTransport`, so this file
// is where the protocol meets an actual subprocess - and a test never spawns one. It is
// deliberately thin: framing and JSON parsing live here because a scripted transport has
// neither, and nothing else does.

/**
 * Where the `codex` binary is, as an ABSOLUTE path this process has confirmed exists.
 *
 * The same resolution `resolveAgentBin("codex")` performs for a dispatched pane, done here
 * so an embedded session and a terminal one cannot end up on different builds - and so a
 * `MISSION_CODEX_BIN` pointing at a wrapper is honoured by both. Throws rather than
 * degrades, per `SdkSpec.launch`: there is no second Codex to fall back to, and a card that
 * looks dispatched while nothing is running is the outcome that rule exists to prevent.
 */
export async function codexExecutable(): Promise<string> {
  const configured = resolveBinSpec(codexBin);
  if (configured.includes("/")) {
    if (existsSync(configured)) return configured;
    throw new Error(`the configured codex binary "${configured}" does not exist`);
  }
  const which = await run("which", [configured]);
  const found = which.stdout.trim().split("\n")[0];
  if (which.code !== 0 || !found || !existsSync(found)) {
    throw new Error(`agent binary "${configured}" not found on PATH`);
  }
  return found;
}

/** How long to let a closing server finish before the process is killed outright. */
const CLOSE_GRACE_MS = 3000;

/**
 * Spawn `codex app-server` and hand back its frames.
 *
 * `args` are the launch-scoped `-c` overrides the caller assembled (our MCP registration
 * today) - config, never protocol, exactly as the terminal path spends them.
 *
 * ONE SERVER PER SESSION (C10). It buys crash isolation, so a wedged thread cannot take
 * every other embedded Codex card with it, and it is what makes the `-c` overrides
 * session-scoped at all: they are process-wide for the server they are given to, so a
 * shared server would put one dispatch's MCP registration inside every other one.
 */
export function spawnAppServer(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): AppServerTransport {
  const child = spawn(executable, ["app-server", ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const failure: { error: Error | null } = { error: null };
  const fail = (err: Error): void => {
    failure.error ??= err;
    child.stdout?.destroy(failure.error);
  };
  child.on("error", fail);
  child.stdin?.on("error", fail);
  const frames = readFrames(child, failure);
  // Read and discard: the server logs to stderr, and a pipe nobody drains fills its buffer
  // and blocks the process that is writing to it. Kept out of the daemon's own log because
  // it is per-turn tracing, not a fault report - a fault arrives as an `error` notification.
  child.stderr?.resume();
  return {
    pid: child.pid ?? null,
    send(frame) {
      if (!child.stdin || child.stdin.destroyed) {
        throw new Error("this session's app-server has closed its input");
      }
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    frames,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Closing stdin is the graceful stop: the server finishes what it is writing and
      // exits, which is what lets the rollout be flushed before anything else opens it.
      child.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, CLOSE_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * The server's stdout as parsed frames: JSONL, one object per line.
 *
 * Hand-rolled rather than `readline` because the stream is not text this daemon owns: a
 * line is whatever arrives between `\n`s, and a chunk boundary can fall anywhere. An
 * unparseable line is SKIPPED rather than thrown - the server interleaves nothing on
 * stdout today, but a future banner there must not take a session down.
 */
export async function* readFrames(child: {
  stdout: NodeJS.ReadableStream | null;
}, failure: { error: Error | null }): AsyncGenerator<unknown> {
  if (failure.error) throw failure.error;
  const stdout = child.stdout;
  if (!stdout) return;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  for await (const chunk of stdout) {
    buf += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        // Not a frame. See above.
      }
    }
  }
  buf += decoder.end();
  if (failure.error) throw failure.error;
}

/** Everything the Codex driver reaches for outside itself. Tests replace the whole object. */
export interface CodexSdkDeps {
  /** Start one connection. `args` are the launch-scoped `-c` config overrides. */
  connect(args: readonly string[], cwd: string, stateHome?: string): Promise<AppServerTransport>;
}

export const defaultCodexSdkDeps: CodexSdkDeps = {
  async connect(args, cwd, stateHome) {
    // `sdkSubprocessEnv` for the reason it documents: a daemon started from a terminal
    // would otherwise hand its own `TMUX_PANE` down to every session it launches, and the
    // machine-installed hooks firing inside them would all key to that one card. Shared
    // with Claude's driver rather than restated, because it is a fact about the DAEMON's
    // environment, not about either harness.
    return spawnAppServer(
      await codexExecutable(),
      args,
      cwd,
      sdkSubprocessEnv(process.env, cwd, stateHome),
    );
  },
};
