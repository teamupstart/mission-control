import type { PermissionMode, ResetPreview, ResetResult, Session, Task } from "@shared/types.ts";
import { resolveWeztermBin } from "./config.ts";
import { capturePaneText } from "./discovery/pane-capture.ts";
import { readPaneModeLine, type PaneModeLine } from "./discovery/pane-mode.ts";
import { hasPendingPaste } from "./discovery/pane-paste.ts";
import { optionRowMiss, readPaneDialog, type OptionRowMiss, type PaneDialog } from "./discovery/pane-dialog.ts";
import { listTmuxClients } from "./discovery/tmux.ts";
import {
  activateWeztermPane,
  findSessionHostPane,
  findSessionHostPanes,
  listWeztermPanes,
  setWeztermTabTitle,
  spawnWeztermTab,
  type WeztermPane,
} from "./discovery/wezterm.ts";
import { run, type RunResult } from "./util/exec.ts";
import { sleep } from "./util/timers.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Shared error when a session has no pane handle we can drive. */
const NO_HANDLE = "session has no tmux or wezterm handle to send to";

/** Shared error when another write already owns this pane. */
const PANE_BUSY = "another write is already in flight for this session's pane";

/** Panes with a write in flight, so two writers can't interleave keystrokes. */
const driving = new Set<string>();

/**
 * The pane a session's writes land on, or null when it has no handle.
 *
 * Keyed on the PANE and not on `session.id`, because the pane is the thing being
 * protected and the id is not stable: it's synthetic for an uninstrumented session
 * and churns as pids/ttys change, so two reads of "the same session" can key
 * differently while addressing one pane. tmux wins when both exist, exactly as every
 * write below resolves its target.
 */
function paneKey(s: Pick<Session, "tmux" | "wezterm">): string | null {
  if (s.tmux) return `tmux:${s.tmux.paneId}`;
  if (s.wezterm) return `wezterm:${s.wezterm.paneId}`;
  return null;
}

/**
 * Serialize writes to one pane. Every public write below goes through this.
 *
 * It began life narrower - one set guarding permission-mode cycling, where two
 * concurrent Shift+Tab walks would step on each other's readback. The hazard was
 * always broader than that: NOTHING stopped a Foreman auto-wrapup and a dashboard
 * send from interleaving into one pane, producing a prompt that is neither of the
 * two things anyone asked to send. It was merely unlikely, because every writer was
 * downstream of a person.
 *
 * The skills reload loop is what makes it likely. It is the first writer that types
 * into MANY panes on its own schedule, so for the first time two writers can pick
 * the same pane at the same moment with nobody involved. Widening the guard is
 * cheaper than reasoning about which pairs can collide.
 *
 * A refusal is a REFUSAL, not a wait: the loser reports busy and its caller decides.
 * Queueing would hold a keystroke behind a walk that reads the pane between every
 * step, and deliver it into a session that has moved on since.
 *
 * Sessions with no pane skip the lock entirely - the write itself answers with
 * NO_HANDLE, which is the honest error, and a null key must not collide with
 * another handleless session's.
 *
 * Exported for its tests. Every writer below is a real subprocess, so the guard's own
 * semantics - who wins, who is refused, and whether the key is ever left held - can
 * only be asserted here.
 */
export async function withPaneLock<T>(
  session: Pick<Session, "tmux" | "wezterm">,
  busy: () => T,
  write: () => Promise<T>,
): Promise<T> {
  const key = paneKey(session);
  if (key === null) return write();
  if (driving.has(key)) return busy();
  driving.add(key);
  try {
    return await write();
  } finally {
    driving.delete(key);
  }
}

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
  return withPaneLock<ActionResult>(session, () => ({ ok: false, error: PANE_BUSY }), () => sendTextLocked(session, text, submit));
}

