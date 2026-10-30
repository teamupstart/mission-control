import { useCallback } from "react";
import { TASK_KIND_CARD_STYLES, TASK_KIND_HEADER_STYLES } from "@shared/protocol.ts";
import type { TaskKindCardStyle, TaskKindHeaderStyle, UiConfig } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Every optional item a Display surface can draw, in one list.
 *
 * A board card draws two dozen distinct things. Each was added because it was the triage
 * signal somebody needed, and until now none of them could be turned off: an operator who
 * never uses Inspector read the Inspector flag anyway, and an operator running a single
 * model read the model pill on every card forever. This registry is the list the operator
 * gets to choose from, and every surface that draws an optional item reads the same list -
 * `SessionTile` for the card, `ConsoleDetail` for the band above the conversation. Nothing
 * else may hold a second copy. That is the rule `LAYOUTS` follows for layout modes and
 * `detailTabs.ts` follows for the tab strip, and `test/board-card-items.test.ts` is what enforces it here.
 *
 * WEB-ONLY, deliberately, and not `src/shared/`. The daemon stores the hidden ids opaquely
 * (`UiConfig.hiddenDisplayItems`) and has no use for prose it never shows - exactly the
 * split between `LAYOUT_MODES` (shared, validated) and `LAYOUTS` (web, prose).
 *
 * What is NOT here, and must not be added:
 *
 * - The attention flags in `.tile-marks` - note, review, queue, PR, Inspector, schedule
 *   origin, ensemble. That row means "things that want your attention", and an operator
 *   must not be able to configure themselves into missing "this session needs you". Each
 *   of those flags already draws nothing when it has nothing to say, which is most of what
 *   a toggle would have bought.
 * - The tone spine and card tone (that IS the state), the session name and its stretched
 *   open button, the agent dot, the `held` tag - which has to carry its own answer because
 *   the section rule above it scrolls away - and the transient drag drop-hint.
 */

/**
 * Which surface an item is drawn on, and therefore which section of the panel lists it.
 *
 * `"conversation"` names the console detail's `PATH`/`BRANCH` band, which is now optional
 * through two more entries in THIS array rather than through a second config key. The
 * panel renders one section per distinct group it finds, so those entries arrived with no
 * panel restructuring - and a group with no entries draws no section, so a third surface
 * would add a third group and be sectioned the same way.
 *
 * `"working"` is that third surface: the marks a conversation adds while its session is
 * working. It is the one group with a preview of its own, because unlike the band's two
 * cells its items change how something MOVES, and a sentence describes motion worse than a
 * picture of it.
 */
export type DisplayItemGroup = "card" | "conversation" | "working";

export interface DisplayItem {
  id: string;
  group: DisplayItemGroup;
  /** What the checklist prints. */
  label: string;
  /**
   * What unchecking this LOSES, not what the item is. That is the difference between a
   * description an operator can act on and one they cannot.
   */
  description: string;
}

