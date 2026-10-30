import type { ActionId } from "./keybindings.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * What the topbar draws, as a list the operator owns.
 *
 * The registry `components/Topbar.tsx` and the Display category's Top bar panel both read,
 * so a topbar item is customizable from the moment it is listed here and from nowhere else -
 * the same contract `lib/board-card.ts` keeps for a card.
 *
 * Two kinds of item, and the split is the whole design:
 *
 * - `optional` items are readouts and tools the bar works without. Each can be hidden. The
 *   feedback form is also a palette command, so hiding its button takes ink away rather than a
 *   capability. Hiding Search also stops the fleet being filtered, because a filter with no box
 *   on screen would hide cards silently.
 *
 *   The pulse's `to answer` segment is deliberately NOT optional, though it sits beside the
 *   three session counts that are. It counts questions rather than sessions, and it is the
 *   only way into the attention inbox - hiding it would make answering an agent's question a
 *   thing no click on the dashboard can reach. It renders only when something is waiting.
 * - `compactable` items are the bar's destinations and its fleet controls. They cannot be
 *   removed, because they are how an operator gets anywhere; what can be chosen is whether
 *   each is ALWAYS drawn the way the ladder draws it when space runs out: the text label
 *   hidden, the glyph kept, and any count on the control (an attention badge, an issue or queue
 *   count) still drawn.
 *
 * Neither list touches the ladder. `fitTopbar` still measures the bar the operator configured
 * and still sheds labels from whatever is left when the window narrows, so the default (every
 * item shown, every item expanded) is exactly the bar this build's predecessor drew.
 *
 * Ids are persisted in `UiConfig.hiddenTopbarItems` and `UiConfig.compactTopbarItems`, so they
 * are effectively permanent: never rename one, and retire one by deleting its entry here,
 * which leaves a stored id inert rather than unreadable.
 */

/** The topbar's primary pages, in reading order, with one direct shortcut each. */
export const PAGE_SEGMENTS = [
  {
    id: "fleet",
    action: "fleet",
    label: "Fleet",
    glyph: "▦",
    hint: "The fleet of running sessions, their tasks and their reviews",
  },
  {
    id: "library",
    action: "workflows",
    label: "Library",
    glyph: "⌗",
    hint: "The Library - workflows, Personas, actions, ensemble strategies and intake",
  },
  {
    id: "runs",
    action: "runs",
    label: "Runs",
    glyph: "▷",
    hint: "Workflow Runs - live and finished workflow reviews",
  },
  {
    id: "scouts",
    action: "scouts",
    label: "Scouts",
    glyph: "⌖",
    hint: "Scouts - finished investigations and the evidence they kept",
  },
] as const satisfies readonly {
  id: "fleet" | "library" | "runs" | "scouts";
  action: ActionId;
  label: string;
  glyph: string;
  hint: string;
}[];

export type PageSegmentId = (typeof PAGE_SEGMENTS)[number]["id"];

export type TopbarItemKind = "optional" | "compactable";

export interface TopbarItem {
  id: string;
  kind: TopbarItemKind;
  /** The name the checklist prints and the control's accessible name in the panel. */
  label: string;
  /** One sentence of consequence, the way the board card checklist states its items. */
  description: string;
}

const OPTIONAL_ITEMS = [
  {
    id: "sessions",
    kind: "optional",
    label: "Session count",
    description: "How many sessions are on the fleet.",
  },
  {
    id: "needYou",
    kind: "optional",
    label: "Need you",
    description: "How many sessions are waiting on you. The Board's needs-you column still holds them.",
  },
  {
    id: "working",
    kind: "optional",
    label: "Working",
    description: "How many sessions are working right now.",
  },
  {
    id: "search",
    kind: "optional",
    label: "Search",
    description: "The fleet filter box. Hidden, nothing on the fleet is filtered.",
  },
  {
    id: "cost",
    kind: "optional",
    label: "Cost estimate",
    description: "Today's estimated fleet spend, and the breakdown it opens. Cost settings stay in Settings.",
  },
  {
    id: "feedback",
    kind: "optional",
    label: "Report product feedback",
    description: "The button that files feedback about Mission Control. The command palette still opens the form.",
  },
  {
    id: "alerts",
    kind: "optional",
    label: "Alerts and away mode",
    description: "The bell that turns desktop alerts, the chime and away mode on and off.",
  },
] as const satisfies readonly TopbarItem[];

