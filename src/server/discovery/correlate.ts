import type { AgentType, NameSource, TmuxInfo, WeztermInfo } from "@shared/types.ts";
import { listProcesses, type Proc } from "./processes.ts";
import { listTmuxPanes, type TmuxPane } from "./tmux.ts";
import { listWeztermPanes, weztermCwdToPath, type WeztermPane } from "./wezterm.ts";
import { gitInfo } from "../util/git.ts";

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
 * Correlate processes with terminal panes to produce one session per agent.
 *
 * The reliable join is process -> controlling tty -> pane. We group agent
 * processes by tty, pick the root agent process on each tty (its parent is the
 * pane shell, not another agent), and name the session by the tmux session (if
 * the tty is a tmux pane) else the wezterm tab title.
 */
export function correlate(input: DiscoveryInput): DiscoveredSession[] {
  const { procs, tmux, wezterm } = input;

  const byPid = new Map<number, Proc>();
  for (const p of procs) byPid.set(p.pid, p);

  const tmuxByTty = new Map<string, TmuxPane>();
  for (const t of tmux) if (t.tty) tmuxByTty.set(t.tty, t);

  const weztermByTty = new Map<string, WeztermPane>();
  for (const w of wezterm) if (w.tty) weztermByTty.set(w.tty, w);

  // Agent processes attached to a tty, grouped by tty.
  const agentPidsOnTty = new Map<string, Set<number>>();
  for (const p of procs) {
    if (!p.agent || !p.tty) continue;
    let set = agentPidsOnTty.get(p.tty);
    if (!set) agentPidsOnTty.set(p.tty, (set = new Set()));
    set.add(p.pid);
  }

  const sessions: DiscoveredSession[] = [];

  for (const [tty, agentPids] of agentPidsOnTty) {
    // Root agent process on this tty: one whose parent is NOT itself an agent on
    // the same tty (i.e. the launcher whose parent is the pane shell).
    const roots: Proc[] = [];
    for (const pid of agentPids) {
      const p = byPid.get(pid);
      if (!p) continue;
      if (!agentPids.has(p.ppid)) roots.push(p);
    }
    if (roots.length === 0) continue;
    // Prefer the earliest-started / lowest-pid root for determinism.
    roots.sort((a, b) => a.startMs - b.startMs || a.pid - b.pid);
    const root = roots[0]!;
    const agent = root.agent!;

    const tmuxPane = tmuxByTty.get(tty) ?? null;
    const weztermPane = weztermByTty.get(tty) ?? null;

    let name: string;
    let nameSource: NameSource;
    let cwd: string | null;
    let tmuxInfo: TmuxInfo | null = null;
    let weztermInfo: WeztermInfo | null = null;

    if (tmuxPane) {
      name = tmuxPane.session;
      nameSource = "tmux";
      cwd = tmuxPane.currentPath || null;
      tmuxInfo = {
        session: tmuxPane.session,
        window: tmuxPane.windowName,
        windowIndex: tmuxPane.windowIndex,
        paneId: tmuxPane.paneId,
      };
    } else if (weztermPane) {
      cwd = weztermCwdToPath(weztermPane.cwd);
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
      name = `${agent} ${root.pid}`;
      nameSource = "process";
      cwd = null;
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

/** Convenience: gather + correlate in one call. */
export async function discover(): Promise<DiscoveredSession[]> {
  return correlate(await gatherDiscoveryInput());
}
