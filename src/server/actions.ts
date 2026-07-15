import type { ResetPreview, ResetResult, Session } from "@shared/types.ts";
import { resolveWeztermBin } from "./config.ts";
import { listTmuxClients } from "./discovery/tmux.ts";
import {
  activateWeztermPane,
  findSessionHostPane,
  listWeztermPanes,
  spawnWeztermTab,
} from "./discovery/wezterm.ts";
import { run, type RunResult } from "./util/exec.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Shared error when a session has no pane handle we can drive. */
const NO_HANDLE = "session has no tmux or wezterm handle to send to";

/** Reduce a finished command to an ActionResult, using stderr (or a fallback) as the error. */
function check(r: RunResult, failMsg: string): ActionResult {
  return r.code !== 0 ? { ok: false, error: r.stderr.trim() || failMsg } : { ok: true };
}

/** Run a command and reduce it to an ActionResult in one step. */
async function step(bin: string, args: string[], failMsg: string): Promise<ActionResult> {
  return check(await run(bin, args), failMsg);
}

/**
 * Type text into a session's prompt, optionally submitting with Enter. Routes
 * through tmux `send-keys` or wezterm `cli send-text` depending on which handle
 * the session has. tmux wins when both exist (the agent's real pane is the tmux
 * pane; the wezterm handle would be the outer client).
 */
export async function sendText(
  session: Session,
  text: string,
  submit: boolean,
): Promise<ActionResult> {
  if (session.tmux) {
    const target = session.tmux.paneId;
    const typed = await step("tmux", ["send-keys", "-t", target, "-l", text], "tmux send-keys failed");
    if (!typed.ok) return typed;
    if (submit) {
      const entered = await step("tmux", ["send-keys", "-t", target, "Enter"], "tmux Enter failed");
      if (!entered.ok) return entered;
    }
    return { ok: true };
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    const args = ["cli", "send-text", "--pane-id", id, "--no-paste", text];
    const typed = await step(bin, args, "wezterm send-text failed");
    if (!typed.ok) return typed;
    if (submit) {
      const enterArgs = ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"];
      const entered = await step(bin, enterArgs, "wezterm Enter failed");
      if (!entered.ok) return entered;
    }
    return { ok: true };
  }
  return { ok: false, error: NO_HANDLE };
}

/**
 * Deliver a whole prompt (possibly multi-line) into a session's input as a single
 * submission. Unlike `sendText`, newlines here must NOT each submit - so we send
 * the body via bracketed paste (tmux `paste-buffer -p` / wezterm's default paste),
 * which agent TUIs treat as one pasted block, then press Enter once to submit.
 * Used by dispatch to seed an agent's first task.
 */
export async function injectPrompt(session: Session, text: string): Promise<ActionResult> {
  if (session.tmux) {
    const target = session.tmux.paneId;
    const buf = `harness-${target.replace(/[^a-zA-Z0-9]/g, "")}`;
    const set = await step("tmux", ["set-buffer", "-b", buf, "--", text], "tmux set-buffer failed");
    if (!set.ok) return set;
    // -p: bracketed paste (so embedded newlines don't submit); -d: drop the buffer after.
    const paste = await step(
      "tmux",
      ["paste-buffer", "-p", "-d", "-b", buf, "-t", target],
      "tmux paste-buffer failed",
    );
    if (!paste.ok) return paste;
    const enter = await step("tmux", ["send-keys", "-t", target, "Enter"], "tmux Enter failed");
    if (!enter.ok) return enter;
    return { ok: true };
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    // Omitting --no-paste makes wezterm send the text as a bracketed paste.
    const pasted = await step(bin, ["cli", "send-text", "--pane-id", id, text], "wezterm send-text failed");
    if (!pasted.ok) return pasted;
    const enterArgs = ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"];
    const entered = await step(bin, enterArgs, "wezterm Enter failed");
    if (!entered.ok) return entered;
    return { ok: true };
  }
  return { ok: false, error: NO_HANDLE };
}

/**
 * Cycle a Claude session's permission mode one step by injecting a Shift+Tab into
 * its pane - the exact keystroke a human presses in the TUI, so it advances
 * default -> acceptEdits -> plan (and on to any further modes) exactly as it would
 * live. There is no API to *set* the mode, so this simulated keypress is the only
 * mechanism. Injecting it tells us nothing about where the mode landed - the
 * mode/cycle route advances the card's chip itself once this succeeds (see
 * `Registry.optimisticCyclePermissionMode`).
 *
 * tmux resolves the `BTab` key name to the terminal's back-tab sequence; wezterm
 * takes the raw sequence, so we send CSI Z (ESC [ Z) - the standard Shift+Tab code.
 */