const COMPACTABLE_ITEMS = [
  ...PAGE_SEGMENTS.map((segment) => ({
    id: segment.id,
    kind: "compactable" as const,
    label: segment.label,
    description: `The ${segment.label} page button. Minimized, it is drawn as its ${segment.glyph} alone.`,
  })),
  {
    id: "missions",
    kind: "compactable",
    label: "Recurring missions",
    description: "The Missions button. Minimized, it is drawn as its ◷ and any attention count.",
  },
  {
    id: "foreman",
    kind: "compactable",
    label: "Foreman",
    description: "The Foreman control. Minimized, it drops its name and mode and keeps its status dot, issue count and queue count.",
  },
  {
    id: "residents",
    kind: "compactable",
    label: "Residents",
    description: "The Residents dock button. Minimized, it is drawn as its ⌂, plus the live count while any resident is running.",
  },
] as const satisfies readonly TopbarItem[];

/** Every customizable topbar item, optional ones first, in the order the bar draws each kind. */
export const TOPBAR_ITEMS: readonly TopbarItem[] = [...OPTIONAL_ITEMS, ...COMPACTABLE_ITEMS];

export type OptionalTopbarItemId = (typeof OPTIONAL_ITEMS)[number]["id"];
export type CompactableTopbarItemId = (typeof COMPACTABLE_ITEMS)[number]["id"];

/** The operator's topbar, resolved: which optional items draw, and which controls stay small. */
export interface TopbarLayout {
  hidden: readonly string[];
  compact: readonly string[];
}

/** The bar as shipped: everything drawn, everything expanded. */
export const DEFAULT_TOPBAR_LAYOUT: TopbarLayout = { hidden: [], compact: [] };

export function isTopbarItemShown(layout: TopbarLayout, id: OptionalTopbarItemId): boolean {
  return !layout.hidden.includes(id);
}

export function isTopbarItemCompact(layout: TopbarLayout, id: CompactableTopbarItemId): boolean {
  return layout.compact.includes(id);
}

/** A list with `id` present or absent, returned as a fresh array and never duplicating it. */
function withId(list: readonly string[], id: string, present: boolean): string[] {
  const without = list.filter((entry) => entry !== id);
  return present ? [...without, id] : without;
}

/** The hidden list after showing or hiding one optional item. Pure, for the panel and tests. */
export function nextHiddenTopbarItems(
  hidden: readonly string[],
  id: OptionalTopbarItemId,
  shown: boolean,
): string[] {
  return withId(hidden, id, !shown);
}

/** The compact list after minimizing or expanding one control. Pure, for the panel and tests. */
export function nextCompactTopbarItems(
  compact: readonly string[],
  id: CompactableTopbarItemId,
  compactNow: boolean,
): string[] {
  return withId(compact, id, compactNow);
}

export function setTopbarItemShown(
  hidden: readonly string[],
  id: OptionalTopbarItemId,
  shown: boolean,
): void {
  void updateUiConfig({ hiddenTopbarItems: nextHiddenTopbarItems(hidden, id, shown) });
}

export function setTopbarItemCompact(
  compact: readonly string[],
  id: CompactableTopbarItemId,
  compactNow: boolean,
): void {
  void updateUiConfig({ compactTopbarItems: nextCompactTopbarItems(compact, id, compactNow) });
}

/** Put the bar back the way it shipped, in one write so the preview never shows half of it. */
export function resetTopbarLayout(): void {
  void updateUiConfig({ hiddenTopbarItems: [], compactTopbarItems: [] });
}

/** The live layout, re-rendering on any change from any surface. */
export function useTopbarLayout(): TopbarLayout {
  const config = useUiConfig();
  return { hidden: config.hiddenTopbarItems, compact: config.compactTopbarItems };
}
