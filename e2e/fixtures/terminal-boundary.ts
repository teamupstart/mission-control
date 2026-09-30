import { LAUNCH_PID_FILE } from "../../src/server/terminal/launch-process.ts";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Proc } from "../../src/server/discovery/processes.ts";
import { listProcessesSnapshot as actualProcessSnapshot } from "../../src/server/discovery/processes.ts";
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
  inventory?: "unavailable" | "absent";
}

const GUI_PID = 900001;
const AGENT_PID = 900002;
const WRAPPER_PID = 900003;
const TARGET = { paneId: "fixture-surface", tabId: "fixture-tab" };
const ok = { ok: true, outcomeUnknown: false } as const;
const statePath = (): string => join(process.env.MISSION_HOME!, "terminal-boundary.json");

function readState(): TerminalBoundaryState | null {
  return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : null;
}

/** Scripted OS observations, never a Session or a dispatched card name. */
export async function listProcesses(): Promise<Proc[]> {
  const state = readState();
  if (!state || existsSync(join(process.env.MC_E2E_RECORD_DIR!, "discovery-block"))) return [];
  const base = { startRaw: String(state.startedAt), startMs: state.startedAt };
  let wrapper = { pid: WRAPPER_PID, startMs: state.startedAt };
  if (process.env.MC_E2E_RESUME_TOOLS === "1") {
    try { wrapper = JSON.parse(readFileSync(join(dirname(state.argv[1]!), "terminal-launch.json"), "utf8")); } catch { /* The guard has not claimed yet. */ }
  }
  return [
    { ...base, pid: GUI_PID, ppid: 1, tty: null, command: "ghostty", agent: null, agentNative: false },
    { ...base, ...wrapper, ppid: GUI_PID, tty: "ttysfixture", command: "-" + state.argv.join(" "), agent: null, agentNative: false },
    { ...base, pid: AGENT_PID, ppid: wrapper.pid, tty: "ttysfixture", command: "claude",
      agent: "claude", agentNative: true },
  ];
}

export async function listProcessesSnapshot() {
  // Only terminal discovery is synthetic. The SDK fake is a real subprocess, and
  // handoff must record its actual lifetime before stop, just as the shipped daemon does.
  const actual = await actualProcessSnapshot();
  const terminal = await listProcesses();
  const scripted = new Set(terminal.map((p) => p.pid));
  return { ...actual, processes: [...actual.processes.filter((p) => !scripted.has(p.pid)), ...terminal],
    cwdScopePids: [...actual.cwdScopePids.filter((pid) => !scripted.has(pid)), ...scripted] };
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
  if (process.env.MC_E2E_WEZTERM_BOUNDARY === "1") {
    deps.emulators.wezterm.bin = { env: null, candidates: [process.execPath], dropEnv: [] };
  } else deps.emulators.ghostty = ghosttyEmulator();
}

/** Pane writes build fresh adapters too, so every Ghostty factory call uses this boundary. */
export function ghosttyEmulator(exec?: TerminalExec): ReturnType<typeof nativeGhosttyEmulator> {
  const ghostty = nativeGhosttyEmulator(exec);
  ghostty.bin = { env: null, candidates: [process.execPath], dropEnv: [] };
  ghostty.spawn = {
    tab: async (spec) => {
      if (!spec.cwd) throw new Error("terminal dispatch must supply its worktree");
      if (process.env.MC_E2E_RECORD_DIR) appendFileSync(join(process.env.MC_E2E_RECORD_DIR, "terminal-launches.log"), "launch\n");
      const state: TerminalBoundaryState = {
        cwd: spec.cwd, requestedTitle: spec.title, argv: spec.argv,
        // Ghostty ignores the requested title. A fixture that echoed it would hide the bug.
        tabTitle: "shell reports the working directory", startedAt: Date.now(),
      };
      if (process.env.MC_E2E_RESUME_TOOLS === "1") {
        // Only OS launch I/O is replaced. Execute the production wrapper and MCP child.
        const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
          cwd: spec.cwd, stdio: "ignore", detached: true,
          env: { ...process.env, TMUX_PANE: "", WEZTERM_PANE: "", ITERM_SESSION_ID: "" },
        });
        child.unref();
      }
      writeFileSync(join(dirname(spec.argv[1]!), LAUNCH_PID_FILE), String(WRAPPER_PID));
      writeFileSync(`${statePath()}.tmp`, JSON.stringify(state));
      renameSync(`${statePath()}.tmp`, statePath());
      return { ...ok, target: TARGET };
    },
  };
  ghostty.list = async () => {
    const state = readState();
    if (state?.inventory === "unavailable") return null;
    if (state?.inventory === "absent") return [];
    return state ? [{ ...TARGET, windowId: "fixture-window", tabTitle: state.tabTitle,
      windowTitle: state.tabTitle, cwd: state.cwd, tty: null, isActive: true }] : [];
  };
  const record = (text: string): typeof ok => {
    appendFileSync(join(process.env.MISSION_HOME!, "terminal-input.txt"), text);
    return ok;
  };
  ghostty.write = {
    text: async (target, text) => {
      if (target.paneId !== TARGET.paneId) throw new Error("wrong terminal recipient");
      return record(text);
    },
    keys: async (_target, keys) => record(keys.join(" ")),
    paste: async (_target, text) => ({ ...record(text), submitted: false }),
  };
  ghostty.focus = { granularity: "pane", raise: async () => ok };
  return ghostty;
}
