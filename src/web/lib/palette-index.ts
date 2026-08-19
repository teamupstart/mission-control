// The everything-palette's index: one provider registry over the client's SSE stores.
//
// This is `settings-search.ts` generalized rather than replaced. That file is still the ONE
// control-level settings index and still owns the matching rule (deterministic substring, no
// fuzzy ranking); this file wraps it in a provider alongside providers for the Library's
// assets and the Line's live objects, so `⌘K` reaches all of them through one input.
//
// Three rules hold the shape together, and each one is load-bearing:
//
//  1. **Providers read stores; they never fetch.** Every row below is a pure function of
//     collections `useEventStream` already holds. A provider that issued a request would be a
//     second, slower answer to a question the SSE stream has already answered, and would make
//     typing a letter into a search box a network event.
//  2. **Live facts are READ, never recomputed.** An ensemble's `attention`, a mission's
//     `health` and a run's triage sentence are all derived by code that already owns them
//     (the daemon, `run-model.ts`); the palette quotes them. A row that folded its own
//     verdict would drift from the surface it navigates to.
//  3. **A row's target is a route earlier phases published, or an affordance that already
//     exists in one step.** The palette invents no destinations and no actions.
//
// Pure data and pure functions - no React - for the same reason `settings-search.ts` is: the
// providers, the component and the tests all read the SAME rows.

import { ensembleStageWord, type EnsembleStrategyId, type EnsembleSummary } from "@shared/ensemble.ts";
import { creatableStrategies } from "@shared/ensemble-strategies.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  sessionActionCompletionLabel,
  workflowRunIsOpen,
  workflowRunWaitsOnOperator,
  type PersonaView,
  type SessionAction,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "@shared/workflow.ts";
import { personaRoutingLabel } from "../library/library-model.ts";
import { runTriageRound, runTriageSentence } from "../workflows/run-model.ts";
import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";
import { SETTINGS_CATEGORIES, settingsCategory } from "./settings-registry.ts";
import { SETTINGS_CONTROLS, type SettingsBindings } from "./settings-search.ts";

/**
 * The three groups the palette renders, in order.
 *
 * They are verbs about the row, not categories of thing: **Jump to** goes somewhere that
 * already exists, **Do** starts something, **Settings** changes how the app behaves. That is
 * why a group is derived from a row's kind rather than chosen per row - a strategy launcher
 * is always a "Do" and a workflow is always a "Jump to", and a provider cannot file a row
 * under a verb its kind does not perform.
 */
export const PALETTE_GROUPS = ["jump", "do", "settings"] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  jump: "Jump to",
  do: "Do",
  settings: "Settings",
};

/**
 * Every kind of row, which is also every value the `tab` filter can cycle through and every
 * chip the operator reads. Append-only: the strings are the chip labels and the filter's
 * public vocabulary.
 */
export const PALETTE_KINDS = [
  "page",
  "workflow",
  "run",
  "ensemble",
  "persona",
  "action",
  "mission",
  "strategy",
  "command",
  "setting",
  "panel",
] as const;
export type PaletteKind = (typeof PALETTE_KINDS)[number];

export interface PaletteKindInfo {
  id: PaletteKind;
  /** The chip's text, and what `tab` announces when it filters to this kind. */
  label: string;
  /** The glyph, matching the Library shelf or the Line surface this kind lives on. */
  glyph: string;
  group: PaletteGroup;
}

/**
 * Glyphs are deliberately the SAME ones the destination wears - `⌁` for workflows and their
 * runs, `❝` for Personas, `▤` for actions, `⧉` for ensembles and their launchers, `◷` for
 * missions (see `library-model.ts`). A palette row is a picture of where you are going.
 */
export const PALETTE_KIND_INFO: Record<PaletteKind, PaletteKindInfo> = {
  // A whole page rather than one object on one, which is why it wears the segmented top
  // bar's own first glyph rather than any one destination's. Each row overrides it with the
  // mark its page wears elsewhere, exactly as a settings panel row wears its rail icon.
  page: { id: "page", label: "page", glyph: "▦", group: "jump" },
  workflow: { id: "workflow", label: "workflow", glyph: "⌁", group: "jump" },
  run: { id: "run", label: "run", glyph: "⌁", group: "jump" },
  ensemble: { id: "ensemble", label: "ensemble", glyph: "⧉", group: "jump" },
  persona: { id: "persona", label: "persona", glyph: "❝", group: "jump" },
  action: { id: "action", label: "action", glyph: "▤", group: "jump" },
  mission: { id: "mission", label: "mission", glyph: "◷", group: "jump" },
  strategy: { id: "strategy", label: "strategy", glyph: "⧉", group: "do" },
  command: { id: "command", label: "command", glyph: "▸", group: "do" },
  setting: { id: "setting", label: "setting", glyph: "⚙", group: "settings" },
  panel: { id: "panel", label: "panel", glyph: "⚙", group: "settings" },
};

