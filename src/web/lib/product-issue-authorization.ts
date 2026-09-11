// Keep the one-time preload capability outside the React refresh boundary. Re-evaluating
// the modal after a hot update must not claim it again and replace it with null.
const capability = typeof window === "undefined"
  ? null
  : window.missionDesktop?.claimProductIssueAuthorization?.() ?? null;

export function authorizeProductIssue(input: { requestId: string; draftIdentity: string }): boolean {
  if (!capability) return false;
  return window.missionDesktop?.authorizeProductIssue?.(capability, input) === true;
}
