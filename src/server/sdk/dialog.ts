import type { PaneDialog } from "@shared/types.ts";
import type { SessionRequest } from "../harness/types.ts";

/**
 * A driver's pending request, as the dialog every surface already renders.
 *
 * Pure, and its own module, because it is the whole of the "one request shape" decision and
 * it has to be readable on its own: a permission callback, an `AskUserQuestion` form and a
 * Codex approval RPC all become the SAME `PaneDialog` a pane parse produces, which is what
 * lets `activePaneDialog` keep answering `needs-you`, the card keep drawing rows as buttons,
 * and Foreman keep answering with `answer.option` - with no second arm anywhere.
 *
 * What it deliberately does NOT do is invent a cursor. `highlighted` is 0, which is no row
 * (options number from 1): a driver request has no pre-selected default and no keystroke
 * that could confirm one, so there is nothing to point at. Reading 0 as "row zero" is not
 * possible for any consumer - the pane path's own walk compares against a row NUMBER, and
 * `selectPaneOption` is never reached for a session with no pane.
 */
export function driverDialog(request: SessionRequest): PaneDialog {
  const questions = request.questions ?? [];
  // A form is answered as a whole (`/submit-options`), a single ask row by row
  // (`/select-option`) - which is exactly what `multiSelect` has always meant, so the flag
  // is derived from the request's shape rather than added as a second signal beside it.
  const isForm = questions.length > 1 || questions.some((q) => q.multiSelect);
  return {
    // A form's rows live on its questions; flattening them here would offer the human a
    // single numbered list whose numbers mean nothing to the driver.
    options: isForm ? [] : [...(questions[0]?.options ?? request.options)],
    highlighted: 0,
    prompt: request.prompt,
    ...(isForm ? { multiSelect: true as const } : {}),
    source: "driver",
    requestId: request.id,
    kind: request.kind,
    ...(questions.length > 0 ? { questions: questions.map((q) => ({ ...q })) } : {}),
  };
}