export function paletteKindGroup(kind: PaletteKind): PaletteGroup {
  return PALETTE_KIND_INFO[kind].group;
}

/**
 * What `enter` does on a row.
 *
 * `route` is the whole of the navigation vocabulary: a `MissionRoute` from the table phases
 * 2 and 4 published, and nothing else - the palette cannot address a page that does not
 * exist. `anchor` rides beside it rather than inside it because the settings hash grammar is
 * category-only by design (see `SettingsPage`'s `flashRef`); it is a transient pointer at a
 * control, delivered to the page, not a location.
 *
 * The other four are the affordances that already exist in one step elsewhere - the Dispatch
 * modal (twice: plain, and preselected on a strategy), the workflow binding dialog, and the
 * Recurring Missions panel. The palette opens the same overlay the same way; it is a second
 * doorway, never a second implementation.
 */
export type PaletteTarget =
  | { kind: "route"; route: MissionRoute; anchor?: string }
  | { kind: "toggle"; controlId: string }
  | { kind: "dispatch" }
  | { kind: "launch-ensemble"; strategyId: EnsembleStrategyId }
  | { kind: "bind-workflow" }
  | { kind: "start-see-work-tour" }
  | { kind: "open-mission"; scheduleId: string };

export interface PaletteRow {
  /** Unique across every provider. Prefixed by kind, so two stores cannot collide on an id. */
  id: string;
  kind: PaletteKind;
  title: string;
  /**
   * The second line: live state for an executing object, the durable fact for an authored
   * one, the current value for a setting. Never empty - a row that could not say anything
   * about itself would be a name with no reason to pick it.
   */
  detail: string;
  /** True when `detail` reports something the operator has to answer. Amber, and sorted up. */
  attention?: boolean;
  /** Extra words the matcher searches beyond title and detail. */
  keywords: readonly string[];
  /**
   * A glyph for this row alone, where the kind's own would be less use than the
   * destination's - a settings panel wears the icon its rail row wears. Absent means the
   * kind's, which is the case for everything with one shelf or one page behind it.
   */
  glyph?: string;
  target: PaletteTarget;
  /**
   * A settings toggle the palette may flip in place, and its current value. Absent means the
   * row jumps to its panel instead - see `settingsProvider` for when, and why.
   */
  switchOn?: boolean;
}

/**
 * Everything the registry reads. One object rather than nine parameters so adding a kind is
 * a field here and a provider below, with no call-site churn.
 *
 * `settingsBindings` is the runtime get/set map `buildSettingsBindings` produces. It arrives
 * as data for the same reason the stores do: the index stays a pure function of what the app
 * currently knows.
 */
export interface PaletteStores {
  workflows: readonly WorkflowSummary[];
  runs: readonly WorkflowRunSummary[];
  ensembles: readonly EnsembleSummary[];
  personas: readonly PersonaView[];
  sessionActions: readonly SessionAction[];
  schedules: readonly MissionSchedule[];
  /**
   * Session id -> the name on its card, for the runs that are bound to one.
   *
   * A projection rather than the sessions themselves, and that narrowness is the point: this
   * is NOT sessions being indexed (they are a later kind, and would need their own provider,
   * their own state line and their own destination). It is the one fact a run row cannot say
   * without help - `WorkflowRunSummary` carries a session id and no name - and a run named
   * only by its workflow is indistinguishable from the other three runs of that workflow.
   */
  sessionNames: ReadonlyMap<string, string>;
  settingsBindings: SettingsBindings;
}

export interface PaletteProvider {
  id: string;
  rows: (stores: PaletteStores) => PaletteRow[];
}

const byName = (a: string, b: string): number => a.localeCompare(b, "en-US");

