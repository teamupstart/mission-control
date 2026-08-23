// The Foreman settings groups, in the order the strip renders and the keyboard walks them.
//
// This is the one answer to which tab owns a settings anchor. Settings search has to select
// that tab before SettingsPage scrolls and flashes the target; keeping the relationship in a
// pure table makes the routing contract testable without a DOM and keeps later presentation
// work from inventing a second grouping.

export const FOREMAN_SETTINGS_TABS = [
  {
    id: "posture",
    label: "Posture",
    anchors: ["foreman/cheap-tier"],
  },
  {
    id: "models",
    label: "Models",
    anchors: [
      "foreman/provider",
      "foreman/model-review",
      "foreman/model-verify",
      "foreman/model-triage",
      "foreman/model-backlog",
    ],
  },
  {
    id: "launches",
    label: "Launches",
    anchors: [
      "foreman/backlog-model-claude",
      "foreman/backlog-model-codex",
      "foreman/backlog-model-pi",
    ],
  },
  {
    id: "safety",
    label: "Safety",
    anchors: [
      "foreman/skip-scout-wrapup",
      "foreman/skip-review-artifact-wrapup",
      "foreman/ship-recovery-minutes",
    ],
  },
] as const;

export type ForemanSettingsTabId = (typeof FOREMAN_SETTINGS_TABS)[number]["id"];

export const FOREMAN_DEFAULT_TAB: ForemanSettingsTabId = "posture";

/** Return the group that owns an anchor, or null for deliberate outsiders and unknowns. */
export function foremanTabForAnchor(anchor: string): ForemanSettingsTabId | null {
  for (const tab of FOREMAN_SETTINGS_TABS) {
    if ((tab.anchors as readonly string[]).includes(anchor)) return tab.id;
  }
  return null;
}