export async function cyclePermissionMode(session: Session): Promise<ActionResult> {
  if (session.tmux) {
    // No -l here: we want tmux to interpret `BTab` as a key name, not literal text.
    return step("tmux", ["send-keys", "-t", session.tmux.paneId, "BTab"], "tmux send-keys BTab failed");
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    const args = ["cli", "send-text", "--pane-id", id, "--no-paste", "\x1b[Z"];
    return step(bin, args, "wezterm send-text (Shift+Tab) failed");
  }
  return { ok: false, error: NO_HANDLE };
}

/** Bring the session's pane/tab into focus. */
export async function focus(session: Session): Promise<ActionResult> {
  if (session.wezterm) {
    const r = await activateWeztermPane(session.wezterm.tabId, session.wezterm.paneId);
    return check(r, "wezterm activate failed");
  }
  if (session.tmux) {
    const sess = session.tmux.session;
    const windowTarget = `${sess}:${session.tmux.windowIndex}`;
    // Point tmux at the agent's own pane/window. This only touches this
    // session's internal state, so whichever terminal shows it lands on the
    // right pane - and it never disturbs any other session.
    const selected = await step("tmux", ["select-pane", "-t", session.tmux.paneId], "tmux select-pane failed");
    if (!selected.ok) return selected;
    await run("tmux", ["select-window", "-t", windowTarget]);

    // Surface the session at the terminal-tab level. If a wezterm tab already
    // runs a tmux client for this session, raise that tab. Otherwise open the
    // session in a NEW, titled tab. We deliberately never repoint an existing
    // client at a different session or detach/kill one - that would yank a tab
    // the user has another session open in.
    const [clients, panes] = await Promise.all([listTmuxClients(), listWeztermPanes()]);
    const host = findSessionHostPane(sess, clients, panes);
    if (host) {
      const r = await activateWeztermPane(host.tabId, host.paneId);
      return check(r, "wezterm activate failed");
    }
    // No tab hosts it yet: open it in a fresh tab titled with the session name.
    const paneId = await spawnWeztermTab(["tmux", "attach", "-t", sess], sess);
    if (paneId != null) return { ok: true };
    // wezterm couldn't open a tab. If the session is already attached somewhere
    // (e.g. a non-wezterm terminal we can't raise), we've at least selected the
    // right pane - report success rather than switching a client's session.
    if (clients.some((c) => c.session === sess)) return { ok: true };
    return { ok: false, error: "no terminal tab hosts this tmux session and none could be opened" };
  }
  return { ok: false, error: "session has no focusable pane" };
}