async function sendTextLocked(session: Session, text: string, submit: boolean): Promise<ActionResult> {
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
 * The outcome of a prompt delivery, plus the one thing a failed caller cannot
 * work out for itself: did any text reach the pane?
 *
 * Delivery is a NON-ATOMIC sequence (buffer -> paste -> Enter), so `ok: false` is
 * not proof that nothing landed. When `pasted` is true the text may be sitting
 * unsubmitted in the pane, and re-delivering would paste a second copy after the
 * first and mangle the prompt. Only `pasted: false` is positive evidence of
 * non-delivery, and therefore the only state a caller may safely retry from.
 */
export interface InjectResult extends ActionResult {
  pasted: boolean;
}

/**
 * How long to let a bracketed paste settle before pressing Enter.
 *
 * Claude COALESCES input for a window after a multi-line paste - that is what
 * powers its "paste again to expand" affordance - and an Enter that arrives
 * inside the window is absorbed into the paste instead of submitting it. Sending
 * the two back-to-back, as this did, put the Enter inside that window every time:
 * every multi-line dispatch pasted its prompt and then sat there unsubmitted.
 *
 * Measured against Claude Code 2.1.215: swallowed at 0/50/100/200ms, submitted at
 * 300/400/500ms. 400 sits a comfortable margin past the boundary while staying far
 * under the dispatch accept timeout.
 *
 * This is a fast path, NOT the guarantee - the window is Claude's, undocumented,
 * and free to move. `awaitPasteSubmitted` is what actually settles it.
 */
const PASTE_SETTLE_MS = 400;

/** How long to wait for the composer to clear after an Enter before re-pressing it. */
const SUBMIT_TIMEOUT_MS = 1200;
/** How often to re-read the pane while waiting for that. */
const SUBMIT_POLL_MS = 60;
/**
 * That wait, expressed as a count of reads rather than a wall-clock deadline.
 *
 * Deliberately not `Date.now()`: the waiting here is done by an injected `sleep`, and
 * a clock the injection can't move would make the loop spin against real time in
 * tests - burning seconds to observe a sequence that has no reason to be slow.
 */
const SUBMIT_POLLS = Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS);
/**
 * How many Enters one delivery may spend. The first should do it; the rest cover a
 * coalescing window longer than `PASTE_SETTLE_MS` on a loaded machine. A backstop,
 * not a budget - each one is gated on seeing the paste still pending.
 */
const MAX_SUBMIT_ENTERS = 3;

/**
 * The seam every write in `injectPrompt` goes through, so its SEQUENCE can be
 * asserted. The order of paste, settle, Enter, and re-read is the entire fix, and
 * an order no test can see is one that quietly stops being true.
 */
export interface InjectDeps {
  exec: (bin: string, args: string[]) => Promise<RunResult>;
  capture: (session: Session) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
}

const defaultInjectDeps: InjectDeps = {
  exec: (bin, args) => run(bin, args),
  capture: capturePaneText,
  sleep,
};

/**
 * Press Enter until the pasted text is no longer sitting in the composer.
 *
 * Every Enter after the first is gated on SEEING the collapsed-paste placeholder,
 * which is why this is a retry and not a hammer. The distinction matters: an
 * ungated second Enter is exactly the keystroke that answers a permission dialog
 * nobody read (see `reload.ts`), whereas a visible placeholder is proof the
 * composer has focus and Enter can only submit what we just pasted.
 *
 * Re-pressing Enter is also the ONLY safe recovery. Re-pasting is what a caller
 * would otherwise reach for, and it is destructive: a second paste onto a collapsed
 * placeholder EXPANDS it and appends a second copy, so the agent reads a doubled,
 * still-unsubmitted prompt. Enter is idempotent where paste is not.
 *
 * Reports true when the paste is gone from the composer, false when it outlasted
 * every attempt. A capture we can't read is not evidence of a stuck paste, so it
 * ends the loop rather than spending an unaimed keystroke on it.
 */
async function awaitPasteSubmitted(
  session: Session,
  pressEnter: () => Promise<ActionResult>,
  deps: InjectDeps,
): Promise<ActionResult> {
  for (let attempt = 1; attempt <= MAX_SUBMIT_ENTERS; attempt++) {
    const entered = await pressEnter();
    if (!entered.ok) return entered;

    for (let poll = 0; poll < SUBMIT_POLLS; poll++) {
      if (poll > 0) await deps.sleep(SUBMIT_POLL_MS);
      if (!hasPendingPaste(await deps.capture(session))) return { ok: true };
    }
  }
  return { ok: false, error: PASTE_NOT_SUBMITTED };
}

const PASTE_NOT_SUBMITTED =
  "the prompt was pasted but Claude never took the Enter - it is sitting in the composer unsubmitted";

/**
 * Deliver a whole prompt (possibly multi-line) into a session's input as a single
 * submission. Unlike `sendText`, newlines here must NOT each submit - so we send
 * the body via bracketed paste (tmux `paste-buffer -p` / wezterm's default paste),
 * which agent TUIs treat as one pasted block, then submit it with Enter. Used by
 * dispatch to seed an agent's first task, and by the work queue to deliver an item.
 *
 * The Enter is NOT sent on the paste's heels, and that is load-bearing: Claude
 * coalesces input for a window afterwards and absorbs an Enter that arrives inside
 * it, which used to leave every multi-line prompt pasted-but-unsubmitted. We let
 * the paste settle, submit, then read the pane back to confirm the composer
 * actually emptied - see `PASTE_SETTLE_MS` and `awaitPasteSubmitted`.
 *
 * Reports which PHASE failed via `pasted`, because the two failures mean opposite
 * things to a caller: a paste that never happened is retryable, while a paste that
 * landed and then failed to submit must not be retyped over. Note that the second
 * of those is now RARE rather than routine, and it is reported honestly instead of
 * being returned as a success the agent never saw.
 */
