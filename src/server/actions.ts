import type { PermissionMode, ResetPreview, ResetResult, Session, Task } from "@shared/types.ts";
import type { FormOutcome } from "@shared/protocol.ts";
import { capturePaneText } from "./discovery/pane-capture.ts";
import { readPaneModeLine, type PaneModeLine } from "./discovery/pane-mode.ts";
import { hasPendingCommand, hasPendingPaste } from "./discovery/pane-paste.ts";
import { controlFor } from "./harness/index.ts";
import type { ControlSpec } from "./harness/types.ts";
import {
  hasUnansweredWarning,
  optionRowMiss,
  parsePaneDialog,
  submitAnswersRow,
  type OptionRowMiss,
  type PaneDialog,
  type PaneOption,
} from "./discovery/pane-dialog.ts";
import { dialogSpecFor, modeLineSpecFor, tuiFor } from "./harness/index.ts";
import { dialogIdentity } from "@shared/session.ts";
import { emulatorHandle, muxHandle, paneToken, type PaneHandles } from "@shared/pane.ts";
import { EMULATOR_IDS } from "@shared/terminal.ts";
import type { EmulatorHandle, MuxHandle } from "@shared/terminal.ts";
import { harnessFor } from "./harness/index.ts";
import { PLAIN_NAMES } from "./terminal/names.ts";
import {
  bindSession,
  defaultTerminalDeps,
  hostPanesFor,
  type BoundPane,
  type TerminalDeps,
} from "./terminal/registry.ts";
import type {
  EmulatorFocus,
  EmulatorPane,
  EmulatorTarget,
  Key,
  Multiplexer,
  NameRules,
  TerminalEmulator,
  TerminalResult,
} from "./terminal/types.ts";
import { run, type RunResult } from "./util/exec.ts";
import { sleep } from "./util/timers.ts";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /**
   * True when the write was refused because the pane is in a multiplexer mode that would
   * have swallowed it - see `paneWriteBlock`.
   *
   * Distinct from every other failure here because its CAUSE is a person, not a fault:
   * it clears when they leave the mode and it says nothing about the item, the session,
   * or the daemon. Callers that ration attempts must not spend one on it. The work
   * queue is the caller that matters - `SEND_ATTEMPT_CAP` would otherwise escalate an
   * item permanently after ~12 seconds of someone reading their own scrollback.
   *
   * It is NOT a synonym for "nothing landed": `pasted` still owns that question, and
   * the post-paste Enter is refused with `paneBlocked` set and `pasted: true`.
   */
  paneBlocked?: boolean;
}

/** Shared error when a session has no pane handle we can drive. */
const NO_HANDLE = "session has no terminal pane to send to";

/** Shared error when another write already owns this pane. */
const PANE_BUSY = "another write is already in flight for this session's pane";

/** Panes with a write in flight, so two writers can't interleave keystrokes. */
const driving = new Set<string>();

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
 * Keyed with `paneToken` rather than with the `BoundPane.token` the write itself
 * addresses, because this must be answerable without a subprocess seam - and the two
 * are pinned equal (`terminal-registry.test.ts`), which is what makes the lock guard
 * the pane the write lands on rather than some other one. Both resolve the innermost
 * handle; if they ever disagreed, a session with both handles would lock its emulator
 * pane while typing into its multiplexer pane, and the exclusion would be nil.
 *
 * Exported for its tests. Every writer below is a real subprocess, so the guard's own
 * semantics - who wins, who is refused, and whether the key is ever left held - can
 * only be asserted here.
 */
export async function withPaneLock<T>(
  session: PaneHandles,
  busy: () => T,
  write: () => Promise<T>,
): Promise<T> {
  const key = paneToken(session);
  if (key === null) return write();
  if (driving.has(key)) return busy();
  driving.add(key);
  try {
    return await write();
  } finally {
    driving.delete(key);
  }
}

/**
 * The seams a pane WRITE needs: the pane itself, and the read that verifies what it did.
 *
 * They travel together because every non-trivial write here is a read-write-read - the
 * mode probe, the keystroke, the confirmation - and a caller that can fake only one
 * half can drive none of them. `InjectDeps` is this plus a clock.
 *
 * The first seam is the PANE and no longer a command runner, which is what routing the
 * writes through the adapters bought. Two things it can now express that an `Exec` could
 * not:
 *
 *   - A test wanting real argv still gets it: `bindSession(session, fakeExec)` builds the
 *     genuine adapter on a fake subprocess, so `-- Enter` versus `\x1b[Z` is asserted
 *     against the code that emits it.
 *   - A test wanting a backend nobody has written yet supplies a `BoundPane` literal. The
 *     capability nulls - no `write`, no `paste`, no `mode` - are where a new backend
 *     degrades, and every one of them is now reachable before that backend exists rather
 *     than after it ships broken.
 */
export interface PaneDeps {
  pane: (session: PaneHandles) => BoundPane | null;
  capture: (session: Session) => Promise<string | null>;
}

const defaultPaneDeps: PaneDeps = {
  pane: (session) => bindSession(session),
  capture: capturePaneText,
};

/**
 * Say a pane is in a mode that swallows keystrokes, in the terms the person who has to
 * clear it needs.
 *
 * The backend NAMES itself (`BoundPane.label`) rather than being spelled "tmux" here: this
 * sentence is read by someone who has to go and leave that mode, and a refusal telling them
 * about a multiplexer they are not running is worse than no sentence at all.
 */
type DescribeMode = (backend: string, mode: string) => string;

const inModeError: DescribeMode = (backend, mode) =>
  `this pane is in ${backend} ${mode}, which swallows keystrokes before the agent sees them - nothing was sent. Leave ${mode} (q, or scroll to the bottom) and it will go through.`;

/**
 * The same, for the one keystroke whose refusal is NOT a clean no-op: the Enter that
 * submits a prompt already sitting in the composer.
 *
 * Every other refusal here means "nothing happened, try again later". This one means
 * "half of it happened", and saying so is the whole point - a human who reads the
 * generic wording would go looking for a prompt that never arrived, when in fact it is
 * on their screen waiting for the Enter the multiplexer took. The caller is told the same
 * thing structurally, via `pasted: true`, which is what stops it re-pasting a second copy.
 */
const inModeAfterPasteError: DescribeMode = (backend, mode) =>
  `this pane entered ${backend} ${mode} after the prompt was pasted, so the Enter that submits it was swallowed - the text is sitting in the composer, unsubmitted. Leave ${mode} (q, or scroll to the bottom) and press Enter to send it.`;

/**
 * Reduce a finished terminal operation to an `ActionResult`.
 *
 * `fallback` is only reached when a backend failed SILENTLY, which both shipped ones do for
 * an unresolvable target; an adapter that has something to say has already put it in
 * `error`. Optional because most callers here are reporting a write, where the pane's own
 * refusal is the whole message, while the lifecycle operations have a sentence of their own
 * worth falling back to.
 *
 * `outcomeUnknown` is deliberately dropped rather than carried. It exists so a WRITE can
 * tell "refused" from "never found out" and decide whether re-pasting is safe; a focus or a
 * rename that may or may not have landed has no such choice to make - it is reported as
 * failed, and the human clicks again.
 */
function fromTerminal(r: TerminalResult, fallback?: string): ActionResult {
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? fallback };
}

/**
 * Refused by declaration: this backend has no way to put keystrokes in a pane at all.
 *
 * Not a fault and not transient, so deliberately NOT `paneBlocked` - a caller that
 * rations attempts should spend one and give up rather than retry forever. Ghostty is
 * the case: a session can be discovered in it and brought forward, and never typed into.
 */
const cannotType = (pane: BoundPane): string =>
  `${pane.label} cannot type into a pane, so this session can only be read`;

/**
 * The same for a whole prompt: a backend with no bracketed paste has no way to deliver a
 * multi-line body as ONE submission, and typing it would submit at every newline - so the
 * delivery is refused rather than shredded into a dozen half-prompts.
 */
const cannotPaste = (pane: BoundPane): string =>
  `${pane.label} cannot paste, so a multi-line prompt would submit a line at a time`;

