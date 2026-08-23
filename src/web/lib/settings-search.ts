// The settings search index: one flat, control-level list of everything the settings
// page can be told to do.
//
// Pure data and pure functions - no React, no `node:` anything - for the same reason
// `settings-registry.ts` is: the palette, the page (which wires the runtime toggle
// bindings), and the integrity test all read this SAME list. It sits BESIDE the registry
// rather than inside it because the registry is category-level (the rail) and this is
// control-level (the palette); keeping them apart is what lets the anchor integrity test
// prove every entry here points at a control the page actually renders.
//
// This is the one control-level index. A new setting adds an entry HERE, next to its
// control's `data-anchor`, rather than starting a second list somewhere a search can miss.
//
// The MATCHER that runs over it lives in `palette-index.ts` now, which wraps this list in a
// provider alongside the Library's assets and the Line's live objects. It kept this file's
// rule - deterministic substring, registry order, no fuzzy ranking - and this file kept the
// list and the toggle bindings, so there is still exactly one of each.

import type { SettingsCategoryId } from "./settings-registry.ts";
import { ACTIONS } from "./keybindings.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

/**
 * One searchable control.
 *
 *  - `anchor` is the `data-anchor="<category>/<slug>"` the jump scrolls to and flashes.
 *    Its prefix MUST equal `category`, and it MUST be one the page renders - the anchor
 *    integrity test (`settings-search.test.ts`) fails otherwise, which is the whole point
 *    of pinning it from day one.
 *  - `kind` is `"toggle"` for a boolean the palette can flip in place, `"jump"` for
 *    everything else (a scalar, a picker, a whole sub-panel). A `"toggle"` the page did
 *    not wire a binding for degrades to a jump rather than drawing a dead switch.
 *  - `risky` marks the D5 exemption set: booleans that ALWAYS jump to their panel so their
 *    consent copy is on screen when they change, never flipped anonymously from a search
 *    result. The page never builds a binding for a risky control, so it renders as a jump
 *    by the same degrade path - the flag is what keeps that deliberate rather than a
 *    forgotten binding.
 */
export interface SettingsControl {
  id: string;
  label: string;
  description: string;
  category: SettingsCategoryId;
  anchor: string;
  keywords: readonly string[];
  kind: "toggle" | "jump";
  risky?: true;
}

/**
 * The per-harness cards, derived from the harness union rather than hand-listed, so a new
 * agent's card is searchable the moment it exists - the same reason `HarnessesPanel` builds
 * its cards from `AGENT_TYPES`. Each points at that card's `harnesses/<agent>` anchor.
 */
const HARNESS_CONTROLS: SettingsControl[] = AGENT_TYPES.map((agent) => ({
  id: `harness-${agent}`,
  label: `${AGENT_IDENTITY[agent].label} defaults`,
  description: "What a dispatch of this harness launches with - default model and effort.",
  category: "harnesses",
  anchor: `harnesses/${agent}`,
  keywords: ["model", "effort", "dispatch", "default", AGENT_IDENTITY[agent].label.toLowerCase()],
  kind: "jump",
}));

/**
 * One entry per keyboard shortcut, derived from the `ACTIONS` registry rather than
 * collapsed into a single "Keyboard" row. Each shortcut is an independently rebindable
 * control with its own `keyboard/<id>` anchor, so searching "dispatch" or "kill" has to
 * land on that action's binding, not merely the top of the panel. Deriving from `ACTIONS`
 * (the same way the harness cards derive from `AGENT_TYPES`) keeps a newly added shortcut
 * searchable with nothing to remember here. The shared keywords let a generic "shortcut"
 * query surface the whole set; a specific query matches the action's own label.
 */
const KEYBOARD_CONTROLS: SettingsControl[] = ACTIONS.map((a) => ({
  id: `keyboard-${a.id}`,
  label: a.label,
  description: a.description,
  category: "keyboard",
  anchor: `keyboard/${a.id}`,
  keywords: ["shortcut", "keybinding", "chord", "hotkey", "rebind", "key"],
  kind: "jump",
}));

/**
 * Every settings control worth searching for, in a stable order (the empty-query preview
 * shows the first few). One entry per control except where a dynamic set collapses to one:
 * the Skills catalog is a single entry (its per-skill rows are runtime data, not indexed),
 * and Foreman's four models and the daemon's background jobs are each one entry over a
 * cluster of `ModelField`s.
 */
