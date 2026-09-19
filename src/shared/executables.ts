/**
 * Built-in executable identities.
 *
 * Append only. These ids appear in diagnostics and operator-facing configuration names.
 * A configurable subprocess integration belongs here before production code can invoke it.
 */
export const EXECUTABLE_IDS = [
  "claude",
  "codex",
  "pi",
  "gh",
  "git",
  "node",
  "npm",
  "jira",
  "conductor",
  "tmux",
  "herdr",
  "cmux",
  "wezterm",
  "ghostty",
  "iterm",
  "open",
  "xdg-settings",
  "gtk-launch",
  "xdg-open",
  "plutil",
  "ps",
  "lsof",
  "du",
  "treehouse",
] as const;

export type ExecutableId = (typeof EXECUTABLE_IDS)[number];

export const EXECUTABLE_SOURCE_IDS = [
  "operator-override",
  "supported-location",
  "operator-directory",
  "inherited-path",
  "login-shell",
  "version-manager",
  "os-default",
  // Ranks after every installed location, and must stay last: a package manager puts its
  // `node_modules/.bin` first on PATH, which is right for a build and wrong for choosing an
  // agent CLI. Searchable, not dropped - some tools live only there.
  "project-local",
  "runtime",
] as const;

export type ExecutableSourceId = (typeof EXECUTABLE_SOURCE_IDS)[number];

export const EXECUTABLE_SOURCE_LABELS: Record<ExecutableSourceId, string> = {
  "operator-override": "operator override",
  "supported-location": "supported application location",
  "operator-directory": "operator search directory",
  "inherited-path": "inherited PATH",
  "login-shell": "login shell",
  "version-manager": "version-manager location",
  "os-default": "operating-system default",
  "project-local": "project-local node_modules",
  runtime: "current runtime",
};

export interface ExecutableDiagnostic {
  id: ExecutableId;
  path: string | null;
  source: ExecutableSourceId | null;
  sourceDetail: string | null;
  generation: number;
  refreshedAt: string;
}
