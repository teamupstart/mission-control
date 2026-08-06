// Environment checks - what the daemon can say about the MACHINE a dispatch would launch
// on, as opposed to its own configuration or the operator's preferences.
//
// Three neighbours it is deliberately not: `SettingsStatus` is a fixed struct of the
// daemon's OWN config (see the module comment in `src/server/settings-status.ts`),
// `ui-config.ts` documents that nothing server-side reads it, and neither is about
// somebody else's installation. A check here asks about third-party tooling a launched
// session inherits from `~/.claude`, which the daemon does not own, cannot fix, and can
// only report on.
//
// This file is the half that must stay pure - no `node:` imports - because the dispatch
// form renders the warnings in the browser and cannot import a module that reads the
// filesystem. The same split `OPEN_TARGET_INFO` makes against `OPEN_TARGETS`: what a check
// IS lives here, what it DOES lives in `src/server/environment/`, and the server's record
// spreads this one in so a call site reads every slot off one object.
//
// The design constraint that governs every entry: **a machine that has never heard of the
// tooling a check asks about must come back silent** (`warning: null`). The dispatch form
// is generic, and a note about a plugin the operator does not use is chrome they cannot
// act on. That is what keeps a per-organisation fact out of the product's core - the
// registry entry is the only thing that knows the tooling's name, exactly as a task-source
// kind is the only thing that knows GitHub's.

/**
 * The checks this build runs, in the order the dispatch form renders their warnings.
 *
 * **Append-only.** Not persisted today - a warning is recomputed on every read and only
 * ever in flight between the route and the note. But these ids are the natural key for
 * the first thing anyone will want next (a per-check "don't warn me again", a telemetry
 * counter), and a renamed id silently stops matching a stored one - the failure
 * `TASK_SOURCE_KINDS` and `LLM_JOB_IDS` carry the same rule for. Treat it like the other
 * append-only tuples in `docs/agent-guides/change-contracts.md`: add at the end, never
 * rename, never reorder.
 */
export const ENVIRONMENT_CHECK_IDS = ["upstartclaw-core-setup"] as const;
export type EnvironmentCheckId = (typeof ENVIRONMENT_CHECK_IDS)[number];

/**
 * What can be said about a check WITHOUT looking at the machine: what its warning is
 * headed with. The server's `EnvironmentCheckImpl` spreads this in and adds the one call
 * that has to read the filesystem.
 */
export interface EnvironmentCheckInfo {
  id: EnvironmentCheckId;
  /**
   * The subject the note leads with, read before the warning sentence - so a reader can
   * tell which of several notes is about which piece of tooling.
   */
  label: string;
}

/**
 * Every check's pure half, keyed by id.
 *
 * `Record<EnvironmentCheckId, …>` is the enforcement: an id appended to
 * `ENVIRONMENT_CHECK_IDS` does not compile until it has said what it is called.
 */
export const ENVIRONMENT_CHECK_INFO: Record<EnvironmentCheckId, EnvironmentCheckInfo> = {
  "upstartclaw-core-setup": {
    id: "upstartclaw-core-setup",
    label: "UpstartClaw core setup",
  },
};

/**
 * One check as the daemon reports it - the pure half plus what only the machine can
 * answer.
 *
 * `warning` is a SENTENCE rather than a boolean, for the reason `OpenTargetView.unavailable`
 * and a task source's `preflight` are: "setup never ran", "setup was started and
 * abandoned" and "the file cannot be read" are three different things for the human to do,
 * and a note that will not say which is a support ticket. `null` means the check has
 * nothing to say, which is the answer on every machine the check does not recognise.
 */
export interface EnvironmentCheckView extends EnvironmentCheckInfo {
  /** Null when there is nothing to warn about; else what is wrong and what fixes it. */
  warning: string | null;
  /**
   * The evidence behind the warning - the file that was read and what it said - so an
   * operator who disagrees with the note knows where to look rather than having to guess
   * which of their files the daemon means. Null when there is nothing to warn about, and
   * when a warning has no single file behind it.
   */
  detail: string | null;
}

/** What `GET /api/environment/checks` answers. Always 200; see the route. */
export interface EnvironmentChecksView {
  checks: EnvironmentCheckView[];
}