/** Send SIGTERM to a pid, reduced to an ActionResult. */
function signalProcess(pid: number): ActionResult {
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Side effects `kill` performs, injectable so tests can drive the branching
 * without signalling real processes or shelling out to tmux.
 */
export interface KillDeps {
  /** SIGTERM the leaf agent process. */
  signal: (pid: number) => ActionResult;
  /** Kill an entire tmux session by name (`tmux kill-session -t <name>`). */
  killTmuxSession: (session: string) => Promise<RunResult>;
}

const defaultKillDeps: KillDeps = {
  signal: signalProcess,
  killTmuxSession: (session) =>
    run("tmux", ["kill-session", "-t", session], { timeoutMs: 10000 }),
};

/**
 * Terminate the agent and tear down its terminal home. SIGTERMs the leaf agent
 * process, then - for a tmux-hosted session - kills the whole tmux session so no
 * orphaned window/pane is left behind. The UI confirms before calling this.
 *
 * The two steps race by nature: the agent's own exit can collapse its tmux session
 * before (or after) we reach kill-session, so we count the action as successful
 * when EITHER the signal or the kill-session landed, and only surface an error when
 * both fail. For a non-tmux session the signal result stands on its own.
 */
export async function kill(session: Session, deps: KillDeps = defaultKillDeps): Promise<ActionResult> {
  const signalled = deps.signal(session.pid);

  if (session.tmux) {
    const killed = await deps.killTmuxSession(session.tmux.session);
    if (killed.code === 0 || signalled.ok) return { ok: true };
    // Both failed: the session was already gone AND the process couldn't be signalled.
    return { ok: false, error: killed.stderr.trim() || signalled.error || "tmux kill-session failed" };
  }

  return signalled;
}

/** Run a git command in a session's worktree. Network ops pass a longer timeout. */
function git(cwd: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
  return run("git", ["-C", cwd, ...args], { timeoutMs });
}

/**
 * The remote's default-branch ref to reset onto - "origin/main" for most repos.
 * Prefers origin's own HEAD symbolic-ref (survives a repo whose default is
 * `master` or otherwise renamed), falling back to the common names. Deliberately
 * remote-only: a reset pulls from origin, so a stale *local* main is never a
 * valid target (unlike the diff's source ref, which may fall back to local).
 */
async function remoteDefaultRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim(); // e.g. "origin/main"
  for (const ref of ["origin/main", "origin/master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.code === 0 && r.stdout.trim()) return ref;
  }
  return null;
}

/**
 * Fetch origin, then report what a hard reset onto its default branch would
 * permanently discard: uncommitted tracked edits, untracked files (which the
 * follow-up `git clean` removes), and local commits ahead of the target. The
 * fetch is what makes "commits ahead" honest against the *current* remote; a
 * fetch failure is a hard error so the confirm dialog never understates the loss.
 */
export async function resetPreview(session: Session): Promise<ResetPreview> {
  const base: ResetPreview = {
    ok: false, error: null, target: null, branch: session.gitBranch,
    dirtyFiles: 0, untrackedFiles: 0, aheadCommits: 0, aheadSubjects: [],
    clean: false, canClear: Boolean(session.tmux || session.wezterm),
  };
  if (!session.cwd) return { ...base, error: "session has no working directory" };
  // Anchor every git op at the worktree top, not the pane's (possibly nested)
  // cwd - `clean` is relative to its cwd, so from a subdir it would miss
  // untracked files elsewhere in the repo that the reset would otherwise strip.
  const top = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return { ...base, error: "not a git repository" };
  const root = top.stdout.trim();

  const fetched = await git(root, ["fetch", "origin"], 30000);
  if (fetched.code !== 0) {
    return { ...base, error: `could not fetch origin: ${fetched.stderr.trim() || "fetch failed"}` };
  }
  const target = await remoteDefaultRef(root);
  if (!target) return { ...base, error: "no origin/main (or origin/master) to reset to" };

  // Split the porcelain status into untracked ("??") vs dirty tracked lines.
  let dirtyFiles = 0;
  let untrackedFiles = 0;
  for (const line of (await git(root, ["status", "--porcelain"])).stdout.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untrackedFiles++;
    else dirtyFiles++;
  }

  // Commits on this branch but not on the target - discarded by the hard reset.
  const aheadCommits = Number((await git(root, ["rev-list", "--count", `${target}..HEAD`])).stdout.trim()) || 0;
  const aheadSubjects = aheadCommits
    ? (await git(root, ["log", "--format=%s", "-n", "10", `${target}..HEAD`])).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const clean = dirtyFiles === 0 && untrackedFiles === 0 && aheadCommits === 0;
  return { ...base, ok: true, target, dirtyFiles, untrackedFiles, aheadCommits, aheadSubjects, clean };
}

/**
 * Pull latest and hard-reset the session's checkout to origin's default branch,
 * then (optionally) clear the agent's context with `/clear`. Order matters: fetch
 * first so we reset onto the *current* remote; `reset --hard` moves the branch
 * and tracked files; `git clean -fd` drops untracked files/dirs so the worktree
 * matches origin exactly (ignored files - node_modules, .env - are kept). The
 * `/clear` is best-effort: the git reset has already landed, so a session with no
 * pane just reports `cleared: false` rather than failing the whole operation.
 */
export async function resetToOrigin(session: Session, clear: boolean): Promise<ResetResult> {
  if (!session.cwd) return { ok: false, error: "session has no working directory", root: null, cleared: false };
  // Run at the worktree top so `reset` and `clean` cover the same (whole) tree -
  // `clean` is relative to its cwd, so a nested pane cwd would leave stray
  // untracked files behind, defeating "make the worktree match origin".
  const top = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) {
    return { ok: false, error: "not a git repository", root: null, cleared: false };
  }
  const root = top.stdout.trim();

  const fetched = await git(root, ["fetch", "origin"], 30000);
  if (fetched.code !== 0) {
    const error = `could not fetch origin: ${fetched.stderr.trim() || "fetch failed"}`;
    return { ok: false, error, root, cleared: false };
  }
  const target = await remoteDefaultRef(root);
  if (!target) {
    return { ok: false, error: "no origin/main (or origin/master) to reset to", root, cleared: false };
  }

  const reset = await git(root, ["reset", "--hard", target]);
  if (reset.code !== 0) {
    return { ok: false, error: reset.stderr.trim() || "git reset failed", root, cleared: false };
  }
  const cleaned = await git(root, ["clean", "-fd"]);
  if (cleaned.code !== 0) {
    return { ok: false, error: cleaned.stderr.trim() || "git clean failed", root, cleared: false };
  }

  if (!clear) return { ok: true, error: null, root, cleared: false };
  const sent = await sendText(session, "/clear", true);
  return { ok: true, error: null, root, cleared: sent.ok };
}
