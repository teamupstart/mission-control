/** Search metadata shared by the dashboard index and the session setting owner. */
export const SKIN_SETTING = {
  key: "ui.skin",
  label: "Skin",
  anchor: "display/skin",
  keywords: ["skin", "theme", "dark", "light", "daylight", "colour", "color", "appearance"],
} as const;

export const SESSION_SETTINGS_ACCESS = {
  key: "sessionSettings.access",
  label: "Allow sessions to access Mission Control settings",
  anchor: "trust/session-settings",
  description: "Let registered sessions read or change supported settings. Turning this off takes effect immediately, including in sessions that are already running.",
  keywords: ["sessions", "settings", "mcp", "access", "revoke", "permission"],
} as const;

/** Settings owners whose existing HTTP views need a bounded invalidation. */
export const SETTINGS_REFRESH_DOMAINS = [
  "ui", "foreman", "inspector", "llm", "shipping", "skills", "cost", "terminals", "reports", "workflows",
] as const;
export type SettingsRefreshDomain = (typeof SETTINGS_REFRESH_DOMAINS)[number];

export function settingsRefreshDomain(key: string): SettingsRefreshDomain | undefined {
  return SETTINGS_REFRESH_DOMAINS.find(domain => key.startsWith(`${domain}.`));
}