/**
 * Pages that are destinations in their own right.
 *
 * One member, and that is a statement about the app rather than an unfinished list: Fleet,
 * the Library and Runs are one press of the segmented top bar away, Ensembles and the
 * settings categories are each linked from a surface an operator is already looking at, and
 * a palette row for any of them would be a second doorway beside a visible first one. The
 * Ship log has NO chrome pointing at it - the Line's Shipped stage still opens the completed
 * run list - so `⌘K` and the hash are the whole of how it is reached, and a page nothing can
 * reach is a page that does not exist.
 *
 * Static rather than derived from `stores`, because a page is a fact about this build.
 */
const pageProvider: PaletteProvider = {
  id: "pages",
  rows: () => [
    {
      id: "page:shipped",
      kind: "page",
      title: "Ship log",
      detail: "Every pull request the fleet opened, across every repository.",
      // The words an operator would reach for, none of which is in the title: they would
      // hunt for what the page is ABOUT (pull requests, merges, repos) far sooner than for
      // what it is called, and "shipped" is the Line stage this page belongs to.
      keywords: ["shipped", "ship", "pull request", "prs", "merged", "repos", "ledger"],
      glyph: "⚑",
      target: { kind: "route", route: { page: "shipped" } },
    },
    {
      id: "page:scouts",
      kind: "page",
      title: "Scouts",
      detail: "Every investigation the fleet finished, and the evidence it kept.",
      // Same rule as the Ship log's row: the words someone would reach for describe what
      // the page is ABOUT, and almost none of them is in its title. "Scout" is the task
      // kind that fills it, so it is here too, but nobody hunting an old answer types it.
      keywords: [
        "scout",
        "investigation",
        "findings",
        "report",
        "research",
        "evidence",
        "history",
        "archive",
        "audit",
      ],
      glyph: "⌖",
      // ONE static page row, and deliberately no archive provider beside it. Providers
      // derive from client stores and never fetch, and the archive catalog is unbounded
      // history that is deliberately kept out of the SSE snapshot - indexing it here would
      // either mean a fetch from the palette or loading every scout ever run into memory to
      // answer a keystroke. Archive search stays inside the page that owns the catalog.
      target: { kind: "route", route: { page: "scouts" } },
    },
  ],
};

/**
 * Library workflows.
 *
 * Archived rows are excluded, exactly as the Library shelf excludes them: an archived asset
 * has no card to land on, so a hit would navigate to a surface that does not list it. The
 * detail line is the AUTHORING fact the shelf card carries (version, reviewer count, draft
 * errors) rather than anything a run is doing - live workflow state belongs to the `run`
 * kind below, which is a different row with a different destination.
 */
const workflowProvider: PaletteProvider = {
  id: "workflows",
  rows: ({ workflows }) =>
    workflows
      .filter((workflow) => workflow.archivedAt === null)
      .slice()
      .sort((a, b) => byName(a.name, b.name))
      .map((workflow) => {
        const reviewers = `${workflow.personaCount} reviewer${workflow.personaCount === 1 ? "" : "s"}`;
        const version = workflow.publishedVersion === null
          ? "Never published"
          : `v${workflow.publishedVersion}`;
        const errors = workflow.errorCount > 0
          ? `${workflow.errorCount} validation error${workflow.errorCount === 1 ? "" : "s"}`
          : null;
        return {
          id: `workflow:${workflow.id}`,
          kind: "workflow" as const,
          title: workflow.name,
          detail: errors ?? `${version} · ${reviewers}`,
          ...(errors ? { attention: true } : {}),
          keywords: ["builder", "definition of done", "review", workflow.description],
          target: {
            kind: "route" as const,
            route: { page: "library", shelf: "workflows", assetId: workflow.id },
          },
        };
      }),
};

/**
 * Live workflow runs.
 *
 * Open runs first, then the finished ones newest-first: the palette's job for this kind is
 * "land on the live run", and a completed run from last week must never sit above the one
 * waiting on you right now. The detail line is `runTriageSentence` - the same sentence the
 * Line's Review drawer and the Runs rail read, quoted rather than re-derived.
 *
 * Not capped. The Runs page already renders every summary in this store, so a cap here would
 * make the palette able to find fewer runs than the page it navigates to.
 *
 * The WORKFLOW names the row and the session qualifies it, rather than the other way round:
 * the workflow name is the durable thing an operator half-remembers, and a session's name is
 * written by the titler minutes after it starts. Both are in the detail line either way, so
 * either one finds the run.
 */
