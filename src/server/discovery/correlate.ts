import type { AgentType, NameSource, TmuxInfo, WeztermInfo } from "@shared/types.ts";
import { listProcesses, type Proc } from "./processes.ts";
import { listTmuxPanes, type TmuxPane } from "./tmux.ts";
import { listWeztermPanes, weztermCwdToPath, type WeztermPane } from "./wezterm.ts";
import { gitInfo } from "../util/git.ts";
import { readProcCwds } from "./proc-cwd.ts";
import { annotateNomistakesLaunches } from "./nomistakes-launch.ts";

/** basename of a path, or "" for null/root - used for name fallbacks. */
function basename(p: string | null): string {
  if (!p) return "";
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * The passively-observable shape of a session, produced purely from OS state.
 * The registry merges this with hook/state data (agentSessionId, precise state,
 * activity) that discovery can't see.
 */
export interface DiscoveredSession {
  /** Stable synthetic id from tty + root agent pid + start time. */
  syntheticId: string;
  agent: AgentType;
  name: string;
  nameSource: NameSource;
  cwd: string | null;
  gitBranch: string | null;
  nomistakesGated: boolean;
  pid: number;
  tty: string | null;
  wezterm: WeztermInfo | null;
  tmux: TmuxInfo | null;
  /** Agent process start time (epoch ms), 0 when unparseable. */
  startedAt: number;
  /**
   * Worktrees where this session is currently driving a no-mistakes run, seen as
   * live `no-mistakes axi run/respond/...` processes in its subtree (added by
   * annotateNomistakesLaunches). Present only while such a process is alive; the
   * registry remembers the binding so attribution survives a parked gate.
   */
  nomistakesRuns?: NmLaunch[];
}

/** A worktree a session is driving a no-mistakes run in (its cwd + that checkout's branch). */
export interface NmLaunch {
  cwd: string;
  branch: string | null;
}

export interface DiscoveryInput {
  procs: Proc[];
  tmux: TmuxPane[];
  wezterm: WeztermPane[];
}

/** Gather the three raw sources. Exposed separately so tests can inject input. */
export async function gatherDiscoveryInput(): Promise<DiscoveryInput> {
  const [procs, tmux, wezterm] = await Promise.all([
    listProcesses(),
    listTmuxPanes(),
    listWeztermPanes(),
  ]);
  return { procs, tmux, wezterm };
}

/**
 * The representative agent process for a tty's process group: the real
 * interactive agent, not a launcher. We prefer a *native* agent (the actual
 * `claude`/`codex` binary) over a wrapper match (`make claude`, `sh -c claude`),
 * then the ancestor-most process in that pool (its parent isn't another agent of
 * the pool). This matters because a launcher's cwd is where it was invoked -
 * often the main repo - while the agent runs in, and writes its transcript
 * under, its own cwd (e.g. a worktree). Deterministic across polls: ties break
 * by earliest start then lowest pid.
 */
export function chooseAgentRoot(group: Proc[]): Proc | null {
  const natives = group.filter((p) => p.agentNative);
  const pool = natives.length > 0 ? natives : group;
  const pids = new Set(pool.map((p) => p.pid));
  const roots = pool.filter((p) => !pids.has(p.ppid));
  const cands = roots.length > 0 ? roots : pool;
  return [...cands].sort((a, b) => a.startMs - b.startMs || a.pid - b.pid)[0] ?? null;
}

/** Group tty-attached agent processes by tty. */
function groupAgentsByTty(procs: Proc[]): Map<string, Proc[]> {
  const byTty = new Map<string, Proc[]>();
  for (const p of procs) {
    if (!p.agent || !p.tty) continue;
    let g = byTty.get(p.tty);
    if (!g) byTty.set(p.tty, (g = []));
    g.push(p);
  }
  return byTty;
}

/** The representative agent pid on each tty - the pids whose real cwd we resolve. */
export function representativeAgentPids(procs: Proc[]): number[] {
  const pids: number[] = [];
  for (const [, group] of groupAgentsByTty(procs)) {
    const root = chooseAgentRoot(group);
    if (root) pids.push(root.pid);
  }
  return pids;
}

/**
 * Correlate processes with terminal panes to produce one session per agent.
 *
 * The reliable join is process -> controlling tty -> pane. We group agent
 * processes by tty, pick the representative agent process on each tty
 * (`chooseAgentRoot`), and name the session by the tmux session (if the tty is a
 * tmux pane) else the wezterm tab title.
 *
 * `procCwds` maps a representative pid to its real working directory (from
 * `readProcCwds`); it takes precedence over the pane's reported path, which only
 * tracks where the pane's launcher was invoked. Absent an entry we fall back to
 * the pane path, preserving the old behavior.
 */
export function correlate(
  input: DiscoveryInput,
  procCwds: Map<number, string> = new Map(),
): DiscoveredSession[] {
  const { tmux, wezterm } = input;

  const tmuxByTty = new Map<string, TmuxPane>();
  for (const t of tmux) if (t.tty) tmuxByTty.set(t.tty, t);

  const weztermByTty = new Map<string, WeztermPane>();
  for (const w of wezterm) if (w.tty) weztermByTty.set(w.tty, w);

  const sessions: DiscoveredSession[] = [];

  for (const [tty, group] of groupAgentsByTty(input.procs)) {
    const root = chooseAgentRoot(group);
    if (!root) continue;
    const agent = root.agent!;

    const tmuxPane = tmuxByTty.get(tty) ?? null;
    const weztermPane = weztermByTty.get(tty) ?? null;
    // The agent process's real cwd is authoritative; the pane path is a fallback.
    const realCwd = procCwds.get(root.pid) ?? null;

    let name: string;
    let nameSource: NameSource;
    let cwd: string | null;
    let tmuxInfo: TmuxInfo | null = null;
    let weztermInfo: WeztermInfo | null = null;

    if (tmuxPane) {
      name = tmuxPane.session;
      nameSource = "tmux";
      cwd = realCwd ?? (tmuxPane.currentPath || null);
      tmuxInfo = {
        session: tmuxPane.session,
        window: tmuxPane.windowName,
        windowIndex: tmuxPane.windowIndex,
        paneId: tmuxPane.paneId,
      };
    } else if (weztermPane) {
      cwd = realCwd ?? weztermCwdToPath(weztermPane.cwd);
      // Prefer an explicit tab title; fall back to the cwd basename rather than
      // the OS window title, which agents overwrite with a noisy status/spinner.
      name = weztermPane.tabTitle || basename(cwd) || `${agent} ${root.pid}`;
      nameSource = "wezterm";
      weztermInfo = {
        paneId: weztermPane.paneId,
        tabId: weztermPane.tabId,
        windowId: weztermPane.windowId,
        tabTitle: weztermPane.tabTitle,
        isActive: weztermPane.isActive,
      };
    } else {
      cwd = realCwd;
      name = `${agent} ${root.pid}`;
      nameSource = "process";
    }

    // A tmux pane can itself live inside a wezterm pane; if we named by tmux but
    // a wezterm pane also maps to this tty (rare), keep the wezterm handle too.
    if (!weztermInfo && weztermPane) {
      weztermInfo = {
        paneId: weztermPane.paneId,
        tabId: weztermPane.tabId,
        windowId: weztermPane.windowId,
        tabTitle: weztermPane.tabTitle,
        isActive: weztermPane.isActive,
      };
    }

    const git = gitInfo(cwd);
    sessions.push({
      syntheticId: `proc:${tty}:${root.pid}:${root.startMs}`,
      agent,
      name,
      nameSource,
      cwd,
      gitBranch: git.branch,
      nomistakesGated: git.nomistakesGated,
      pid: root.pid,
      tty,
      wezterm: weztermInfo,
      tmux: tmuxInfo,
      startedAt: root.startMs,
    });
  }

  sessions.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  return sessions;
}

/** Convenience: gather + correlate in one call, annotating no-mistakes launches. */
export async function discover(): Promise<DiscoveredSession[]> {
  const input = await gatherDiscoveryInput();
  const procCwds = await readProcCwds(representativeAgentPids(input.procs));
  const sessions = correlate(input, procCwds);
  await annotateNomistakesLaunches(sessions, input.procs);
  return sessions;
}