export async function injectPrompt(
  session: Session,
  text: string,
  deps: InjectDeps = defaultInjectDeps,
): Promise<InjectResult> {
  // A refusal here is `pasted: false`, and that is the contract doing its job rather
  // than a detail: the lock turns a would-be write away BEFORE any byte reaches the
  // pane, which is precisely the positive evidence of non-delivery a caller is
  // allowed to retry from.
  return withPaneLock<InjectResult>(
    session,
    () => ({ ok: false, error: PANE_BUSY, pasted: false }),
    () => injectPromptLocked(session, text, deps),
  );
}

async function injectPromptLocked(
  session: Session,
  text: string,
  deps: InjectDeps,
): Promise<InjectResult> {
  const cmd = async (bin: string, args: string[], failMsg: string): Promise<ActionResult> =>
    check(await deps.exec(bin, args), failMsg);

  if (session.tmux) {
    const target = session.tmux.paneId;
    const buf = `harness-${target.replace(/[^a-zA-Z0-9]/g, "")}`;
    const set = await cmd("tmux", ["set-buffer", "-b", buf, "--", text], "tmux set-buffer failed");
    if (!set.ok) return { ...set, pasted: false };
    // -p: bracketed paste (so embedded newlines don't submit); -d: drop the buffer after.
    // A non-zero exit here means tmux couldn't resolve the buffer or the pane, both
    // of which it checks BEFORE writing: nothing reached the pane.
    const paste = await cmd(
      "tmux",
      ["paste-buffer", "-p", "-d", "-b", buf, "-t", target],
      "tmux paste-buffer failed",
    );
    if (!paste.ok) return { ...paste, pasted: false };
    // Past this point the text IS in the pane, submitted or not.
    await deps.sleep(PASTE_SETTLE_MS);
    const submitted = await awaitPasteSubmitted(
      session,
      () => cmd("tmux", ["send-keys", "-t", target, "Enter"], "tmux Enter failed"),
      deps,
    );
    return { ...submitted, pasted: true };
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const id = String(session.wezterm.paneId);
    // Omitting --no-paste makes wezterm send the text as a bracketed paste.
    const pasted = await cmd(bin, ["cli", "send-text", "--pane-id", id, text], "wezterm send-text failed");
    if (!pasted.ok) return { ...pasted, pasted: false };
    await deps.sleep(PASTE_SETTLE_MS);
    const enterArgs = ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"];
    const submitted = await awaitPasteSubmitted(
      session,
      () => cmd(bin, enterArgs, "wezterm Enter failed"),
      deps,
    );
    return { ...submitted, pasted: true };
  }
  return { ok: false, error: NO_HANDLE, pasted: false };
}

/**
 * Inject one Shift+Tab into a Claude session's pane - the exact keystroke a human
 * presses in the TUI, so it advances the permission mode one step exactly as it
 * would live. There is no API to set the mode, so this simulated keypress is the
 * only mechanism.
 *
 * A successful injection only proves the bytes reached the pane. It does NOT mean
 * Claude cycled: if the session isn't at its normal prompt (a permission dialog, a
 * slash-command menu) Claude binds Tab itself and swallows this. Callers must read
 * the pane back to learn where the mode actually landed - see `readPaneModeLine`.
 *
 * tmux resolves the `BTab` key name to the terminal's back-tab sequence; wezterm
 * takes the raw sequence, so we send CSI Z (ESC [ Z) - the standard Shift+Tab code.
 */
