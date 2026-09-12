import { z } from "zod";
import {
  ENVIRONMENT_CHECK_IDS,
  type EnvironmentCheckId,
} from "./environment-checks.ts";
import type { PipelineProviderId } from "./pipeline.ts";

// External tooling Mission Control can explain, split from the daemon probes for the same
// reason `ENVIRONMENT_CHECK_INFO` is split from `server/environment`: the dashboard needs
// names, impact, and remedies, while only the daemon may inspect this machine.

/**
 * Every external dependency this build reports, in family order.
 *
 * **Append-only.** These ids are the natural key for later acknowledgement and install
 * actions. Add at the end, never rename or reorder, so a stored reference from a newer or
 * older build keeps naming the same tool.
 */
export const SETUP_DEPENDENCY_IDS = [
  "claude-cli",
  "codex-cli",
  "pi-cli",
  "tmux",
  "cmux",
  "wezterm",
  "ghostty",
  "gh-cli",
  "gh-auth",
  "claude-plugins",
  "claude-skills",
  "ai-conductor",
  "iterm",
  "herdr",
  "node-runtime",
] as const;

export type SetupDependencyId = (typeof SETUP_DEPENDENCY_IDS)[number];

/** The order the Setup panel teaches the machine in. */
export const SETUP_FAMILY_IDS = [
  "agents",
  "terminals",
  "github",
  "extensions",
  "pipelines",
  "runtime",
] as const;

export type SetupFamilyId = (typeof SETUP_FAMILY_IDS)[number];

export interface SetupFamilyInfo {
  id: SetupFamilyId;
  label: string;
  description: string;
}

export const SETUP_FAMILY_INFO: Record<SetupFamilyId, SetupFamilyInfo> = {
  agents: {
    id: "agents",
    label: "Agent CLIs",
    description: "Mission Control launches these programs to create and continue coding sessions.",
  },
  terminals: {
    id: "terminals",
    label: "Terminals",
    description: "A usable terminal path needs a window, and detached sessions may also need a multiplexer.",
  },
  github: {
    id: "github",
    label: "GitHub",
    description: "The GitHub CLI carries pull requests, reviews, issues, and repository reads.",
  },
  extensions: {
    id: "extensions",
    label: "Agent extensions",
    description: "Extensions connect agents to Mission Control; plugins and skills add capabilities and reusable workflows.",
  },
  pipelines: {
    id: "pipelines",
    label: "Pipelines",
    description: "External SDLC engines can drive and report gated feature work.",
  },
  runtime: {
    id: "runtime",
    label: "Runtime",
    description: "The system Node.js runtime used by app updates and Node-based tools.",
  },
};

export type SetupRequirement = "required" | "recommended" | "optional";

/**
 * Local background services Mission Control can start on the operator's behalf.
 *
 * Not persisted, unlike `SETUP_DEPENDENCY_IDS`: nothing stores a service id, so this tuple is
 * free to change. It is a closed vocabulary all the same, because the id travels on the wire
 * as the whole of a start request - the daemon resolves how each one is started, and
 * `server/setup/service.ts` fails typecheck until a new id has exactly one starter.
 *
 * A service is not a dependency. `herdr` the CLI is either installed or not, and that is
 * what its row's install remedy answers; the server it talks to is a separate, restartable
 * fact about this machine right now, and it is the one an operator with Herdr installed is
 * far more likely to be missing.
 */
export const SETUP_SERVICE_IDS = ["herdr-server", "cmux-app", "cmux-socket-control"] as const;

export type SetupServiceId = (typeof SETUP_SERVICE_IDS)[number];

/**
 * Each service says what its own success and failure read like, rather than being described
 * by a sentence built around its label.
 *
 * `The ${label} is running.` is true of a server and false of everything else. It produced
 * "The cmux socket control is running." for a repair that writes one value into a config
 * file and starts no process at all, which tells an operator nothing they can check.
 */
export const SETUP_SERVICE_INFO: Record<
  SetupServiceId,
  { id: SetupServiceId; label: string; started: string; refused: string }
