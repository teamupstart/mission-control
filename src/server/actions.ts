import type { Session } from "@shared/types.ts";
import { resolveWeztermBin } from "./config.ts";
import { listTmuxClients } from "./discovery/tmux.ts";
import {
  activateWeztermPane,
  findSessionHostPane,
  listWeztermPanes,
  spawnWeztermTab,
} from "./discovery/wezterm.ts";
import { run } from "./util/exec.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
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
    const r1 = await run("tmux", ["send-keys", "-t", target, "-l", text]);
    if (r1.code !== 0) return { ok: false, error: r1.stderr.trim() || "tmux send-keys failed" };
    if (submit) {
      const r2 = await run("tmux", ["send-keys", "-t", target, "Enter"]);
      if (r2.code !== 0) return { ok: false, error: r2.stderr.trim() || "tmux Enter failed" };
    }
    return { ok: true };
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    const r1 = await run(bin, ["cli", "send-text", "--pane-id", id, "--no-paste", text]);
    if (r1.code !== 0) return { ok: false, error: r1.stderr.trim() || "wezterm send-text failed" };
    if (submit) {
      const r2 = await run(bin, ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"]);
      if (r2.code !== 0) return { ok: false, error: r2.stderr.trim() || "wezterm Enter failed" };
    }
    return { ok: true };
  }
  return { ok: false, error: "session has no tmux or wezterm handle to send to" };
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
    const set = await run("tmux", ["set-buffer", "-b", buf, "--", text]);
    if (set.code !== 0) return { ok: false, error: set.stderr.trim() || "tmux set-buffer failed" };
    // -p: bracketed paste (so embedded newlines don't submit); -d: drop the buffer after.
    const paste = await run("tmux", ["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
    if (paste.code !== 0) return { ok: false, error: paste.stderr.trim() || "tmux paste-buffer failed" };
    const enter = await run("tmux", ["send-keys", "-t", target, "Enter"]);
    if (enter.code !== 0) return { ok: false, error: enter.stderr.trim() || "tmux Enter failed" };
    return { ok: true };
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    // Omitting --no-paste makes wezterm send the text as a bracketed paste.
    const r1 = await run(bin, ["cli", "send-text", "--pane-id", id, text]);
    if (r1.code !== 0) return { ok: false, error: r1.stderr.trim() || "wezterm send-text failed" };
    const r2 = await run(bin, ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"]);
    if (r2.code !== 0) return { ok: false, error: r2.stderr.trim() || "wezterm Enter failed" };
    return { ok: true };
  }
  return { ok: false, error: "session has no tmux or wezterm handle to send to" };
}

/** Bring the session's pane/tab into focus. */
export async function focus(session: Session): Promise<ActionResult> {
  if (session.wezterm) {
    const r = await activateWeztermPane(session.wezterm.tabId, session.wezterm.paneId);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "wezterm activate failed" };
    return { ok: true };
  }
  if (session.tmux) {
    const sess = session.tmux.session;
    const windowTarget = `${sess}:${session.tmux.windowIndex}`;
    // Point tmux at the agent's own pane/window. This only touches this
    // session's internal state, so whichever terminal shows it lands on the
    // right pane - and it never disturbs any other session.
    const rp = await run("tmux", ["select-pane", "-t", session.tmux.paneId]);
    if (rp.code !== 0) return { ok: false, error: rp.stderr.trim() || "tmux select-pane failed" };
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
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "wezterm activate failed" };
      return { ok: true };
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

/** Terminate the agent process (SIGTERM). The UI confirms before calling this. */
export function kill(session: Session): ActionResult {
  try {
    process.kill(session.pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
