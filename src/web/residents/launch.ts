import type { LaunchResident, ResidentLaunchResult } from "@shared/residents.ts";
import { actionFetch } from "../lib/experience.ts";

/**
 * What a launch answered, as the browser reads it: the daemon's launch result, or a refusal
 * that created nothing.
 */
export type ResidentLaunchAnswer =
  | ResidentLaunchResult
  | { state: "refused"; error: string; code: "invalid" | "not_found" | "conflict" | "unavailable" };

/**
 * Launch a resident from a profile. THE ONE browser launch call: every Launch affordance -
 * Dispatch > Resident today, the Residents dock in a later phase - goes through here, so the
 * request id, the route and the reading of its answer exist once.
 *
 * `input.requestId` makes the call idempotent. A caller keeps the same id while it retries an
 * answer it did not receive, and mints a new one only after a definitive outcome.
 */
export async function launchResident(
  profileId: string,
  input: LaunchResident,
): Promise<ResidentLaunchAnswer> {
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