export const DISPLAY_ITEMS = [
  {
    /**
     * The one entry here that governs a CAPABILITY and not just a fact.
     *
     * Unchecking it takes the keycap off every card AND every rail row AND stands the twelve
     * chords down, so an operator who does not want them keeps ⌘0/⌘-/⌘= for whatever else
     * they use those keys for. That coupling is deliberate and is why there is no second
     * switch: an invisible shortcut that still fires is the one shape this control must not
     * have. The chords themselves live in `lib/card-shortcuts.ts`.
     *
     * The one entry in the `card` group that also governs a surface outside the card - the
     * Console rail prints the same key beside its state word, off the same assignment. It
     * stays one item rather than two because it is one capability and one number row: a rail
     * switch that could be on while the board's was off would have to renumber nothing and
     * yet answer the same twelve keys, and its description is where an operator reads which
     * surfaces it covers.
     */
    id: "cardShortcut",
    group: "card",
    label: "Jump shortcut",
    description:
      "The ⌘1 … ⌘0, ⌘-, ⌘= keycap on the card and beside the Console rail's state word, and the chord itself: press it to open that session's console. The keys are handed out down the fleet and across the board's columns - the rail is those columns read end to end, so a session keeps its key when you switch layout - and they move up as sessions finish. While this is on the number row belongs to the fleet: in the desktop app page zoom keeps its View menu items but gives up ⌘0/⌘-/⌘=, and in a browser tab any key your browser keeps for selecting a tab or zooming stays the browser's. Unchecked, the keycaps go, the chords stand down, and those keys zoom again.",
  },
  {
    id: "goal",
    group: "card",
    label: "Goal",
    description:
      "The one-line answer to what this session is for. Without it a card is identified by its name alone, which for a dispatched session is its task title.",
  },
  {
    id: "activity",
    group: "card",
    label: "Live activity",
    description:
      "What the agent is doing this second - the board's only live signal past \"6s ago\", and what tells an actively-editing session apart from one stalled on a prompt.",
  },
  {
    id: "workflow",
    group: "card",
    label: "Workflow",
    description:
      "The cropped stage ladder for the review that owns this session. Hidden, a run in progress is only visible from Runs or the console.",
  },
  {
    id: "workflowProgressBar",
    group: "card",
    label: "Workflow progress bar",
    description:
      "The run's whole stage track and repair-round budget. Unchecked, the card returns to the single consequential stage with its member detail.",
  },
  {
    id: "workflowDetails",
    group: "card",
    label: "Workflow details",
    description:
      "Why the run is where it is, and the control that opens its whole actionable ladder inside the card. It ships OFF, so by default a card states the stage track, the stage it is on and the repair-round count and nothing else. Checked, it adds the expand/collapse control - and the Board's expand chord - and the sentence naming what objected or what the run is waiting on.",
  },
  {
    id: "pipelinePhases",
    group: "card",
    label: "Pipeline phases",
    description:
      "The five-segment phase meter for the ai-conductor run driving this session: how far it has got, which phase it is in, what failed, and what its tier or track skipped. Hidden, a driven card names its run and says nothing about the run's progress, so a halted feature looks like a working one until you open Runs. Draws nothing at all on a session no engine is driving, which is every session on a fleet with no pipeline provider enabled.",
  },
  {
    id: "model",
    group: "card",
    label: "Model",
    description:
      "Which model the session is running, and whether it is on a long-context window. Worth retiring if your whole fleet runs one model.",
  },
  {
    id: "context",
    group: "card",
    label: "Context meter",
    description:
      "How much of the context window is used, with its percentage. This is the signal that a session is about to compact.",
  },
  {
    id: "effort",
    group: "card",
    label: "Reasoning effort",
    description:
      "The thinking level, as a control you can change from the board. Hidden, effort is still changeable from the console detail.",
  },
  {
    id: "mode",
    group: "card",
    label: "Permission mode",
    description:
      "What this session is allowed to do right now, as a control you can change from the board. Hidden, the mode is still shown and changeable in the console detail.",
  },
  {
    id: "cost",
    group: "card",
    label: "Cost",
    description:
      "This session's API-equivalent spend so far. The chip's own tone is what escalates when the estimate stops being routine.",
  },
  {
    id: "branch",
    group: "card",
    label: "Branch",
    description:
      "The git branch the session is on. A session with no branch shows where its name came from instead, and keeps doing so when this is hidden.",
  },
  {
    id: "worktree",
    group: "card",
    label: "Worktree",
    description:
      "Which checkout the session is in, as the directory's name with the full path on hover. The one item here no card drew before, so it ships OFF - turn it on and the console detail stops being the only place this fact lives.",
  },
  {
    id: "lastSeen",
    group: "card",
    label: "Last seen",
    description:
      "How long ago the session last did anything, or how long it has been up. Hidden, a stalled card looks the same as a busy one.",
  },
  {
    /**
     * A resident's border glow and label chip, in its profile's color. Like `cardShortcut` it
     * governs a surface outside the card too: the Console rail row draws the same accent edge
     * and chip off this one switch. It hides ink only - a pinned resident still sorts first in
     * its column, and the Console band and the Residents dock still name it.
     */
    id: "residentMarker",
    group: "card",
    label: "Resident marker",
    description:
      "A glowing outline and label chip, in its profile's color, on every resident's card and Console rail row - the quickest way to find a long-running agent on a busy board. Hidden, a resident looks like any other session, though a pinned one still sorts to the top of its column and the Residents dock still lists it.",
  },
  /**
   * The console detail's `PATH`/`BRANCH` band.
   *
   * Deliberately NOT the same switches as the card's `branch` and `worktree` above. An
   * operator may want the path on the card and not over the conversation, in both places,
   * or in neither, and one checkbox meaning two surfaces could not express "neither".
   *
   * Both descriptions state the condition rather than promising height back: the same band
   * hosts a task's chip and its pull requests, so it collapses only when nothing else is in
   * it. That is the ordinary dispatched session and not a scout, a re-assigned, a
   * scheduled, an outcome-carrying or a multi-repo one.
   */
  {
    id: "detailPath",
    group: "conversation",
    label: "Working directory",
    description:
      "The session's directory above the conversation, shortened, with the full path on hover. Hidden, the console no longer states where the session is running - turn the card's Worktree item on if you still want it somewhere.",
  },
  {
    id: "detailBranch",
    group: "conversation",
    label: "Git branch",
    // "Git branch" rather than "Branch": a checkbox's accessible name is the whole answer a
    // screen reader gives, and the card already has a "Branch". Two controls in one panel
    // announcing the same name are two controls nobody can tell apart - and `getByRole`
    // would not be able to either.
    description:
      "The git branch above the conversation. Independent of the card's Branch item, so you can keep the branch on the card and drop it here.",
  },
  /**
   * The conversation's working indicator, beyond its base row.
   *
   * The base is not here and cannot be switched off: while a session is working, the log's
   * last row says what it reports doing and how long the current turn has run. These two
   * add to that, and both ship ON - `DISPLAY_ITEM_SEEDS` also switches them back on for a
   * profile given them off when they were introduced - so a working conversation holds its
   * row in view and marks its reply box until the operator unchecks either.
   *
   * Both mount on the same gate as the row itself, `liveActivity(session)`, so neither can
   * claim the session is working while the row has gone.
   */
  {
    id: "workingPinned",
    group: "working",
    label: "Pin the working row",
    description:
      "Keeps the row saying what the session is doing, with its spinner and clock, on the bottom edge of the conversation while you scroll back through it. Unchecked, the row is the last line of the log and scrolls away with it.",
  },
  {
    id: "workingProgressBar",
    group: "working",
    label: "Reply box progress bar",
    description:
      "A thin moving bar along the top of the reply box while the session is working, visible without reading anything. Unchecked, the reply box looks the same whether the session is working or not.",
  },
] as const satisfies readonly DisplayItem[];

