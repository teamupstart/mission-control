import { useCallback, useEffect, useRef, useState } from "react";

export interface CopyTextEnvironment {
  clipboard?: Pick<Clipboard, "writeText"> | null;
  document?: Pick<Document, "activeElement" | "body" | "createElement" | "execCommand"> | null;
}

/**
 * Copy text in both secure browser contexts and the embedded Electron renderer.
 *
 * The async Clipboard API can be absent or permission-blocked even after a direct click.
 * The selected, read-only textarea is the established synchronous fallback for that case.
 */
export async function copyText(
  text: string,
  environment: CopyTextEnvironment = {
    clipboard: globalThis.navigator?.clipboard,
    document: globalThis.document,
  },
): Promise<"clipboard" | "fallback"> {
  let clipboardError: unknown = null;
  if (environment.clipboard) {
    try {
      await environment.clipboard.writeText(text);
      return "clipboard";
    } catch (error) {
      clipboardError = error;
    }
  }

  const document = environment.document;
  if (!document || typeof document.execCommand !== "function") {
    throw clipboardError instanceof Error
      ? clipboardError
      : new Error("Clipboard access is unavailable");
  }

  const target = document.createElement("textarea");
  const priorFocus = document.activeElement;
  target.value = text;
  target.setAttribute("readonly", "");
  target.style.position = "fixed";
  target.style.inset = "0 auto auto 0";
  target.style.width = "1px";
  target.style.height = "1px";
  target.style.opacity = "0";

  document.body.appendChild(target);
  try {
    target.focus();
    target.select();
    target.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("The browser refused the clipboard copy");
    }
    return "fallback";
  } finally {
    target.remove();
    if (priorFocus && "focus" in priorFocus && typeof priorFocus.focus === "function") {
      priorFocus.focus();
    }
  }
}

// The confirmation half of a copy, once rather than per button.
//
// Six controls used to spell this out inline and four of them got it wrong, each in a
// different way: two called `navigator.clipboard.writeText` directly and so lost the
// fallback above - the one reason this module exists - which made them silently do nothing
// in the Electron renderer; two armed a bare `setTimeout` with no ref, no clear of a prior
// timer and no unmount cleanup, so rapid clicks stacked timers that raced each other and
// then fired into a dead tree; one swallowed every error, leaving a failed fetch and a
// blocked clipboard indistinguishable and both invisible; and one gave no feedback at all.
//
// A CONTROLLER with a thin React binding, rather than a hook alone, because the thing worth
// pinning here is the timer discipline and the ordering around an await - and this
// repository renders with `renderToStaticMarkup` and has no jsdom, so a hook's effects and
// timers cannot be driven from a test at all. `createCopyFeedback` takes its clock and its
// clipboard as parameters, exactly as `copyText` takes its environment, so
// `test/copy-feedback.test.ts` drives the real implementation instead of a paraphrase of it.
//
// It stays clipboard-shaped on purpose. `TranscriptPanel.showFlash` and `ActionBar.showFlash`
// are byte-identical transient-message helpers and the obvious third caller, but they carry
// send and queue outcomes over 3500-6000ms rather than a copy over 1600, and folding them in
// would make this a general flash hook that happens to know about clipboards.

/**
 * How long a copy confirmation stays up.
 *
 * The duration all six migrated controls already used, and now the app-wide one, so a reader
 * who copies from two different surfaces sees the same control return at the same moment.
 * Well under `e2e/specs/workflow-run-audit.spec.ts`'s 4000ms wait for the resting label.
 */
export const COPY_FEEDBACK_HOLD_MS = 1_600;

/** The confirmation label, app-wide. Never a decorated variant. */
export const COPY_FEEDBACK_LABEL = "Copied";

/**
 * What a control hands over: the text, or the work that produces it.
 *
 * The thunk arm is not a convenience. `ReportPanel` fetches `/api/report.md` before it has
 * anything to copy, and a signature taking a plain `string` would put that fetch back outside
 * the helper - which is where its errors were being swallowed.
 */
export type CopyPayload = string | (() => string | Promise<string>);

/** Everything a copy control renders from. */
export interface CopyFeedbackState {
  /** True from a successful write until the hold expires. */
  copied: boolean;
  /** The failure sentence, or null. Returned rather than rendered - routing differs per site. */
  error: string | null;
}

