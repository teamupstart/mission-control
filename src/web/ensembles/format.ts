import type {
  EnsembleAgentCost,
  EnsembleArtifactStatus,
  EnsembleMemberStatus,
  EnsembleStatus,
  EnsembleSummary,
  EnsembleUnreadable,
} from "@shared/ensemble.ts";

/**
 * Presentational helpers shared by the Ensembles list, detail, and Best-of-N result view, so
 * a status word or a tone reads the same in all three. Kept pure and export-per-helper so a
 * render test can pin them without a DOM, the way the Workflow marks pin `workflowRunTone`.
 */

export type EnsembleTone = "running" | "waiting" | "attention" | "done" | "failed";

/**
 * A run's health tone. An unreadable snapshot always wins: a run a newer build wrote is a
 * thing the operator can still cancel or delete, and it must not read as merely "running".
 */
export function ensembleStatusTone(
  status: EnsembleStatus | null,
  unreadable: EnsembleUnreadable | null,
): EnsembleTone {
  if (unreadable) return "attention";
  switch (status) {
    case "completed":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
    case "awaiting_decision":
      return "attention";
    case "waiting":
      return "waiting";
    case "planning":
    case "running":
    case "evaluating":
    case "finalizing":
    case "cancelling":
      return "running";
    default:
      // A status this build cannot name reads as needing a look, not as healthy.
      return "attention";
  }
}

/** Title-case a snake_cased enum for display: `awaiting_decision` -> `Awaiting decision`. */
export function titleCaseEnum(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function ensembleStatusLabel(summary: Pick<EnsembleSummary, "status" | "unreadable">): string {
  if (summary.unreadable) return "Unreadable";
  return summary.status ? titleCaseEnum(summary.status) : "Unknown";
}

export function memberStatusLabel(status: EnsembleMemberStatus | null): string {
  return status ? titleCaseEnum(status) : "Unknown";
}

export function memberStatusTone(status: EnsembleMemberStatus | null): EnsembleTone {
  switch (status) {
    case "retained":
    case "advanced":
      return "done";
    case "eliminated":
    case "failed":
    case "withdrawn":
      return "failed";
    case "submitted":
    case "reviewing":
      return "waiting";
    default:
      return "running";
  }
}

export function artifactStatusLabel(status: EnsembleArtifactStatus | null): string {
  return status ? titleCaseEnum(status) : "Unknown";
}

/**
 * The aggregate candidate cost as a sentence, with what is unknown kept unknown.
 *
 * Shared by the detail's facts list and the dossier's header so one figure cannot be printed two
 * ways. `reported: false` means NOBODY reported a cost, which is not "$0.00" - a run whose
 * runners are silent about spend must not read as a free run, and a partial total says how
 * partial it is rather than silently under-counting.
 */
export function agentCostSummary(
  cost: EnsembleAgentCost,
  fmt: (usd: number) => string,
): { label: string; reported: boolean } {
  if (cost.known === 0) return { label: "not reported", reported: false };
  const total = fmt(cost.totalUsd ?? 0);
  return {
    label:
      cost.unknown === 0
        ? total
        : `${total} · ${cost.known} of ${cost.known + cost.unknown} reported`,
    reported: true,
  };
}

/** A git object short id for display. Never used to address anything - the full id is durable. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "";
}

/** A locator field, pulled defensively out of the untyped `EnsembleJson` an artifact carries. */
export function locatorString(locator: unknown, key: string): string | null {
  if (locator && typeof locator === "object" && !Array.isArray(locator)) {
    const value = (locator as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Elapsed wall-clock between two epoch-ms stamps, or from `from` to now when `to` is null. */
export function fmtElapsed(from: number, to: number | null): string {
  const end = to ?? Date.now();
  const seconds = Math.max(0, Math.round((end - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
