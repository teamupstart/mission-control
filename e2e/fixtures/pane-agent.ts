import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";

import type { DaemonHandle } from "./daemon.ts";
import { tempDir } from "../../test/temp-root.mjs";

/**
 * An idle, hook-instrumented agent that holds no task resources: the one kind of session
 * `TaskManager.assign` accepts, and the one kind the rest of this suite cannot produce.
 *
 * A dispatched agent fails the handover twice over. Its session is an Agent SDK one, which
 * `paneAcceptsPrompt` refuses, and it holds its task's worktree, which
 * `taskResourceOwnerForSession` refuses. What is accepted is a `runtime: "terminal"` session,
 * and that runtime is stamped only by discovery (`registry.ts:mergeDiscovered`). So this starts
 * `pane-agent.mjs` in a real tmux pane, under a link named `claude` so `harnessOf` detects it,
 * in this daemon's fixture repository. The agent announces itself idle through the hook bridge
 * at once, which is what makes the session `instrumented`.
 *
 * A spec using this needs discovery on for its own daemon and outside sessions shown, through
 * `test.use(PANE_AGENT_DAEMON)`, and skips itself without tmux (`hasTmux`), which CI installs.
 * Discovery then cards the developer's own agents as well, so a spec addresses only the session
 * on its own pane (`paneSession`) and never asserts on the fleet as a whole.
 *
 * No model tokens: the thing in the pane is `node`.
 */

/** The daemon options a pane agent needs: discovery on and brisk, and outside sessions shown. */
export const PANE_AGENT_DAEMON = { daemonEnv: { MISSION_POLL_MS: "400" }, outsideSessions: true } as const;

/** Whether tmux is on this machine. A spec skips without it rather than failing. */
export function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

export interface PaneAgent {
  /** The tmux session name it started under. A handover renames it after the task. */
  name: string;
  /** The tmux pane id, which stays stable across that rename. */
  id: string;
  /** What the pane shows now. */
  screen: () => string;
  /** Each submission's full text, in order. Empty unless started with `turns: true`. */
  turns: () => string[];
  /** Kill the pane and remove its scratch directory. */
  cleanup: () => void;
}

/**
 * Start one pane agent in the fixture checkout (`daemon.repo` by default).
 *
 * `turns: true` runs it in whole-turn mode (`PANE_AGENT_TURNS`): bracketed paste is honoured,
 * each submission's text is logged for `turns()`, and each turn is reported through
 * `UserPromptSubmit` and `Stop` as Claude reports one. Without it the agent records only each
 * submission's length on screen.
 *
 * Two spawns, not one: the agent has to be told its own pane id so its hooks bind to this card,
 * and tmux only issues that id once the pane exists. `respawn-pane -k` replaces the placeholder
 * in place, keeping the id. The session name is unique per run, so a parallel worker's pane or
 * a stray from an earlier run is never this one.
 */
export function startPaneAgent(daemon: DaemonHandle, opts: { prefix?: string; turns?: boolean; cwd?: string } = {}): PaneAgent {
  const prefix = opts.prefix ?? "mc-e2e-pane";
  const cwd = opts.cwd ?? daemon.repo;
  const dir = tempDir(`${prefix}-`);
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  // argv0's basename is what `harnessOf` matches, so the link's name is the whole disguise.
  symlinkSync(execPath, join(bin, "claude"));
  const agent = fileURLToPath(new URL("./pane-agent.mjs", import.meta.url));
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const log = opts.turns ? join(dir, "turns.jsonl") : null;
  const name = `${prefix}-${process.pid}-${Date.now()}`;
  // tmux runs this through a shell: every argument is quoted, so a path with spaces stays one.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const run = (paneId: string) => [
    "env",
    ...(log ? [`PANE_AGENT_TURNS=${log}`] : []),
    join(bin, "claude"), agent, daemon.baseURL, token, paneId, cwd, dir,
  ].map(quote).join(" ");
  const tmux = (args: string[]) => execFileSync("tmux", args, { encoding: "utf8", stdio: "pipe" });
  let id: string;
  try {
    tmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", cwd, run("%0")]);
    id = tmux(["list-panes", "-t", name, "-F", "#{pane_id}"]).trim();
    tmux(["respawn-pane", "-k", "-t", id, "-c", cwd, run(id)]);
  } catch (error) {
    // A half-started agent is never handed back, so nothing else would ever stop it. By name:
    // nothing has renamed the session yet, and the pane id may be the step that failed.
    spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    name,
    id,
    screen: () => {
      try {
        return tmux(["capture-pane", "-p", "-t", id]);
      } catch {
        return "";
      }
    },
    turns: () => (log && existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { text: string }).text)
      : []),
    // By pane id, never by name: a handover renames the session after its task, so the name
    // addresses nothing by now and a pane left running would be carded by the next run.
    cleanup: () => {
      spawnSync("tmux", ["kill-pane", "-t", id], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface SessionRow { id: string; state: string; instrumented?: boolean; terminals?: Array<{ paneId?: string }> }

async function sessions(daemon: DaemonHandle): Promise<SessionRow[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  if (!response.ok) throw new Error(`/api/sessions answered ${response.status}`);
  return await response.json() as SessionRow[];
}

/** The id of the session discovery carded for this pane, once it is idle and instrumented. */
export async function paneSession(daemon: DaemonHandle, agent: PaneAgent, timeout = 30_000): Promise<string> {
  let sessionId = "";
  await expect.poll(async () => {
    const ours = (await sessions(daemon)).find((session) => session.terminals?.some((terminal) => terminal.paneId === agent.id));
    sessionId = ours?.state === "idle" && ours.instrumented ? ours.id : "";
    return sessionId;
  }, { timeout, message: `the pane agent on ${agent.id} was never carded idle and instrumented` }).not.toBe("");
  return sessionId;
}

/** Wait for a session to be idle again, as a handover requires. */
export async function sessionIdle(daemon: DaemonHandle, sessionId: string, timeout = 60_000): Promise<void> {
  await expect.poll(async () => (await sessions(daemon)).find((session) => session.id === sessionId)?.state, { timeout }).toBe("idle");
}

/**
 * Hand a backlog task to a running agent through `POST /api/tasks/:id/assign`, claiming what the
 * board's drop claims for a person, and wait until the task is running on that session.
 */
export async function handOver(daemon: DaemonHandle, taskId: string, sessionId: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/tasks/${taskId}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, overrideDisabled: true, overridePauseHold: true, confirmReset: true }),
  });
  if (!response.ok) throw new Error(`handing ${taskId} over answered ${response.status}: ${await response.text()}`);
  await expect.poll(async () => {
    const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{ id: string; status: string; sessionId: string | null }>;
    const task = tasks.find((entry) => entry.id === taskId);
    return task?.status === "running" && task.sessionId === sessionId;
  }, { timeout: 60_000 }).toBe(true);
}
