import { run } from "../util/exec.ts";
import { normTty } from "./tty.ts";
import type { AgentType } from "@shared/types.ts";

export interface Proc {
  pid: number;
  ppid: number;
  /** tty normalized without /dev/ (e.g. "ttys012"), or null when not attached. */
  tty: string | null;
  /** Raw `lstart` string, used as a stable component of session identity. */
  startRaw: string;
  startMs: number;
  /** Full argv as reported by ps. */
  command: string;
  /** Which agent this process is, if any. */
  agent: AgentType | null;
  /**
   * True when `agent` was matched by a strong signature (the real `claude`/`codex`
   * binary), false when matched only as a wrapped token (`make claude`). Discovery
   * prefers native agents as the session's representative process, because a
   * launcher's cwd is where it was invoked, not where the agent actually runs.
   */
  agentNative: boolean;
}

/**
 * Commands that legitimately launch an agent as a sub-argument, e.g.
 * `make claude`, `docker exec ... claude`, `sh -c 'claude ...'`. Only when
 * argv0 is one of these do we treat a bare `claude`/`codex` token as an agent -
 * so an unrelated `git commit -m "fix claude bug"` is not misclassified.
 */
const WRAPPERS = new Set([
  "make", "docker", "sh", "bash", "zsh", "fish", "env", "npx", "npm", "pnpm",
  "yarn", "bun", "sudo", "ssh", "script", "timeout", "gtimeout", "nice",
  "stdbuf", "caffeinate", "tmux", "screen", "uv", "poetry", "direnv",
  "watchexec", "entr", "mise", "asdf",
]);

/**
 * Match a command against the *strong* signatures of a real agent process (the
 * actual `claude`/`codex` binary), seeing through the disguises: the `claude`
 * launcher re-execs a version-named binary (argv0 like `.../claude/versions/2.1.195`),
 * and `codex` is a node script (`node .../@openai/codex/bin/codex.js`). Returns
 * null for a wrapper invocation like `make claude` - that's a launcher, not the
 * agent itself (see `classifyAgent`).
 */
export function nativeAgent(command: string): AgentType | null {
  const argv0 = command.split(/\s+/, 1)[0] ?? "";
  const base = argv0.replace(/.*\//, "");

  // Strong claude signatures.
  if (
    base === "claude" ||
    argv0.endsWith("/claude") ||
    command.includes("/claude/versions/") ||
    command.includes("/.claude/local/") ||
    command.includes("@anthropic-ai/claude") ||
    command.includes("claude-code")
  ) {
    return "claude";
  }
  // Strong codex signatures.
  if (
    base === "codex" ||
    argv0.endsWith("/codex") ||
    command.includes("@openai/codex") ||
    command.includes("codex.js")
  ) {
    return "codex";
  }
  return null;
}

/**
 * Classify a process command as an agent: a strong native signature first, then
 * a bare token only when argv0 is a known wrapper (`make claude`, `sh -c codex`).
 * Callers that need to distinguish the two use `nativeAgent` directly.
 */
export function classifyAgent(command: string): AgentType | null {
  const native = nativeAgent(command);
  if (native) return native;
  // Wrapped invocation: trust a bare token only under a known launcher.
  const argv0 = command.split(/\s+/, 1)[0] ?? "";
  const base = argv0.replace(/.*\//, "");
  if (WRAPPERS.has(base)) {
    if (/(^|\s)claude(\s|$)/.test(command)) return "claude";
    if (/(^|\s)codex(\s|$)/.test(command)) return "codex";
  }
  return null;
}

/**
 * Claude Code's own background invocations, by the subcommand that names the role.
 * `mcp serve` is two tokens; the rest are one.
 *
 * APPEND-ONLY as new ones appear. Both directions of a mistake here are costly: a
 * form we miss becomes a phantom session in the dashboard, and a form we match too
 * eagerly makes a real agent silently disappear from it.
 */
const BACKGROUND_SUBCOMMANDS = new Set(["daemon", "bg-pty-host", "bg-spare", "mcp serve"]);

/**
 * The same roles again, as the flags the app bundle takes when it is spawned with no
 * subcommand at all (`.../ClaudeCode.app/Contents/MacOS/claude --bg-pty-host <sock>`).
 * Matched as a whole token in flag position, never as a substring.
 */
const BACKGROUND_FLAGS = new Set(["--bg-pty-host", "--bg-spare"]);

/**
 * Exclude background processes that carry an agent signature but are not interactive
 * sessions: `claude daemon run …`, `claude mcp serve`, and the pty-host / spare
 * workers Claude Code keeps alive beside a session. Interactive sessions are
 * additionally required to have a tty by the caller, but this catches the case
 * defensively.
 *
 * Decided over TOKENS against an explicit allowlist, never by searching the raw
 * string. A dispatched session's argv now carries a state-dir path (`--mcp-config
 * <MISSION_HOME>/ask-channel/mcp.json`) and the entire ~1.2KB inline redirect prompt
 * (`ask-channel.ts`), so any substring test hands the decision to text we do not
 * control: an operator whose `MISSION_HOME` is `~/daemon-state`, or one edit putting
 * the word "daemon" into that prompt's prose, would make every dispatched agent
 * undetectable. It would never bind to a session and would simply vanish.
 *
 * The workers were previously caught only by ACCIDENT - their socket path contains
 * `cc-daemon-501`, which satisfied a `\bdaemon\b` search of the whole line. Naming
 * them is what stops that accident from being load-bearing.
 *
 * Only argv[1] and argv[2] are ever looked at, because that is where every real form
 * declares its role and it is the one position no argument VALUE can occupy. Scanning
 * further would reopen the hole one rung up: a `claude -p '<prompt>'` whose prompt
 * merely quotes the token `--bg-pty-host` is prose, not a pty host, and was observed
 * matching a whole-argv token scan.
 */
export function isBackgroundAgent(command: string): boolean {
  const [, one, two] = command.split(/\s+/).filter(Boolean);
  if (one === undefined) return false;
  if (BACKGROUND_FLAGS.has(one) || BACKGROUND_SUBCOMMANDS.has(one)) return true;
  return two !== undefined && BACKGROUND_SUBCOMMANDS.has(`${one} ${two}`);
}

function parseStart(raw: string): number {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Snapshot every process on the system with pid/ppid/tty/start and full argv.
 *
 * Two `ps` passes because macOS `ps` has no field delimiter: pass A puts the
 * multi-token `lstart` at the tail (pid ppid tty are single tokens before it);
 * pass B puts the multi-token `command` at the tail. We join on pid.
 */
export async function listProcesses(): Promise<Proc[]> {
  const [a, b] = await Promise.all([
    run("ps", ["-Ao", "pid=,ppid=,tty=,lstart="]),
    run("ps", ["-Ao", "pid=,command="]),
  ]);

  const commands = new Map<number, string>();
  for (const line of b.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    commands.set(Number(m[1]), (m[2] ?? "").trim());
  }

  const procs: Proc[] = [];
  for (const line of a.stdout.split("\n")) {
    // pid ppid tty <lstart: Www Mmm DD HH:MM:SS YYYY>
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = commands.get(pid) ?? "";
    const detectable = command && !isBackgroundAgent(command);
    const agent = detectable ? classifyAgent(command) : null;
    procs.push({
      pid,
      ppid: Number(m[2]),
      tty: normTty(m[3] ?? ""),
      startRaw: (m[4] ?? "").trim(),
      startMs: parseStart((m[4] ?? "").trim()),
      command,
      agent,
      agentNative: detectable ? nativeAgent(command) !== null : false,
    });
  }
  return procs;
}
