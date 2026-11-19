/**
 * The start-up banner (headless mode, spec 7.21, F17): three lines printed from the
 * `SessionStart` hook on a fresh startup. This is the only place banner text is written, and
 * every harness calls it with its own name, so Claude Code, Codex and Pi show the same banner.
 *
 * Pure and browser-safe. Names and brand colours come from the agent registry, never from a
 * branch on the harness. With `color` false the lines are plain ASCII with no escape
 * characters; with it true they use SGR colour codes only, and each line ends with a reset.
 * Every line is at most `BANNER_MAX_COLUMNS` columns in both versions, because a hook cannot
 * read the terminal's width.
 */
import { AGENT_IDENTITY } from "./agent.ts";
import { DISPATCH_COMMAND } from "./home-dispatch.ts";
import type { AgentType } from "./types.ts";

export const BANNER_MAX_COLUMNS = 72;

/** The line-3 text a version mismatch shows instead of the counts (7.3). */
export const BANNER_VERSION_MISMATCH = "hook and daemon versions differ | run mctl doctor";

export const BANNER_MENU_HINT = "I will ask how you want to start";
export const BANNER_COMMAND_HINT = `${DISPATCH_COMMAND} opens the menu`;

/** Single-width marks, so the layout never shifts. Chosen here (Q12); the plain version has none. */
const MISSION_CONTROL_MARK = "◆"; // black diamond
const MISSION_CONTROL_ACCENT = "#3dd6c6";
const HARNESS_MARKS: Record<AgentType, string> = {
  claude: "✻", // teardrop-spoked asterisk
  codex: "●", // black circle
  pi: "π", // greek small letter pi
};

export interface BannerInput {
  harness: AgentType;
  /** The status line segment's numbers for the session's repository (7.12). */
  counts: { running: number; waiting: number };
  /** Whether the launcher menu will be offered on this session (7.4). */
  menuOffered: boolean;
  versionMismatch: boolean;
  color: boolean;
}

const RESET = "\u001b[0m";

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

function statusText(input: BannerInput): string {
  if (input.versionMismatch) return BANNER_VERSION_MISMATCH;
  const { running, waiting } = input.counts;
  const counts = running === 0 && waiting === 0 ? "nothing running" : `${running} running | ${waiting} waiting on you`;
  return `${counts} | ${input.menuOffered ? BANNER_MENU_HINT : BANNER_COMMAND_HINT}`;
}

/** The three banner lines. Join them with `\n` for the hook's `systemMessage`. */
export function dispatchBanner(input: BannerInput): [string, string, string] {
  const identity = AGENT_IDENTITY[input.harness];
  const tagline = `${identity.label} x Mission Control`;
  const status = statusText(input);
  if (!input.color) {
    return [`| MC Mission Control | ${identity.label}`, `| ${tagline}`, `| ${status}`];
  }
  const bar = "┃"; // box drawing heavy vertical
  const mc = rgb(MISSION_CONTROL_ACCENT);
  const agent = rgb(identity.accent);
  return [
    `${mc}${bar} ${MISSION_CONTROL_MARK} Mission Control${RESET} ${agent}${HARNESS_MARKS[input.harness]} ${identity.label}${RESET}`,
    `${mc}${bar}${RESET} ${tagline}${RESET}`,
    `${mc}${bar}${RESET} ${status}${RESET}`,
  ];
}

/** Visible columns of a line: escape sequences take none. */
export function bannerWidth(line: string): number {
  // eslint-disable-next-line no-control-regex
  return [...line.replace(/\u001b\[[0-9;]*m/g, "")].length;
}
