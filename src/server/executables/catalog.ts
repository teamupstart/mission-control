import { homedir } from "node:os";
import { join } from "node:path";
import {
  EXECUTABLE_IDS,
  type ExecutableId,
} from "@shared/executables.ts";

export interface ExecutableCandidateContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

/** One declared configurable external command. */
export interface ExecutableSpec {
  /** Built-in catalog identity, or null for an operator-authored command. */
  id: ExecutableId | null;
  label: string;
  command: string;
  /** Suffix read through MISSION_, FLEET_, then HARNESS_. */
  overrideEnv: string | null;
  /** Historical raw names retained after the prefixed chain. */
  legacyEnv: readonly string[];
  /** Absolute supported locations checked before PATH. */
  candidates: (context: ExecutableCandidateContext) => readonly string[];
  /** Whether the command name is eligible for PATH lookup after absolute candidates. */
  searchPath: boolean;
  /** Variables removed from children of this executable. */
  dropEnv: readonly string[];
}

const none = (): readonly string[] => [];
const appCandidates = (appPath: string, executablePath: string) =>
  ({ home }: ExecutableCandidateContext): readonly string[] => [
    join("/Applications", appPath, executablePath),
    join(home, "Applications", appPath, executablePath),
  ];

function spec(
  id: ExecutableId,
  label: string,
  command: string,
  overrideEnv: string | null,
  options: {
    legacyEnv?: readonly string[];
    candidates?: ExecutableSpec["candidates"];
    dropEnv?: readonly string[];
    searchPath?: boolean;
  } = {},
): ExecutableSpec {
  return {
    id,
    label,
    command,
    overrideEnv,
    legacyEnv: options.legacyEnv ?? [],
    candidates: options.candidates ?? none,
    searchPath: options.searchPath ?? true,
    dropEnv: options.dropEnv ?? [],
  };
}

/**
 * The sole registry of configurable production executables.
 *
 * Fixed OS utilities are intentionally absent and declared below. Operator-authored
 * Workflow commands are resolved inside the same environment but are not built-in ids.
 */
export const EXECUTABLE_SPECS: Record<ExecutableId, ExecutableSpec> = {
  claude: spec("claude", "Claude Code", "claude", "CLAUDE_BIN", {
    legacyEnv: ["FOREMAN_CLAUDE_BIN"],
  }),
  codex: spec("codex", "Codex", "codex", "CODEX_BIN"),
  pi: spec("pi", "Pi", "pi", "PI_BIN"),
  gh: spec("gh", "GitHub CLI", "gh", "GH_BIN"),
  git: spec("git", "Git", "git", "GIT_BIN"),
  node: spec("node", "Node.js", "node", "NODE_BIN"),
  npm: spec("npm", "npm", "npm", "NPM_BIN"),
  jira: spec("jira", "Jira CLI", "jira", "JIRA_BIN"),
  conductor: spec("conductor", "ai-conductor", "conduct-ts", "CONDUCTOR_BIN"),
  tmux: spec("tmux", "tmux", "tmux", "TMUX_BIN"),
  herdr: spec("herdr", "Herdr", "herdr", "HERDR_BIN", {
    legacyEnv: ["HERDR_BIN"],
    dropEnv: [
      "HERDR_SESSION",
      "HERDR_SOCKET_PATH",
      "HERDR_WORKSPACE_ID",
      "HERDR_TAB_ID",
      "HERDR_PANE_ID",
    ],
  }),
  cmux: spec("cmux", "cmux", "cmux", "CMUX_BIN", {
    legacyEnv: ["CMUX_BIN"],
    candidates: appCandidates("cmux.app", "Contents/Resources/bin/cmux"),
    dropEnv: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID"],
  }),
  wezterm: spec("wezterm", "WezTerm", "wezterm", "WEZTERM_BIN", {
    legacyEnv: ["WEZTERM_BIN"],
    candidates: appCandidates("WezTerm.app", "Contents/MacOS/wezterm"),
    dropEnv: ["WEZTERM_UNIX_SOCKET"],
  }),
  ghostty: spec("ghostty", "Ghostty", "ghostty", "GHOSTTY_BIN", {
    legacyEnv: ["GHOSTTY_BIN"],
    candidates: appCandidates("Ghostty.app", "Contents/MacOS/ghostty"),
    searchPath: false,
  }),
  iterm: spec("iterm", "iTerm2", "iTerm2", "ITERM_BIN", {
    legacyEnv: ["ITERM_BIN"],
    candidates: appCandidates("iTerm.app", "Contents/MacOS/iTerm2"),
    searchPath: false,
  }),
  open: spec("open", "macOS application launcher", "open", "OPEN_BIN", {
    candidates: () => ["/usr/bin/open"],
  }),
  "xdg-settings": spec("xdg-settings", "XDG settings", "xdg-settings", "XDG_SETTINGS_BIN"),
  "gtk-launch": spec("gtk-launch", "GTK application launcher", "gtk-launch", "GTK_LAUNCH_BIN"),
  "xdg-open": spec("xdg-open", "XDG application launcher", "xdg-open", "XDG_OPEN_BIN"),
  plutil: spec("plutil", "Property list utility", "plutil", "PLUTIL_BIN", {
    candidates: () => ["/usr/bin/plutil"],
  }),
  ps: spec("ps", "process status", "ps", "PS_BIN", {
    candidates: ({ platform }) => platform === "darwin" ? ["/bin/ps"] : ["/usr/bin/ps"],
  }),
  lsof: spec("lsof", "open-file inspector", "lsof", "LSOF_BIN", {
    candidates: ({ platform }) => platform === "darwin" ? ["/usr/sbin/lsof"] : [],
  }),
  du: spec("du", "disk usage", "du", "DU_BIN", {
    candidates: ({ platform }) => platform === "darwin" ? ["/usr/bin/du"] : ["/usr/bin/du"],
  }),
  treehouse: spec("treehouse", "Treehouse compatibility CLI", "treehouse", "TREEHOUSE_BIN"),
};

/** Truly fixed OS utilities. They are never searched and must be invoked by this path. */
export const FIXED_OS_EXECUTABLES = {
  env: "/usr/bin/env",
  sh: "/bin/sh",
  osascript: "/usr/bin/osascript",
} as const;

export type FixedOsExecutableId = keyof typeof FIXED_OS_EXECUTABLES;

export function executableSpec(id: ExecutableId): ExecutableSpec {
  return EXECUTABLE_SPECS[id];
}

export function executableSpecForCommand(command: string): ExecutableSpec | null {
  return EXECUTABLE_IDS.map((id) => EXECUTABLE_SPECS[id])
    .find((candidate) => candidate.command === command) ?? null;
}

export function executableCandidateContext(
  env: NodeJS.ProcessEnv = process.env,
): ExecutableCandidateContext {
  return {
    env,
    home: env.HOME?.trim() || homedir(),
    platform: process.platform,
  };
}