export interface CopyFeedback extends CopyFeedbackState {
  /**
   * Resolve the payload, write it through `copyText`, then confirm or record the failure.
   *
   * Never rejects. It resolves with THE STATE THIS CONTROL IS IN once the attempt settles -
   * which is this attempt's outcome when it is still the current one, and whatever the copy
   * that overtook it left behind when it is not. A control that renders `error` straight from
   * the hook can ignore the return; a page that owns one error slot of its own -
   * `WorkflowRuns`, `WorkflowLadder`, `PersonaEditor` all do - routes the returned sentence
   * into that slot, which keeps last-write-wins rather than leaving two competing sources for
   * one line of prose.
   *
   * "The surface" and not "your attempt" is the whole contract, and it was the other way round
   * for one round of review. Neither copy button disables while a copy is in flight, so two
   * clicks can settle out of order - one stalled on a permission prompt, a later one straight
   * through. Handing each caller its own outcome meant the loser's `.then` wrote its stale
   * refusal into the shared error line AFTER the winner had already published `Copied`, so the
   * page showed a confirmation and a contradicting failure for the same action at once. The
   * flag was generation-guarded and the sentence beside it was not.
   *
   * Fixed here rather than by a guard at each call site on purpose: three of the five sites
   * route this value, and a rule every caller has to remember is the rule this module exists
   * to stop repeating. Callers keep writing `if (error !== null)` and are simply correct.
   */
  copy: (produce: CopyPayload) => Promise<CopyFeedbackState>;
  /** Drop the confirmation and any armed timer - for a surface that changed what it is about. */
  reset: () => void;
}

export interface CopyFeedbackController {
  copy: (produce: CopyPayload) => Promise<CopyFeedbackState>;
  reset: () => void;
  /** Clear the timer and stop publishing. Idempotent. */
  dispose: () => void;
}

