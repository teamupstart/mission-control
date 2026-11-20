import type { HomeSessionRegistration } from "@shared/home-dispatch.ts";

// Owner: P3. The launcher decision (spec 7.4): whether a registration answer sets
// `offerLauncher`. It has no route of its own; `sessions.ts` calls it and records
// `launcher_offered_at` when the answer is yes.

/**
 * The setting `dispatch.launcher.prompt` (7.4). P4 owns `GET /dispatch/config` and the setting
 * itself; until it lands the launcher prompt is on, which is the setting's default. `sessions.ts`
 * reads it through this seam so P4 swaps one function body and no caller.
 */
export function launcherPromptSetting(): boolean {
  return true;
}

export interface LauncherFacts {
  registration: Pick<
    HomeSessionRegistration,
    "source" | "entrypoint" | "interactive" | "beforeFirstPrompt" | "launcherDisabled"
  >;
  /** True when this session has been offered the launcher before (`launcher_offered_at` is set). */
  alreadyOffered: boolean;
  /** `dispatch.launcher.prompt`. */
  promptSetting: boolean;
  /** The caller passed the home-session rule: registered, never a worker. */
  registeredHomeSession: boolean;
}

/**
 * Whether to offer the launcher. Every condition of 7.4 must hold: the start source is
 * `startup`, the entrypoint is `cli` (L6) and the session is interactive, nothing has been
 * prompted yet, it was never offered, the setting is on, the session did not disable it, and
 * it is a registered home session. A late registration (the daemon was down at start) has
 * `beforeFirstPrompt: false`, so it fails safe.
 */
export function shouldOfferLauncher(facts: LauncherFacts): boolean {
  const r = facts.registration;
  return (
    facts.registeredHomeSession &&
    r.source === "startup" &&
    r.entrypoint === "cli" &&
    r.interactive &&
    r.beforeFirstPrompt &&
    !facts.alreadyOffered &&
    facts.promptSetting &&
    !r.launcherDisabled
  );
}
