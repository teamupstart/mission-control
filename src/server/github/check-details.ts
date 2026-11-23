import type { PrCheckDetails } from "@shared/pr-check-details.ts";

/** Preserve individual conclusions, including old runs, without interpreting gate policy. */
export function checkDetails(raw: unknown): PrCheckDetails {
  const entries = Array.isArray(raw) ? raw : [];
  const results: PrCheckDetails["results"] = [];
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : entry.context;
    const conclusion = entry.conclusion || entry.state || entry.status;
    if (typeof name !== "string" || typeof conclusion !== "string") continue;
    const rawUrl = entry.detailsUrl || entry.targetUrl;
    let url: string | null = null;
    if (typeof rawUrl === "string" && rawUrl.length <= 4096) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") url = rawUrl;
      } catch { /* A missing or malformed provider URL is rendered as plain text. */ }
    }
    results.push({ name: name.slice(0, 512), conclusion: conclusion.slice(0, 64), url });
  }
  return { results, complete: Array.isArray(raw) && entries.length < 100 && results.length === entries.length };
}