async function injectShiftTab(session: Session): Promise<ActionResult> {
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

/** Result of a mode change: the mode the pane was actually in when we stopped. */
export interface ModeResult extends ActionResult {
  /** Observed from the pane, not assumed. Null when we couldn't read it. */
  mode?: PermissionMode | null;
}

/** How long to wait for the TUI to repaint after a Shift+Tab before calling it swallowed. */
const REPAINT_TIMEOUT_MS = 900;
/** How often to re-read the pane while waiting for that repaint. */
const REPAINT_POLL_MS = 50;
/**
 * Cap on Shift+Tabs per request. The longest cycle Claude has is five
 * (manual, accept edits, plan, bypass, auto), so anything beyond six steps means
 * loop detection already should have fired - this is a backstop, not a budget.
 */
const MAX_CYCLE_STEPS = 6;

/** Wait for the pane's mode line to differ from `prev`, or null if it never does. */
async function awaitModeLineChange(session: Session, prev: string): Promise<PaneModeLine | null> {
  const deadline = Date.now() + REPAINT_TIMEOUT_MS;
  for (;;) {
    const line = await readPaneModeLine(session);
    if (line && line.text !== prev) return line;
    if (Date.now() >= deadline) return null;
    await sleep(REPAINT_POLL_MS);
  }
}

/**
 * Advance a Claude session's permission mode one step, reporting the mode it
 * actually landed on rather than guessing at it.
 */
export async function cyclePermissionMode(session: Session): Promise<ModeResult> {
  return withPaneLock<ModeResult>(session, () => ({ ok: false, error: PANE_BUSY }), () => cycleLocked(session));
}

async function cycleLocked(session: Session): Promise<ModeResult> {
  const before = await readPaneModeLine(session);
  const sent = await injectShiftTab(session);
  if (!sent.ok) return sent;
  // With no line to compare against we can't tell a repaint from a no-op, so
  // report the mode as unknown and let the next poll's read settle the chip.
  if (!before) return { ok: true, mode: null };
  const after = await awaitModeLineChange(session, before.text);
  return after ? { ok: true, mode: after.mode } : { ok: true, mode: before.mode };
}

/**
 * Drive a Claude session to a specific permission mode.
 *
 * Shift+Tab is the only lever, and it only steps forward - so reaching a chosen
 * mode means walking the cycle to it. We can't precompute how far: the optional
 * `bypassPermissions`/`auto` modes slot in after `plan` only when flags and
 * account settings we can't observe enable them, so the cycle's length is unknown
 * until we walk it. Instead of counting steps we read the pane after each one,
 * which makes every step self-verifying and needs no model of the cycle at all.
 *
 * Three ways this stops short, each fail-safe:
 *   - No mode line to start from. A dialog or menu is foreground, where Claude
 *     binds Tab itself and would swallow the keystroke (or worse, act on it). We
 *     refuse rather than fire blind keystrokes at a dialog.
 *   - The line doesn't change within `REPAINT_TIMEOUT_MS`. Something ate the
 *     keystroke; stop rather than hammer.
 *   - We come back to a mode line we've already seen. The cycle is a loop, so
 *     this means the target isn't in it - and, because it's a loop, walking it
 *     fully has landed us back where we started. Nothing to undo.
 */
export async function setPermissionMode(session: Session, target: PermissionMode): Promise<ModeResult> {
  if (!session.tmux && !session.wezterm) return { ok: false, error: NO_HANDLE };
  return withPaneLock<ModeResult>(session, () => ({ ok: false, error: PANE_BUSY }), () => walkToMode(session, target));
}

async function walkToMode(session: Session, target: PermissionMode): Promise<ModeResult> {
  let line = await readPaneModeLine(session);
  if (!line) return { ok: false, error: CANNOT_SEE_MODE, mode: null };
  if (line.mode === target) return { ok: true, mode: target };

  // Keyed on the line text, not the parsed mode, so a mode this build doesn't
  // recognize is still a distinct position we can step through and loop on.
  const seen = new Set<string>([line.text]);
  for (let i = 0; i < MAX_CYCLE_STEPS; i++) {
    const sent = await injectShiftTab(session);
    if (!sent.ok) return { ...sent, mode: line.mode };
    const next = await awaitModeLineChange(session, line.text);
    if (!next) return { ok: false, error: SWALLOWED, mode: line.mode };
    if (next.mode === target) return { ok: true, mode: target };
    if (seen.has(next.text)) return { ok: false, error: notInCycle(target), mode: next.mode };
    seen.add(next.text);
    line = next;
  }
  return { ok: false, error: notInCycle(target), mode: line.mode };
}

const CANNOT_SEE_MODE =
  "can't see Claude's mode line - a dialog or menu is probably open in this session";
const SWALLOWED = "Claude ignored Shift+Tab - a dialog may have opened in this session";

/** The row a caller wants selected: the number Claude printed, and the label it read there. */
export interface OptionTarget {
  number: number;
  /** The row's label as the caller read it, re-checked against the screen before any Enter. */
  label: string;
}

/** How many arrow presses one selection may spend. A menu's rows are few; this is a backstop. */
const MAX_ARROW_STEPS = 12;

/** Send one arrow key to a pane. tmux takes the key name; wezterm takes the raw CSI sequence. */
async function injectArrow(session: Session, dir: "Up" | "Down"): Promise<ActionResult> {
  if (session.tmux) {
    // No -l: `Up`/`Down` are tmux key names, not literal text to type.
    return step("tmux", ["send-keys", "-t", session.tmux.paneId, dir], `tmux send-keys ${dir} failed`);
  }
  if (session.wezterm) {
    const bin = resolveWeztermBin();
    const seq = dir === "Down" ? "\x1b[B" : "\x1b[A";
    const args = ["cli", "send-text", "--pane-id", String(session.wezterm.paneId), "--no-paste", seq];
    return step(bin, args, `wezterm send-text (${dir}) failed`);
  }
  return { ok: false, error: NO_HANDLE };
}

/** Wait for the menu's cursor to leave `from`, or null if it never does. */
async function awaitCursorMove(session: Session, from: number): Promise<PaneDialog | null> {
  const deadline = Date.now() + REPAINT_TIMEOUT_MS;
  for (;;) {
    const d = await readPaneDialog(session);
    if (d && d.highlighted !== from) return d;
    if (Date.now() >= deadline) return null;
    await sleep(REPAINT_POLL_MS);
  }
}

/**
 * Answer an option dialog the way a human does: walk the cursor onto a row, then press
 * Enter. This is the ONLY correct way to answer one - see `pane-dialog.ts` for what typing
 * prose at a menu actually does (it is swallowed, and the Enter confirms the default).
 *
 * Every step is verified against the screen rather than counted out, because a menu is not
 * ours: the cursor may not start at row 1, an arrow may be swallowed, and the child may
 * repaint or close the dialog between our reading it and our answering it. So the rule this
 * holds to is that Enter is pressed ONLY while the pane is showing the intended row
 * selected, confirmed by a read taken after the last keystroke.
 *
 * That makes every failure here a no-op by construction. Arrows alone commit nothing - a
 * menu with the cursor moved is a menu still waiting - so returning `ok: false` at any point
 * before the Enter leaves the child exactly as it was found, still parked on its question,
 * for the caller to escalate to the human. The one thing this must never do is confirm a
 * row it did not verify, which is the bug it exists to close.
 */
export async function selectPaneOption(session: Session, target: OptionTarget): Promise<ActionResult> {
  if (!session.tmux && !session.wezterm) return { ok: false, error: NO_HANDLE };
  // Shares the mode-walk's lock: both drive the same pane with bare keystrokes, and
  // interleaving them would land arrows in a dialog the other opened. It has to be the
  // SAME lock, keyed the same way (on the pane, not the session), or the exclusion is
  // nil in both directions - a concurrent `sendText`'s trailing Enter would confirm
  // whatever row this walk is passing through.
  return withPaneLock<ActionResult>(
    session,
    () => ({ ok: false, error: PANE_BUSY }),
    () => selectOptionLocked(session, target),
  );
}

async function selectOptionLocked(session: Session, target: OptionTarget): Promise<ActionResult> {
  let dialog = await readPaneDialog(session);
  if (!dialog) return { ok: false, error: NO_MENU };
  // The number alone is a position; the label is what makes it an ANSWER. If the screen
  // doesn't read as the row we were told to answer, the menu on it isn't that menu, and
  // pressing Enter would confirm whatever replaced it.
  const miss = optionRowMiss(dialog, target);
  if (miss) return { ok: false, error: describeMiss(miss, dialog, target) };

  for (let i = 0; dialog.highlighted !== target.number; i++) {
    if (i >= MAX_ARROW_STEPS) return { ok: false, error: "could not walk the cursor onto that option" };
    const dir = target.number > dialog.highlighted ? "Down" : "Up";
    const sent = await injectArrow(session, dir);
    if (!sent.ok) return sent;
    const moved = await awaitCursorMove(session, dialog.highlighted);
    // The cursor didn't move: the dialog closed under us, or it ate the arrow. Either
    // way we no longer know what Enter would confirm, so we don't press it.
    if (!moved) return { ok: false, error: "Claude ignored the arrow key - the menu may have closed" };
    dialog = moved;
  }

  // Read once more rather than trusting the walk: this is the last look before the only
  // irreversible keystroke in the function.
  const final = await readPaneDialog(session);
  if (!final || final.highlighted !== target.number || optionRowMiss(final, target)) {
    return { ok: false, error: "the menu changed before the selection could be confirmed" };
  }
  return injectEnter(session);
}

/** Say which way the screen failed to be the menu we were told to answer. */
function describeMiss(miss: OptionRowMiss, dialog: PaneDialog, target: OptionTarget): string {
  switch (miss) {
    case "no-such-row":
      return `this menu has no option ${target.number}`;
    case "label-differs": {
      const row = dialog.options.find((o) => o.number === target.number);
      return `option ${target.number} now reads "${row?.label}" - the screen changed`;
    }
    case "label-ambiguous":
      return `"${target.label}" reads the same as another row on this menu`;
  }
}

const NO_MENU = "no option menu is on this session's screen";

/** Press Enter, with no text before it - the confirm half of a menu selection. */
async function injectEnter(session: Session): Promise<ActionResult> {
  if (session.tmux) {
    return step("tmux", ["send-keys", "-t", session.tmux.paneId, "Enter"], "tmux Enter failed");
  }
  const bin = resolveWeztermBin();
  const id = String(session.wezterm!.paneId);
  return step(bin, ["cli", "send-text", "--pane-id", id, "--no-paste", "\r"], "wezterm Enter failed");
}

/** Explain an unreachable target, naming the flag that would put it in the cycle. */
function notInCycle(target: PermissionMode): string {
  const why: Partial<Record<PermissionMode, string>> = {
    auto: "auto isn't enabled for this session - it needs an account and model that support it",
    bypassPermissions:
      "bypass isn't enabled for this session - it needs Claude started with --dangerously-skip-permissions",
    dontAsk: "don't-ask can't be reached by Shift+Tab - it's only settable at startup",
  };
  return why[target] ?? `${target} isn't in this session's Shift+Tab cycle`;
}

/**
 * Validate a proposed session name against the handle that backs it, returning the
 * trimmed name or a human-readable reason it's rejected. Kept pure (no exec) so the
 * route can answer a bad name with a 400 and it can be unit-tested directly. tmux
 * is the handle we rename when present (as in `sendText`/`rename`), so its stricter
 * naming rules apply whenever the session has a tmux pane.
 */
export function validateSessionName(
  session: Pick<Session, "tmux" | "wezterm">,
  rawName: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "name can't be empty" };
  // A newline would submit/split in a tmux name or a terminal title; other control
  // chars are meaningless in a display name. Reject them for either handle.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, error: "name can't contain control characters" };
  }
  if (!session.tmux && !session.wezterm) {
    return { ok: false, error: "this session has no tmux or wezterm pane to rename" };
  }
  // tmux session names may not contain a period or colon - both are separators in
  // tmux target specs (`session:window.pane`), so `rename-session` refuses them.
  if (session.tmux && /[.:]/.test(name)) {
    return { ok: false, error: "a tmux session name can't contain '.' or ':'" };
  }
  // A leading '$' is tmux's session-ID sigil: `-t '$0'` resolves by ID and never
  // falls back to a name lookup, so a session named `$0` would make focus/kill
  // target whichever session holds ID 0 instead of this one.
  if (session.tmux && /^\$/.test(name)) {
    return { ok: false, error: "a tmux session name can't start with '$'" };
  }
  return { ok: true, name };
}

