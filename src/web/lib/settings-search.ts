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
import {
  backupDomains,
  backupNotApplicable,
  type SettingsBackupCoverage,
} from "@shared/settings-backup-domains.ts";

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
  backup: SettingsBackupCoverage;
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
  backup: backupDomains("harnesses"),
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
  backup: backupDomains("ui"),
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
    backup: backupDomains("ui"),
  },
  {
    id: "conversation-view",
    label: "Conversation rendering",
    description: "Read conversations as a chat log or as a terminal stream.",
    category: "display",
    anchor: "display/conversation-view",
    keywords: ["terminal", "pty", "shell", "stdout", "prompt", "transcript", "chat", "stream"],
    kind: "jump",
    backup: backupDomains("ui"),
  },
  {
    id: "format-messages",
    label: "Format messages",
    description: "Render transcripts as markdown rather than the literal text an agent emitted.",
    category: "display",
    anchor: "display/format-messages",
    keywords: ["rich text", "markdown", "appearance", "code blocks", "syntax"],
    kind: "toggle",
    backup: backupDomains("ui"),
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
    backup: backupDomains("ui"),
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
    backup: backupDomains("ui"),
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
    backup: backupDomains("ui"),
  },
  {
    id: "auto-mode",
    label: "Auto mode on dispatch",
    description: "Launch every dispatched session in its most autonomous permission mode.",
    category: "harnesses",
    anchor: "harnesses/auto-mode",
    keywords: ["permission", "bypass", "autonomous", "yolo", "accept edits"],
    kind: "toggle",
    backup: backupDomains("harnesses"),
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
    backup: backupDomains("worktrees"),
  },
  {
    id: "native-worktree-pools",
    label: "Native worktree pools",
    description: "Inspect slots and preview Return, Prune, Reconcile, and Destroy.",
    category: "worktrees",
    anchor: "worktrees/native-pools",
    keywords: ["slot", "lease", "dirty", "occupied", "quarantine", "cleanup"],
    kind: "jump",
    backup: backupNotApplicable("operational-action"),
  },
  {
    id: "legacy-worktree-drain",
    label: "Legacy Treehouse drain",
    description: "Inspect exact and unverifiable historical Treehouse resources.",
    category: "worktrees",
    anchor: "worktrees/legacy-drain",
    keywords: ["treehouse", "legacy", "return", "foreign", "unreadable"],
    kind: "jump",
    backup: backupNotApplicable("operational-action"),
  },
  {
    id: "skills-enabled",
    label: "Enable Mission Control skills",
    description: "Master switch - symlink the skill set into every harness's skills directory.",
    category: "skills",
    anchor: "skills/enabled",
    keywords: ["skill", "slash command", "symlink", "master"],
    kind: "toggle",
    backup: backupDomains("skills"),
  },
  {
    id: "skills-catalog",
    label: "Skills catalog",
    description: "Which individual skills every session gets.",
    category: "skills",
    anchor: "skills/catalog",
    keywords: ["skill", "catalog", "slash command"],
    kind: "jump",
    backup: backupDomains("skills"),
  },
  {
    id: "standing-instructions-default",
    label: "Standing instructions for every repository",
    description: "The machine-wide text a session gets when its checkout has no rule of its own.",
    category: "standing-instructions",
    anchor: "standing-instructions/default",
    keywords: ["instruction", "prompt", "default", "global", "preamble", "always"],
    kind: "jump",
    backup: backupDomains("standing-instructions"),
  },
  {
    id: "standing-instructions-repositories",
    label: "Standing instructions per repository",
    description: "One box per checkout, sent to every session Mission Control opens into it.",
    category: "standing-instructions",
    anchor: "standing-instructions/repositories",
    keywords: ["instruction", "repository", "override", "inherited", "per-repo", "rule"],
    kind: "jump",
    backup: backupDomains("standing-instructions"),
  },
  {
    id: "cost-track",
    label: "Track Claude estimated cost",
    description: "Write a telemetry env block so sessions report usage to the daemon.",
    category: "cost",
    anchor: "cost/track",
    keywords: ["telemetry", "otel", "usage", "spend", "money", "estimate"],
    kind: "toggle",
    backup: backupDomains("cost"),
  },
  {
    id: "cost-interval",
    label: "Export interval",
    description: "How often each session reports its usage.",
    category: "cost",
    anchor: "cost/interval",
    keywords: ["telemetry", "frequency", "seconds", "interval"],
    kind: "jump",
    backup: backupDomains("cost"),
  },
  {
    id: "cost-view",
    label: "Lead with",
    description: "Whether the topbar's usage strip leads with estimated cost or plan usage.",
    category: "cost",
    anchor: "cost/view",
    keywords: ["topbar", "usd", "dollars", "plan", "tokens", "strip"],
    kind: "jump",
    backup: backupDomains("cost"),
  },
  {
    id: "foreman-tier",
    label: "Cheap tier",
    description: "Whether the Foreman answers the easy prompts itself - off, shadow, or on.",
    category: "foreman",
    anchor: "foreman/cheap-tier",
    keywords: ["triage", "shadow", "router", "auto-responder"],
    kind: "jump",
    backup: backupDomains("foreman", "foreman-instructions"),
  },
  {
    id: "foreman-skip-scout-wrapup",
    label: "Skip automatic completion for Scout tasks",
    description: "Keep Scout findings out of Ship it, No-Mistakes Review, and Straight to PR.",
    category: "foreman",
    anchor: "foreman/skip-scout-wrapup",
    keywords: ["scout", "kind", "wrap up", "workflow", "pull request", "ship it"],
    kind: "jump",
    backup: backupDomains("foreman"),
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
    backup: backupDomains("foreman"),
  },
  {
    id: "foreman-ship-recovery-minutes",
    label: "Pre-PR ship recovery wait",
    description: "Set the quiet window before Foreman resumes an eligible managed Ship task.",
    category: "foreman",
    anchor: "foreman/ship-recovery-minutes",
    keywords: ["ship", "recovery", "idle", "quiet", "minutes", "pull request", "escalation"],
    kind: "jump",
    backup: backupDomains("foreman"),
  },
  {
    id: "foreman-episodes",
    label: "Foreman decisions",
    description: "Every prompt Foreman has decided on, across every session, newest first.",
    category: "foreman",
    anchor: "foreman/episodes",
    keywords: ["episode", "decision", "answered", "escalated", "shadow", "ledger", "history"],
    kind: "jump",
    backup: backupNotApplicable("derived-status"),
  },
  {
    id: "workflow-dispatch-default",
    label: "Default dispatch workflow",
    description: "The published Workflow preselected to run after each new agent dispatch.",
    category: "workflows",
    anchor: "workflows/dispatch-default",
    keywords: ["default", "dispatch", "after work", "workflow", "agent", "task"],
    kind: "jump",
    backup: backupDomains("workflow-policy"),
  },
  {
    id: "workflow-live-delivery",
    label: "Enable Live workflow delivery",
    description: "Whether Persona repairs may be typed into agent sessions, or only previewed.",
    category: "workflows",
    anchor: "workflows/live-delivery",
    keywords: ["live delivery", "workflow", "repair", "paste", "preview", "persona"],
    kind: "toggle",
    backup: backupDomains("workflow-policy"),
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
    backup: backupDomains("workflow-policy"),
  },
  {
    id: "workflow-test-evidence",
    label: "Test evidence readiness",
    description:
      "First-pass acceptance, rejection reasons and evidence adoption for the Test Evidence Auditor.",
    category: "workflows",
    anchor: "workflows/test-evidence",
    keywords: [
      "test evidence", "auditor", "readiness", "rejection", "first pass", "screenshot",
      "artifact", "evidence", "overreach", "telemetry",
    ],
    kind: "jump",
    backup: backupNotApplicable("derived-status"),
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
    backup: backupDomains("workflow-policy"),
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
    backup: backupDomains("workflow-commands"),
  },
  {
    id: "workflow-retention",
    label: "Workflow run retention",
    description: "How long raw evidence and finished run history are kept before a sweep prunes them.",
    category: "workflows",
    anchor: "workflows/retention",
    keywords: ["retention", "history", "evidence", "prune", "sweep", "compact", "delete"],
    kind: "jump",
    backup: backupDomains("workflow-policy"),
  },
  {
    id: "workflow-health",
    label: "Workflow health",
    description: "Active runs, queued Persona calls, waiting deliveries, and the last sweep.",
    category: "workflows",
    anchor: "workflows/health",
    keywords: ["health", "queue", "deliveries", "recovery", "sweep", "counters"],
    kind: "jump",
    backup: backupNotApplicable("derived-status"),
  },
  {
    id: "task-sources",
    label: "Task sources",
    description: "The upstreams that pull work into the backlog.",
    category: "task-sources",
    anchor: "task-sources/sources",
    keywords: ["github issues", "sweep", "backlog", "import", "upstream"],
    kind: "jump",
    backup: backupDomains("task-sources"),
  },
  {
    id: "conductor-repos",
    label: "Conductor repositories",
    description: "The repository directory: which checkouts Conductor manages, and which are observed.",
    category: "conductor",
    anchor: "conductor/repos",
    keywords: ["ai-conductor", "pipeline", "sdlc", "engine", "repository", "consent", "observe", "directory"],
    kind: "jump",
    backup: backupDomains("pipelines"),
  },
  // The other five anchors this panel renders. It drew six and indexed one, so the engine,
  // the master switch, the Engineer host and Foreman triage were reachable only by opening
  // the category and scrolling - which is what the palette exists to replace. Every one is
  // a `jump`: none is a boolean the palette could honestly flip from a search row, and the
  // consent switch is exactly the kind whose copy has to be on screen when it moves.
  {
    id: "conductor-overview",
    label: "Conductor commissioning",
    description: "Where an external SDLC engine's setup stands: engine, registration, observation.",
    category: "conductor",
    anchor: "conductor/pipelines",
    keywords: ["ai-conductor", "pipeline", "sdlc", "commissioning", "setup", "register", "overview"],
    kind: "jump",
    backup: backupNotApplicable("derived-status"),
  },
  {
    id: "conductor-detection",
    label: "Conductor engine detection",
    description: "Whether conduct-ts was found, where, which version, and which registry it read.",
    category: "conductor",
    anchor: "conductor/detection",
    keywords: ["conduct-ts", "engine", "install", "installer", "version", "registry", "probe", "path"],
    kind: "jump",
    backup: backupNotApplicable("derived-status"),
  },
  {
    id: "conductor-enabled",
    label: "Observe Conductor pipelines",
    description: "The master consent switch for reading any Conductor pipeline state at all.",
    category: "conductor",
    anchor: "conductor/enabled",
    keywords: ["observe", "consent", "master switch", "pipeline", "ai-conductor", "read"],
    kind: "jump",
    backup: backupDomains("pipelines"),
  },
  {
    id: "conductor-launch-runtime",
    label: "Conductor Engineer host",
    description: "Which Mission Control host starts Engineer: the managed Agent SDK, or a terminal.",
    category: "conductor",
    anchor: "conductor/launch-runtime",
    keywords: ["engineer", "launch", "runtime", "agent sdk", "terminal", "host", "pipeline"],
    kind: "jump",
    backup: backupDomains("pipelines"),
  },
  {
    id: "conductor-foreman-triage",
    label: "Foreman pipeline triage",
    description: "Whether Foreman may unpark mechanical pipeline halts on its own.",
    category: "conductor",
    anchor: "conductor/foreman-triage",
    keywords: ["foreman", "triage", "halt", "unpark", "mechanical", "pipeline"],
    kind: "jump",
    backup: backupDomains("pipelines"),
  },
  // Two entries, because there are now two controls and `models/provider` only names one of
  // them. That anchor is the APP-WIDE radio; the per-job providers live in the matrix below
  // it, and an operator searching "run the goal job on Codex" who lands on the radio has been
  // sent to the control that specifically does not answer that.
  {
    id: "llm-runner",
    label: "App-wide model provider",
    description: "Which provider the app's own calls use when a job hasn't chosen its own.",
    category: "models",
    anchor: "models/provider",
    keywords: ["provider", "runner", "claude", "codex", "app-wide", "default"],
    kind: "jump",
    backup: backupDomains("models"),
  },
  {
    id: "llm-jobs",
    label: "Background job providers and models",
    description: "A provider and a model per job - titling, goals, digests, workflow context.",
    category: "models",
    anchor: "models/jobs",
    keywords: [
      "title",
      "goal",
      "digest",
      "workflow",
      "provider",
      "runner",
      "job",
      "per job",
      "override",
      "inherit",
    ],
    kind: "jump",
    backup: backupDomains("models"),
  },
  // A third entry on this category, because the grid below the jobs answers a different
  // question from either control above it: not "what does the app spend on itself" but "what
  // does a dispatched plan run as". Someone searching "plan model" wants this row and nothing
  // else on the page.
  {
    id: "task-kind-defaults",
    label: "Agent, model and effort per task kind",
    description: "What a dispatched plan, ship, scout or chat task is filed on and launches with.",
    category: "models",
    anchor: "models/task-kinds",
    // Kind names appear only inside phrases ("plan model"), never as the bare ids. Listing
    // them bare would restate the kind vocabulary outside its registry, which
    // `task-kinds.test.ts` refuses precisely so a stale copy cannot silently drop a kind.
    keywords: [
      "task kind",
      "plan model",
      "plan agent",
      "ship model",
      "scout model",
      "chat model",
      "dispatch default",
      "harness",
      "agent",
      "effort",
      "reasoning",
      "per kind",
      "inherit",
    ],
    kind: "jump",
    backup: backupDomains("harnesses"),
  },
  // Re-pointed here from the Foreman and GitHub Inspector categories when their model
  // controls moved. The IDS are unchanged - `foreman-models` and `review-model` are the keys
  // a keybinding is stored under (`BINDABLE_CONTROL_IDS`), so renaming one to match its new
  // home would silently orphan a chord somebody had bound. Only the category and the anchor
  // move, which is exactly what changed.
  {
    id: "foreman-models",
    label: "Foreman provider and models",
    description: "The provider and the four models behind Review, Verify, Triage, and Backlog.",
    category: "models",
    anchor: "models/foreman",
    keywords: [
      "foreman",
      "model",
      "review",
      "verify",
      "triage",
      "backlog",
      "provider",
      "runner",
      "per role",
      "inherit",
    ],
    kind: "jump",
    backup: backupDomains("foreman"),
  },
  {
    id: "review-model",
    label: "GitHub Inspector review model",
    description: "The provider and model GitHub Inspector reviews pull requests with.",
    category: "models",
    anchor: "models/inspector",
    keywords: ["inspector", "github", "model", "provider", "runner", "review", "pull request"],
    kind: "jump",
    backup: backupDomains("inspector"),
  },
  {
    id: "inspector-enabled",
    label: "Run GitHub Inspector",
    description: "Whether GitHub Inspector reviews the pull requests we open remotely.",
    category: "inspector",
    anchor: "inspector/enabled",
    keywords: ["review", "pull request", "pr", "enable"],
    kind: "toggle",
    backup: backupDomains("inspector"),
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
    backup: backupDomains("inspector"),
    risky: true,
  },
  {
    id: "yolo",
    label: "YOLO mode",
    description: "Whether clean pull requests we open merge themselves.",
    category: "shipping",
    anchor: "shipping/yolo",
    keywords: ["auto merge", "automerge", "ship", "self-merge"],
    kind: "toggle",
    backup: backupDomains("shipping"),
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
    backup: backupDomains("shipping"),
  },
  {
    id: "merge-method",
    label: "How to merge",
    description: "Squash, merge commit, or rebase.",
    category: "shipping",
    anchor: "shipping/method",
    keywords: ["squash", "rebase", "merge commit", "method"],
    kind: "jump",
    backup: backupDomains("shipping"),
  },
  {
    id: "trust-grants",
    label: "Trust grants",
    description: "Which repositories each subsystem may act in.",
    category: "trust",
    anchor: "trust/matrix",
    keywords: ["allowlist", "repo", "repository", "permission", "grant", "matrix"],
    kind: "jump",
    backup: backupDomains("foreman", "workflow-policy", "inspector", "shipping", "pipelines"),
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
