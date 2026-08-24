// The Foreman settings groups, in the order the strip renders and the keyboard walks them.
//
// This is the one answer to which tab owns a settings anchor. There is no Models group any
// more: Foreman's provider and its four role models moved to Settings > Models, where every
// app-owned model choice is answerable in one screen, and the panel leaves a pointer above
// the strip rather than an empty tab. The per-harness BACKLOG DISPATCH models under Launches
// did NOT move - they choose what a launched agent runs as, which is the dispatch ladder and
// not a call Foreman makes on its own account. Settings search has to select
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