/**
 * Refuse a rename that would move this tmux session ONTO a name a task still
 * records. Pairs with `validateSessionName` on the route's 400 path: the name rules
 * there are pure characters, this one needs task state, so the two stay separate and
 * the route (which holds the task list) runs both.
 *
 * `Task.tmuxSession` is a second copy of the name, and it aims destructive teardown:
 * `teardownWorktree` runs `tmux kill-session -t tmuxSession`, and `reconcileOnStartup`
 * probes it to decide whether to reclaim the worktree. That copy outlives its session
 * - a `done` task keeps it until an explicit reclaim, while tmux frees a dead
 * session's name for immediate reuse - so a name no LIVE session holds can still be
 * spoken for. Taking it would re-aim that task's Reclaim at this live agent, or
 * convince the reconciler the dead task's agent survived and leak its tree.
 *
 * Scoped to tasks still holding a worktree, since those are the ones teardown can
 * still fire for; reclaim/cancel clear the worktree and the name together, so a
 * retired task frees its name here too. A task holding THIS session's worktree is
 * its own binding rather than a collision - it follows the rename in
 * `Registry.renameSession`.
 */
export function validateSessionNameAgainstTasks(
  session: Pick<Session, "tmux" | "cwd">,
  name: string,
  tasks: readonly Pick<Task, "tmuxSession" | "worktreePath">[],
): { ok: true } | { ok: false; error: string } {
  // Only a tmux rename moves a name teardown targets - a wezterm tab title is
  // free-form and no task binds to it.
  if (!session.tmux) return { ok: true };
  const collides = tasks.some(
    (t) => t.worktreePath !== null && t.tmuxSession === name && t.worktreePath !== session.cwd,
  );
  return collides
    ? { ok: false, error: `another task still holds the tmux session name '${name}'` }
    : { ok: true };
}

