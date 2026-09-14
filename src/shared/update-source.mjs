/** Full Git object identity, never a moving branch name or abbreviated ref. */
export function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** Refuse a commit install unless the packaged source is exactly the requested commit. */
export function sourceCommitProblem(ref, commit) {
  if (!isCommitSha(ref)) return null;
  return ref === commit ? null : "The app bundle does not contain the requested source commit. Prepare the update again.";
}
