import type { AgentType, NameSource, PaneDialog, PermissionMode } from "@shared/types.ts";
import type { TerminalHandle } from "@shared/terminal.ts";
import { listProcesses, type Proc } from "./processes.ts";
import { enumerateTerminals, type TerminalEnumeration } from "../terminal/enumerate.ts";
import { ttysHostedBy } from "../terminal/host.ts";
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
  /** Every terminal pane this session is reachable through. See `Session.terminals`. */
  terminals: TerminalHandle[];
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

/**
 * Gather the raw sources. Exposed separately so tests can inject input.
 *
 * Sequential, where this used to be a `Promise.all`: the sweep now takes the process table,
 * because a backend that declares a `hostProcess` must not be asked anything when its GUI is
 * not running (see `enumerateTerminals`). The lost overlap is one `ps` read; what it buys is
 * that the same reading answers both the gate and the correlation, instead of an adapter
 * growing a private second way to ask whether its app is up.
 */
export async function gatherDiscoveryInput(): Promise<DiscoveryInput> {
  const procs = await listProcesses();
  const terminals = await enumerateTerminals(procs);
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
 * The pane is carried whole rather than reduced to a handle at this point, because the
 * naming walk wants the whole pane (its cwd fallback, its title) while `handleOf` wants only
 * what a `Session` records.
 */
type TerminalCandidate =
  | { kind: "multiplexer"; backend: MultiplexerId; name: string; pane: MuxPane }
  | { kind: "emulator"; backend: EmulatorId; name: string; pane: EmulatorPane };

/**
 * A tty we are about to build a session on, and the cwd we already know for it.
 *
 * The cwd comes from the agent process itself (`readProcCwds`), which makes it the
 * trustworthy side of the weak join below - a pane's self-reported directory is compared
 * against it, never the other way round.
 */
interface AgentTty {
  tty: string;
  cwd: string | null;
}

/**
 * Index every enumerated pane by the tty it is on, over TWO keys.
 *
 * The tty a backend reports itself is the strong key and always wins. It was also the only
 * key, which quietly made "can this backend name a tty?" a precondition for existing at all -
 * and Ghostty is a backend that enumerates real, focusable, typeable surfaces and cannot name
 * one (see `HostProcessSpec`). So a pane with no tty gets a second chance through its
 * backend's GUI process, and the rule for spending it is uniqueness: pair when exactly one
 * answer is possible, decline otherwise.
 *
 * Declining is the important half. A wrong pairing does not degrade, it MISDIRECTS - the
 * card would focus someone else's tab and type a prompt into it, which is the failure mode
 * every write path in this codebase is arranged to avoid. An unpaired session is the
 * already-tested handleless one: it is named `<agent> <pid>`, its Send is disabled and its
 * Focus refuses. That is a visible absence, and it is what "degrades correctly" means here.
 */
function panesByTty(
  terminals: readonly TerminalEnumeration[],
  procs: readonly Proc[],
  agentTtys: readonly AgentTty[],
): Map<string, TerminalCandidate[]> {
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
    // arrival order of a duplicate decide a card's name - and, through `MuxHandle.session`,
    // which session `rename-session` and `kill-session` target.
    const at = list.findIndex((x) => x.backend === c.backend);
    if (at >= 0) list[at] = c;
    else list.push(c);
  };

  for (const e of terminals) {
    if (e.kind === "multiplexer") {
      // A multiplexer session always has a name, so this never falls through to the cwd.
      for (const p of e.panes) add(p.tty, { kind: "multiplexer", backend: e.backend, name: p.session, pane: p });
    } else {
      // The explicit tab title, and NOT the OS window title, which agents overwrite with a
      // noisy status/spinner. An untitled tab falls back to the cwd basename below - it
      // still names its session, and its `nameSource` is still this backend.
      for (const p of e.panes) add(p.tty, { kind: "emulator", backend: e.backend, name: p.tabTitle, pane: p });
    }
  }

  // Second key, and only for panes the first one could not place. Runs after the whole first
  // pass so a backend never competes with itself, and so a tty already claimed by a pane that
  // knows its own name is never reassigned by a guess.
  for (const e of terminals) {
    if (e.kind !== "emulator" || !e.hostProcess) continue;
    const hosted = ttysHostedBy(e.hostProcess, procs);
    const openTtys = agentTtys.filter(
      (a) => hosted.has(a.tty) && !(byTty.get(a.tty) ?? []).some((c) => c.backend === e.backend),
    );
    const openPanes = e.panes.filter((p) => !p.tty);
    for (const { tty, pane } of pairUniquely(openTtys, openPanes)) {
      add(tty, { kind: "emulator", backend: e.backend, name: pane.tabTitle, pane });
    }
  }
  return byTty;
}

