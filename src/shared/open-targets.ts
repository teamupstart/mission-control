// "Open in ..." - handing a file in a session's checkout to an application OUTSIDE
// Mission Control, addressed by what the human wants ("a browser", "my editor") rather
// than by a binary name.
//
// This file is the half that must stay pure - no `node:` imports - because the files
// view renders the menu in the browser and cannot import a module that spawns processes.
// The same split `HARNESS_CAPABILITIES` makes against `HARNESSES`, and
// `TASK_SOURCE_KIND_INFO` against `TASK_SOURCES`: what a target IS lives here, what it
// DOES lives in `src/server/open-targets/`, and the server's record spreads this one in
// so a call site reads every slot off one object.
//
// The dashboard renders one row per registered id and nothing else. A new target is a
// file under `src/server/open-targets/` plus an entry in each record here and there; no
// component, no stylesheet rule and no route changes, which is the whole point of the
// menu being a fold over this list rather than a hand-written row per application.

/**
 * The targets this build offers, in menu order.
 *
 * Not persisted today - the menu is a fresh choice every time, so an id is only ever in
 * flight between the click and the POST. **The moment a "default target" preference is
 * stored** (in `ui_config`, or per-session), these become append-only for the reason
 * `TASK_SOURCE_KINDS` and `LLM_JOB_IDS` are: a renamed id stops matching a registered
 * target and silently opens nothing.
 */
export const OPEN_TARGET_IDS = ["browser"] as const;
export type OpenTargetId = (typeof OPEN_TARGET_IDS)[number];

/**
 * What can be said about a target WITHOUT leaving the process: what the menu row calls
 * it and what that row promises. The server's `OpenTargetImpl` spreads this in and adds
 * the one call that has to look at the machine.
 */
export interface OpenTargetInfo {
  id: OpenTargetId;
  /** The menu row, read after the control's own "Open in" label. */
  label: string;
  /** One line saying where the file actually lands, shown under the label. */
  blurb: string;
  /** Leading glyph for the row. A character, never an image or an agent colour. */
  glyph: string;
}

/**
 * Every target's pure half, keyed by id.
 *
 * `Record<OpenTargetId, …>` is the enforcement: an id appended to `OPEN_TARGET_IDS` does
 * not compile until it has said what it is called and what it promises.
 */
export const OPEN_TARGET_INFO: Record<OpenTargetId, OpenTargetInfo> = {
  browser: {
    id: "browser",
    label: "Browser",
    blurb: "Opens the file from disk in your default browser.",
    glyph: "◍",
  },
};

/**
 * One target as the daemon reports it - the pure half plus what only the machine can
 * answer.
 *
 * `unavailable` is a SENTENCE rather than a boolean for the reason a task source's
 * `preflight` is: "this build has no such target", "no browser is registered on this
 * platform" and "the launcher is not installed" are three different things for the human
 * to do, and a greyed-out row that will not say which is a support ticket.
 */
export interface OpenTargetView extends OpenTargetInfo {
  /** Null when the target can be used right now; else why it cannot. */
  unavailable: string | null;
  /**
   * What will actually be launched, when the target can name it - "Google Chrome" beside
   * the "Browser" row. Null when it resolves through a handler that names nothing
   * (`xdg-open`), which is not the same claim as "unavailable".
   */
  detail: string | null;
}

/** What the daemon answers a launch with, so the menu can report the app by name. */
export interface OpenFileResult {
  ok: boolean;
  target?: OpenTargetId;
  /** The target's label, so a toast reads "Opened in Browser" without re-deriving it. */
  label?: string;
  /** The resolved application, when it has a name. See `OpenTargetView.detail`. */
  detail?: string | null;
  error?: string;
}