> = {
  "herdr-server": {
    id: "herdr-server",
    label: "Herdr server",
    started: "The Herdr server is running.",
    refused: "The Herdr server could not be started.",
  },
  "cmux-app": {
    id: "cmux-app",
    label: "cmux app",
    started: "cmux is open, and its control socket is answering.",
    refused: "cmux could not be opened.",
  },
  // Not a process, and the only entry here that is not. It is in this union because it is
  // the same shape of promise: a named repair the daemon owns end to end, carrying no argv
  // and no path the browser could influence. See `CMUX_SOCKET_CONTROL_REMEDY`.
  "cmux-socket-control": {
    id: "cmux-socket-control",
    label: "cmux socket control",
    started: "cmux socket control is set to allowAll. cmux applies it without a restart.",
    refused: "The cmux configuration could not be written.",
  },
};

/**
 * How the panel helps with one unsatisfied row.
 *
 * A remedy carries identity and prose, never an argv the browser could influence. A `command`
 * is a fixed catalog entry the daemon re-verifies against its own install grammar before it
 * opens anything; `provider-installer` and `service` name a thing and let the daemon resolve
 * how it runs. That is what keeps this union safe to widen: the wire contract grows a case,
 * not an execution surface.
 */
export type SetupRemedy =
  | { kind: "link"; url: string; label: string }
  | { kind: "command"; argv: readonly string[]; note: string }
  | { kind: "provider-installer"; provider: PipelineProviderId }
  | { kind: "skill"; command: string }
  // The one remedy that is not an installation. It carries no argv for the same reason
  // `provider-installer` does not: the browser names the service, and the daemon owns how
  // that service is started.
  | { kind: "service"; service: SetupServiceId; label: string; note: string };

/**
 * Start Herdr's default server, offered in place of the install link while the CLI is
 * installed and its server is down.
 *
 * Not on `SETUP_DEPENDENCY_INFO.herdr`, because a row's catalog remedy is its answer for
 * "this is not here at all", and telling someone who already has Herdr to read the install
 * guide is the wrong sentence. The probe hands this back for the one reading it repairs.
 */
export const HERDR_SERVER_REMEDY: SetupRemedy = {
  kind: "service",
  service: "herdr-server",
  label: "Start the Herdr server",
  note: "Start Herdr's default server now, the same way a dispatch to Herdr would.",
};

/**
 * Open cmux, offered while the CLI is installed and the app is closed.
 *
 * cmux's control socket exists only while its app is running, and the adapter degrades to an
 * empty pane list rather than saying so once a tick. Installing again repairs nothing, so
 * this stands in for the install link on that one reading - the same trade `HERDR_SERVER_REMEDY`
 * makes.
 */
export const CMUX_APP_REMEDY: SetupRemedy = {
  kind: "service",
  service: "cmux-app",
  label: "Open cmux",
  note: "Open the cmux app and wait for its control socket, which is how Mission Control reaches it.",
};

/**
 * Let Mission Control's daemon drive cmux, offered while the socket is answering and
 * refusing.
 *
 * The one remedy here that edits an operator's own configuration, and it exists because
 * nothing else can: cmux ships `automation.socketControlMode: "cmuxOnly"`, which admits only
 * processes started inside cmux, and under it EVERY socket call is denied - including the
 * reload that would pick a repair up. So Setup used to report cmux as satisfied on the
 * strength of the binary existing while every dispatch to it failed.
 *
 * The write is one value, the previous file is copied to a timestamped `.bak` first, and a
 * file that will not parse is refused rather than replaced. See `setup/cmux-config.ts`.
 */
export const CMUX_SOCKET_CONTROL_REMEDY: SetupRemedy = {
  kind: "service",
  service: "cmux-socket-control",
  label: "Allow Mission Control to drive cmux",
  note: "Set automation.socketControlMode to allowAll in ~/.config/cmux/cmux.json, keeping a timestamped backup of the current file.",
};

export interface SetupDependencyInfo {
  id: SetupDependencyId;
  label: string;
  family: SetupFamilyId;
  requirement: SetupRequirement;
  /** What is unavailable while this row is not satisfied. */
  enables: string;
  remedy: SetupRemedy;
}

