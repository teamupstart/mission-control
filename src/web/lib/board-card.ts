import { useCallback } from "react";
import { RESIDENT_CARD_NAMES_FLAG_ID } from "@shared/feature-flag-registry.ts";
import {
  BACKGROUND_AGENTS_STYLES,
  RESIDENT_CARD_NAME_STYLES,
  residentCardNameStylesOf,
  TASK_KIND_CARD_STYLES,
  TASK_KIND_HEADER_STYLES,
} from "@shared/protocol.ts";
import type {
  BackgroundAgentsStyle,
  ResidentCardNameStyle,
  TaskKindCardStyle,
  TaskKindHeaderStyle,
  UiConfig,
} from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";

import { RESIDENT_CARD_NAME_COPY, type DisplayItemId, type DisplayItemGroup } from "@shared/board-card-settings.ts";
export * from "@shared/board-card-settings.ts";

/**
 * Whether an item should be drawn, given the operator's hidden list.
 *
 * Free of React so the tile's gate and the tests can ask the same question. An id the
 * stored list does not mention is VISIBLE, which is what makes an item added by a later
 * build appear for everyone automatically, and what makes a renamed id lapse to visible
 * rather than silently hiding a fact.
 *
 * There is no per-item default here on purpose. An item that ships hidden says so by being
 * in `UI_CONFIG_DEFAULTS.hiddenDisplayItems` - `worktree` and `workflowDetails` are the two -
 * so this stays a single question asked of a single list, and checking the box removes the id
 * exactly as it does for every other item.
 */
export function isDisplayItemShown(
  hidden: readonly string[],
  id: DisplayItemId,
): boolean {
  return !hidden.includes(id);
}

/**
 * One predicate over the live config, for a component that gates several items.
 *
 * `useUiConfig` is a `useSyncExternalStore` whose server snapshot is its client snapshot,
 * so this is safe under `renderToStaticMarkup` and reads the shipped defaults there.
 */
export function useDisplayItems(): (id: DisplayItemId) => boolean {
  const hidden = useUiConfig().hiddenDisplayItems;
  return useCallback((id: DisplayItemId) => isDisplayItemShown(hidden, id), [hidden]);
}

/**
 * Show or hide one item, persisted through the daemon like every other Display preference.
 *
 * The whole array is owned by this panel and replaced wholesale, which is the blob's
 * shallow-merge rule (`UiConfigPatchSchema`). Ids this build does not know are preserved
 * rather than pruned: a stored list may name an item a NEWER build ships, and dropping it
 * here would silently un-hide it the next time that build is opened.
 */
export function setDisplayItemShown(
  hidden: readonly string[],
  id: DisplayItemId,
  shown: boolean,
): void {
  const next = shown
    ? hidden.filter((entry) => entry !== id)
    : hidden.includes(id)
      ? [...hidden]
      : [...hidden, id];
  void updateUiConfig({ hiddenDisplayItems: next });
}

/**
 * The Display choices that are a STYLE rather than a show/hide switch.
 *
 * Kept beside `DISPLAY_ITEMS` and keyed by the same groups, so the panel renders each one in
 * the section for the surface it governs, but a separate list: an item is one boolean in
 * `hiddenDisplayItems`, while a choice is its own `UiConfig` key holding one of a fixed set of
 * values, often with `off` among them. Folding these into the item list would make "hidden" a sixth
 * style of a five-way choice and leave two places that can each turn the mark off.
 *
 * Each option's copy is a `Record` over the persisted style list, so a style added to
 * `TASK_KIND_*_STYLES` or `BACKGROUND_AGENTS_STYLES` does not compile until it says how it is
 * offered.
 */
export interface DisplayChoiceOption<V extends string> {
  id: V;
  label: string;
  description: string;
}

const TASK_KIND_HEADER_COPY: Record<TaskKindHeaderStyle, Omit<DisplayChoiceOption<TaskKindHeaderStyle>, "id">> = {
  badge: {
    label: "Title badge",
    description: "A colour-coded badge leading the session's name, read in the same glance as the name.",
  },
  eyebrow: {
    label: "Eyebrow",
    description: "A small line above the name that also says what the kind is for. Adds a line of height.",
  },
  tile: {
    label: "Kind tile",
    description: "The agent dot grows into a tile with the kind's icon and word, and the header's left edge takes the kind's colour.",
  },
  tabs: {
    label: "Tab strip",
    description: "The first item of the tab strip, leaving the row with the name exactly as it was.",
  },
  off: {
    label: "Off",
    description: "The console does not say what kind of task this is.",
  },
};

const TASK_KIND_CARD_COPY: Record<TaskKindCardStyle, Omit<DisplayChoiceOption<TaskKindCardStyle>, "id">> = {
  tab: {
    label: "Edge tab",
    description: "A tab on the card's top border, like a folder tab. Takes no room inside the card.",
  },
  chip: {
    label: "Name chip",
    description: "A chip beside the session's name. Takes some width from the name.",
  },
  band: {
    label: "Top band",
    description: "A tinted band across the top of the card that also says what the kind is for. Makes each card taller.",
  },
  medallion: {
    label: "Medallion",
    description: "The agent dot becomes the kind's icon. The word is on hover.",
  },
  off: {
    label: "Off",
    description: "Cards do not say what kind of task they are.",
  },
};

