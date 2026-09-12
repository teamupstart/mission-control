/**
 * Stable logical domains carried by settings snapshots.
 *
 * These ids are persisted in ordinary files that can outlive the build that wrote them.
 * Append new ids and readers; never rename or reorder an existing value.
 */
export const SETTINGS_BACKUP_DOMAINS = [
  { id: "ui", surface: "settings" },
  { id: "harnesses", surface: "settings" },
  { id: "worktrees", surface: "settings" },
  { id: "skills", surface: "settings" },
  { id: "cost", surface: "settings" },
  { id: "foreman", surface: "settings" },
  { id: "foreman-instructions", surface: "settings" },
  { id: "workflow-policy", surface: "settings" },
  { id: "task-sources", surface: "settings" },
  { id: "models", surface: "settings" },
  { id: "standing-instructions", surface: "settings" },
  { id: "inspector", surface: "settings" },
  { id: "shipping", surface: "settings" },
  { id: "pipelines", surface: "settings" },
  { id: "repo-index", surface: "settings" },
  // Which terminal app each multiplexer's sessions open in. Its controls live on the
  // Setup panel's Terminals rows rather than in a settings card of their own.
  { id: "terminals", surface: "settings" },
  // Away thresholds and the current away flag are operator configuration, but their controls
  // live in the top bar rather than Settings. They still participate in typed config coverage.
  { id: "away", surface: "runtime" },
  { id: "personas", surface: "library" },
  { id: "session-actions", surface: "library" },
  { id: "workflow-commands", surface: "library" },
  { id: "workflow-definitions", surface: "library" },
  { id: "workflow-versions", surface: "library" },
] as const;

export type SettingsBackupDomainId = (typeof SETTINGS_BACKUP_DOMAINS)[number]["id"];
export type SettingsBackupDomainSurface =
  (typeof SETTINGS_BACKUP_DOMAINS)[number]["surface"];

export const SETTINGS_BACKUP_DOMAIN_IDS = SETTINGS_BACKUP_DOMAINS.map((domain) => domain.id);

export type SettingsBackupCoverage =
  | { kind: "domain"; domains: readonly SettingsBackupDomainId[] }
  | {
      kind: "not-applicable";
      reason: "read-only" | "operational-action" | "derived-status";
    };

export function backupDomains(
  ...domains: readonly SettingsBackupDomainId[]
): SettingsBackupCoverage {
  return { kind: "domain", domains };
}

export function backupNotApplicable(
  reason: Extract<SettingsBackupCoverage, { kind: "not-applicable" }>["reason"],
): SettingsBackupCoverage {
  return { kind: "not-applicable", reason };
}
