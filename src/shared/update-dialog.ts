// What an auto-update conversation SAYS and OFFERS, in one browser-safe owner.
//
// These seven questions used to be `dialog.showMessageBox` calls written out in
// `main/index.ts`. That draws the platform's own sheet: a grey panel, system buttons, the
// app icon, and nothing of Mission Control's panel, border, type ramp or accent. Every
// other confirm in the product - kill, reset, complete, bind a workflow - is a themed
// `.modal`, so the one surface a person meets while the app is updating itself was also
// the one surface that did not look like the app.
//
// So the words and the answers move here, and the DRAWING moves to the dashboard
// (`web/components/UpdateDialog.tsx`). No platform sheet is kept for any case: a second,
// unthemed auto-update surface is the thing being removed, not a fallback worth holding on
// to. A question the dashboard cannot take - the renderer is still loading, or went away -
// settles as its own dismissal, which is the same answer as pressing "Later" and which the
// updater already handles. See `main/update-dialog.ts` for that path.
//
// Browser-safe by construction: no `node:` imports, so the renderer and the Electron main
// process read one owner rather than two copies.

import { UPDATE_COPY } from "./update-copy.ts";
import type { UpdateApplyOutcome } from "./update.ts";

/** Which conversation this is. Carried on the wire so a surface can style or find one. */
export const UPDATE_DIALOG_KINDS = [
  "available",
  "up-to-date",
  "preparing",
  "ready",
  "applying",
  "error",
  "outcome",
] as const;

export type UpdateDialogKind = (typeof UPDATE_DIALOG_KINDS)[number];

/**
 * What a person can answer, in two words for every dialog.
 *
 * Generic on purpose: "apply vs defer" and "install vs defer" are the updater's vocabulary,
 * not the modal's, and keeping them out of the wire means the dashboard renders any of the
 * seven without a per-kind branch. `main/index.ts` translates at the seam it owns.
 */
export type UpdateDialogChoice = "confirm" | "dismiss";

/** Info, a finished update, or a failure. Drives the accent, never the words. */
export type UpdateDialogTone = "info" | "success" | "error";

export interface UpdateDialogAction {
  choice: UpdateDialogChoice;
  label: string;
  /** The tooltip the dashboard puts on the button. */
  hint: string;
  tone: "primary" | "ghost";
}

export interface UpdateDialogContent {
  kind: UpdateDialogKind;
  tone: UpdateDialogTone;
  /** The headline, drawn as the modal's `<strong>`. */
  title: string;
  /** The sentence under it, or null where the headline is the whole of it. */
  detail: string | null;
  /**
   * In presentation order, primary first. The LAST one is what Escape and the backdrop
   * answer with, which is why every dialog ends on its dismissing action.
   */
  actions: readonly UpdateDialogAction[];
}

/** One live dialog: content, plus the id its answer has to carry back. */
export interface UpdateDialogRequest extends UpdateDialogContent {
  id: string;
}

/** The single-button acknowledgement four of the seven end on. */
function acknowledge(hint: string): readonly UpdateDialogAction[] {
  return [{ choice: "dismiss", label: "OK", hint, tone: "primary" }];
}

export interface UpdateReleaseOffer {
  currentVersion: string;
  newVersion: string;
  name: string;
  notes: string;
}

export const UPDATE_DIALOGS = {
  available(release: UpdateReleaseOffer): UpdateDialogContent {
    return {
      kind: "available",
      tone: "info",
      title: `Mission Control ${release.newVersion} is available`,
      detail: [release.name, release.notes].filter(Boolean).join("\n\n") || null,
      actions: [
        {
          choice: "confirm",
          label: "Update Now",
          hint: `Build Mission Control ${release.newVersion} now, then restart when it is ready`,
          tone: "primary",
        },
        {
          choice: "dismiss",
          label: "Later",
          hint: "Hide this update until the next check",
          tone: "ghost",
        },
      ],
    };
  },
  upToDate(version: string): UpdateDialogContent {
    return {
      kind: "up-to-date",
      tone: "success",
      title: `Mission Control ${version} is up to date`,
      detail: null,
      actions: acknowledge("Close this update notice"),
    };
  },
  preparing(version: string, stage: string): UpdateDialogContent {
    return {
      kind: "preparing",
      tone: "info",
      title: UPDATE_COPY.preparing.title(version),
      detail: `${stage}. ${UPDATE_COPY.preparing.detail}`,
      actions: acknowledge("Close this notice and watch the progress in the dashboard"),
    };
  },
  ready(version: string): UpdateDialogContent {
    return {
      kind: "ready",
      tone: "success",
      title: UPDATE_COPY.ready.title(version),
      detail: UPDATE_COPY.ready.detail,
      actions: [
        {
          choice: "confirm",
          label: "Restart and Install",
          hint: `Restart into Mission Control ${version}`,
          tone: "primary",
        },
        {
          choice: "dismiss",
          label: "Later",
          hint: "Keep the prepared update and install it later",
          tone: "ghost",
        },
      ],
    };
  },
  applying(version: string): UpdateDialogContent {
    return {
      kind: "applying",
      tone: "info",
      title: UPDATE_COPY.applying.title(version),
      detail: UPDATE_COPY.applying.detail,
      actions: acknowledge("Close this notice"),
    };
  },
  error(message: string): UpdateDialogContent {
    return {
      kind: "error",
      tone: "error",
      title: "The update could not be completed",
      detail: message,
      actions: acknowledge("Close this update error"),
    };
  },
  outcome(outcome: UpdateApplyOutcome): UpdateDialogContent {
    const failed = outcome.result === "failure";
    return {
      kind: "outcome",
      tone: failed ? "error" : "success",
      title: failed
        ? `Mission Control ${outcome.targetVersion} could not be installed`
        : `Mission Control was updated to ${outcome.targetVersion}`,
      detail: outcome.result === "failure" ? outcome.message : null,
      actions: acknowledge(failed ? "Close this update failure" : "Close this update confirmation"),
    };
  },
};

/**
 * What Escape, the backdrop, and a renderer that went away all answer with.
 *
 * Read off the content rather than assumed, so a future dialog whose only button confirms
 * cannot silently be dismissed into an answer nobody gave.
 */
export function updateDialogDismissal(content: UpdateDialogContent): UpdateDialogAction {
  const actions = content.actions;
  return actions[actions.length - 1] ?? { choice: "dismiss", label: "OK", hint: "Close", tone: "primary" };
}

/** Whether a payload off the IPC bridge is a dialog the dashboard can draw. */
export function isUpdateDialogRequest(value: unknown): value is UpdateDialogRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UpdateDialogRequest>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.title === "string" &&
    (candidate.detail === null || typeof candidate.detail === "string") &&
    UPDATE_DIALOG_KINDS.includes(candidate.kind as UpdateDialogKind) &&
    (candidate.tone === "info" || candidate.tone === "success" || candidate.tone === "error") &&
    Array.isArray(candidate.actions) &&
    candidate.actions.length > 0 &&
    candidate.actions.every(
      (action) =>
        typeof action?.label === "string" &&
        typeof action?.hint === "string" &&
        (action?.choice === "confirm" || action?.choice === "dismiss") &&
        (action?.tone === "primary" || action?.tone === "ghost"),
    )
  );
}
