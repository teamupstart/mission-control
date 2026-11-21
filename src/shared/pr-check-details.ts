/** Display evidence only. Never used to change review or merge gates. */
export interface PrCheckDetails {
  /** At most the first 100 results from GitHub's CLI export. */
  results: Array<{ name: string; conclusion: string; url: string | null }>;
  complete: boolean;
}

export function prCheckSummary(details: PrCheckDetails | null | undefined): string {
  if (!details?.results.length) return "CI is not passing; individual check results unavailable";
  const results = details.results;
  const failed = results.filter(r => r.conclusion === "FAILURE" || r.conclusion === "ERROR");
  if (failed.length) return `${failed.length} CI check${failed.length === 1 ? "" : "s"} reported failure`;
  const cancelled = results.filter(r => r.conclusion === "CANCELLED");
  if (cancelled.length) return `CI includes ${cancelled.length} cancelled check${cancelled.length === 1 ? "" : "s"}; no failures in the reported results`;
  return "CI is not passing; no failures in the reported results";
}
