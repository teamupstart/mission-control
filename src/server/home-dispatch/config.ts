import type { Handler } from "hono";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { HomeDispatchConfigSchema, type HomeDispatchConfig } from "@shared/home-dispatch.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { isCliRequest, resolveCaller } from "./caller.ts";
import type { HomeDispatchHandler } from "./stub.ts";

// Owner: P4. `GET /dispatch/config` (spec 2.3, 7.13): the dispatch settings `mctl config view`
// shows. `dispatch.launcher.prompt` (7.4) lives here, and `launcher.ts` reads it through
// `launcherPromptEnabled`, so the decision and the view can never disagree.

/** `dispatch.launcher.prompt`: on until someone sets it off. */
export function launcherPromptEnabled(): boolean {
  return getAppConfig(APP_CONFIG_ENTRIES.dispatchLauncherPrompt) ?? true;
}

export function setLauncherPrompt(enabled: boolean): void {
  setAppConfig(APP_CONFIG_ENTRIES.dispatchLauncherPrompt, enabled);
}

export function dispatchConfig(): HomeDispatchConfig {
  return HomeDispatchConfigSchema.parse({ launcher: { prompt: launcherPromptEnabled() } });
}

/** Readable by `mctl` and by a registered home session, like every other read. */
export const configHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  // The setting is global, so `mctl config view` names no repository. Any other caller must be a
  // registered home session, and is refused with the reason when it is not.
  if (!isCliRequest(c)) {
    const outcome = await resolveCaller(deps, c, { sessionId: c.req.query("session") });
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  }
  return c.json(dispatchConfig());
};