/** Every dependency's pure metadata, exhaustively keyed by its append-only id. */
export const SETUP_DEPENDENCY_INFO: Record<SetupDependencyId, SetupDependencyInfo> = {
  "claude-cli": {
    id: "claude-cli",
    label: "Claude Code",
    family: "agents",
    requirement: "recommended",
    enables: "Without it, Claude sessions and Claude-backed background jobs cannot launch.",
    remedy: {
      kind: "command",
      argv: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
      note: "Install the official Claude Code npm package without sudo.",
    },
  },
  "codex-cli": {
    id: "codex-cli",
    label: "Codex CLI",
    family: "agents",
    requirement: "recommended",
    enables: "Without it, Codex sessions and Codex-backed background jobs cannot launch.",
    remedy: {
      kind: "link",
      url: "https://developers.openai.com/codex/cli",
      label: "Open Codex installation guide",
    },
  },
  "pi-cli": {
    id: "pi-cli",
    label: "Pi",
    family: "agents",
    requirement: "recommended",
    enables: "Without it, Pi sessions cannot launch or resume, and Pi's Agent SDK runtime stays unavailable.",
    remedy: {
      kind: "command",
      argv: ["npm", "install", "-g", "@earendil-works/pi-coding-agent"],
      note: "Install the Pi coding agent package globally.",
    },
  },
  tmux: {
    id: "tmux",
    label: "tmux",
    family: "terminals",
    requirement: "optional",
    enables: "Adds durable detached sessions, provided an installed emulator can raise them.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "tmux"],
      note: "Install tmux with Homebrew.",
    },
  },
  cmux: {
    id: "cmux",
    label: "cmux",
    family: "terminals",
    requirement: "optional",
    enables: "Adds visible, durable workspaces that need no second terminal to raise them.",
    remedy: {
      kind: "link",
      url: "https://cmux.com/docs/getting-started",
      label: "Open cmux installation guide",
    },
  },
  wezterm: {
    id: "wezterm",
    label: "WezTerm",
    family: "terminals",
    requirement: "optional",
    enables: "Adds scriptable terminal windows and can raise detached tmux sessions.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "--cask", "wezterm"],
      note: "Install WezTerm with Homebrew.",
    },
  },
  ghostty: {
    id: "ghostty",
    label: "Ghostty",
    family: "terminals",
    requirement: "optional",
    enables: "Adds native terminal windows that Mission Control can discover and focus on macOS.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "--cask", "ghostty"],
      note: "Install Ghostty with Homebrew.",
    },
  },
  "gh-cli": {
    id: "gh-cli",
    label: "GitHub CLI",
    family: "github",
    requirement: "required",
    enables: "Without it, Mission Control cannot inspect, open, review, or merge GitHub work.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "gh"],
      note: "Install the GitHub CLI with Homebrew.",
    },
  },
  "gh-auth": {
    id: "gh-auth",
    label: "GitHub authentication",
    family: "github",
    requirement: "required",
    enables: "Without a github.com login, GitHub operations fail even when the CLI is installed.",
    remedy: {
      kind: "link",
      url: "https://cli.github.com/manual/gh_auth_login",
      label: "Open GitHub authentication guide",
    },
  },
  "claude-plugins": {
    id: "claude-plugins",
    label: "Claude Code plugins",
    family: "extensions",
    requirement: "optional",
    enables: "Without plugins, Claude sessions do not receive plugin-provided tools, hooks, or commands.",
    remedy: {
      kind: "link",
      url: "https://docs.anthropic.com/en/docs/claude-code/plugins",
      label: "Open Claude Code plugin guide",
    },
  },
  "claude-skills": {
    id: "claude-skills",
    label: "Mission Control skills",
    family: "extensions",
    requirement: "optional",
    enables: "Without them, sessions do not receive Mission Control's reusable workflow skills.",
    remedy: {
      kind: "link",
      url: "#/settings/skills",
      label: "Open Skills settings",
    },
  },
  "ai-conductor": {
    id: "ai-conductor",
    label: "ai-conductor",
    family: "pipelines",
    requirement: "optional",
    enables: "Without it, Mission Control cannot commission or observe gated ai-conductor runs.",
    remedy: { kind: "provider-installer", provider: "ai-conductor" },
  },
  iterm: {
    id: "iterm",
    label: "iTerm2",
    family: "terminals",
    requirement: "optional",
    enables: "Adds scriptable iTerm2 windows and can raise detached tmux sessions on macOS.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "--cask", "iterm2"],
      note: "Install iTerm2 with Homebrew.",
    },
  },
  herdr: {
    id: "herdr",
    label: "Herdr",
    family: "terminals",
    requirement: "optional",
    enables: "Adds durable default-server workspaces, pane control, and full-client reattachment on macOS and Linux.",
    remedy: {
      kind: "link",
      url: "https://herdr.dev/docs/install/",
      label: "Open Herdr installation guide",
    },
  },
  "node-runtime": {
    id: "node-runtime",
    label: "Node.js",
    family: "runtime",
    requirement: "required",
    enables: "A supported system Node.js installation is required to prepare app updates and run Node-based tools.",
    remedy: {
      kind: "command",
      argv: ["brew", "install", "node"],
      note: "Install or update Node.js and npm with Homebrew, then press Re-check.",
    },
  },
};

