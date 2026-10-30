import type { LaunchResident, ResidentLaunchResult, ResidentProfile, ResidentRun } from "@shared/residents.ts";
import { actionFetch } from "../lib/experience.ts";
import { authorizeResidentLaunch, canAuthorizeSessionControl } from "../lib/session-control-authorization.ts";

/**
 * What a launch answered, as the browser reads it: the daemon's launch result, or a refusal
 * that created nothing.
 */
export type ResidentLaunchAnswer =
  | ResidentLaunchResult
  | { state: "refused"; error: string; code: "invalid" | "not_found" | "conflict" | "unavailable" };

/**
 * Whether a Launch click on this page can give a resident session control: only in the desktop
 * app, whose preload holds the private session-control capability. The standalone browser never
 * can, so every resident it launches starts without control.
 */
export function residentLaunchCanGrantControl(): boolean {
  return canAuthorizeSessionControl();
}

/**
 * What a launched run says about session control, or null when its pinned revision does not ask
 * for it: `authorized` when the daemon consumed this launch's desktop click, else `not-granted`.
 */
export function residentRunControlOutcome(run: ResidentRun): "authorized" | "not-granted" | null {
  if (!run.settings.authority.controlOtherSessions) return null;
  return run.control.authorizedAt !== null ? "authorized" : "not-granted";
}

/**
 * Launch a resident from a profile. THE ONE browser launch call: every Launch affordance -
 * Dispatch > Resident and the Residents dock - goes through here, so the request id, the route,
 * the reading of its answer and the session-control click exist once.
 *
 * `input.requestId` makes the call idempotent. A caller keeps the same id while it retries an
 * answer it did not receive, and mints a new one only after a definitive outcome.
 *
 * `options.profile` is the profile the operator clicked Launch on, passed only by the call made
 * inside that click. When its revision turns Control other sessions on, the click is armed here -
 * synchronously, before anything is awaited, so it is still the operator's trusted click - for
 * exactly this request id, profile and revision. A replay passes no profile: it arms nothing, and
 * the daemon answers it from the run the first request reserved.
 */
export async function launchResident(
  profileId: string,
  input: LaunchResident,
  options: { profile?: ResidentProfile | null } = {},
): Promise<ResidentLaunchAnswer> {
  const profile = options.profile;
  if (profile?.id === profileId && profile.settings.authority.controlOtherSessions) {
    authorizeResidentLaunch({ requestId: input.requestId, profileId, revision: profile.revision });
  }
  let response: Response;
  try {
    response = await actionFetch(`/api/residents/profiles/${encodeURIComponent(profileId)}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return {
      state: "refused",
      code: "unavailable",
      error: error instanceof Error ? error.message : "Mission Control did not answer",
    };
  }
  const body = (await response.json().catch(() => ({}))) as Partial<ResidentLaunchResult> & {
    error?: string;
    code?: "invalid" | "not_found" | "conflict";
  };
  if (body.state === "launched" || body.state === "pending" || body.state === "failed") {
    return body as ResidentLaunchResult;
  }
  return {
    state: "refused",
    code: body.code ?? "unavailable",
    error: body.error ?? `The launch was refused (${response.status})`,
  };
}