const runProvider: PaletteProvider = {
  id: "runs",
  rows: ({ runs, sessionNames }) =>
    runs
      .slice()
      .sort((a, b) => {
        const openness = Number(workflowRunIsOpen(b.status)) - Number(workflowRunIsOpen(a.status));
        return openness !== 0 ? openness : b.updatedAt - a.updatedAt;
      })
      .map((run) => {
        const session = run.sessionId ? sessionNames.get(run.sessionId) : undefined;
        return {
          id: `run:${run.id}`,
          kind: "run" as const,
          title: run.workflowName,
          detail: [
            ...(session ? [session] : []),
            runTriageSentence(run),
            runTriageRound(run),
          ].join(" · "),
          keywords: [
            "run",
            run.status,
            run.phase,
            `v${run.workflowVersion}`,
            ...(run.externalSource ? ["ensemble handoff"] : []),
          ],
          // The empty-query preview hoists `attention` rows, and this is the predicate that
          // decides which runs are yours - the same one the Line strip's Review fold and the
          // Review drawer read, so the palette cannot offer a different answer to "what do I
          // owe" than the strip above it. `workflowRunWaitsOnOperator`'s own docstring has
          // always claimed this list reads it; until now it did not.
          ...(workflowRunWaitsOnOperator(run) ? { attention: true } : {}),
          target: { kind: "route" as const, route: { page: "runs", runId: run.id } },
        };
      }),
};

/**
 * Live ensembles.
 *
 * `attention` is the daemon's own derivation (failed, cancelling, unreadable, awaiting a
 * decision, or a blocked member) and is read straight through - the browser does not decide
 * what needs the operator. `ensembleStageWord` is the shared operator-voice verb the
 * attention inbox and the session card already use, so a decision waiting here reads the
 * same as it does everywhere else.
 */
const ensembleProvider: PaletteProvider = {
  id: "ensembles",
  rows: ({ ensembles }) =>
    ensembles
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((ensemble) => ({
        id: `ensemble:${ensemble.id}`,
        kind: "ensemble" as const,
        title: ensemble.title,
        detail: `${ensemble.strategyLabel} · ${ensembleStageWord(ensemble)} · `
          + `${ensemble.membersReady}/${ensemble.maxMembers} in`,
        ...(ensemble.attention ? { attention: true } : {}),
        keywords: ["ensemble", "decision", ensemble.strategyLabel, ensemble.strategyKey],
        target: { kind: "route" as const, route: { page: "ensembles", ensembleId: ensemble.id } },
      })),
};

/** Library Personas, filtered and described exactly as the Personas shelf describes them. */
const personaProvider: PaletteProvider = {
  id: "personas",
  rows: ({ personas }) =>
    personas
      .filter((persona) => persona.archivedAt === null)
      .slice()
      .sort((a, b) => byName(a.normalizedName, b.normalizedName))
      .map((persona) => ({
        id: `persona:${persona.id}`,
        kind: "persona" as const,
        title: persona.name,
        detail: personaRoutingLabel(persona),
        keywords: [
          "reviewer",
          "judge",
          "guidance",
          ...(persona.builtin ? ["built-in"] : []),
          persona.description,
        ],
        target: {
          kind: "route" as const,
          route: { page: "library", shelf: "personas", assetId: persona.id },
        },
      })),
};

/** Library session actions. The store keeps archived rows, so this filter is load-bearing. */
const actionProvider: PaletteProvider = {
  id: "actions",
  rows: ({ sessionActions }) =>
    sessionActions
      .filter((action) => action.archivedAt === null)
      .slice()
      .sort((a, b) => byName(a.normalizedName, b.normalizedName))
      .map((action) => ({
        id: `action:${action.id}`,
        kind: "action" as const,
        title: action.name,
        detail: sessionActionCompletionLabel(action.completion),
        keywords: [
          "session action",
          "instruction",
          ...(action.builtin ? ["built-in"] : []),
          action.description,
        ],
        target: {
          kind: "route" as const,
          route: { page: "library", shelf: "actions", assetId: action.id },
        },
      })),
};