export type SetupStatus =
  | { state: "satisfied"; evidence: string; source?: string }
  | { state: "missing" }
  | { state: "needs-setup"; why: string; evidence: string | null }
  | { state: "unknown"; why: string; evidence: string | null };

export type SetupDerivedRowId = "terminal-pair";

export type SetupRowId =
  | { source: "dependency"; id: SetupDependencyId }
  | { source: "environment-check"; id: EnvironmentCheckId }
  | { source: "derived"; id: SetupDerivedRowId };

/** The persisted row identity keeps its namespace so ids from different sources cannot alias. */
export const SetupRowIdSchema: z.ZodType<SetupRowId> = z.discriminatedUnion("source", [
  z.object({ source: z.literal("dependency"), id: z.enum(SETUP_DEPENDENCY_IDS) }),
  z.object({ source: z.literal("environment-check"), id: z.enum(ENVIRONMENT_CHECK_IDS) }),
  z.object({ source: z.literal("derived"), id: z.literal("terminal-pair") }),
]);

/** What this operator has acknowledged while the named rows remained unsatisfied. */
export const SetupBannerDismissalSchema = z.object({
  firstLaunchAcknowledged: z.boolean().default(false),
  acknowledged: z.array(SetupRowIdSchema).default([]),
});

export type SetupBannerDismissal = z.output<typeof SetupBannerDismissalSchema>;

export const DEFAULT_SETUP_BANNER_DISMISSAL: SetupBannerDismissal = {
  firstLaunchAcknowledged: false,
  acknowledged: [],
};

export interface SetupRowView {
  rowId: SetupRowId;
  label: string;
  family: SetupFamilyId;
  requirement: SetupRequirement;
  enables: string;
  remedy: SetupRemedy;
  status: SetupStatus;
}

export interface SetupChecksView {
  /** Positive readiness from Setup's Pi CLI probe; consumers do not reconstruct it from rows. */
  piCliReady?: boolean;
  /** First installation only, never a repair of an existing or enabled integration. */
  piExtensionInstallAvailable?: boolean;
  /** Positive health from the Pi extension probe; silence alone does not establish this. */
  piExtensionReady?: boolean;
  rows: SetupRowView[];
  banner: SetupBannerView;
  /**
   * This machine's home directory, so the panel can render evidence relative to it.
   *
   * It travels on the wire because only the daemon can read it. Every path the panel shows
   * begins with these same bytes, so at any width narrow enough to truncate the first thing
   * lost is the only part that differs - the binary name. Sent as the home itself rather than
   * as pre-shortened evidence, so a row can still show the absolute path on hover.
   */
  home: string;
}

/**
 * `evidence` with this machine's home written as `~`.
 *
 * An exact prefix match on the daemon's own `homeDir`, not a `/Users/` pattern: this build
 * runs on Linux too, and a regex over a path is how you end up rewriting `/var/Users/...`.
 * The trailing separator check is what keeps a sibling directory out - `/home/jo` must not
 * rewrite `/home/jordan/bin`. Anything not under the home is returned untouched.
 */
