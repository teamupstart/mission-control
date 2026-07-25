import type { PaneDialog } from "@shared/types.ts";
import type { SubmitOptions } from "@shared/protocol.ts";
import type { SessionRequestAnswer } from "../harness/types.ts";
import { describeOptionRowMiss, optionRowMiss } from "../discovery/pane-dialog.ts";

/**
 * Turning what a CALLER sent into what a driver can be told, against the ask the caller was
 * actually looking at.
 *
 * The pure half of the answer routes' driver arm, and its own module for the reason
 * `sdk/dialog.ts` is: `driverDialog` projects a request INTO the shape every surface renders,
 * and this projects an answer back OUT of it. Between them they are the whole of "menus stop
 * being screens", and both have to be readable without a subprocess to reason about.
 *
 * ## Why verify here at all, when the driver verifies too
 *
 * They check different things against different sources of truth, and both are load-bearing.
 * This checks the caller's answer against the SNAPSHOT they were shown - the same
 * `optionRowMiss` rule the pane walk applies, catching a click made against a question that
 * has since been replaced. The adapter re-checks against the handle it is holding, which is
 * the authority, and refuses a request id it no longer has. Keep both: a stale card and a
 * stale handle are two different ways to answer the wrong question, and neither check sees
 * the other's.
 */

export type DriverAnswer =
  | { ok: true; requestId: string; answer: SessionRequestAnswer }
  /** Every refusal is a 409 at the route: the ask moved, and nothing was delivered. */
  | { ok: false; error: string };

/** Whether this dialog is a driver's pending request rather than a screen we read. */
export function driverRequestId(dialog: PaneDialog | null | undefined): string | null {
  if (!dialog || dialog.source !== "driver") return null;
  return dialog.requestId ?? null;
}

const NO_REQUEST = "this session has no pending request to answer";

/**
 * One row of a single ask - the `/select-option` body, verified.
 *
 * The number identifies and the label verifies, exactly as on the pane path: a number alone
 * is a position on a list the caller may have re-read since, which is how a confident,
 * well-formed request answers the wrong question.
 */
export function driverOptionAnswer(
  dialog: PaneDialog | null | undefined,
  target: { number: number; label: string },
): DriverAnswer {
  const requestId = driverRequestId(dialog);
  if (!dialog || !requestId) return { ok: false, error: NO_REQUEST };
  if (dialog.multiSelect) {
    return {
      ok: false,
      error:
        "this ask is a form - answering one row of it answers nothing, so it has to be submitted whole",
    };
  }
  const miss = optionRowMiss(dialog, target);
  if (miss) return { ok: false, error: describeOptionRowMiss(miss, dialog, target) };
  return { ok: true, requestId, answer: { kind: "option", ...target } };
}

/**
 * A whole multi-question form - the `/submit-options` driver body, verified.
 *
 * Refuses a partial submission rather than sending it, which is the same call the pane path
 * makes when the review tab reports an unanswered question: a half-filled form puts answers
 * the human never gave under their name. The difference is only where the refusal comes
 * from - here it is arithmetic over the request, there it is a banner read off a screen.
 */
export function driverFormAnswer(
  dialog: PaneDialog | null | undefined,
  submitted: NonNullable<SubmitOptions["answers"]>,
): DriverAnswer {
  const requestId = driverRequestId(dialog);
  if (!dialog || !requestId) return { ok: false, error: NO_REQUEST };
  const questions = dialog.questions ?? [];
  if (questions.length === 0) {
    return { ok: false, error: "this ask is not a form - answer one of its rows instead" };
  }
  for (const one of submitted) {
    const question = questions.find((q) => q.question === one.question);
    if (!question) {
      return { ok: false, error: `this form no longer asks "${one.question}" - it changed` };
    }
    if (!one.text?.trim() && one.labels.length === 0) {
      return { ok: false, error: `"${one.question}" was not answered` };
    }
    if (!question.multiSelect && one.labels.length > 1) {
      return { ok: false, error: `"${one.question}" takes one answer, not ${one.labels.length}` };
    }
    for (const label of one.labels) {
      if (!question.options.some((o) => o.label === label)) {
        return { ok: false, error: `"${label}" is no longer an option for "${one.question}"` };
      }
    }
  }
  const answered = new Set(submitted.map((a) => a.question));
  const missing = questions.find((q) => !answered.has(q.question));
  if (missing) return { ok: false, error: `"${missing.question}" was not answered` };
  return {
    ok: true,
    requestId,
    answer: {
      kind: "form",
      answers: submitted.map((a) => ({
        question: a.question,
        labels: [...a.labels],
        ...(a.text?.trim() ? { text: a.text.trim() } : {}),
      })),
    },
  };
}
