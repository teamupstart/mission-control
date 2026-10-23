import type { SessionControlAuthorization } from "@shared/session-control-authorization.ts";

// Kept outside React's refresh boundary, like the public-report click capability.
const capability = typeof window === "undefined"
  ? null : window.missionDesktop?.claimSessionControlAuthorization?.() ?? null;

export function canAuthorizeSessionControl(): boolean { return capability !== null; }

export function authorizeSessionControl(input: SessionControlAuthorization): boolean {
  return capability !== null && window.missionDesktop?.authorizeSessionControl?.(capability, input) === true;
}