/**
 * Recurring missions.
 *
 * `health` is the daemon's derivation, read the same way the Library shelf reads it. The
 * target is the Recurring Missions panel deep-linked to this schedule - an overlay rather
 * than a route, because that is the only surface a mission has ever had.
 *
 * Task SOURCES have no provider, deliberately: they are not in any client store (the panel
 * polls `/api/task-sources` and owns that poll), and inventing a fetch for them here would
 * break the no-server-calls rule this file opens with. They stay findable through the
 * Settings group's own `task-sources` row, which is where the Library's Sources card points
 * too - one destination, named once.
 */
const missionProvider: PaletteProvider = {
  id: "missions",
  rows: ({ schedules }) =>
    schedules
      .filter((schedule) => schedule.archivedAt === null)
      .slice()
      .sort((a, b) => byName(a.name, b.name))
      .map((schedule) => ({
        id: `mission:${schedule.id}`,
        kind: "mission" as const,
        title: schedule.name,
        detail: schedule.health === "attention"
          ? `${schedule.expression} · needs attention`
          : `${schedule.expression} · ${schedule.enabled ? schedule.timezone : "paused"}`,
        ...(schedule.health === "attention" ? { attention: true } : {}),
        keywords: ["mission", "schedule", "cadence", "recurring", schedule.template?.title ?? ""],
        target: { kind: "open-mission" as const, scheduleId: schedule.id },
      })),
};

/**
 * The ensemble strategy launchers - the Library's Ensembles shelf, as verbs.
 *
 * Through `creatableStrategies()` for the shelf's own reason: a strategy this build has
 * turned off must not be launchable from here while Dispatch refuses to offer it.
 */
const strategyProvider: PaletteProvider = {
  id: "strategies",
  rows: () =>
    creatableStrategies().map((info) => ({
      id: `strategy:${info.id}`,
      kind: "strategy" as const,
      title: `Launch a ${info.label} ensemble…`,
      detail: info.blurb,
      keywords: ["ensemble", "launch", "dispatch", "race", info.id],
      target: { kind: "launch-ensemble" as const, strategyId: info.id },
    })),
};

/**
 * The fixed commands.
 *
 * The production commands already exist as a single click somewhere: the topbar's Dispatch
 * button, the Library's ＋ New cards, and the binding dialog. The one explicit exception is
 * the temporary Driver.js comparison spike, whose brief requires a palette-only entry and no
 * permanent top-bar chrome. Removing that spike removes one row and one target arm.
 */
const commandProvider: PaletteProvider = {
  id: "commands",
  rows: () => [
    {
      id: "command:see-work-tour",
      kind: "command",
      title: "Start See the work tour",
      detail: "Preview how the Fleet, Board, and one session desk fit together.",
      keywords: ["tour", "product tour", "onboarding", "fleet", "board", "session detail"],
      target: { kind: "start-see-work-tour" },
    },
    {
      id: "command:dispatch",
      kind: "command",
      title: "Dispatch an agent…",
      detail: "Launch or queue a new session.",
      keywords: ["new", "start", "launch", "agent", "session", "task"],
      target: { kind: "dispatch" },
    },
    {
      id: "command:bind-workflow",
      kind: "command",
      title: "Bind a workflow to a session…",
      detail: "Pick a session and a published version, and run it.",
      keywords: ["workflow", "bind", "review", "session", "run"],
      target: { kind: "bind-workflow" },
    },
    {
      id: "command:new-workflow",
      kind: "command",
      title: "New workflow…",
      detail: "Open the builder on a blank draft.",
      keywords: ["create", "author", "builder", "workflow"],
      target: { kind: "route", route: { page: "library", shelf: "workflows", creating: true } },
    },
    {
      id: "command:new-persona",
      kind: "command",
      title: "New Persona…",
      detail: "Open the Persona editor on a blank draft.",
      keywords: ["create", "author", "reviewer", "persona"],
      target: { kind: "route", route: { page: "library", shelf: "personas", creating: true } },
    },
    {
      id: "command:new-action",
      kind: "command",
      title: "New action…",
      detail: "Open the action editor on a blank draft.",
      keywords: ["create", "author", "session action"],
      target: { kind: "route", route: { page: "library", shelf: "actions", creating: true } },
    },
  ],
};

