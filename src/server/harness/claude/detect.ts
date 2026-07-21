import type { DetectSpec } from "../types.ts";

/**
 * Claude Code on the process table.
 *
 * The signatures are disguises observed in the wild, not guesses: the launcher re-execs
 * `~/.local/share/claude/versions/<version>`, a local install lives under
 * `~/.claude/local/`, and an npm install runs as
 * `node .../@anthropic-ai/claude-code/cli.js`. In none of those is argv0 `claude`.
 */
export const claudeDetect: DetectSpec = {
  commands: ["claude"],
  argvSignatures: ["/claude/versions/", "/.claude/local/", "@anthropic-ai/claude", "claude-code"],
  /**
   * Five real forms, every one of them verbatim from `ps` on a live machine (see
   * `process-background-filter.test.ts`): the daemon, the MCP server, and the pty-host /
   * spare workers Claude Code keeps beside a session - which appear both as a subcommand
   * and, when the app bundle is spawned with no subcommand, as the same word in flag
   * position. The workers were once caught only by ACCIDENT, because their socket path
   * contains `cc-daemon-501` and a whole-line search for `daemon` hit it. Naming them is
   * what stops that accident from being load-bearing.
   */
  background: {
    subcommands: ["daemon", "bg-pty-host", "bg-spare", "mcp serve"],
    flags: ["--bg-pty-host", "--bg-spare"],
  },
};