/**
 * The background sub-agent treatments, each named for what the board card does and saying
 * what the conversation does with it, because one value switches both halves.
 */
const BACKGROUND_AGENTS_COPY: Record<BackgroundAgentsStyle, Omit<DisplayChoiceOption<BackgroundAgentsStyle>, "id">> = {
  nested: {
    label: "Nested sub-cards",
    description:
      "Each agent hangs under its card, and a tray above the reply box lists them. Cards grow while agents run.",
  },
  chip: {
    label: "Chip and popover",
    description:
      "A chip in the card's flags opens the list, and the conversation rail gains an Agents tab. Cards keep their height.",
  },
};

/**
 * Each choice's `UiConfig` key with the values that key stores, so a key and its styles travel
 * together: the board card's key accepts only card styles, and the header's only header styles.
 */
export type DisplayChoiceValues = Pick<UiConfig, "taskKindHeader" | "taskKindCard" | "backgroundAgentsStyle">;
export type DisplayChoiceKey = keyof DisplayChoiceValues;

export interface DisplayChoice<K extends DisplayChoiceKey = DisplayChoiceKey> {
  key: K;
  group: DisplayItemGroup;
  label: string;
  description: string;
  options: readonly DisplayChoiceOption<DisplayChoiceValues[K]>[];
}

/**
 * One entry per key, each typed to that key. Not `DisplayChoice<DisplayChoiceKey>`: that would
 * let an entry pair the card's key with a header style, and the picker would then submit a
 * preference the daemon refuses.
 */
export type AnyDisplayChoice = { [K in DisplayChoiceKey]: DisplayChoice<K> }[DisplayChoiceKey];

export const DISPLAY_CHOICES: readonly AnyDisplayChoice[] = [
  {
    key: "taskKindCard",
    group: "card",
    label: "Task type",
    description:
      "How a card marks what kind of task it came from - ship, bugfix, scout, plan, pipeline, chat or document. Every kind is marked, ship included.",
    options: TASK_KIND_CARD_STYLES.map((id) => ({ id, ...TASK_KIND_CARD_COPY[id] })),
  },
  {
    // In the Board card group, after Task type, although it governs the conversation too: the
    // operator decides it by the card, and the card is what this group's preview draws.
    key: "backgroundAgentsStyle",
    group: "card",
    label: "Background sub-agents",
    description: "How a session shows the sub-agents it launched in the background, on its card and in its conversation.",
    options: BACKGROUND_AGENTS_STYLES.map((id) => ({ id, ...BACKGROUND_AGENTS_COPY[id] })),
  },
  {
    key: "taskKindHeader",
    group: "conversation",
    label: "Task type",
    description:
      "How the console marks what kind of task a session is working on. Every kind is marked, ship included.",
    options: TASK_KIND_HEADER_STYLES.map((id) => ({ id, ...TASK_KIND_HEADER_COPY[id] })),
  },
];

/** The operator's current style for one choice, read live like `useDisplayItems`. */
export function useDisplayChoice<K extends DisplayChoiceKey>(key: K): ReturnType<typeof useUiConfig>[K] {
  return useUiConfig()[key];
}

export function setDisplayChoice<K extends DisplayChoiceKey>(key: K, value: DisplayChoiceValues[K]): void {
  // A computed key widens to an index signature, so the patch is re-narrowed to the one key
  // it holds; the signature above is what keeps the value paired with that key.
  void updateUiConfig({ [key]: value } as Pick<DisplayChoiceValues, K>);
}

/** Not a `DisplayChoice`: those are one-of-N, and these styles combine. */
export const RESIDENT_CARD_NAME_SETTING = {
  flag: RESIDENT_CARD_NAMES_FLAG_ID,
  label: "Resident name with call sign",
  description:
    "Also show a resident's profile name on its card while the card is titled by the call sign it answers to. The call sign stays the title. Turn on either style, or both.",
  options: RESIDENT_CARD_NAME_STYLES.map((id) => ({ id, ...RESIDENT_CARD_NAME_COPY[id] })),
} as const;

export function useResidentCardNameStyles(): ReadonlySet<ResidentCardNameStyle> {
  const offered = useFeatureFlag(RESIDENT_CARD_NAMES_FLAG_ID);
  const styles = useUiConfig().residentCardNameStyles;
  return new Set(offered ? styles : []);
}

export function setResidentCardNameStyle(
  current: readonly ResidentCardNameStyle[],
  style: ResidentCardNameStyle,
  on: boolean,
): void {
  const next = on ? [...current, style] : current.filter((candidate) => candidate !== style);
  void updateUiConfig({ residentCardNameStyles: residentCardNameStylesOf(next) });
}