export const SETTINGS_CONTROLS: readonly SettingsControl[] = [
  {
    id: "layout",
    label: "Layout",
    description: "Arrange the fleet as Console or Board.",
    category: "display",
    anchor: "display/layout",
    keywords: ["console", "board", "arrangement", "view"],
    kind: "jump",
  },
  {
    id: "conversation-view",
    label: "Conversation rendering",
    description: "Read conversations as a chat log or as a terminal stream.",
    category: "display",
    anchor: "display/conversation-view",
    keywords: ["terminal", "pty", "shell", "stdout", "prompt", "transcript", "chat", "stream"],
    kind: "jump",
  },
  {
    id: "format-messages",
    label: "Format messages",
    description: "Render transcripts as markdown rather than the literal text an agent emitted.",
    category: "display",
    anchor: "display/format-messages",
    keywords: ["rich text", "markdown", "appearance", "code blocks", "syntax"],
    kind: "toggle",
  },
  {
    id: "board-card",
    label: "Board card",
    description: "Choose which items a session card draws in every Board column.",
    category: "display",
    anchor: "display/board-card",
    // "hide"/"show"/"customize" are what an operator types who wants the panel and has not
    // read its label; the item names are what someone types who wants ONE of them gone and
    // does not know they are all in one place. `kind` is "jump" rather than "toggle"
    // because a checklist has no single boolean for the palette to flip.
    keywords: [
      "card",
      "tile",
      "hide",
      "show",
      "customize",
      "items",
      "worktree",
      "branch",
      "model",
      "cost",
      "context",
      "goal",
    ],
    kind: "jump",
  },
  {
    // Same panel, same anchor, second subject. An operator who wants the path gone from
    // above the conversation would never type "board card" to find it, and the panel's
    // heading is the only other thing that could lead them there. Two entries pointing at
    // one anchor is what the index is for: it is a control-level index, and this section
    // governs two controls' worth of surface.
    id: "conversation-header",
    label: "Conversation header",
    description:
      "Choose whether the console states a session's working directory and branch above its conversation.",
    category: "display",
    anchor: "display/board-card",
    keywords: [
      "path",
      "working directory",
      "cwd",
      "branch",
      "console",
      "detail",
      "conversation",
      "header",
      "band",
      "hide",
      "show",
    ],
    kind: "jump",
  },
  ...KEYBOARD_CONTROLS,
  {
    id: "guided-dispatch",
    label: "Guided dispatch",
    description:
      "Ask for kind, harness and after work before handing over the dispatch form.",
    category: "dispatch",
    anchor: "dispatch/guided",
    // "wizard" and "walkthrough" are what someone calls this who has not read the label;
    // "kind", "harness" and "after work" are the questions themselves, which is what an
    // operator who met the pass and wants it gone will actually remember about it.
    keywords: ["guided", "wizard", "walkthrough", "steps", "questions", "kind", "harness", "after work"],
    kind: "toggle",
  },
  {
    id: "auto-mode",
    label: "Auto mode on dispatch",
    description: "Launch every dispatched session in its most autonomous permission mode.",
    category: "harnesses",
    anchor: "harnesses/auto-mode",
    keywords: ["permission", "bypass", "autonomous", "yolo", "accept edits"],
    kind: "toggle",
  },
  ...HARNESS_CONTROLS,
  {
    id: "worktree-policy",
    label: "Worktree policy",
    description: "Default and repository-specific native checkout capacity and setup argv.",
    category: "worktrees",
    anchor: "worktrees/policy",
    keywords: ["pool", "capacity", "setup", "argv", "repository", "disable"],
    kind: "jump",
  },
  {
    id: "native-worktree-pools",
    label: "Native worktree pools",
    description: "Inspect slots and preview Return, Prune, Reconcile, and Destroy.",
    category: "worktrees",
    anchor: "worktrees/native-pools",
    keywords: ["slot", "lease", "dirty", "occupied", "quarantine", "cleanup"],
    kind: "jump",
  },
  {
    id: "legacy-worktree-drain",
    label: "Legacy Treehouse drain",
    description: "Inspect exact and unverifiable historical Treehouse resources.",
    category: "worktrees",
    anchor: "worktrees/legacy-drain",
    keywords: ["treehouse", "legacy", "return", "foreign", "unreadable"],
    kind: "jump",
  },
  {
    id: "skills-enabled",
    label: "Enable Mission Control skills",
    description: "Master switch - symlink the skill set into every harness's skills directory.",
    category: "skills",
    anchor: "skills/enabled",
    keywords: ["skill", "slash command", "symlink", "master"],
    kind: "toggle",
  },
  {
    id: "skills-catalog",
    label: "Skills catalog",
    description: "Which individual skills every session gets.",
    category: "skills",
    anchor: "skills/catalog",
    keywords: ["skill", "catalog", "slash command"],
    kind: "jump",
  },
  {
    id: "cost-track",
    label: "Track Claude estimated cost",
    description: "Write a telemetry env block so sessions report usage to the daemon.",
    category: "cost",
    anchor: "cost/track",
    keywords: ["telemetry", "otel", "usage", "spend", "money", "estimate"],
    kind: "toggle",
  },
  {
    id: "cost-interval",
    label: "Export interval",
    description: "How often each session reports its usage.",
    category: "cost",
    anchor: "cost/interval",
    keywords: ["telemetry", "frequency", "seconds", "interval"],
    kind: "jump",
  },
  {
    id: "cost-view",
    label: "Lead with",
    description: "Whether the topbar's usage strip leads with estimated cost or plan usage.",
    category: "cost",
    anchor: "cost/view",
    keywords: ["topbar", "usd", "dollars", "plan", "tokens", "strip"],
    kind: "jump",
  },
  {
    id: "foreman-tier",
    label: "Cheap tier",
    description: "Whether the Foreman answers the easy prompts itself - off, shadow, or on.",
    category: "foreman",
    anchor: "foreman/cheap-tier",
    keywords: ["triage", "shadow", "router", "auto-responder"],
    kind: "jump",
  },
  {
    id: "foreman-models",
    label: "Foreman provider and models",
    description: "The provider and the four models behind Review, Verify, Triage, and Backlog.",
    category: "foreman",
    anchor: "foreman/provider",
    keywords: ["model", "review", "verify", "triage", "backlog", "provider", "runner"],
    kind: "jump",
  },
  {
    id: "foreman-skip-scout-wrapup",
    label: "Skip automatic completion for Scout tasks",
    description: "Keep Scout findings out of Ship it, No-Mistakes Review, and Straight to PR.",
    category: "foreman",
    anchor: "foreman/skip-scout-wrapup",
    keywords: ["scout", "kind", "wrap up", "workflow", "pull request", "ship it"],
    kind: "jump",
  },
  {
    id: "foreman-skip-review-artifact-wrapup",
    label: "Skip automatic completion for mockups and review artifacts",
    description: "Keep review-only deliverables out of automatic shipping actions.",
    category: "foreman",
    anchor: "foreman/skip-review-artifact-wrapup",
    keywords: [
      "mockup",
      "wireframe",
      "prototype",
      "report",
      "plan",
      "review artifact",
      "workflow",
      "pull request",
    ],
    kind: "jump",
  },
  {
    id: "foreman-ship-recovery-minutes",
    label: "Pre-PR ship recovery wait",
    description: "Set the quiet window before Foreman resumes an eligible managed Ship task.",
    category: "foreman",
    anchor: "foreman/ship-recovery-minutes",
    keywords: ["ship", "recovery", "idle", "quiet", "minutes", "pull request", "escalation"],
    kind: "jump",
  },
  {
    id: "foreman-episodes",
    label: "Foreman decisions",
    description: "Every prompt Foreman has decided on, across every session, newest first.",
    category: "foreman",
    anchor: "foreman/episodes",
    keywords: ["episode", "decision", "answered", "escalated", "shadow", "ledger", "history"],
    kind: "jump",
  },
  {
    id: "workflow-dispatch-default",
    label: "Default dispatch workflow",
    description: "The published Workflow preselected to run after each new agent dispatch.",
    category: "workflows",
    anchor: "workflows/dispatch-default",
    keywords: ["default", "dispatch", "after work", "workflow", "agent", "task"],
    kind: "jump",
  },
  {
    id: "workflow-live-delivery",
    label: "Enable Live workflow delivery",
    description: "Whether Persona repairs may be typed into agent sessions, or only previewed.",
    category: "workflows",
    anchor: "workflows/live-delivery",
    keywords: ["live delivery", "workflow", "repair", "paste", "preview", "persona"],
    kind: "toggle",
    // Risky for the Inspector master switch's reason in a local key: flipping it anonymously
    // from a search row would arm a paste into somebody's live session with the consent copy
    // off screen. It always jumps to the panel.
    risky: true,
  },
  {
    id: "workflow-allowlist",
    label: "Workflow allowed repositories",
    // Still a `workflows` row, and it still lands on `workflows/allowlist`, because that is
    // where an operator asking this question is going: the card names the count and carries
    // the Manage-in-Trust link. Pointing the row straight at `trust/matrix` would skip the
    // sentence explaining that one grant covers both delivery and checks.
    description: "Where Live delivery may send and Command nodes may run. Granted in Trust.",
    category: "workflows",
    anchor: "workflows/allowlist",
    keywords: ["allowlist", "repo", "repository", "workflow", "live delivery", "grant", "trust"],
    kind: "jump",
  },
  {
    id: "workflow-checks",
    label: "Allow workflow Commands",
    description: "Whether a Command node may run its configured argv, executing branch-authored code.",
    category: "workflows",
    // The anchor is unchanged and permanently so: it is a kept link, and the control it names
    // is the same machine-wide switch it always was. Only the words on it moved.
    anchor: "workflows/checks",
    keywords: [
      "check", "command", "test", "lint", "typecheck", "build", "gate", "exit code", "allow",
      "pause",
    ],
    kind: "toggle",
    // Risky for the same reason Live delivery is, and more so: this one authorizes running
    // code the reviewed branch supplies, with the daemon's filesystem authority.
    risky: true,
  },
  {
    // Kept under its old id and keywords, pointed at the card that now says where the catalog
    // went. An operator searching "check commands" for a table this panel no longer has is
    // exactly who this row exists for, and dropping it would answer them with nothing.
    id: "workflow-check-commands",
    label: "What each Command runs",
    description: "The test, lint, typecheck and build argvs - authored in Library › Commands.",
    category: "workflows",
    anchor: "workflows/command-catalog",
    keywords: [
      "check", "command", "argv", "slot", "test", "lint", "typecheck", "build", "repo",
      "override", "default", "library",
    ],
    kind: "jump",
  },
  {
    id: "workflow-retention",
    label: "Workflow run retention",
    description: "How long raw evidence and finished run history are kept before a sweep prunes them.",
    category: "workflows",
    anchor: "workflows/retention",
    keywords: ["retention", "history", "evidence", "prune", "sweep", "compact", "delete"],
    kind: "jump",
  },
  {
    id: "workflow-health",
    label: "Workflow health",
    description: "Active runs, queued Persona calls, waiting deliveries, and the last sweep.",
    category: "workflows",
    anchor: "workflows/health",
    keywords: ["health", "queue", "deliveries", "recovery", "sweep", "counters"],
    kind: "jump",
  },
  {
    id: "task-sources",
    label: "Task sources",
    description: "The upstreams that pull work into the backlog.",
    category: "task-sources",
    anchor: "task-sources/sources",
    keywords: ["github issues", "sweep", "backlog", "import", "upstream"],
    kind: "jump",
  },
  {
    id: "conductor-repos",
    label: "Conductor repositories",
    description: "Which repositories an external SDLC engine's pipelines are observed in.",
    category: "conductor",
    anchor: "conductor/repos",
    keywords: ["ai-conductor", "pipeline", "sdlc", "engine", "repository", "consent", "observe"],
    kind: "jump",
  },
  {
    id: "llm-jobs",
    label: "Background job models",
    description: "The provider and models behind the app's own titling, goals, and digests.",
    category: "models",
    anchor: "models/provider",
    keywords: ["title", "goal", "digest", "workflow", "provider", "runner", "job"],
    kind: "jump",
  },
  {
    id: "inspector-enabled",
    label: "Run GitHub Inspector",
    description: "Whether GitHub Inspector reviews the pull requests we open remotely.",
    category: "inspector",
    anchor: "inspector/enabled",
    keywords: ["review", "pull request", "pr", "enable"],
    kind: "toggle",
    risky: true,
  },
  {
    id: "inspector-mode",
    label: "GitHub Inspector mode",
    description: "Dry run - record findings and post nothing - or live, posting review comments.",
    category: "inspector",
    anchor: "inspector/mode",
    keywords: ["dry run", "live", "publish", "post", "comments"],
    kind: "jump",
    risky: true,
  },
  {
    id: "review-model",
    label: "Review model",
    description: "The provider and model GitHub Inspector reviews with.",
    category: "inspector",
    anchor: "inspector/provider",
    keywords: ["model", "provider", "runner", "review"],
    kind: "jump",
  },
  {
    id: "yolo",
    label: "YOLO mode",
    description: "Whether clean pull requests we open merge themselves.",
    category: "shipping",
    anchor: "shipping/yolo",
    keywords: ["auto merge", "automerge", "ship", "self-merge"],
    kind: "toggle",
    risky: true,
  },
  {
    id: "soak",
    label: "Soak time",
    description: "Minutes a clean pull request stays open before it may merge.",
    category: "shipping",
    anchor: "shipping/soak",
    keywords: ["soak", "window", "delay", "minutes", "wait"],
    kind: "jump",
  },
  {
    id: "merge-method",
    label: "How to merge",
    description: "Squash, merge commit, or rebase.",
    category: "shipping",
    anchor: "shipping/method",
    keywords: ["squash", "rebase", "merge commit", "method"],
    kind: "jump",
  },
  {
    id: "trust-grants",
    label: "Trust grants",
    description: "Which repositories each subsystem may act in.",
    category: "trust",
    anchor: "trust/matrix",
    keywords: ["allowlist", "repo", "repository", "permission", "grant", "matrix"],
    kind: "jump",
  },
];

