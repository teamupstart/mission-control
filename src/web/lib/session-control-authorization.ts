import type { ResidentLaunchAuthorization, SessionControlAuthorization } from "@shared/session-control-authorization.ts";

// Kept outside React's refresh boundary, like the public-report click capability.
const capability = typeof window === "undefined"
  ? null : window.missionDesktop?.claimSessionControlAuthorization?.() ?? null;

export function canAuthorizeSessionControl(): boolean { return capability !== null; }

export function authorizeSessionControl(input: SessionControlAuthorization): boolean {
  return capability !== null && window.missionDesktop?.authorizeSessionControl?.(capability, input) === true;
}

/**
 * Arm the session-control grant for one resident launch. Call it synchronously inside the Launch
 * click, before the launch request is sent: outside a trusted click, or outside the desktop app,
 * it arms nothing and the launch starts without control.
 */
export function authorizeResidentLaunch(input: ResidentLaunchAuthorization): boolean {
  return capability !== null && window.missionDesktop?.authorizeResidentLaunch?.(capability, input) === true;
}