export function homeRelative(evidence: string, home: string): string {
  if (!home || !evidence.startsWith(home)) return evidence;
  const rest = evidence.slice(home.length);
  if (rest === "") return "~";
  return rest.startsWith("/") ? "~" + rest : evidence;
}

/** A server-issued binding between one checks observation and a later dismissal write. */
export interface SetupChecksSnapshot extends SetupChecksView {
  snapshotToken: string;
}

export interface SetupBannerView {
  visible: boolean;
  /** Required missing or unfinished rows in the fresh snapshot, whether acknowledged or not. */
  attentionRowIds: SetupRowId[];
  /** The number the banner names to the operator. */
  attentionCount: number;
}

/** Metadata the narrower environment-check contract does not carry itself. */
export const ENVIRONMENT_ROW_METADATA: Record<
  EnvironmentCheckId,
  {
    family: SetupFamilyId;
    requirement: SetupRequirement;
    enables: string;
    remedy: SetupRemedy;
  }
> = {
  "pi-extension": {
    family: "extensions",
    requirement: "required",
    enables: "A broken Pi extension can silently lose Mission Control integration or prevent every Pi session from starting.",
    remedy: {
      kind: "command",
      argv: ["npm", "run", "install-pi-extension"],
      note: "Build first with npm run build in a durable Mission Control clone, then run this installer. For a desktop install, update or reinstall the integration from a durable app installation. This row never repairs it automatically.",
    },
  },
  "upstartclaw-core-setup": {
    family: "extensions",
    requirement: "optional",
    enables: "Until setup finishes, UpstartClaw tools cannot authenticate reliably in dispatched sessions.",
    remedy: { kind: "skill", command: "/upstartclaw-core:setup" },
  },
  // `required`, unlike its neighbour, and the difference is what the row's presence means.
  // An environment row exists only while its check is warning (see `environmentRow`), and
  // this one warns only when hooks ARE installed and their script has gone: a state strictly
  // worse than never installing them, since every event on the machine now fails loudly
  // instead of quietly not existing. So the row cannot nag a machine that opted out, and
  // when it does appear the setup banner is exactly where it belongs.
  "mission-hook-script": {
    family: "extensions",
    requirement: "required",
    enables: "While a hook path is dead, every Claude hook event on this machine fails and terminal sessions report no state.",
    // The note carries BOTH repairs because the row cannot tell which installer wrote the
    // dead path. The check fires identically for this repo's `hooks/harness-hook.mjs` and
    // for the packaged app's `dist/satellites/hook.mjs`, and someone who only ever pressed
    // "Install Claude integrations" may have no checkout to run an npm script in at all.
    // Offering them a command they cannot run, with no hint that a button exists, is a
    // required row they can only dismiss. Conditioning the structured remedy on the missing
    // script would mean carrying a remedy on `EnvironmentCheckView`, which is a wire
    // contract change for one row; naming both here costs a sentence.
    remedy: {
      kind: "command",
      argv: ["npm", "run", "install-hooks"],
      note: "Re-point the hooks at a checkout that exists, from a durable clone rather than a pooled worktree. If you installed from the desktop app and have no checkout, press Install Claude integrations in Settings instead.",
    },
  },
};

/** The required capability row derived from terminal target composition. */
export const TERMINAL_PAIR_INFO = {
  rowId: { source: "derived", id: "terminal-pair" },
  label: "A terminal window Mission Control can open",
  family: "terminals",
  requirement: "required",
  enables: "Without a usable backend, dispatches cannot open a visible terminal window on their checkout.",
  remedy: {
    kind: "link",
    url: "https://wezterm.org/installation.html",
    label: "Open terminal installation guide",
  },
} as const satisfies Omit<SetupRowView, "status">;

/** A collision-proof anchor slug, including the row's id namespace. */
export function setupRowAnchor(rowId: SetupRowId): string {
  return `setup/${rowId.source}-${rowId.id}`;
}

/** A stable, collision-proof key for comparing persisted discriminated row ids. */
export function setupRowKey(rowId: SetupRowId): string {
  return `${rowId.source}:${rowId.id}`;
}