/**
 * The control ids the page is expected to wire a boolean binding for: every `"toggle"`
 * that is not risky. The page builds its `Map<controlId, ToggleBinding>` for exactly these
 * (see `SettingsPage`), so a risky control can never receive a binding and can never flip
 * from a search result - it degrades to a jump. Exported so the test can pin that without
 * reaching into the page's runtime wiring.
 */
export const BINDABLE_CONTROL_IDS: readonly string[] = SETTINGS_CONTROLS.filter(
  (c) => c.kind === "toggle" && !c.risky,
).map((c) => c.id);

/** A runtime get/set pair for one boolean control, supplied by the page. */
export interface ToggleBinding {
  get: () => boolean;
  set: (on: boolean) => void;
}

/** The bindings the page hands the palette, keyed by control id. */
export type SettingsBindings = Map<string, ToggleBinding>;

/**
 * One boolean control's current value and setter, or `null` when its backing state has not
 * loaded yet - a daemon config still in flight. A null source gets NO binding, so the
 * control degrades to a jump.
 */
export type ToggleSource = { value: boolean; set: (on: boolean) => void } | null;

/**
 * Assemble the palette's toggle bindings from the page's current state.
 *
 * A daemon-backed control (auto mode, skills, cost) passes `null` until its config has
 * landed, and gets no binding until then. The reason is the panels' own: they DISABLE the
 * control until the first read, because a flip against an assumed default would either
 * write a guessed value or silently no-op on a refused update. A missing binding makes the
 * palette render that control as a jump (open the panel), which is the honest pre-poll
 * affordance rather than a switch that lies. The browser-local formatting toggle has
 * shipped defaults, so it is always bindable - there is no pre-poll interval to guard.
 *
 * Kept here, beside the index, so the "loaded before bindable" rule is one testable pure
 * function rather than a conditional buried in the page.
 */
export function buildSettingsBindings(sources: {
  formatMessages: { value: boolean; set: (on: boolean) => void };
  guidedDispatch: { value: boolean; set: (on: boolean) => void };
  autoMode: ToggleSource;
  skillsEnabled: ToggleSource;
  costTrack: ToggleSource;
}): SettingsBindings {
  const map: SettingsBindings = new Map();
  map.set("format-messages", {
    get: () => sources.formatMessages.value,
    set: sources.formatMessages.set,
  });
  // Not a `ToggleSource`, for the same reason formatting is not: both are browser-local
  // `UiConfig` booleans with shipped defaults, so there is no pre-poll interval in which
  // their value is unknown and no honest reason to degrade either to a jump.
  map.set("guided-dispatch", {
    get: () => sources.guidedDispatch.value,
    set: sources.guidedDispatch.set,
  });
  const put = (id: string, source: ToggleSource): void => {
    if (source) map.set(id, { get: () => source.value, set: source.set });
  };
  put("auto-mode", sources.autoMode);
  put("skills-enabled", sources.skillsEnabled);
  put("cost-track", sources.costTrack);
  return map;
}
