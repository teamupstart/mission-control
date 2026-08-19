/** Whether a release candidate is strictly newer than the running app. */
export function isNewerVersion(currentVersion: string, candidateVersion: string): boolean {
  const currentParts = currentVersion.replace(/^v/, "").split(".").map(Number);
  const candidateParts = candidateVersion.replace(/^v/, "").split(".").map(Number);

  for (let index = 0; index < Math.max(currentParts.length, candidateParts.length); index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const candidatePart = candidateParts[index] ?? 0;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }

  return false;
}