/**
 * Side effects `rename` performs, injectable so tests can assert the branching
 * (tmux vs wezterm) without renaming a real tmux session or shelling out.
 */
export interface RenameDeps {
  /** `tmux rename-session -t <from> -- <to>`. */
  renameTmuxSession: (from: string, to: string) => Promise<RunResult>;
  /** `wezterm cli set-tab-title --pane-id <id> -- <title>`. */
  setWeztermTabTitle: (paneId: number, title: string) => Promise<RunResult>;
  /** The wezterm panes whose tabs host a tmux client attached to `session`. */
  findTmuxHostPanes: (session: string) => Promise<WeztermPane[]>;
}

const defaultRenameDeps: RenameDeps = {
  // `--` ends flag parsing so a name like "-wip" is read as the new name rather
  // than as a flag bundle (which would surface an arg-parser dump behind a 500).
  renameTmuxSession: (from, to) => run("tmux", ["rename-session", "-t", from, "--", to]),
  setWeztermTabTitle,
  findTmuxHostPanes: async (session) => {
    const [clients, panes] = await Promise.all([listTmuxClients(), listWeztermPanes()]);
    return findSessionHostPanes(session, clients, panes);
  },
};

/**
 * Rename a session's terminal home so the next discovery sweep reads the new name
 * back onto its card, and so the terminal tab the user is looking at agrees.
 *
 * A wezterm-hosted session is one call: its tab title IS its card name. A
 * tmux-hosted one takes two, because its name lives in two places the harness
 * has to keep in step:
 *
 *   - the tmux session name, which is the card name (`nameSource: "tmux"`), and
 *     what Focus/Kill target; and
 *   - the title of the wezterm tab running `tmux attach`, which `spawnWeztermTab`
 *     stamped once at spawn and nothing has updated since.
 *
 * The tab is NOT reachable via `session.wezterm` - that handle is keyed on the
 * agent's tty, and an agent inside tmux sits on a tmux pane tty while its tab
 * sits on the client tty, so a tmux-hosted session's `wezterm` is always null.
 * We find the tab the way Focus does, by joining tmux clients to wezterm panes
 * on that shared client tty. Skipping this was the whole bug: renames landed in
 * tmux while every tab kept its spawn-time title forever.
 *
 * Assumes `name` was already validated - the route calls `validateSessionName`
 * first so a bad name is a 400, not a shelled-out failure.
 */