export interface CopyFeedbackDeps {
  /** Called with each new state. */
  publish: (state: CopyFeedbackState) => void;
  /** Read when the timer is armed, so a caller may vary it between renders. */
  holdMs?: () => number;
  /** Defaults to `copyText`. Overridden only by tests - the fallback is the point. */
  write?: (text: string) => Promise<unknown>;
  setTimer?: (run: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

function copyFailureMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message.trim() : "";
  return message === "" ? "The copy did not complete" : message;
}

/**
 * The copy-confirm cycle, with no React in it.
 *
 * Two guards carry the defects this replaces. `generation` makes the LAST call win, so a slow
 * producer that resolves after a newer click cannot confirm over it or re-arm a timer the
 * newer click already owns. `disposed` makes every publish after teardown a no-op, so the
 * unmounted-tree write is unrepresentable rather than merely unlikely.
 */
export function createCopyFeedback(deps: CopyFeedbackDeps): CopyFeedbackController {
  const holdMs = deps.holdMs ?? ((): number => COPY_FEEDBACK_HOLD_MS);
  const write = deps.write ?? ((text: string): Promise<unknown> => copyText(text));
  const setTimer = deps.setTimer
    ?? ((run: () => void, ms: number): number => globalThis.setTimeout(run, ms) as unknown as number);
  const clearTimer = deps.clearTimer
    ?? ((handle: number): void => { globalThis.clearTimeout(handle); });

  let state: CopyFeedbackState = { copied: false, error: null };
  let timer: number | null = null;
  let generation = 0;
  let disposed = false;

  const disarm = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const publish = (next: CopyFeedbackState): void => {
    if (disposed) return;
    // A publish that changes nothing is skipped, so `reset()` on an already-clean control is
    // free. `WorkflowLadder` resets on every `run.id` effect including the first, and the
    // `useState(false)` this replaced was bailed out of by React for the same reason.
    if (next.copied === state.copied && next.error === state.error) return;
    state = next;
    deps.publish(next);
  };

  return {
    async copy(produce: CopyPayload): Promise<CopyFeedbackState> {
      const mine = ++generation;
      // Always before the attempt, never after it: an armed timer belongs to the copy that
      // armed it, and leaving it running is how the earliest click used to clear a later
      // click's confirmation.
      disarm();
      // Only the error is dropped up front. Clearing `copied` too would flip a still-true
      // confirmation to "Copy" and back within a frame on a second click, and the previous
      // copy really is still on the clipboard until this one lands.
      if (state.error !== null) publish({ ...state, error: null });

      let text: string;
      try {
        text = typeof produce === "function" ? await produce() : produce;
        await write(text);
      } catch (caught) {
        // Overtaken: report the surface, not this attempt. See the return contract above.
        if (mine !== generation) return state;
        const outcome: CopyFeedbackState = { copied: false, error: copyFailureMessage(caught) };
        publish(outcome);
        return outcome;
      }
      if (mine !== generation) return state;
      const outcome: CopyFeedbackState = { copied: true, error: null };
      publish(outcome);
      // Not after teardown. `dispose()` disarms what is armed at that moment, and a copy still
      // awaiting its write when the surface unmounted would otherwise arm a fresh timer with
      // nothing left to clear it.
      if (disposed) return outcome;
      timer = setTimer(() => {
        timer = null;
        publish({ copied: false, error: null });
      }, holdMs());
      return outcome;
    },
    reset(): void {
      disarm();
      // Bumps the generation so a copy still in flight cannot confirm onto whatever the
      // surface has become - a run id that changed under it, say.
      generation++;
      publish({ copied: false, error: null });
    },
    dispose(): void {
      disarm();
      disposed = true;
    },
  };
}

export interface CopyFeedbackOptions {
  /** How long a confirmation holds. Defaults to `COPY_FEEDBACK_HOLD_MS`. */
  holdMs?: number;
  /**
   * What this control is currently about - a run id, a selected file path. A change resets the
   * confirmation and the error.
   *
   * Pass it whenever the surface can change subject WITHOUT remounting, which is most of them:
   * a control whose component unmounts between subjects gets this for free and needs nothing.
   * `WorkflowRuns` is the cautionary case. Its two flags used to be state inside a view that
   * `setDetail(null)` unmounted on every run change, so selecting another run cleared them by
   * accident; hoisting them into the host, which stays mounted, silently removed that - leaving
   * a run nobody had copied showing `Copied` for the rest of the previous run's hold.
   *
   * Declared here rather than left to an effect at each call site because three of the six
   * controls need it, and the fourth to be written is the one that would forget.
   */
  resetOn?: string | number | boolean | null;
}

/**
 * One copy control's confirmation state.
 *
 * `copy()` never rejects - it records the failure in `error` and lets the caller decide where
 * that sentence goes, because the six sites route it five different ways (a local error line,
 * a page-level `setError`, the editor's own banner, a status line beside the button, nothing).
 */
export function useCopyFeedback(options: CopyFeedbackOptions = {}): CopyFeedback {
  const { holdMs = COPY_FEEDBACK_HOLD_MS, resetOn = null } = options;
  const [state, setState] = useState<CopyFeedbackState>({ copied: false, error: null });
  const hold = useRef(holdMs);
  hold.current = holdMs;
  const controller = useRef<CopyFeedbackController | null>(null);

  /*
   * Built on first use rather than during render, and rebuilt if it is ever missing.
   *
   * StrictMode mounts, tears down and mounts again, so an instance created in render and
   * disposed by the first cleanup would leave the second mount holding a dead controller that
   * silently refuses to publish. Creating on demand makes that sequence self-healing - which
   * is also why `disposed` is a guard for the teardown WINDOW rather than a permanent seal: a
   * call arriving after unmount would build a fresh controller, and nothing in the app makes
   * one, because every caller is an event handler or an effect on a mounted tree.
   */
  const live = useCallback((): CopyFeedbackController => {
    controller.current ??= createCopyFeedback({
      publish: setState,
      holdMs: () => hold.current,
    });
    return controller.current;
  }, []);

  useEffect(() => () => {
    controller.current?.dispose();
    controller.current = null;
  }, []);

  // Publishes nothing on mount, and nothing on a subject change with no confirmation up: the
  // controller skips a publish that would change nothing.
  useEffect(() => { live().reset(); }, [live, resetOn]);

  const copy = useCallback(
    (produce: CopyPayload): Promise<CopyFeedbackState> => live().copy(produce),
    [live],
  );
  const reset = useCallback((): void => { live().reset(); }, [live]);

  return { copied: state.copied, error: state.error, copy, reset };
}