/**
 * Refuse a write when the pane's own multiplexer would eat it, naming the mode. Null means
 * go ahead - and so does a backend with no such concept, which is the important half.
 *
 * A pane in copy-mode routes every key to tmux's own key table: `send-keys` and
 * `paste-buffer` BOTH still exit 0, and the child receives nothing. Reporting that as
 * success is the one lie this module must never tell, because everything above it
 * treats a successful write as proof the keystroke landed. Foreman is the sharp edge:
 * it stamps a prompt handled only once the send succeeds (see `applyVerdict`), so a
 * swallowed answer marks the question answered, the idempotency check then refuses to
 * retry it, and the session waits on a human forever underneath a note claiming it was
 * already answered. That is not hypothetical - it is how a session sat in "Needs You"
 * with `answered: option 1` written above the menu it never actually answered.
 *
 * `BoundPane.mode` is the capability, and the two nulls it separates are not the same
 * claim. A null CAPABILITY means the backend has no input mode to be stuck in - true of
 * every emulator, and the reason the wezterm path never probed - so a write may go. A null
 * ANSWER means we asked and the pane is in none. Reading the first as the second is how a
 * multiplexer that grows a copy-mode gets its keystrokes swallowed silently; reading the
 * second as "cannot tell" would refuse every write on the machine.
 *
 * This deliberately does NOT cancel the mode to push the keys through. A pane in
 * copy-mode is a PERSON reading their own scrollback, and yanking them out of it for a
 * background write would be a worse bug than the wait. Refusing keeps the failure a
 * no-op by construction, exactly like every other guard here, and it is transient:
 * callers retry on their next sweep and the write lands the moment the human leaves.
 * `paneBlocked` on the result is what tells them it is that kind of failure - a caller
 * that rations attempts must not spend one here.
 *
 * What this does NOT do is make the lie impossible, and the distinction is worth being
 * precise about. The probe and the write are two commands, and tmux offers no way to
 * send a key conditionally on the pane's mode - so someone entering copy-mode in the
 * milliseconds between them still gets a keystroke swallowed and reported as sent. The
 * window shrinks from "the whole time the pane is in a mode", which is minutes whenever
 * a person is reading scrollback, to a sub-frame race. That is the trade being made
 * here; it is not a proof the case is gone. Moving the probe behind the interface did
 * not shrink it further and must not be read as having done so.
 */
async function paneWriteBlock(
  pane: BoundPane,
  describe: DescribeMode = inModeError,
): Promise<ActionResult | null> {
  if (!pane.mode) return null;
  const mode = await pane.mode();
  return mode === null ? null : { ok: false, error: describe(pane.label, mode), paneBlocked: true };
}

/**
 * The two guarded write verbs, and the only ones anything below may call.
 *
 * Every keystroke in this module goes through one of them, so no path can forget the mode
 * check - see `paneWriteBlock` for why a swallowed key is worse than a refused one. The
 * verbs are not interchangeable: `text` types literally (a newline in it SUBMITS), `keys`
 * presses named keys, and which convention those keys are rendered in - tmux's `BTab`,
 * wezterm's `\x1b[Z` - is the adapter's business and never this file's.
 */
async function writeText(pane: BoundPane, text: string): Promise<ActionResult> {
  if (!pane.write) return { ok: false, error: cannotType(pane) };
  const blocked = await paneWriteBlock(pane);
  if (blocked) return blocked;
  return fromTerminal(await pane.write.text(text));
}

async function sendKeys(
  pane: BoundPane,
  keys: readonly Key[],
  describe?: DescribeMode,
): Promise<ActionResult> {
  if (!pane.write) return { ok: false, error: cannotType(pane) };
  const blocked = await paneWriteBlock(pane, describe);
  if (blocked) return blocked;
  return fromTerminal(await pane.write.keys(keys));
}

/**
 * Type text into a session's prompt, optionally submitting with Enter.
 *
 * The pane it lands on is `bindSession`'s decision: the innermost handle wins, because the
 * agent's real pane is the multiplexer pane and the emulator handle addresses the client
 * showing it. Nothing here knows which backend answered.
 */
export async function sendText(
  session: Session,
  text: string,
  submit: boolean,
  deps: PaneDeps = defaultPaneDeps,
): Promise<ActionResult> {
  return withPaneLock<ActionResult>(session, () => ({ ok: false, error: PANE_BUSY }), () => sendTextLocked(session, text, submit, deps));
}