export async function rename(
  session: Session,
  name: string,
  deps: RenameDeps = defaultRenameDeps,
): Promise<ActionResult> {
  if (session.tmux) {
    const from = session.tmux.session;
    // Resolve the tabs BEFORE the rename, while they still answer to `from` -
    // after it, this lookup would have to guess which name tmux now reports.
    const hosts = await deps.findTmuxHostPanes(from);
    const renamed = check(await deps.renameTmuxSession(from, name), "tmux rename-session failed");
    if (!renamed.ok) return renamed;
    // Best-effort: the tmux name is the card's source of truth and it already
    // moved, so a tmux-only user (or a wezterm GUI that just went away) gets the
    // rename they asked for rather than a failure over a cosmetic tab title.
    for (const h of hosts) await deps.setWeztermTabTitle(h.paneId, name);
    return renamed;
  }
  if (session.wezterm) {
    return check(
      await deps.setWeztermTabTitle(session.wezterm.paneId, name),
      "wezterm set-tab-title failed",
    );
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
export async function remoteDefaultRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim(); // e.g. "origin/main"
  for (const ref of ["origin/main", "origin/master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.code === 0 && r.stdout.trim()) return ref;
  }
  return null;
}

/**
 * The local branch name behind a remote default ref - "origin/main" -> "main".
 *
 * `remoteDefaultRef` only ever answers with an `origin/`-qualified ref, so this is
 * a prefix strip and not a parse: splitting on "/" instead would read a repo whose
 * default is `release/next` as the branch `release`.
 */
function defaultBranchOf(remoteRef: string): string {
  return remoteRef.startsWith("origin/") ? remoteRef.slice("origin/".length) : remoteRef;
}

/**
 * Park a reset checkout on `target`'s commit with no branch checked out, and
 * report whether it now holds none.
 *
 * This is what makes a reset hand back a worktree ready for unrelated work rather
 * than one still standing on the finished task's branch. A reset alone moves the
 * branch's TIP to origin but keeps its NAME, and the name is the identity every
 * layer downstream keys on: `gh pr list --head <branch>` still matches the PR that
 * branch already has (so the card keeps a chip for work that's over - see
 * `pollAndReconcilePrs`, which retires it once the session moves off the branch),
 * and the next task's commits land on top of a branch whose PR is merged, where
 * no-mistakes sees a non-default branch and validates onto it.
 *
 * Detaching, rather than checking the default branch out, is the only option here:
 * a linked worktree cannot check out `main` while the main checkout holds it, and
 * git refuses rather than sharing. It is also exactly the state treehouse's pool
 * hands a fresh worktree out in, so this returns a reused session to the shape a
 * brand-new one starts in.
 *
 * Called AFTER the reset has landed, never before: the tree matches `target` by
 * then, so this is a pure HEAD move that cannot fail over local edits it would
 * otherwise have to carry across. The branch ref is left behind (pointing at
 * `target`, where the reset put it) - the commits it held are already gone by
 * design, and deleting the name outright would be a loss the confirm dialog never
 * warned about.
 */
async function releaseBranch(root: string, branch: string | null, target: string): Promise<boolean> {
  // Already standing on a commit - nothing holds the checkout, nothing to release.
  if (!branch) return true;
  // The default branch is the main checkout's resting state: no PR is keyed to it,
  // no-mistakes already forces a feature branch off it, and yanking the user's own
  // tree into detached HEAD is not a thing a reset should surprise them with.
  if (branch === defaultBranchOf(target)) return false;
  return (await git(root, ["checkout", "--detach", target])).code === 0;
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
 * release the branch it was holding, then (optionally) clear the agent's context
 * with `/clear`. Order matters: fetch first so we reset onto the *current* remote;
 * `reset --hard` moves the branch and tracked files; `git clean -fd` drops
 * untracked files/dirs so the worktree matches origin exactly (ignored files -
 * node_modules, .env - are kept); `releaseBranch` last, once the tree is pristine
 * and the detach is a pure HEAD move.
 *
 * Resetting the branch's tip without releasing its name is what left a reused
 * session holding a finished task's branch - keeping that branch's PR chip on the
 * card and inviting the next task's commits onto a merged PR's branch. See
 * `releaseBranch`.
 *
 * The last two steps are best-effort: the git reset has already landed by then, so
 * a session with no pane reports `cleared: false`, and a checkout that couldn't be
 * detached reports `detached: false`, rather than either failing the whole
 * operation and telling the caller a reset that DID happen did not.
 */
export async function resetToOrigin(session: Session, clear: boolean): Promise<ResetResult> {
  if (!session.cwd) {
    return { ok: false, error: "session has no working directory", root: null, cleared: false, detached: false };
  }
  // Run at the worktree top so `reset` and `clean` cover the same (whole) tree -
  // `clean` is relative to its cwd, so a nested pane cwd would leave stray
  // untracked files behind, defeating "make the worktree match origin".
  const top = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) {
    return { ok: false, error: "not a git repository", root: null, cleared: false, detached: false };
  }
  const root = top.stdout.trim();

  // The branch this checkout holds, or null when HEAD already names a commit.
  // `symbolic-ref` is the exact question, failing precisely when HEAD is detached;
  // `rev-parse --abbrev-ref HEAD` would answer the string "HEAD" there and read
  // back as a branch called HEAD. Read before the reset purely because it is free
  // to - a reset moves the branch's tip, never which branch is checked out.
  const held = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = held.code === 0 ? held.stdout.trim() : null;

  const fetched = await git(root, ["fetch", "origin"], 30000);
  if (fetched.code !== 0) {
    const error = `could not fetch origin: ${fetched.stderr.trim() || "fetch failed"}`;
    return { ok: false, error, root, cleared: false, detached: false };
  }
  const target = await remoteDefaultRef(root);
  if (!target) {
    return { ok: false, error: "no origin/main (or origin/master) to reset to", root, cleared: false, detached: false };
  }

  const reset = await git(root, ["reset", "--hard", target]);
  if (reset.code !== 0) {
    return { ok: false, error: reset.stderr.trim() || "git reset failed", root, cleared: false, detached: false };
  }
  const cleaned = await git(root, ["clean", "-fd"]);
  if (cleaned.code !== 0) {
    return { ok: false, error: cleaned.stderr.trim() || "git clean failed", root, cleared: false, detached: false };
  }
  const detached = await releaseBranch(root, branch, target);

  if (!clear) return { ok: true, error: null, root, cleared: false, detached };
  const sent = await sendText(session, "/clear", true);
  return { ok: true, error: null, root, cleared: sent.ok, detached };
}
