import type {
  AgentType,
  NameSource,
  PaneDialog,
  PermissionMode,
  TmuxInfo,
  WeztermInfo,
} from "@shared/types.ts";
import { listProcesses, type Proc } from "./processes.ts";
import { enumerateTerminals, type TerminalEnumeration } from "../terminal/enumerate.ts";
import type {
  EmulatorId,
  EmulatorPane,
  MultiplexerId,
  MuxPane,
} from "../terminal/types.ts";
import { gitInfo } from "../util/git.ts";
import { readProcCwds } from "./proc-cwd.ts";
import { annotateNomistakesLaunches } from "./nomistakes-launch.ts";
import { annotatePaneState } from "./pane-mode.ts";

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
  /** Root of the checkout `cwd` sits in, resolved through symlinks. */
  gitRoot: string | null;
  /** Root of the repo that checkout belongs to (see `GitInfo.repoRoot`). */
  repoRoot: string | null;
  nomistakesGated: boolean;
  pid: number;
  tty: string | null;
  wezterm: WeztermInfo | null;
  tmux: TmuxInfo | null;
  /** Agent process start time (epoch ms), 0 when unparseable. */
  startedAt: number;
  /**
   * Claude's live permission mode, read off the pane by `annotatePaneState`.
   * Undefined when we couldn't read it (a Codex session, no pane handle, or a
   * dialog covering Claude's mode line) - the registry then keeps whatever a hook
   * last reported rather than treating "unknown" as "changed".
   */
  permissionMode?: PermissionMode;
  /**
   * The option dialog on this session's pane, from the same capture the mode line
   * is read off (`annotatePaneState`). Null - not undefined - when the pane was
   * read and showed no menu, because that is a FACT the registry must apply: a
   * dismissed dialog has to clear the card. Undefined only when there was no
   * capture to draw it from, which the registry leaves alone.
   */
  paneDialog?: PaneDialog | null;
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
  /**
   * What each terminal backend can see, in naming-priority order (see `enumerateTerminals`).
   *
   * A LIST, not the `{ tmux, wezterm }` pair of named fields this used to be. That struct was
   * the structural blocker for the whole terminal migration: it made "how many backends are
   * there" a fact of the type rather than of the registries, so a third one had nowhere to
   * go and every consumer below had to be taught its name.
   */
  terminals: TerminalEnumeration[];
}

/** Gather the raw sources. Exposed separately so tests can inject input. */
export async function gatherDiscoveryInput(): Promise<DiscoveryInput> {
  const [procs, terminals] = await Promise.all([listProcesses(), enumerateTerminals()]);
  return { procs, terminals };
}

/**
 * One backend's pane on one tty, plus the name that backend offers for a session sitting on
 * it.
 *
 * `name` is precomputed because it is the ONE thing the two axes answer differently - a
 * multiplexer names by session, an emulator by tab title - and resolving it here is what
 * lets the correlation loop pick a namer by priority instead of by an `if/else` chain whose
 * arm order silently IS the priority.
 *
 * The pane is carried whole rather than reduced to a handle: `Session`'s two vendor fields
 * still want a window name, a window id, a tab title and an active flag, none of which a
 * handle carries. See `legacyHandles`.
 */
type TerminalCandidate =
  | { kind: "multiplexer"; backend: MultiplexerId; name: string; pane: MuxPane }
  | { kind: "emulator"; backend: EmulatorId; name: string; pane: EmulatorPane };

/**
 * Index every enumerated pane by its controlling tty, keeping backend order within each tty.
 *
 * The tty is the reliable join between a process and a pane, and the only one: a session's
 * handles are whatever backends hold a pane on the tty its agent process sits on.
 */
function panesByTty(terminals: readonly TerminalEnumeration[]): Map<string, TerminalCandidate[]> {
  const byTty = new Map<string, TerminalCandidate[]>();
  const add = (tty: string | null, c: TerminalCandidate): void => {
    if (!tty) return;
    let list = byTty.get(tty);
    if (!list) byTty.set(tty, (list = []));
    // At most one candidate per backend per tty, LAST reported winning - which is what the
    // `Map.set` this replaced did, and the two are not the same by accident. One backend can
    // report the same pane twice: `tmux list-panes -a` walks sessions then windows, so a
    // window linked into two sessions (`new-session -t`, `link-window`) yields that pane once
    // per session, with a different `session_name` each time. Appending both would let the
    // arrival order of a duplicate decide a card's name - and, through `TmuxInfo.session`,
    // which session `rename-session` and `kill-session` target.
    const at = list.findIndex((x) => x.backend === c.backend);
    if (at >= 0) list[at] = c;
    else list.push(c);
  };

  for (const e of terminals) {
    if (e.kind === "multiplexer") {
      // A multiplexer session always has a name, so this never falls through to the cwd.
      //
      // `sessionName`, NOT `session`: the second is the target spec, and the two are one
      // string only in tmux. Naming a card by the address would title every cmux session
      // with a UUID.
      for (const p of e.panes) add(p.tty, { kind: "multiplexer", backend: e.backend, name: p.sessionName, pane: p });
    } else {
      // The explicit tab title, and NOT the OS window title, which agents overwrite with a
      // noisy status/spinner. An untitled tab falls back to the cwd basename below - it
      // still names its session, and its `nameSource` is still this backend.
      for (const p of e.panes) add(p.tty, { kind: "emulator", backend: e.backend, name: p.tabTitle, pane: p });
    }
  }
  return byTty;
}