async function sendTextLocked(
  session: Session,
  text: string,
  submit: boolean,
  deps: PaneDeps,
): Promise<ActionResult> {
  const pane = deps.pane(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  const typed = await writeText(pane, text);
  if (!typed.ok || !submit) return typed;
  // Re-probed rather than covered by the check above, exactly as the two `send-keys` calls
  // this replaced were: the mode can be entered between them, and the Enter is the half
  // that commits.
  return sendKeys(pane, ["enter"]);
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
  /**
   * True ONLY when the collapsed-paste placeholder was seen PENDING before the Enter and
   * seen GONE after it. Verification is that transition, never a single reading, because
   * only the transition rules out an Enter the TUI swallowed - and the pending half has
   * to be read BEFORE the keystroke or the answer is a race with the TUI's redraw.
   *
   * Everything else is false, and false is "no news" rather than "it failed". Three
   * ordinary deliveries land there: a harness whose `control.pastePlaceholder` is null
   * renders nothing to read; a prompt its `control.collapses` does not claim (for Claude,
   * any one-liner) never puts a placeholder on screen, which makes false the COMMON answer
   * there too, every one-line queue item included; and a capture that comes back null is
   * evidence of nothing in either direction and must never be read as a clear composer.
   *
   * Required rather than optional, for the reason `TerminalResult.outcomeUnknown` is: an
   * optional flag defaults the decision to whoever forgot it, and this is exactly the
   * decision that was being defaulted - before this existed a verified submit and an
   * unverified one were byte-identical at the call site, and the unverified one was being
   * read as confirmed. No caller acts on it yet; the point is that one now can.
   */
  submitVerified: boolean;
}

/**
 * Nothing reached the pane, so nothing could have been verified. Stated once because the
 * failure mode is a future early return that sets one of the two flags and forgets the
 * other, leaving a caller told it may safely retry a prompt that is sitting in a composer.
 */
const undelivered = (r: ActionResult): InjectResult => ({
  ...r,
  pasted: false,
  submitVerified: false,
});

// The settle window and the collapsed-paste placeholder used to be constants here, both
// measured against one Claude build and both applied to every agent. They are properties
// of the harness being typed into, not of this module, and now live on `harness.control`
// (`ControlSpec`) where a harness that lacks one can say so. See `harness/claude/control.ts`.

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
 * coalescing window longer than the harness's `settleMs` on a loaded machine. A backstop,
 * not a budget - each one is gated on seeing the paste still pending.
 */
const MAX_SUBMIT_ENTERS = 3;
/**
 * How many consecutive unreadable captures end the wait.
 *
 * The whole wait runs inside the pane lock, so its worst case is how long every other
 * write to that pane is refused with PANE_BUSY - and dispatch gives up waiting for its
 * own accept after 20s. Reading a pane we cannot see for the full `SUBMIT_POLLS`, each
 * capture carrying its own one-second timeout, spends that entire budget learning
 * nothing. Two in a row separates a blink from a pane that is gone.
 */
const MAX_UNREADABLE_CAPTURES = 2;

/**
 * The seam every write in `injectPrompt` goes through, so its SEQUENCE can be
 * asserted. The order of paste, settle, Enter, and re-read is the entire fix, and
 * an order no test can see is one that quietly stops being true.
 */
export interface InjectDeps extends PaneDeps {
  sleep: (ms: number) => Promise<void>;
}

const defaultInjectDeps: InjectDeps = { ...defaultPaneDeps, sleep };

/**
 * Read, once, whether the paste is sitting COLLAPSED in the composer - between the settle
 * and the first Enter, while it is definitively unsubmitted.
 *
 * This is the only reading allowed to establish "pending", and taking it here is what
 * makes the verification claim a fact rather than a race. Read only AFTER an Enter, the
 * placeholder is gone whenever the TUI redraws before the capture subprocess returns - so
 * a healthy delivery reported unverified while a SWALLOWED Enter, the one case where the
 * placeholder lingers, was the case most likely to report verified. The flag was close to
 * inverted and flipped between runs of the same delivery.
 *
 * One capture, and only where the HARNESS says it can answer: whether a placeholder exists
 * at all and whether this text is one that produces it are both its claims, asked here and
 * never guessed at. Null (a capture that failed) establishes nothing and is not retried -
 * the delivery proceeds and reports unverified, which is the honest answer and not a
 * failure.
 */
async function pasteIsCollapsed(
  session: Session,
  text: string,
  control: Extract<ControlSpec, { kind: "keystroke" }>,
  deps: InjectDeps,
): Promise<boolean> {
  const { pastePlaceholder } = control;
  if (!pastePlaceholder || !control.collapses(text)) return false;
  return hasPendingPaste(await deps.capture(session), pastePlaceholder);
}

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
 * `submitVerified` answers a stricter question than `ok` and the two part company on
 * purpose. `ok` says the Enter went out and nothing on screen contradicts it; verified
 * says the paste was watched LEAVING the composer. `pasteWasPending` supplies the first
 * half of that transition and nothing here may supply it - see `pasteIsCollapsed` for
 * why the reading has to predate the Enter. Reads taken below can only ever supply the
 * second half.
 *
 * A capture that comes back null is evidence in neither direction: not a clear composer,
 * so it cannot end the wait as a success; not a pending paste, so it cannot aim the next
 * Enter. It is skipped - but only `MAX_UNREADABLE_CAPTURES` of them in a row, because
 * this wait holds the pane lock the whole time. Giving up that way is neither a verified
 * submit nor a failure: the Enter that went out stands, unverified.
 */
async function awaitPasteSubmitted(
  session: Session,
  pressEnter: () => Promise<ActionResult>,
  placeholder: RegExp | null,
  pasteWasPending: boolean,
  deps: InjectDeps,
): Promise<ActionResult & { submitVerified: boolean }> {
  // No placeholder means this harness renders nothing that could ever show a pending
  // paste, so every poll would read "clear" from a blank screen and every retry would be
  // gated on evidence that cannot appear. Spend ONE Enter and say plainly that the
  // outcome is unverified, rather than looping to manufacture a confirmation.
  //
  // One Enter and not three, deliberately: the extra presses exist to outlast a
  // coalescing window, and they are safe only because a visible placeholder proves the
  // composer has focus. Without that proof a second Enter is the ungated keystroke
  // `reload.ts` warns about - the one that answers a foreground dialog on the operator's
  // behalf.
  if (!placeholder) {
    const entered = await pressEnter();
    return { ...entered, submitVerified: false };
  }

  let unreadable = 0;
  for (let attempt = 1; attempt <= MAX_SUBMIT_ENTERS; attempt++) {
    const entered = await pressEnter();
    if (!entered.ok) return { ...entered, submitVerified: false };

    // Re-armed per Enter, because the next one is only safe while THIS wait is still
    // looking at a pending paste. Evidence from a wait ago is stale by a second and more.
    // A wait that mixes an unreadable capture with a later pending one still arms it, and
    // deliberately so: the placeholder was seen in this same wait, which is the whole of
    // what makes the keystroke aimed.
    let pendingThisWait = false;
    for (let poll = 0; poll < SUBMIT_POLLS; poll++) {
      if (poll > 0) await deps.sleep(SUBMIT_POLL_MS);
      const pane = await deps.capture(session);
      if (pane === null) {
        if (++unreadable >= MAX_UNREADABLE_CAPTURES) return { ok: true, submitVerified: false };
        continue;
      }
      unreadable = 0;
      if (!hasPendingPaste(pane, placeholder)) return { ok: true, submitVerified: pasteWasPending };
      pendingThisWait = true;
    }
    if (!pendingThisWait) return { ok: true, submitVerified: false };
  }
  return { ok: false, error: PASTE_NOT_SUBMITTED, submitVerified: false };
}

/**
 * A harness whose delivery is not keystrokes reaching this path at all. Not a runtime
 * fault - a declaration that the pane-typing route does not apply to it - so it names the
 * capability rather than blaming the pane.
 */
const NO_KEYSTROKE_DELIVERY =
  "this agent does not take prompts by keystroke, and no other delivery is implemented yet";

const PASTE_NOT_SUBMITTED =
  "the prompt was pasted but the agent never took the Enter - it is sitting in the composer unsubmitted";

/**
 * Whether this session could take a prompt RIGHT NOW, without sending one.
 *
 * The point is the caller that has something destructive to do first. `TaskManager.assign`
 * resets the agent's checkout - detaching it, wiping its work queue, clearing its context
 * - and then types. Discovering only afterwards that the pane has no handle, that its
 * terminal cannot be typed into at all, or that it is in copy-mode with a human reading
 * their scrollback, leaves an agent stripped for a task that went straight back to the
 * backlog. Asking first costs one mode probe, and nothing at all on a backend with no
 * mode to probe for.
 *
 * It is a PROBE, not a lock: the pane can be entered a millisecond later, which is the
 * same sub-frame race `paneWriteBlock` documents and the same one `injectPrompt` re-runs
 * the check for. This shrinks a minutes-long window to that race; it does not close it.
 */
export async function paneAcceptsPrompt(
  session: Session,
  deps: PaneDeps = defaultPaneDeps,
): Promise<ActionResult> {
  // Asked before the handles, and refused in `injectPrompt`'s own words: a harness that
  // does not take keystrokes cannot become deliverable by owning a pane, so answering
  // `ok` on the strength of one is how the destructive step runs anyway and the refusal
  // arrives afterwards, on a stripped agent whose task went back to the backlog.
  if (controlFor(session).kind !== "keystroke") return { ok: false, error: NO_KEYSTROKE_DELIVERY };
  const pane = deps.pane(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  // Asked in the order a write would hit them: a backend that cannot type is a permanent
  // refusal, a pane in a mode a transient one.
  if (!pane.write) return { ok: false, error: cannotType(pane) };
  return (await paneWriteBlock(pane)) ?? { ok: true };
}

/**
 * Deliver a whole prompt (possibly multi-line) into a session's input as a single
 * submission. Unlike `sendText`, newlines here must NOT each submit - so we send
 * the body via the backend's bracketed paste (`PaneWrite.paste`), which agent TUIs treat
 * as one pasted block, then submit it with Enter. Used by dispatch to seed an agent's
 * first task, and by the work queue to deliver an item.
 *
 * The Enter is NOT sent on the paste's heels, and that is load-bearing: an agent that
 * coalesces input for a window afterwards absorbs an Enter that arrives inside it, which
 * used to leave every multi-line prompt pasted-but-unsubmitted. So the sequence is paste,
 * settle, READ, Enter, read back. The settle outlasts that window (`ControlSpec.settleMs`);
 * the read before the Enter catches the paste while it is still definitively in the
 * composer (`pasteIsCollapsed`), which is the half that makes a confirmation a fact rather
 * than a race with the TUI's redraw; the reads after it watch the paste leave
 * (`awaitPasteSubmitted`).
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
    () => undelivered({ ok: false, error: PANE_BUSY }),
    () => injectPromptLocked(session, text, deps),
  );
}

async function injectPromptLocked(
  session: Session,
  text: string,
  deps: InjectDeps,
): Promise<InjectResult> {
  // How this agent takes a turn. Read once, up front, rather than branched on per step:
  // the delivery below is generic over harnesses and must never name one.
  const control = controlFor(session);
  // The only delivery implemented today. A `stream-json` harness does not go through a
  // pane at all, so it cannot fall through to the pane path below and quietly type at
  // nothing - it is refused here, by declaration, until that path exists.
  if (control.kind !== "keystroke") {
    return undelivered({ ok: false, error: NO_KEYSTROKE_DELIVERY });
  }
  const { settleMs, pastePlaceholder } = control;

  const pane = deps.pane(session);
  if (!pane) return undelivered({ ok: false, error: NO_HANDLE });
  if (!pane.write) return undelivered({ ok: false, error: cannotType(pane) });
  // Refused BEFORE the mode probe and before a byte is written: a backend with no
  // bracketed paste cannot deliver this as one submission at all, and "type it anyway"
  // would submit the first line as a whole prompt.
  const paste = pane.write.paste;
  if (!paste) return undelivered({ ok: false, error: cannotPaste(pane) });

  // Before anything else: a paste is swallowed by a pane in a mode exactly like a
  // keystroke is, and just as silently, so the "the text IS in the pane" invariant below
  // is only true once this has cleared.
  const blocked = await paneWriteBlock(pane);
  if (blocked) return undelivered(blocked);

  const pasted = await paste(text);
  if (!pasted.ok) {
    // The one place `TerminalResult.outcomeUnknown` decides something, and the reason the
    // interface makes it required. A paste that REPORTED failure resolved its target
    // before writing, so nothing reached the pane and the caller may retry; a paste that
    // was killed rather than answering may be sitting in the composer right now, and a
    // caller told `pasted: false` would paste a second copy on top of it and mangle the
    // prompt. Erring toward "it may have landed" costs a prompt a human has to re-send;
    // erring the other way corrupts one they already sent.
    return { ...fromTerminal(pasted), pasted: pasted.outcomeUnknown, submitVerified: false };
  }
  // Past this point the text IS in the pane, submitted or not.
  await deps.sleep(settleMs);
  const wasPending = await pasteIsCollapsed(session, text, control, deps);
  // Re-probed per Enter rather than trusting the pre-paste check: the settle window and
  // the submit polls are ~1.6s of wall clock during which a human can start scrolling,
  // and this Enter is an ordinary keystroke like any other. Routing it through `sendKeys`
  // is what makes that guard's invariant true instead of nearly true - and it upgrades
  // the failure a caller sees from the generic "the agent never took the Enter", reached
  // only after three swallowed presses and ~3.6s of pane captures, to one that names the
  // mode a person can actually clear.
  const submitted = await awaitPasteSubmitted(
    session,
    () => sendKeys(pane, ["enter"], inModeAfterPasteError),
    pastePlaceholder,
    wasPending,
    deps,
  );
  // `pasted: true` regardless of how the submit failed, and that is the contract
  // holding: the text IS in the composer. A refusal here is the one blocked write
  // that must NOT be retried from the top - re-pasting onto it would append a second
  // copy - so the caller is told "may have landed" and hands it to a human.
  return { ...submitted, pasted: true };
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
 * The key is NAMED, never written: tmux resolves `BTab` to the terminal's back-tab
 * sequence while wezterm takes the raw CSI Z, and a third backend will spell it a third
 * way. Each adapter renders the `Key` in its own convention.
 */
async function injectShiftTab(session: Session): Promise<ActionResult> {
  const pane = bindSession(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  return sendKeys(pane, ["shift-tab"]);
}

/** Result of a mode change: the mode the pane was actually in when we stopped. */
export interface ModeResult extends ActionResult {
  /** Observed from the pane, not assumed. Null when we couldn't read it. */
  mode?: PermissionMode | null;
}

// How long a repaint may take and how long the mode cycle may be are the AGENT's
// properties, so they arrive on `harness.tui` (`repaintTimeoutMs`, `maxCycleSteps`) rather
// than being constants here. How often WE re-read while waiting is ours, and stays.

/** How often to re-read the pane while waiting for that repaint. */
const REPAINT_POLL_MS = 50;

/**
 * How long to let this session's agent repaint before re-reading its pane.
 *
 * Falls back to the poll interval for a harness with no TUI capability at all, which is a
 * value no walk actually spends: every caller of this has already refused such a session
 * for want of a grammar to read the repaint WITH.
 */
function repaintTimeoutFor(session: Session): number {
  return tuiFor(session.agent)?.repaintTimeoutMs ?? REPAINT_POLL_MS;
}

/**
 * Parse the menu on a session's pane with its own harness's grammar.
 *
 * A harness that draws no readable menus reads as "no menu", which is the answer every
 * caller here already handles and the one that routes them to their safe path - refusing
 * rather than spending an unaimed keystroke. It must never be reached by testing the agent
 * id: that guard is what kept the parser off Codex panes it could have read.
 */
function readPaneDialog(session: Session, paneText: string | null): PaneDialog | null {
  const spec = dialogSpecFor(session.agent);
  return spec ? parsePaneDialog(paneText, spec) : null;
}

/** This dialog's send row, per the session's own form vocabulary. Null when it has none. */
function readSubmitRow(session: Session, dialog: PaneDialog): PaneOption | null {
  const spec = dialogSpecFor(session.agent);
  return spec ? submitAnswersRow(dialog, spec) : null;
}

/**
 * Whether the review screen is refusing because a question is unanswered.
 *
 * False for a harness with no forms, which is correct rather than merely safe: it draws no
 * such banner, so there is nothing to be refused BY.
 */
function readUnansweredWarning(session: Session, paneText: string | null): boolean {
  const spec = dialogSpecFor(session.agent);
  return spec ? hasUnansweredWarning(paneText, spec) : false;
}

/** Wait for the pane's mode line to differ from `prev`, or null if it never does. */
async function awaitModeLineChange(session: Session, prev: string): Promise<PaneModeLine | null> {
  const deadline = Date.now() + repaintTimeoutFor(session);
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
 * Drive a session to a specific permission mode.
 *
 * Shift+Tab is the only lever, and it only steps forward - so reaching a chosen
 * mode means walking the cycle to it. We can't precompute how far: the optional
 * `bypassPermissions`/`auto` modes slot in after `plan` only when flags and
 * account settings we can't observe enable them, so the cycle's length is unknown
 * until we walk it. Instead of counting steps we read the pane after each one,
 * which makes every step self-verifying and needs no model of the cycle at all.
 *
 * Four ways this stops short, each fail-safe:
 *   - The harness has no permission modes (`tui.modeLine` is null). There is no
 *     cycle to walk and no footer to read it off, so this refuses by declaration
 *     rather than walking an agent around a loop it does not have.
 *   - No mode line to start from. A dialog or menu is foreground, where the agent
 *     binds Tab itself and would swallow the keystroke (or worse, act on it). We
 *     refuse rather than fire blind keystrokes at a dialog.
 *   - The line doesn't change within the harness's `repaintTimeoutMs`. Something
 *     ate the keystroke; stop rather than hammer.
 *   - We come back to a mode line we've already seen. The cycle is a loop, so
 *     this means the target isn't in it - and, because it's a loop, walking it
 *     fully has landed us back where we started. Nothing to undo.
 */
export async function setPermissionMode(session: Session, target: PermissionMode): Promise<ModeResult> {
  if (!bindSession(session)) return { ok: false, error: NO_HANDLE };
  if (!modeLineSpecFor(session.agent)) return { ok: false, error: NO_MODES, mode: null };
  return withPaneLock<ModeResult>(session, () => ({ ok: false, error: PANE_BUSY }), () => walkToMode(session, target));
}

async function walkToMode(session: Session, target: PermissionMode): Promise<ModeResult> {
  const spec = modeLineSpecFor(session.agent);
  if (!spec) return { ok: false, error: NO_MODES, mode: null };
  let line = await readPaneModeLine(session);
  if (!line) return { ok: false, error: CANNOT_SEE_MODE, mode: null };
  if (line.mode === target) return { ok: true, mode: target };

  // Keyed on the line text, not the parsed mode, so a mode this build doesn't
  // recognize is still a distinct position we can step through and loop on.
  const seen = new Set<string>([line.text]);
  for (let i = 0; i < spec.maxCycleSteps; i++) {
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

// Operator-facing, so they say "the agent" rather than naming one: these reach a session
// of whichever harness, and a Codex card reporting what "Claude" did is the kind of wrong
// that makes an operator doubt the whole readout.
const CANNOT_SEE_MODE =
  "can't see the agent's mode line - a dialog or menu is probably open in this session";
const SWALLOWED = "the agent ignored Shift+Tab - a dialog may have opened in this session";
/** Refused by declaration: this harness has no permission modes to drive. */
const NO_MODES = "this agent has no permission modes";

/** The row a caller wants selected: the number Claude printed, and the label it read there. */
export interface OptionTarget {
  number: number;
  /** The row's label as the caller read it, re-checked against the screen before any Enter. */
  label: string;
}

/** How many arrow presses one selection may spend. A menu's rows are few; this is a backstop. */
const MAX_ARROW_STEPS = 12;

/** The four arrows, as a subset of the key vocabulary the adapters render. */
type Arrow = Extract<Key, "up" | "down" | "left" | "right">;

/** Send one arrow key to a pane. Which bytes that is, is the backend's business. */
async function injectArrow(session: Session, dir: Arrow, deps: PaneDeps): Promise<ActionResult> {
  const pane = deps.pane(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  return sendKeys(pane, [dir]);
}

/** Wait for the menu's cursor to leave `from`, or null if it never does. */
async function awaitCursorMove(session: Session, from: number, deps: PaneDeps): Promise<PaneDialog | null> {
  const deadline = Date.now() + repaintTimeoutFor(session);
  for (;;) {
    const d = readPaneDialog(session, await deps.capture(session));
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
export async function selectPaneOption(
  session: Session,
  target: OptionTarget,
  deps: PaneDeps = defaultPaneDeps,
): Promise<ActionResult> {
  if (!deps.pane(session)) return { ok: false, error: NO_HANDLE };
  // Shares the mode-walk's lock: both drive the same pane with bare keystrokes, and
  // interleaving them would land arrows in a dialog the other opened. It has to be the
  // SAME lock, keyed the same way (on the pane, not the session), or the exclusion is
  // nil in both directions - a concurrent `sendText`'s trailing Enter would confirm
  // whatever row this walk is passing through.
  return withPaneLock<ActionResult>(
    session,
    () => ({ ok: false, error: PANE_BUSY }),
    () => selectOptionLocked(session, target, deps),
  );
}

async function selectOptionLocked(
  session: Session,
  target: OptionTarget,
  deps: PaneDeps,
): Promise<ActionResult> {
  const dialog = readPaneDialog(session, await deps.capture(session));
  if (!dialog) return { ok: false, error: NO_MENU };
  // The number alone is a position; the label is what makes it an ANSWER. If the screen
  // doesn't read as the row we were told to answer, the menu on it isn't that menu, and
  // pressing Enter would confirm whatever replaced it.
  const miss = optionRowMiss(dialog, target);
  if (miss) return { ok: false, error: describeMiss(miss, dialog, target) };

  // A checkbox row is not answerable by pressing it: Enter TOGGLES it and the form stays
  // up, so this would report a delivered answer for a keystroke that sent nothing. That is
  // the same shape as the incident `pane-dialog.ts` opens with - a caller told "answered"
  // while the child sat on the question - so it is refused here rather than at the edges,
  // where the dashboard, Foreman and the MCP tool would each have to remember to.
  // Unboxed rows on a form ("Chat about this") are real presses and stay allowed.
  const row = dialog.options.find((o) => o.number === target.number)!;
  if (row.checked !== undefined) return { ok: false, error: IS_A_FORM };

  const walked = await walkCursorTo(session, dialog, target.number, deps);
  if (!walked.ok) return walked;

  // Read once more rather than trusting the walk: this is the last look before the only
  // irreversible keystroke in the function.
  const final = readPaneDialog(session, await deps.capture(session));
  if (!final || final.highlighted !== target.number || optionRowMiss(final, target)) {
    return { ok: false, error: "the menu changed before the selection could be confirmed" };
  }
  return injectEnter(session, deps);
}

const IS_A_FORM =
  "that row is a checkbox on a multi-select form - ticking it answers nothing, so it has to be submitted as a form";

/**
 * A cursor walk that either parked on `number` or explains why it couldn't.
 *
 * The failure arm is a whole `ActionResult` rather than a bare string so a refusal made
 * further down keeps its FLAGS on the way up - `paneBlocked` above all, which tells a
 * caller the walk stopped because a human is in copy-mode and not because anything is
 * broken. Flattened to `{ error }`, a blocked arrow reads as a plain failure and the work
 * queue spends a rationed attempt on it.
 */
type WalkResult = { ok: true; dialog: PaneDialog } | (ActionResult & { ok: false });

/**
 * Walk the menu cursor onto a row, verifying every step against the screen.
 *
 * Shared by the two things that drive a dialog - pressing a row and ticking a form's boxes
 * - because the rule they must agree on is that arrows are COUNTED OUT BY THE SCREEN and
 * not by us: the cursor may not start where we last saw it, an arrow may be swallowed, and
 * the child may repaint under the walk. Arrows commit nothing, so every failure here
 * leaves the dialog exactly as it was found.
 */
async function walkCursorTo(
  session: Session,
  from: PaneDialog,
  number: number,
  deps: PaneDeps,
): Promise<WalkResult> {
  let dialog = from;
  for (let i = 0; dialog.highlighted !== number; i++) {
    if (i >= MAX_ARROW_STEPS) return { ok: false, error: "could not walk the cursor onto that option" };
    const dir = number > dialog.highlighted ? "down" : "up";
    const sent = await injectArrow(session, dir, deps);
    if (!sent.ok) return { ...sent, ok: false, error: sent.error ?? "could not send an arrow key" };
    const moved = await awaitCursorMove(session, dialog.highlighted, deps);
    // The cursor didn't move: the dialog closed under us, or it ate the arrow. Either
    // way we no longer know what Enter would confirm, so we don't press it.
    if (!moved) return { ok: false, error: "Claude ignored the arrow key - the menu may have closed" };
    dialog = moved;
  }
  return { ok: true, dialog };
}

/** A form row as the human left it: the row they were shown, and whether they want it ticked. */
export interface FormTarget extends OptionTarget {
  checked: boolean;
}

export interface FormResult extends ActionResult {
  outcome?: FormOutcome;
  /**
   * What to tell the human instead of the sentence the outcome alone implies, on the paths
   * where the daemon knows something the outcome can't carry - it is set when the walk left
   * the form somewhere other than where a plain reading of the outcome would put it.
   */
  note?: string;
}

/**
 * Fill in and SEND a multi-select `AskUserQuestion` - the form half of answering a dialog.
 *
 * A form is not a menu, and the difference is the whole reason this exists. On a menu,
 * Enter on a row is the answer. On a form, Enter on a row only ticks its box: the form
 * stays up, the cursor stays put, and NOTHING has reached Claude. So the dashboard's
 * per-row press - correct for every menu - was a no-op that reported success on every
 * multi-select ever shown, which is a human clicking an option, watching the same question
 * sit there, and clicking it again. (The second click then failed outright, because the
 * row it was aiming at now rendered "[✔] Beta" against the "[ ] Beta" they were shown. The
 * checkbox is out of the label now, so that half is gone too.)
 *
 * Sending it means walking Claude's own submit path: tick the boxes that differ, step `→`
 * onto the next tab, and confirm "Submit answers" when that tab is the review one. Each
 * step is verified against a fresh read, on the same rule the menu walk holds to - the
 * only irreversible keystroke is the last one, and it is pressed only while the screen
 * still reads as what the human was shown.
 *
 * It stops short of that Enter in the two cases where pressing on would be answering
 * something nobody was asked. `next-question` is Claude having more questions, so `→`
 * landed on the next one rather than on the review tab: the ticks are safe on screen, the
 * next poll renders the new question, and the human answers it the same way. `unanswered`
 * is the review tab itself reporting a gap - Claude will send a half-filled form, and a
 * walk that pressed through that would put answers the human never gave under their name.
 * Both leave the form up, which is the state a human can finish from either surface.
 */
export async function submitPaneForm(
  session: Session,
  targets: FormTarget[],
  deps: PaneDeps = defaultPaneDeps,
): Promise<FormResult> {
  if (!deps.pane(session)) return { ok: false, error: NO_HANDLE };
  if (targets.length === 0) return { ok: false, error: "no rows to submit" };
  return withPaneLock<FormResult>(
    session,
    () => ({ ok: false, error: PANE_BUSY }),
    () => submitFormLocked(session, targets, deps),
  );
}

async function submitFormLocked(
  session: Session,
  targets: FormTarget[],
  deps: PaneDeps,
): Promise<FormResult> {
  let dialog = readPaneDialog(session, await deps.capture(session));
  if (!dialog) return { ok: false, error: NO_MENU };
  if (!dialog.multiSelect) return { ok: false, error: NOT_A_FORM };

  // Every target is checked against the screen BEFORE anything is typed, so a form that
  // has moved on is refused whole rather than half-ticked.
  for (const t of targets) {
    const miss = optionRowMiss(dialog, t);
    if (miss) return { ok: false, error: describeMiss(miss, dialog, t) };
    if (dialog.options.find((o) => o.number === t.number)!.checked === undefined) {
      return { ok: false, error: `option ${t.number} is not a checkbox on this form` };
    }
  }

  for (const t of targets) {
    const row = dialog.options.find((o) => o.number === t.number)!;
    if (row.checked === t.checked) continue;
    const walked = await walkCursorTo(session, dialog, t.number, deps);
    if (!walked.ok) return walked;
    const sent = await injectEnter(session, deps);
    if (!sent.ok) return sent;
    // The box is the receipt. Without this the walk would type Enters into a form that
    // stopped responding and call the result a filled-in answer.
    const ticked = await awaitChecked(session, t.number, t.checked, deps);
    if (!ticked) return { ok: false, error: `"${t.label}" did not tick - the form may have closed` };
    dialog = ticked;
  }

  // Park on the first row before stepping tabs. `→` is a tab move only while the cursor is
  // on an ordinary row: on Claude's trailing "Type something" row it opens a text field
  // that EATS left/right, so a walk that happened to finish there would press `→` into an
  // input and sit on the same tab believing it had moved.
  const parked = await walkCursorTo(session, dialog, dialog.options[0]!.number, deps);
  if (!parked.ok) return parked;

  const before = dialogIdentity(parked.dialog);
  const stepped = await injectArrow(session, "right", deps);
  if (!stepped.ok) return stepped;
  const next = await awaitDialogChange(session, before, deps);
  if (!next) return { ok: false, error: "the agent did not move on from this question" };

  // Another question rather than the review tab: the ticks stand, and the human answers
  // the next one from whichever surface they are on.
  const submit = readSubmitRow(session, next);
  if (!submit) return { ok: true, outcome: "next-question" };
  if (readUnansweredWarning(session, await deps.capture(session))) return stepBackFromReview(session, next, deps);

  const onSubmit = await walkCursorTo(session, next, submit.number, deps);
  if (!onSubmit.ok) return onSubmit;
  const final = readPaneDialog(session, await deps.capture(session));
  const stillThere = final && readSubmitRow(session, final);
  if (!final || !stillThere || final.highlighted !== stillThere.number) {
    return { ok: false, error: "the review screen changed before the answers could be sent" };
  }
  const done = await injectEnter(session, deps);
  return done.ok ? { ok: true, outcome: "submitted" } : done;
}

const NOT_A_FORM = "this session's screen is not a multi-select form";

/**
 * Back off the review tab with `←`, having refused to send a half-filled form.
 *
 * Refusing the Enter is only half the guard. The review tab is, to every other reader in
 * this system, an ordinary two-row menu - "Submit answers" / "Cancel", no checkboxes - so
 * a form abandoned on it is re-parsed on the next poll as a MENU, rendered as two buttons,
 * and one click sends exactly the half-filled form this refusal exists to stop. Walking
 * back to the question is what makes the refusal hold past the request that made it.
 *
 * Verified the same way the forward step is, and reported honestly when it can't be: an
 * unverified step back means the pane may still be sitting on the review tab, and telling
 * the human "it's back on your questions" when it isn't is the class of lie the whole
 * module is written against. `←` commits nothing either way, so the failure is safe.
 *
 * ONE step back, which reaches only the LAST question - the one they just submitted from.
 * On a multi-question form the gap Claude is reporting may be an earlier one, and we cannot
 * tell: a plain `capture-pane` gives us the header's per-question answered/unanswered marks
 * but not which tab is current (that is colour, and reading it would mean `-e` and parsing
 * escape sequences). Guessing a tab position from the marks would mean firing `←` a counted
 * number of times at a screen we can't confirm we're on - arrows into the dark, and the
 * dashboard would report arriving somewhere it never checked. So the note says where the
 * pane actually is and that an earlier gap needs the terminal, which is the true thing we
 * can say without another blind walk.
 */
async function stepBackFromReview(
  session: Session,
  review: PaneDialog,
  deps: PaneDeps,
): Promise<FormResult> {
  const back = await injectArrow(session, "left", deps);
  const returned = back.ok && (await awaitDialogChange(session, dialogIdentity(review), deps));
  return returned
    ? { ok: true, outcome: "unanswered" }
    : {
        ok: true,
        outcome: "unanswered",
        note: "Saved, but Claude says a question is still unanswered - and the form is stuck on its review tab, so finish it in the terminal.",
      };
}

/** Wait for a form row's box to reach `want`, or null if it never does. */
async function awaitChecked(
  session: Session,
  number: number,
  want: boolean,
  deps: PaneDeps,
): Promise<PaneDialog | null> {
  const deadline = Date.now() + repaintTimeoutFor(session);
  for (;;) {
    const d = readPaneDialog(session, await deps.capture(session));
    if (d?.options.find((o) => o.number === number)?.checked === want) return d;
    if (Date.now() >= deadline) return null;
    await sleep(REPAINT_POLL_MS);
  }
}

/**
 * Wait for the pane to show a DIFFERENT dialog than the one identified by `from`, or null
 * if it never does. Keyed on `dialogIdentity` (prompt plus rows) rather than on the cursor,
 * because what a tab step changes is the question, and the cursor lands on row 1 of both.
 */
async function awaitDialogChange(
  session: Session,
  from: string,
  deps: PaneDeps,
): Promise<PaneDialog | null> {
  const deadline = Date.now() + repaintTimeoutFor(session);
  for (;;) {
    const d = readPaneDialog(session, await deps.capture(session));
    if (d && dialogIdentity(d) !== from) return d;
    if (Date.now() >= deadline) return null;
    await sleep(REPAINT_POLL_MS);
  }
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
async function injectEnter(session: Session, deps: PaneDeps): Promise<ActionResult> {
  const pane = deps.pane(session);
  if (!pane) return { ok: false, error: NO_HANDLE };
  return sendKeys(pane, ["enter"]);
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
 * The naming rules that apply to this session's renameable handle - see `NameRules`.
 *
 * The INNERMOST handle's rules, matching `rename` below: a session inside a multiplexer is
 * renamed by moving the multiplexer session's name, so that backend's grammar is the one the
 * name has to survive and its hosting tab merely follows. A session with only an emulator
 * handle is renamed by retitling a tab, which is display text.
 *
 * The rules belong to the BACKEND. tmux's ban on `.`, `:` and a leading `$` comes from its
 * target grammar (`session:window.pane`, `$0` as a session id) and no other multiplexer need
 * share it, so a second one with looser rules would otherwise be refused names it accepts,
 * in tmux's words.
 *
 * `PLAIN_NAMES` for a handleless session, so this stays total; its caller refuses that
 * session for having nothing to rename, which is a better sentence than any name rule would
 * produce.
 */
export function nameRulesFor(
  session: PaneHandles,
  deps: TerminalDeps = defaultTerminalDeps,
): NameRules {
  const mux = muxHandle(session);
  if (mux) return deps.multiplexers[mux.backend].sessions?.names ?? PLAIN_NAMES;
  const emu = emulatorHandle(session);
  if (emu) return deps.emulators[emu.backend].names;
  return PLAIN_NAMES;
}

/**
 * Validate a proposed session name against the handle that backs it, returning the trimmed
 * name or a human-readable reason it is rejected. Kept pure (no exec) so the route can answer
 * a bad name with a 400 and it can be unit-tested directly.
 *
 * What is left here is what is true of every backend: a name has to be something, and a
 * session has to have somewhere for a name to live. The GRAMMAR belongs to the adapter
 * (`NameRules`), beside the `sanitize` that has to agree with it - these rules and
 * `sessionLabel`'s coercion were two half-copies of tmux's target spec in two files, and they
 * had already drifted by one character class. What no display name can hold - a newline
 * submits, splits or truncates depending on which surface reads it first - is the shared
 * half every backend's rules are built on (`plainValidate`), not a check restated here.
 */
export function validateSessionName(
  session: PaneHandles,
  rawName: string,
  deps: TerminalDeps = defaultTerminalDeps,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "name can't be empty" };
  if (!muxHandle(session) && !emulatorHandle(session)) {
    return { ok: false, error: "this session has no terminal pane to rename" };
  }
  const why = nameRulesFor(session, deps).validate(name);
  return why ? { ok: false, error: why } : { ok: true, name };
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
  session: PaneHandles & Pick<Session, "cwd">,
  name: string,
  tasks: readonly Pick<Task, "tmuxSession" | "worktreePath">[],
  deps: TerminalDeps = defaultTerminalDeps,
): { ok: true } | { ok: false; error: string } {
  // Only a multiplexer rename moves a name teardown targets - an emulator tab title is
  // free-form and no task binds to it.
  if (!muxHandle(session)) return { ok: true };
  const collides = tasks.some(
    (t) => t.worktreePath !== null && t.tmuxSession === name && t.worktreePath !== session.cwd,
  );
  if (!collides) return { ok: true };
  const handle = muxHandle(session)!;
  return {
    ok: false,
    error: `another task still holds the ${deps.multiplexers[handle.backend].label} session name '${name}'`,
  };
}

/** One emulator tab that hosts a multiplexer client, with the backend that can act on it. */
interface HostTab {
  emulator: TerminalEmulator;
  pane: EmulatorPane;
}

/**
 * The emulator tabs whose windows host a client attached to `session`, and whether anything
 * is attached at all.
 *
 * The outward half of the composition rule, and the reason the terminal axis is two
 * interfaces rather than one. An agent inside a multiplexer sits on a multiplexer PANE tty
 * while the tab showing it sits on the CLIENT tty, so the session's own emulator handle is
 * never the tab to raise or retitle - it is null for such a session anyway. The link is the
 * shared client tty, and `hostPanesFor` is the join.
 *
 * Both nulls here are declared capabilities and both degrade to "no tabs": a multiplexer
 * that cannot report its clients (`clients: null`) can never be walked outward from, and an
 * emulator that cannot be enumerated (`list: null` - Ghostty) can never be found on the
 * other side of the join. `attached` is then false too, which is honest: without a client
 * list we do not know that anyone is looking.
 */
async function hostTabs(
  mux: Multiplexer,
  session: string,
  deps: TerminalDeps,
): Promise<{ tabs: HostTab[]; attached: boolean }> {
  if (!mux.clients) return { tabs: [], attached: false };
  const clients = await mux.clients();
  const tabs: HostTab[] = [];
  // In `EMULATOR_IDS` order, which is the declared precedence - the same order enumeration
  // uses to decide which backend names a session.
  for (const id of EMULATOR_IDS) {
    const emulator = deps.emulators[id];
    if (!emulator.list) continue;
    for (const pane of hostPanesFor(session, clients, await emulator.list())) {
      tabs.push({ emulator, pane });
    }
  }
  // Attached with no host tab means attached in a terminal we cannot raise, which is the one
  // case Focus reports as success without having raised anything.
  return { tabs, attached: clients.some((c) => c.session === session) };
}

/**
 * Rename a session's terminal home so the next discovery sweep reads the new name back onto
 * its card, and so the terminal tab the user is looking at agrees.
 *
 * An emulator-hosted session is one call: its tab title IS its card name. A
 * multiplexer-hosted one takes two, because its name lives in two places the harness has to
 * keep in step:
 *
 *   - the multiplexer session name, which is the card name (`nameSource`) and what Focus and
 *     Kill target; and
 *   - the title of every tab running a client for it, which `spawn` stamped once and nothing
 *     has updated since.
 *
 * Skipping the second was the whole bug: renames landed in tmux while every tab kept its
 * spawn-time title forever. Both halves are capabilities now rather than two vendors - a
 * multiplexer with no `sessions` has no name to move, and an emulator with no `retitle`
 * simply keeps its title, which is the same best-effort the wezterm path always had.
 *
 * Assumes `name` was already validated - the route calls `validateSessionName` first, so a
 * bad name is a 400 rather than a shelled-out failure.
 */
export async function rename(
  session: Session,
  name: string,
  deps: TerminalDeps = defaultTerminalDeps,
): Promise<ActionResult> {
  const inside = muxHandle(session);
  if (inside) {
    const mux = deps.multiplexers[inside.backend];
    if (!mux.sessions) return { ok: false, error: `${mux.label} has no session to rename` };
    const from = inside.session;
    // Resolve the tabs BEFORE the rename, while they still answer to `from` - after it, this
    // lookup would have to guess which name the backend now reports.
    const { tabs } = await hostTabs(mux, from, deps);
    const renamed = await mux.sessions.rename(from, name);
    if (!renamed.ok) return fromTerminal(renamed, `${mux.label} could not rename that session`);
    // Best-effort: the multiplexer name is the card's source of truth and it already moved,
    // so a multiplexer-only user (or an emulator GUI that just went away) gets the rename
    // they asked for rather than a failure over a cosmetic tab title.
    for (const tab of tabs) await tab.emulator.retitle?.(tab.pane, name);
    return { ok: true };
  }
  const tab = emulatorHandle(session);
  if (tab) {
    const emulator = deps.emulators[tab.backend];
    if (!emulator.retitle) return { ok: false, error: `${emulator.label} can't retitle a tab` };
    return fromTerminal(
      await emulator.retitle(tab, name),
      `${emulator.label} could not retitle that tab`,
    );
  }
  return { ok: false, error: NO_HANDLE };
}

/** Raise a tab, or the whole application for a backend that can only be aimed that far. */
function raiseThrough(focus: EmulatorFocus, target: EmulatorTarget): Promise<TerminalResult> {
  return focus.granularity === "pane" ? focus.raise(target) : focus.raise();
}

/**
 * Bring the session's pane and window into focus.
 *
 * Two steps, and they are the composition rule rather than a tmux special case:
 *
 *   1. **Inward** - `Multiplexer.select` decides what the session SHOWS. It raises nothing,
 *      and it touches only this session's own state, so whichever terminal is displaying it
 *      lands on the right pane and no other session is disturbed.
 *   2. **Outward** - an emulator puts a window in front of the human (`raiseOutward`).
 *
 * A session with only an emulator handle skips step 1 because there is no inside to select;
 * a multiplexer with no emulator anywhere lands on the same refusal it always did. Neither
 * is a branch on which vendor we found.
 */
export async function focus(
  session: Session,
  deps: TerminalDeps = defaultTerminalDeps,
): Promise<ActionResult> {
  const inside = muxHandle(session);
  const mux = inside ? deps.multiplexers[inside.backend] : null;

  if (mux?.select && inside) {
    const selected = await mux.select(inside);
    if (!selected.ok) return fromTerminal(selected, `${mux.label} could not select that pane`);
  }
  return raiseOutward(session, mux, deps);
}

/**
 * The outward half of focus: get a window in front of the human, in the order that never
 * takes a tab away from something else.
 *
 * We deliberately never repoint an existing client at a different session, and never detach
 * or kill one - that would yank a tab the user has another session open in. So the walk only
 * ever raises a tab that is ALREADY showing this session, or opens a new one.
 */
async function raiseOutward(
  session: PaneHandles,
  mux: Multiplexer | null,
  deps: TerminalDeps,
): Promise<ActionResult> {
  const inside = muxHandle(session);
  let attached = false;

  // 1. A tab already hosting a client for this session. For a multiplexer-hosted session
  //    this is the only correct tab - see `hostTabs`.
  if (mux && inside) {
    const hosts = await hostTabs(mux, inside.session, deps);
    attached = hosts.attached;
    const host = hosts.tabs[0];
    if (host?.emulator.focus) {
      return fromTerminal(
        await raiseThrough(host.emulator.focus, host.pane),
        `${host.emulator.label} could not raise that tab`,
      );
    }
  }

  // 2. The session's own emulator handle. For a session with BOTH handles this is the pane
  //    the agent's tty maps to, which is worth raising once step 1 found no client tab; for
  //    an emulator-only session it is the whole answer.
  const own = emulatorHandle(session);
  if (own) {
    const emulator = deps.emulators[own.backend];
    if (!emulator.focus) return { ok: false, error: `${emulator.label} can't raise a window` };
    return fromTerminal(
      await raiseThrough(emulator.focus, own),
      `${emulator.label} could not raise that tab`,
    );
  }

  if (!mux || !inside) return { ok: false, error: "session has no focusable pane" };

  // 3. This backend's sessions are never without a window, so there is nothing to attach and
  //    the walk ENDS here rather than failing. `attachArgv: null` is cmux's declaration: a
  //    workspace is drawn by the cmux app from the moment it exists, and step 1 already
  //    selected it there, so the session is showing what it should be showing. That is the
  //    same claim `attached` makes below for a terminal we cannot raise, arrived at by
  //    declaration instead of by observation.
  //
  //    What is NOT claimed is that anything was brought to the FRONT. Raising a
  //    self-hosting multiplexer's own window is a capability this interface still does not
  //    have; cmux can do it (`focus-window`) and the adapter deliberately did not invent a
  //    slot for it. It stays uninvented HERE too, because the rule that kept it out of the
  //    adapter is the same one that governs this file - a capability gets designed against a
  //    live backend, and there is no cmux on the machine this was written on to point one at.
  //    Recorded as an open gap on the plan rather than guessed at.
  const attachArgv = mux.sessions?.attachArgv;
  if (mux.sessions && !attachArgv) return { ok: true };

  // 4. Nothing hosts it yet: open it in a fresh tab, titled with the session name, running
  //    the multiplexer's own attach argv. A backend that cannot say what it opened still
  //    counts - `SpawnResult.ok` is "a tab opened", and the human has their window.
  if (attachArgv) {
    const argv = attachArgv(inside.session);
    for (const id of EMULATOR_IDS) {
      const spawn = deps.emulators[id].spawn;
      if (!spawn) continue;
      const opened = await spawn.tab({ argv, title: inside.session, cwd: null });
      if (opened.ok) return { ok: true };
    }
  }

  // 5. No tab could be opened. If the session is attached somewhere anyway (a terminal we do
  //    not integrate with), step 1 already selected the right pane inside it - report success
  //    rather than switching some client's session.
  if (attached) return { ok: true };
  // Composed from the backend's own label rather than written as a tmux sentence, for the
  // reason `inModeError` is: this is the moment one specific backend refuses, so the tmux
  // wording stays byte-identical and a cmux one is true.
  return {
    ok: false,
    error: `no terminal tab hosts this ${mux.label} session and none could be opened`,
  };
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
 * Side effects `kill` performs, injectable so tests can drive the branching without
 * signalling real processes.
 *
 * The signal stays a function field - it is a syscall, not a backend - while the terminal
 * half is the registries, so a test can hand `kill` a multiplexer whose sessions are not a
 * killable group and watch the signal stand alone.
 */
export interface KillDeps {
  /** SIGTERM the leaf agent process. */
  signal: (pid: number) => ActionResult;
  terminals: TerminalDeps;
}

const defaultKillDeps: KillDeps = { signal: signalProcess, terminals: defaultTerminalDeps };

/**
 * Terminate the agent and tear down its terminal home. SIGTERMs the leaf agent process, then
 * - for a session whose home IS a killable group - kills the whole group so no orphaned
 * window or pane is left behind. The UI confirms before calling this.
 *
 * "Has a killable group" is `MuxSessions.kill`, asked out loud, and not the implicit else it
 * used to be. An emulator tab is not a group: closing the window is the human's to do, and
 * the agent is reached by its pid, which is exactly what the signal above already did. A
 * multiplexer that declared no `kill` would have silently inherited that same path with
 * nothing saying why its other panes were still running.
 *
 * The two steps race by nature: the agent's own exit can collapse its session before (or
 * after) we reach the kill, so the action counts as successful when EITHER landed, and only
 * surfaces an error when both fail. With no group, the signal result stands on its own.
 */
export async function kill(session: Session, deps: KillDeps = defaultKillDeps): Promise<ActionResult> {
  const signalled = deps.signal(session.pid);

  const inside = muxHandle(session);
  const mux = inside ? deps.terminals.multiplexers[inside.backend] : null;
  const killGroup = mux?.sessions?.kill;
  if (!inside || !mux || !killGroup) return signalled;

  const killed = await killGroup(inside.session);
  if (killed.ok || signalled.ok) return { ok: true };
  // Both failed: the session was already gone AND the process couldn't be signalled.
  return {
    ok: false,
    error: killed.error ?? signalled.error ?? `${mux.label} could not kill that session`,
  };
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
 * What an unattended reset of this checkout would destroy, in one human sentence, or
 * null when it would destroy nothing.
 *
 * The guard in front of `TaskManager.assign`'s reset, and deliberately NOT `resetPreview`
 * even though they ask a very similar question. Three differences, all load-bearing:
 *
 *  - The question is "can this be RECOVERED if we discard it", not "did it land". A
 *    commit reachable from any `origin/*` ref can be fetched back by name, so throwing
 *    the checkout away costs nothing; a commit no remote ref holds exists only here.
 *    Asking "is it on origin/main" instead is what refused every agent that had shipped:
 *    a squash merge gives the landed change a new SHA, so the branch's own commits are
 *    never on origin/main no matter how thoroughly the work is safe.
 *  - It does not fetch. `resetPreview` fetches because it backs a confirm dialog that
 *    must not understate the loss, and it can afford ~30s because a human is reading it.
 *    This runs on Foreman's 4s loop, where a network round trip per candidate agent is a
 *    cost the scheduler should not carry. Reading the LOCAL remote-tracking refs only
 *    ever makes the answer more conservative - a ref we have not fetched yet cannot
 *    vouch for a commit - and every error here is a refusal, which is the safe way to be
 *    wrong.
 *  - It answers a yes/no, not a breakdown, because the caller has no dialog to draw. It
 *    has a decision to make and a sentence to log.
 *
 * The one hole, written down so nobody rediscovers it as a bug: a remote that DELETES the
 * head branch on merge, followed by a `fetch --prune` in this clone, takes those commits
 * off every remote-tracking ref and this refuses the agent again. Accepted - it fails
 * toward refusing, which costs a worktree and never work.
 *
 * A git failure of any kind reports "cannot tell", which refuses. We are about to run
 * `reset --hard` and `clean -fd` in a directory nobody is looking at; "I could not check"
 * has to mean stop.
 */
export async function resetWouldDestroyWork(session: Session): Promise<string | null> {
  if (!session.cwd) return "the session has no working directory";
  const top = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return "it is not a git repository";
  const root = top.stdout.trim();

  // Tracked edits and untracked files alike: `reset --hard` takes the first, `clean -fd`
  // takes the second. Ignored files (node_modules, .env) are not listed and survive.
  const status = await git(root, ["status", "--porcelain"]);
  if (status.code !== 0) return "its working tree could not be read";
  const changed = status.stdout.split("\n").filter((l) => l.trim()).length;
  if (changed > 0) return `it has ${changed} uncommitted file(s)`;

  // Commits on HEAD that NO origin ref holds - the only ones a discard would end. A
  // pushed branch's commits are reachable from its own `origin/<branch>` ref, so an
  // agent that shipped reads 0 here whether its PR is open or merged; a commit that was
  // only ever committed locally reads 1 and refuses.
  const stranded = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  if (stranded.code !== 0) return "its commits could not be compared against origin";
  const n = Number(stranded.stdout.trim()) || 0;
  return n > 0 ? `it has ${n} commit(s) no origin ref has` : null;
}

/**
 * The branch a reset would take this checkout OFF, or null when the reset leaves it
 * holding whatever name it holds now.
 *
 * Exists so the drag-onto-an-agent confirm can NAME what the gesture releases. Detaching
 * is not a loss `resetWouldDestroyWork` covers - the commits are safe on origin by the
 * time it says yes - but it is still a thing done to someone's checkout without asking,
 * and "your branch will be released" is the sentence that makes the drop honest.
 *
 * Mirrors `releaseBranch`'s rule rather than restating it loosely: an already-detached
 * checkout and one sitting on the repo's default branch both answer null, because
 * neither of them ends up anywhere else.
 */
export async function branchReleasedByReset(session: Session): Promise<string | null> {
  if (!session.cwd) return null;
  const top = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  // `symbolic-ref` is the exact question, failing precisely when HEAD is detached - see
  // `resetToOrigin`, which reads the branch the same way for the same reason.
  const held = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = held.code === 0 ? held.stdout.trim() : "";
  if (!branch) return null;
  const target = await remoteDefaultRef(root);
  return target && branch === defaultBranchOf(target) ? null : branch;
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
    clean: false,
    // Two conditions, both permanent-ish: somewhere to type, and a command worth
    // typing. Without the second the modal offered a "clear the agent's context"
    // checkbox that submitted `/clear` as a prompt on any harness that doesn't speak it.
    // "Somewhere to type" is the pane's WRITE capability, not merely a handle: an
    // emulator with no scripting CLI holds a pane nothing can be typed into, and the
    // checkbox would promise a keystroke that could never be sent.
    canClear: Boolean(bindSession(session)?.write && harnessFor(session.agent).clearContext),
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
 * release the branch it was holding, then (optionally) clear the agent's context with
 * its harness's `clearContext` command. Order matters: fetch first so we reset onto the
 * *current* remote;
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
 * a session with no pane - or with a harness that declares no clear command - reports
 * `cleared: false`, and a checkout that couldn't be detached reports `detached: false`,
 * rather than either failing the whole operation and telling the caller a reset that DID
 * happen did not.
 *
 * `cleared` means the agent ACTED on the command, not that the terminal took the
 * keystrokes - see `awaitClearProcessed`. The caller that depends on the difference is
 * `TaskManager.assign`, which types a task's intent immediately afterwards.
 */
export async function resetToOrigin(
  session: Session,
  clear: boolean,
  deps: InjectDeps = defaultInjectDeps,
): Promise<ResetResult> {
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

  // `clearContext` is null for a harness that has no such command, and that answer lands
  // on the SAME `cleared: false` a pane-less session has always produced - the already
  // tested degradation, not a new branch. Before this, `/clear` was typed at every agent
  // type ungated, so an agent that does not speak Claude's slash commands got a literal
  // `/clear` submitted as a prompt.
  const clearing = clear ? harnessFor(session.agent).clearContext : null;
  if (!clearing) return { ok: true, error: null, root, cleared: false, detached };
  // Read the screen BEFORE the keystrokes, so "nothing has happened yet" is a state we
  // can recognise rather than one we mistake for a clear that already landed.
  const before = await deps.capture(session);
  const sent = await sendText(session, clearing.command, true, deps);
  const cleared = sent.ok && (await awaitClearProcessed(session, clearing.command, before, deps));
  return { ok: true, error: null, root, cleared, detached };
}

/** How long to give the agent to act on a `/clear` before we stop claiming it did. */
const CLEAR_TIMEOUT_MS = 5000;
/** How often to re-read the pane while waiting for that. */
const CLEAR_POLL_MS = 100;
/** That wait as a count of reads, for the reason `SUBMIT_POLLS` is one. */
const CLEAR_POLLS = Math.ceil(CLEAR_TIMEOUT_MS / CLEAR_POLL_MS);

/**
 * Wait until the pane shows the clear command was actually acted on.
 *
 * `sendText` resolves when the terminal has taken the keystrokes, which is not the same
 * event: the agent processes the command whenever it gets round to it. The caller that cannot
 * live with the difference is `TaskManager.assign`, which pastes a task's intent behind
 * this - a clear processed after that paste wipes the composer, `awaitPasteSubmitted`
 * then sees no pending paste and reports success, and the task is marked running with
 * nothing running it. That is the exact failure the type-before-claim ordering exists to
 * prevent, arriving silently.
 *
 * Two conditions, and both are needed. The screen must have CHANGED (an unchanged
 * capture is the window before the agent has even echoed the command), and the command
 * must no longer be in the composer (a screen showing `> /clear` has changed but proves
 * the opposite of what we want). A capture we cannot read is not evidence of anything, so
 * it ends the wait as a false - "I could not see it happen" must not read as "it
 * happened".
 *
 * `command` is passed rather than spelled here so the read-back checks for the SAME bytes
 * that were typed; a harness whose clear command is not `/clear` would otherwise look
 * like it had never echoed anything and every reset would report `cleared: false`.
 */
async function awaitClearProcessed(
  session: Session,
  command: string,
  before: string | null,
  deps: InjectDeps,
): Promise<boolean> {
  for (let poll = 0; poll < CLEAR_POLLS; poll++) {
    await deps.sleep(CLEAR_POLL_MS);
    const now = await deps.capture(session);
    if (now === null) return false;
    if (now !== before && !hasPendingCommand(now, command)) return true;
  }
  return false;
}