/**
 * Settings, wrapping `SETTINGS_CONTROLS` - the one control-level index, unchanged.
 *
 * A control renders as an inline switch only when a binding for it is in hand, and jumps to
 * its panel otherwise. That is `settings-search.ts`'s own rule ("a null source gets NO
 * binding, so the control degrades to a jump"), and it is what a palette that opens on any
 * page has to obey: the daemon-backed configs behind Auto mode and Skills are polled by the
 * Settings page alone, so away from it there is no loaded value to flip and a switch would
 * be a lie about state that has not been read. The risky set (D5) is never bindable at all,
 * so it always lands on its consent copy.
 */
/**
 * The settings panels themselves, so "just show me Trust" is a row rather than a hunt for one
 * of its controls.
 *
 * These are the category hits `searchSettings` used to offer as its own second group, kept as
 * ordinary rows here because the palette has one matcher: the category's registry `keywords`
 * are the row's keywords, so "hotkey" still reaches the Keyboard panel. They sort after the
 * controls for the reason they always did - a query that names a control should land on the
 * control, not on the panel around it.
 */
const settingsPanelProvider: PaletteProvider = {
  id: "settings-panels",
  rows: () =>
    SETTINGS_CATEGORIES.map((category) => ({
      id: `panel:${category.id}`,
      kind: "panel" as const,
      title: `${category.label} settings`,
      detail: category.blurb,
      keywords: category.keywords,
      glyph: category.icon,
      target: { kind: "route" as const, route: { page: "settings", category: category.id } },
    })),
};

const settingsProvider: PaletteProvider = {
  id: "settings",
  rows: ({ settingsBindings }) =>
    SETTINGS_CONTROLS.map((control) => {
      const binding = control.kind === "toggle" && !control.risky
        ? settingsBindings.get(control.id)
        : undefined;
      const category = settingsCategory(control.category);
      return {
        id: `setting:${control.id}`,
        kind: "setting" as const,
        title: control.label,
        detail: `${category.label} · ${control.description}`,
        keywords: control.keywords,
        ...(binding
          ? { target: { kind: "toggle" as const, controlId: control.id }, switchOn: binding.get() }
          : {
              target: {
                kind: "route" as const,
                route: { page: "settings" as const, category: control.category },
                anchor: control.anchor,
              },
            }),
      };
    }),
};

/**
 * The registry, in result order.
 *
 * Order inside a group is this order, after the attention rows have been hoisted (see
 * `groupRows`). Workflows lead the jumps because a half-remembered name is most often an
 * asset's; live runs and ensembles follow because they are the second thing anyone hunts.
 *
 * This is the extension point named in the phase's handoff: a future kind (sessions, tasks)
 * adds a provider HERE. It must never fork a second index.
 */
export const PALETTE_PROVIDERS: readonly PaletteProvider[] = [
  pageProvider,
  workflowProvider,
  runProvider,
  ensembleProvider,
  personaProvider,
  actionProvider,
  missionProvider,
  strategyProvider,
  commandProvider,
  settingsProvider,
  settingsPanelProvider,
];

/** Every row every provider offers, in registry order. */
export function paletteRows(stores: PaletteStores): PaletteRow[] {
  return PALETTE_PROVIDERS.flatMap((provider) => provider.rows(stores));
}

/** Where a route row lands, in the words the topbar and the rail use for it. */
function routeDestination(route: MissionRoute): string {
  switch (route.page) {
    case "library":
      return "the Library";
    case "runs":
      return "Workflow runs";
    case "ensembles":
      return "Ensembles";
    case "shipped":
      return "the Ship log";
    case "scouts":
      return "Scouts";
    case "settings":
      return `${settingsCategory(route.category).label} settings`;
    case "fleet":
      return "the Fleet";
  }
}

/**
 * What `enter` will do, in a sentence - the row's hover and focus description.
 *
 * Kept here rather than in the component because it is a fact about the TARGET, and because
 * a description that lives beside the destinations it names cannot drift from them when a
 * new target kind arrives: this switch fails to compile until the new kind says what it does.
 */
export function paletteRowHint(row: PaletteRow): string {
  switch (row.target.kind) {
    case "route":
      return `Open in ${routeDestination(row.target.route)} - ${row.detail}`;
    case "toggle":
      return `${row.switchOn ? "Switch off" : "Switch on"} here - ${row.detail}`;
    case "dispatch":
      return "Open the form to launch or queue a new agent.";
    case "launch-ensemble":
      return "Open Dispatch already in Ensemble mode on this strategy.";
    case "bind-workflow":
      return "Open the binding dialog to pick a session and a published workflow version.";
    case "start-see-work-tour":
      return "Start the temporary guided See the work comparison tour.";
    case "open-mission":
      return "Open Recurring Missions on this schedule's run history.";
  }
}