export type DisplayItemId = (typeof DISPLAY_ITEMS)[number]["id"];

/** The groups the panel sections by, in registry order, each drawn only if it has entries. */
export const DISPLAY_ITEM_GROUPS: readonly DisplayItemGroup[] = [...new Set(
  DISPLAY_ITEMS.map((item) => item.group),
)];

/**
 * The prose above each section. One entry per group, so a group that gains its first entry
 * gains its heading with it.
 */
export const DISPLAY_GROUP_COPY: Record<
  DisplayItemGroup,
  { heading: string; blurb: string }
> = {
  card: {
    heading: "Board card",
    blurb:
      "What a session card draws in every Board column. Unchecking an item applies to every card immediately; nothing here changes what the session is doing, only what the card says about it.",
  },
  conversation: {
    heading: "Conversation header",
    blurb:
      "What the console detail states above the conversation. Hiding a cell does not always give its height back: the band it sits in is also home to a task's chip and its pull requests, and it only collapses when nothing else is in it.",
  },
  working: {
    heading: "Working indicator",
    blurb:
      "How a conversation shows that its session is working. The last row of the log always says what the session reports doing and how long the current turn has run; these add to it, and neither takes any height while the session is idle.",
  },
};

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
 * values, `off` among them. Folding these into the item list would make "hidden" a sixth
 * style of a five-way choice and leave two places that can each turn the mark off.
 *
 * Each option's copy is a `Record` over the persisted style list, so a style added to
 * `TASK_KIND_*_STYLES` does not compile until it says how it is offered.
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
 * Each choice's `UiConfig` key with the values that key stores, so a key and its styles travel
 * together: the board card's key accepts only card styles, and the header's only header styles.
 */
export type DisplayChoiceValues = Pick<UiConfig, "taskKindHeader" | "taskKindCard">;
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
