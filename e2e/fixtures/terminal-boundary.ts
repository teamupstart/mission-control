import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Proc } from "../../src/server/discovery/processes.ts";
import type { TerminalDeps } from "../../src/server/terminal/registry.ts";
import type { TerminalExec } from "../../src/server/terminal/exec.ts";
import { ghosttyEmulator as nativeGhosttyEmulator } from "../../src/server/terminal/ghostty.ts";

export { daemonOwnedPids } from "../../src/server/discovery/processes.ts";

export interface TerminalBoundaryState {
  cwd: string;
  requestedTitle: string;
  tabTitle: string;
  argv: string[];
  startedAt: number;
}

const GUI_PID = 900001;
const AGENT_PID = 900002;
const TARGET = { paneId: "fixture-surface", tabId: "fixture-tab" };
const ok = { ok: true, outcomeUnknown: false } as const;
const statePath = (): string => join(process.env.MISSION_HOME!, "terminal-boundary.json");

function readState(): TerminalBoundaryState | null {
  return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : null;
}

/** Scripted OS observations, never a Session or a dispatched card name. */
export async function listProcesses(): Promise<Proc[]> {
  const state = readState();
  if (!state) return [];
  const base = { startRaw: String(state.startedAt), startMs: state.startedAt };
  return [
    { ...base, pid: GUI_PID, ppid: 1, tty: null, command: "ghostty", agent: null, agentNative: false },
    { ...base, pid: AGENT_PID, ppid: GUI_PID, tty: "ttysfixture", command: "claude",
      agent: "claude", agentNative: true },
  ];
}

export async function readProcCwds(): Promise<Map<number, string>> {
  const state = readState();
  return new Map(state ? [[AGENT_PID, state.cwd]] : []);
}

/** Replace only terminal I/O. Keep Ghostty's real names, host correlation and capability nulls. */
export function installTerminalBoundary(deps: TerminalDeps): void {
  for (const backend of [...Object.values(deps.multiplexers), ...Object.values(deps.emulators)]) {
    backend.bin = { env: null, candidates: [join(process.env.MISSION_HOME!, "missing-terminal")], dropEnv: [] };
  }
  deps.emulators.ghostty = ghosttyEmulator();
}

/** Pane writes build fresh adapters too, so every Ghostty factory call uses this boundary. */
export function ghosttyEmulator(exec?: TerminalExec): ReturnType<typeof nativeGhosttyEmulator> {
  const ghostty = nativeGhosttyEmulator(exec);
  ghostty.bin = { env: null, candidates: [process.execPath], dropEnv: [] };
  ghostty.spawn = {
    tab: async (spec) => {
      if (!spec.cwd) throw new Error("terminal dispatch must supply its worktree");
      const state: TerminalBoundaryState = {
        cwd: spec.cwd, requestedTitle: spec.title, argv: spec.argv,
        // Ghostty ignores the requested title. A fixture that echoed it would hide the bug.
        tabTitle: "shell reports the working directory", startedAt: Date.now(),
      };
      writeFileSync(`${statePath()}.tmp`, JSON.stringify(state));
      renameSync(`${statePath()}.tmp`, statePath());
      return { ...ok, target: TARGET };
    },
  };
  ghostty.list = async () => {
    const state = readState();
    return state ? [{ ...TARGET, windowId: "fixture-window", tabTitle: state.tabTitle,
      windowTitle: state.tabTitle, cwd: state.cwd, tty: null, isActive: true }] : [];
  };
  const record = (text: string): typeof ok => {
    appendFileSync(join(process.env.MISSION_HOME!, "terminal-input.txt"), text);
    return ok;
  };
  ghostty.write = {
    text: async (_target, text) => record(text),
    keys: async (_target, keys) => record(keys.join(" ")),
    paste: async (_target, text) => ({ ...record(text), submitted: false }),
  };
  ghostty.focus = { granularity: "pane", raise: async () => ok };
  return ghostty;
}