/**
 * How many attention rows the empty query previews before the "Do" rows.
 *
 * Capped so a fleet with a dozen amber ensembles does not push every verb off the first
 * screen: the empty palette answers "what needs me, and what can I start", and it has to be
 * able to answer the second half.
 */
export const PALETTE_ATTENTION_PREVIEW = 4;

export interface PaletteGroupResult {
  group: PaletteGroup;
  label: string;
  rows: PaletteRow[];
}

export interface PaletteResult {
  /** The groups that have rows, in `PALETTE_GROUPS` order. */
  groups: PaletteGroupResult[];
  /** The same rows flattened in render order - the list roving selection indexes into. */
  rows: PaletteRow[];
  /**
   * Every kind present in the results for this query BEFORE the kind filter narrowed them,
   * in `PALETTE_KINDS` order. This is what `tab` cycles: filtering to a kind must not shrink
   * the set of kinds you can filter to next, or one press would strand you.
   */
  kinds: PaletteKind[];
}

function haystack(row: PaletteRow): string {
  return `${row.title} ${row.detail} ${PALETTE_KIND_INFO[row.kind].label} ${row.keywords.join(" ")}`
    .toLowerCase();
}

/**
 * Group in `PALETTE_GROUPS` order, hoisting the rows that need the operator to the top of
 * their own group.
 *
 * Attention sorts first WITHIN a group rather than across the whole list, because the groups
 * are verbs: an amber ensemble is still a "Jump to" and must not appear under "Do". `sort`
 * is stable in every engine this runs on, so registry order survives underneath.
 */
function groupRows(rows: readonly PaletteRow[]): PaletteGroupResult[] {
  return PALETTE_GROUPS.map((group) => ({
    group,
    label: PALETTE_GROUP_LABELS[group],
    rows: rows
      .filter((row) => paletteKindGroup(row.kind) === group)
      .sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention))),
  })).filter((entry) => entry.rows.length > 0);
}

function result(rows: readonly PaletteRow[], kind: PaletteKind | null): PaletteResult {
  const kinds = PALETTE_KINDS.filter((k) => rows.some((row) => row.kind === k));
  const groups = groupRows(kind ? rows.filter((row) => row.kind === kind) : rows);
  return { groups, rows: groups.flatMap((entry) => entry.rows), kinds };
}

/**
 * The palette's search: deterministic substring matching over title, detail, kind label and
 * keywords, optionally narrowed to one kind.
 *
 * No fuzzy ranking, which is the rule inherited from the settings-only search this replaced:
 * the same query returns the same rows in the same order, and that order is a registry order
 * rather than a relevance guess an operator cannot predict.
 *
 * An empty query previews what the fleet would want said unprompted - the rows that need an
 * answer, then everything you can start - rather than an arbitrary alphabetical slice.
 */
export function searchPalette(
  query: string,
  stores: PaletteStores,
  kind: PaletteKind | null = null,
): PaletteResult {
  const all = paletteRows(stores);
  const q = query.trim().toLowerCase();
  if (!q) {
    const attention = all.filter((row) => row.attention).slice(0, PALETTE_ATTENTION_PREVIEW);
    const commands = all.filter((row) => paletteKindGroup(row.kind) === "do");
    return result([...attention, ...commands], kind);
  }
  return result(all.filter((row) => haystack(row).includes(q)), kind);
}

/**
 * The next kind in the `tab` cycle: null (everything) -> each kind present -> null again.
 *
 * Cycling back through "everything" is what makes the filter escapable with the same key
 * that set it, so `tab` never becomes a mode you have to know a second key to leave.
 */
export function nextPaletteKind(
  kinds: readonly PaletteKind[],
  current: PaletteKind | null,
): PaletteKind | null {
  if (kinds.length === 0) return null;
  if (current === null) return kinds[0] ?? null;
  const index = kinds.indexOf(current);
  // A filter whose kind vanished from the results falls back to the first one still present
  // rather than to "everything", so a keystroke narrows rather than silently widening.
  if (index === -1) return kinds[0] ?? null;
  return index === kinds.length - 1 ? null : (kinds[index + 1] ?? null);
}
