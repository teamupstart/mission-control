// The settings registry: which categories exist, how they group, and how far each one's
// writes reach. Pure data - no React, no component imports, no `node:` anything - because
// four very different callers have to read the SAME list at runtime:
//
//   - the router (`useWorkflowRoute.ts`), which validates `#/settings/<id>` against it and
//     therefore needs the VALUES, not just the type: a type-only import is erased before it
//     could refuse an unknown category;
//   - the page (`components/SettingsPage.tsx`), which renders the rail from it;
//   - the render test, which walks it to prove every category is reachable;
//   - later, the settings search index, which derives its category hits from it.
//
// Keeping it out of the page module is what lets the router import it without pulling a
// component (and the five hooks behind it) into the router's module graph.

/**
 * The groups, in rail order, and the order the whole registry is read in.
 *
 * Ordered by blast radius rather than by age or alphabet: a group's `scope` is the badge
 * the rail draws beside its label, so the nav answers "what does this reach" before you
 * click anything. Rendering the rail from this array - never from a hand-kept list in JSX -
 * is what keeps a new category from landing in a group nothing draws.
 */
export const SETTINGS_GROUPS = [
  { id: "screen", label: "This screen", scope: "browser" },
  { id: "sessions", label: "Sessions", scope: "machine" },
  { id: "background", label: "Background work", scope: "machine" },
  { id: "outbound", label: "Leaves the machine", scope: "github" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * How far a setting's writes reach, worst case, as four answers a human can act on.
 *
 * A group carries the scope of its members in general; a CATEGORY carries its own, which
 * is sometimes stronger - Skills sits in *Sessions* (this machine) but symlinks into `~/`,
 * so its panel header says `Writes ~/` where the rail's group label says This machine. The
 * rail is the summary, the panel header is the precise claim, and neither is allowed to be
 * softer than the truth.
 */
export const SETTINGS_SCOPES = {
  browser: {
    label: "This browser",
    hint: "Stored on this machine for the dashboard. Nothing here reaches the daemon.",
  },
  machine: {
    label: "This machine",
    hint: "Changes what the daemon does locally. Nothing leaves this machine.",
  },
  home: {
    label: "Writes ~/",
    hint: "Edits files in your home directory, so it reaches sessions this app never launched.",
  },
  github: {
    label: "Acts on GitHub",
    hint: "Can publish or merge under your GitHub account.",
  },
} as const satisfies Record<string, { label: string; hint: string }>;

export type SettingsScopeId = keyof typeof SETTINGS_SCOPES;

/**
 * The settings categories, in rail order. Each is a peer destination in the left nav, so
 * adding one - Notifications, General - is appending an entry here plus a `case` in
 * `renderCategory`, never lengthening a scroll. Keeping the list as data (not inlined JSX)
 * is also what the render test walks to prove every category is reachable.
 *
 * Entries are grouped CONTIGUOUSLY and in `SETTINGS_GROUPS` order, because the rail renders
 * group by group while the arrow keys walk this flat array: if the two orders disagree,
 * Down moves the selection somewhere the eye is not. `settings-sidebar-render.test.ts`
 * pins that.
 *
 * Fields:
 *  - `blurb` is what the rail's tooltip says. It sits on the registry rather than at the
 *    nav's render site so a new panel cannot be added without saying what it is for - the
 *    same reason `label` and `icon` live here.
 *  - `group` places it in the rail; `scope` is the badge its panel header carries.
 *  - `keywords` are the extra words a human might search for that the label does not
 *    contain. Minimal for now; the settings search palette consumes them.
 *
 * Ids are NOT persisted anywhere - the hash is a link, not storage - so renaming one costs
 * a stale bookmark that falls back to the default category, nothing more.
 *
 * ANCHORS. Every control row across the panels carries `data-anchor="<category>/<slug>"`,
 * where `<category>` is an id from this list. Those anchors are stable ids the settings
 * search index points at, so renaming one is a breaking change to that index rather than a
 * cosmetic edit; `settings-sidebar-render.test.ts` fails on a duplicate anchor or on one
 * whose prefix is not a category here.
 */
export const SETTINGS_CATEGORIES = [
  {
    id: "display",
    label: "Display",
    icon: "▦",
    blurb: "How the dashboard arranges sessions, and how transcripts are drawn",
    group: "screen",
    scope: "browser",
    keywords: ["layout", "appearance", "cards", "console", "board", "markdown", "rich text"],
  },
  {
    id: "keyboard",
    label: "Keyboard",
    icon: "⌨",
    blurb: "Rebind any shortcut",
    group: "screen",
    scope: "browser",
    keywords: ["shortcut", "chord", "hotkey", "binding", "keys"],
  },
  {
    id: "harnesses",
    label: "Harnesses",
    icon: "⚙",
    blurb: "Defaults each agent is dispatched with",
    group: "sessions",
    scope: "machine",
    keywords: ["agent", "model", "effort", "auto mode", "permission mode", "dispatch"],
  },
  {
    id: "skills",
    label: "Skills",
    icon: "✦",
    blurb: "Which skills every session gets",
    group: "sessions",
    scope: "home",
    keywords: ["skill", "slash command", "symlink", "catalog"],
  },
  {
    id: "cost",
    label: "Cost",
    icon: "$",
    blurb: "Usage telemetry and what the topbar reports",
    group: "sessions",
    scope: "home",
    keywords: ["telemetry", "otel", "usage", "spend", "estimate", "interval"],
  },
  {
    id: "foreman",
    label: "Foreman",
    icon: "●",
    blurb: "The auto-responder's posture and trusted repos",
    group: "background",
    scope: "machine",
    keywords: ["auto-responder", "triage", "cheap tier", "allowlist", "backlog"],
  },
  {
    id: "workflows",
    label: "Workflows",
    // The same glyph the topbar's Workflows button carries, so the rail row and the page
    // it configures are recognisably the same subsystem.
    icon: "⌘",
    blurb: "Live repair delivery, its trusted repos, and how long run history is kept",
    group: "background",
    // `machine`, not `home`: Live delivery types a repair packet into a terminal pane, and
    // the config itself lives in the daemon's own state - nothing here edits a file in the
    // home directory, which is the precise claim `home`'s "Writes ~/" badge makes (Skills
    // and Cost, which do). The blast radius is still real and this scope names it: the
    // daemon acts locally, including in sessions this app never launched.
    scope: "machine",
    keywords: [
      "workflow",
      "live delivery",
      "allowlist",
      "retention",
      "persona",
      "review",
      "repair",
      "evidence",
      "health",
    ],
  },
  {
    id: "task-sources",
    label: "Task sources",
    icon: "⇊",
    blurb: "Upstreams that pull work into the backlog",
    group: "background",
    scope: "machine",
    keywords: ["github issues", "sweep", "backlog", "import", "upstream"],
  },
  {
    id: "models",
    label: "Models",
    icon: "◈",
    blurb: "The provider and models behind the app's own calls",
    group: "background",
    scope: "machine",
    keywords: ["provider", "runner", "title", "goal", "digest", "workflow context"],
  },
  {
    id: "inspector",
    label: "Inspector",
    icon: "⌕",
    blurb: "Review of the pull requests we open",
    group: "outbound",
    scope: "github",
    keywords: ["review", "pull request", "dry run", "live", "comments"],
  },
  {
    id: "shipping",
    label: "Shipping",
    icon: "⚑",
    blurb: "Whether clean pull requests merge themselves",
    group: "outbound",
    scope: "github",
    keywords: ["yolo", "auto merge", "soak", "squash", "rebase"],
  },
  {
    id: "trust",
    label: "Trust",
    icon: "⛨",
    blurb: "Which repositories each subsystem may act in",
    group: "outbound",
    scope: "github",
    keywords: ["allowlist", "repo", "repository", "permission", "grant", "matrix", "merge", "review"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  group: SettingsGroupId;
  scope: SettingsScopeId;
  keywords: readonly string[];
}[];

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

/**
 * How a panel asks the page to move: to another category, and optionally to flash one
 * anchored control there once it renders.
 *
 * The optional `anchor` is a transient UI concern, never part of the route/hash (that
 * grammar is Phase 1's, category-only): `SettingsPage` changes the route and, after the
 * target panel is on screen, scrolls its `data-anchor` target into view and flashes it.
 * The three outbound panels use this to deep-link into Trust, and Shipping's dependency
 * warnings use it to land on the exact Inspector control they name.
 */
export type SettingsNavigate = (category: SettingsCategoryId, anchor?: string) => void;

/**
 * Where `#/settings` with no category lands, and where an unknown one falls back to.
 *
 * Display, deliberately: it is the only category in the browser-scoped group, so a stale
 * link or a typo cannot open a panel that acts on GitHub.
 */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = "display";

/** Runtime membership, for the router: an unknown id in a link must not become a route. */
export function isSettingsCategory(id: string): id is SettingsCategoryId {
  return SETTINGS_CATEGORIES.some((c) => c.id === id);
}

/** The categories in one group, in registry order. The rail's only way to draw a group. */
export function settingsCategoriesIn(
  group: SettingsGroupId,
): readonly (typeof SETTINGS_CATEGORIES)[number][] {
  return SETTINGS_CATEGORIES.filter((c) => c.group === group);
}

/** One category's entry, by id. */
export function settingsCategory(
  id: SettingsCategoryId,
): (typeof SETTINGS_CATEGORIES)[number] {
  // Non-null by construction: `SettingsCategoryId` is this array's own union.
  return SETTINGS_CATEGORIES.find((c) => c.id === id)!;
}