/**
 * Pair ttys with panes only where exactly one pairing is possible.
 *
 * Two rules, both of which are "there is no choice to make" rather than a best guess:
 *
 *   - **cwd agreement.** A pane reports the directory its shell is in; the tty's agent
 *     process reports its own. Where one tty and one pane are alone in sharing a directory,
 *     they are the same terminal. Two tabs open on the same worktree - the ordinary case of
 *     an agent tab beside a shell tab - make both sides ambiguous and neither is paired.
 *   - **last one standing.** With a single unplaced tty and a single unplaced pane there is
 *     only one pairing available, and it needs no directory at all. This is the rule that
 *     carries a surface spawned with a raw command, which reports an EMPTY cwd because shell
 *     integration never ran to emit OSC 7 - measured, and the reason the cwd rule cannot be
 *     the only one.
 *
 * Anything else is left unpaired on purpose. Note the counts are rarely equal and that is
 * expected: a terminal's plain shell tabs are panes with no agent tty to match, so most
 * enumerations end here having paired nothing, which is correct.
 */
function pairUniquely(
  ttys: readonly AgentTty[],
  panes: readonly EmulatorPane[],
): { tty: string; pane: EmulatorPane }[] {
  const pairs: { tty: string; pane: EmulatorPane }[] = [];
  const takenTty = new Set<string>();
  const takenPane = new Set<string>();

  for (const a of ttys) {
    if (!a.cwd) continue;
    // Both sides must be alone in claiming this directory, or there is a real choice here
    // and we are not entitled to make it.
    if (ttys.filter((x) => x.cwd === a.cwd).length !== 1) continue;
    const matches = panes.filter((p) => p.cwd && p.cwd === a.cwd);
    if (matches.length !== 1) continue;
    const pane = matches[0]!;
    if (takenPane.has(pane.paneId)) continue;
    takenTty.add(a.tty);
    takenPane.add(pane.paneId);
    pairs.push({ tty: a.tty, pane });
  }

  const restTtys = ttys.filter((a) => !takenTty.has(a.tty));
  const restPanes = panes.filter((p) => !takenPane.has(p.paneId));
  if (restTtys.length === 1 && restPanes.length === 1) {
    pairs.push({ tty: restTtys[0]!.tty, pane: restPanes[0]! });
  }
  return pairs;
}

/**
 * Reduce an enumerated pane to the handle a `Session` carries.
 *
 * What `legacyHandles` was, with the vendor names gone: it projected onto `Session.tmux` /
 * `Session.wezterm`, so a backend with no field of its own correlated, named its session,
 * and then silently recorded no handle - discovered but unreachable. Phase 3 replaced those
 * two named siblings with a list, and this is the whole of what was left to write. Nothing
 * here can recognise a vendor, and there is no longer a `Number` cast either: the adapters
 * normalize pane ids to strings and the handle keeps them that way.
 */
function handleOf(c: TerminalCandidate): TerminalHandle {
  if (c.kind === "multiplexer") {
    const p = c.pane;
    return {
      kind: "multiplexer",
      backend: c.backend,
      session: p.session,
      windowIndex: p.windowIndex,
      windowName: p.windowName,
      paneId: p.paneId,
    };
  }
  const p = c.pane;
  return {
    kind: "emulator",
    backend: c.backend,
    paneId: p.paneId,
    tabId: p.tabId,
    windowId: p.windowId,
    tabTitle: p.tabTitle,
    isActive: p.isActive,
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
  // The tty groups are built first because the second correlation key needs them: pairing a
  // pane that could not name its own tty is only possible against the ttys we are actually
  // building sessions on, with the cwds we resolved for them.
  const groups = [...groupAgentsByTty(input.procs)];
  const roots = new Map<string, Proc>();
  const agentTtys: AgentTty[] = [];
  for (const [tty, group] of groups) {
    const root = chooseAgentRoot(group);
    if (!root) continue;
    roots.set(tty, root);
    agentTtys.push({ tty, cwd: procCwds.get(root.pid) ?? null });
  }

  const byTty = panesByTty(input.terminals, input.procs, agentTtys);
  const sessions: DiscoveredSession[] = [];

  for (const [tty] of groups) {
    const root = roots.get(tty);
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
    const terminals = [
      candidates.find((c) => c.kind === "multiplexer"),
      candidates.find((c) => c.kind === "emulator"),
    ]
      .filter((c) => c !== undefined)
      .map(handleOf);

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
      terminals,
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
