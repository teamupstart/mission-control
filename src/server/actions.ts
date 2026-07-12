import type { Session } from "@shared/types.ts";
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

/** Terminate the agent process (SIGTERM). The UI confirms before calling this. */
export function kill(session: Session): ActionResult {
  try {
    process.kill(session.pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