/**
 * Project a session's handles onto `Session`'s two per-vendor fields.
 *
 * The only vendor names left in this file, and they are here because `Session.tmux` /
 * `Session.wezterm` are still two named nullable siblings - structural blocker #2, which
 * phase 3 replaces with a handle list. This function is what phase 3 deletes; until then it
 * is the seam, kept in one place so the loop above never grows a second one. A backend with
 * no field to land in (a zellij pane, today) correlates and names normally and simply has no
 * handle recorded, which is the honest shape of a half-finished migration rather than a
 * crash.
 *
 * The `Number` casts are that same debt from the other side: the adapters normalize pane ids
 * to strings because tmux's are `"%3"`, and `WeztermInfo` still holds wezterm's numeric ones.
 */
function legacyHandles(
  mux: TerminalCandidate | undefined,
  emu: TerminalCandidate | undefined,
): { tmux: TmuxInfo | null; wezterm: WeztermInfo | null } {
  const t = mux?.kind === "multiplexer" && mux.backend === "tmux" ? mux.pane : null;
  const w = emu?.kind === "emulator" && emu.backend === "wezterm" ? emu.pane : null;
  return {
    tmux: t
      ? { session: t.session, window: t.windowName, windowIndex: t.windowIndex, paneId: t.paneId }
      : null,
    wezterm: w
      ? {
          paneId: Number(w.paneId),
          tabId: Number(w.tabId),
          windowId: Number(w.windowId),
          tabTitle: w.tabTitle,
          isActive: w.isActive,
        }
      : null,
  };
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
 * (`chooseAgentRoot`), and name the session by the highest-priority terminal backend
 * holding a pane on that tty - which no longer means "tmux, else wezterm, else the pid",
 * because this function names no backend at all. It reads the enumerations the registries
 * produced, in the order they declared, and a machine running neither shipped backend gets
 * the same already-tested `process` path a machine running both would if their panes moved.
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
  const byTty = panesByTty(input.terminals);
  const sessions: DiscoveredSession[] = [];

  for (const [tty, group] of groupAgentsByTty(input.procs)) {
    const root = chooseAgentRoot(group);
    if (!root) continue;
    const agent = root.agent!;

    const candidates = byTty.get(tty) ?? [];
    // The highest-priority backend holding a pane on this tty names the session and supplies
    // the fallback cwd. Multiplexers outrank emulators (see `enumerateTerminals`), which is
    // the old tmux-beats-wezterm arm order, now decided by the registries.
    const primary = candidates[0];
    // The agent process's real cwd is authoritative; the pane path is a fallback.
    const realCwd = procCwds.get(root.pid) ?? null;
    const cwd = realCwd ?? primary?.pane.cwd ?? null;
    const fallbackName = `${agent} ${root.pid}`;
    // The cwd basename is a backend's fallback, not the absence of one: a pane that offers
    // no name (an untitled tab) is still what named this session, so `nameSource` stays that
    // backend. With no pane at all there is nothing to have named it, and the session falls
    // straight to `<agent> <pid>` rather than borrowing a directory name it was not told.
    const name = primary ? primary.name || basename(cwd) || fallbackName : fallbackName;
    const nameSource: NameSource = primary?.backend ?? "process";

    // A session may hold one handle per AXIS, and both at once - a multiplexer pane lives
    // inside an emulator pane, which is why the two interfaces exist. Taking the first of
    // each IS the composition rule; it replaces a "keep the wezterm handle too" fixup that
    // ran after the naming branch and had to restate what that branch had just decided.
    const { tmux: tmuxInfo, wezterm: weztermInfo } = legacyHandles(
      candidates.find((c) => c.kind === "multiplexer"),
      candidates.find((c) => c.kind === "emulator"),
    );

    const git = gitInfo(cwd);
    sessions.push({
      syntheticId: `proc:${tty}:${root.pid}:${root.startMs}`,
      agent,
      name,
      nameSource,
      cwd,
      gitBranch: git.branch,
      gitRoot: git.root,
      repoRoot: git.repoRoot,
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
  await Promise.all([
    annotateNomistakesLaunches(sessions, input.procs),
    annotatePaneState(sessions),
  ]);
  return sessions;
}
