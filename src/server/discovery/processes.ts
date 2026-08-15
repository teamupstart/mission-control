import { run } from "../util/exec.ts";
import { normTty } from "./tty.ts";
import { allHarnesses, harnessFor } from "../harness/index.ts";
import type { Harness } from "../harness/types.ts";
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
 * argv0 is one of these do we treat a bare `claude`/`codex`/`pi` token as an agent -
 * so an unrelated `git commit -m "fix claude bug"` is not misclassified.
 *
 * Terminal MULTIPLEXERS are deliberately NOT here (`tmux`, `screen`), and the Phase 5 `pi`
 * harness is why the omission is load-bearing rather than incidental. An agent running inside
 * tmux/screen ALWAYS also appears as its own NATIVE process on the pane's tty (its real binary,
 * or a `process.title` like pi's), so the wrapped match over the multiplexer's command line
 * buys no real detection - it only adds false-positive surface, because a multiplexer command
 * carries an arbitrary SESSION NAME: `tmux attach -t "P5 pi harness adapter"` has `pi` as a
 * space-delimited word and was carded as a phantom pi session. The risk is symmetric for every
 * agent (`tmux attach -t "fix claude bug"`), but pi's short, common name makes it routine
 * rather than rare - the same "a short token in text nobody controls" hazard `BackgroundSpec`
 * documents, one layer up. `test/detection.test.ts` pins that a multiplexer command carrying an
 * agent token is not a session.
 */
const WRAPPERS = new Set([
  "make", "docker", "sh", "bash", "zsh", "fish", "env", "npx", "npm", "pnpm",
  "yarn", "bun", "sudo", "ssh", "script", "timeout", "gtimeout", "nice",
  "stdbuf", "caffeinate", "uv", "poetry", "direnv",
  "watchexec", "entr", "mise", "asdf",
]);

/**
 * Bare-token matchers, one per command any harness declares, compiled once.
 *
 * At module load rather than per line because `listProcesses` walks every process on the
 * machine on each discovery tick, and `new RegExp` in that loop would be a per-harness tax
 * on every one of them.
 */
const WRAPPED_TOKENS: ReadonlyArray<readonly [AgentType, RegExp]> = allHarnesses().flatMap((h) =>
  h.detect.commands.map(
    (name) => [h.id, new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`)] as const,
  ),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a command turned out to be: which harness, and whether it is the real binary. */
interface AgentMatch {
  agent: AgentType;
  native: boolean;
}

/** A command's harness, before asking whether this particular invocation is a session. */
interface HarnessMatch {
  harness: Harness;
  native: boolean;
}

/**
 * Which harness (if any) a command's SIGNATURE belongs to, and how strongly.
 *
 * The signatures are each harness's own (`detect`, `harness/<agent>/detect.ts`) rather than
 * a literal list here, so a new harness is discovered by declaring itself instead of by
 * editing this file. What stays is the part that is genuinely agent-agnostic: `WRAPPERS`,
 * and the native-before-wrapped preference the caller depends on (see `chooseAgentRoot` in
 * `correlate.ts` - a launcher's cwd is where it was invoked, not where the agent runs).
 *
 * Says nothing about whether the process is a session - `isBackgroundAgent` is that
 * question, and it needs this answer first to know whose vocabulary to ask with.
 */
function harnessOf(command: string): HarnessMatch | null {
  if (!command) return null;
  const argv0 = command.split(/\s+/, 1)[0] ?? "";
  const base = argv0.replace(/.*\//, "");

  for (const h of allHarnesses()) {
    const strong =
      h.detect.commands.includes(base) ||
      h.detect.argvSignatures.some((sig) => command.includes(sig));
    if (strong) return { harness: h, native: true };
  }
  // Wrapped invocation: trust a bare token only under a known launcher.
  if (!WRAPPERS.has(base)) return null;
  for (const [agent, token] of WRAPPED_TOKENS) {
    if (token.test(command)) return { harness: harnessFor(agent), native: false };
  }
  return null;
}

/**
 * The harness a process is a live session OF, or null.
 *
 * A background role resolves to null rather than falling through to the next harness: the
 * command has already been identified, and the only question left was whether it is a
 * session.
 */
function matchAgent(command: string): AgentMatch | null {
  const found = harnessOf(command);
  if (!found || !isSession(found.harness, command)) return null;
  return { agent: found.harness.id, native: found.native };
}

/**
 * Match a command against the *strong* signatures of a real agent process (the actual
 * `claude`/`codex` binary), seeing through the disguises each harness declares: the
 * `claude` launcher re-execs a version-named binary (argv0 like
 * `.../claude/versions/2.1.195`), and `codex` is a node script
 * (`node .../@openai/codex/bin/codex.js`). Returns null for a wrapper invocation like
 * `make claude` - that's a launcher, not the agent itself (see `classifyAgent`).
 */
export function nativeAgent(command: string): AgentType | null {
  const m = matchAgent(command);
  return m?.native ? m.agent : null;
}

/**
 * Classify a process command as an agent: a strong native signature first, then
 * a bare token only when argv0 is a known wrapper (`make claude`, `sh -c codex`).
 * Callers that need to distinguish the two use `nativeAgent` directly.
 */
export function classifyAgent(command: string): AgentType | null {
  return matchAgent(command)?.agent ?? null;
}

/**
 * Whether a command is one of its harness's own background roles rather than somebody's
 * session: `claude daemon run …`, `claude mcp serve`, and the pty-host / spare workers
 * Claude Code keeps alive beside a session. Interactive sessions are additionally required
 * to have a tty by the caller, but this catches the case defensively.
 *
 * The vocabulary is the harness's (`detect.background`), so this asks the question of
 * whichever harness the command turns out to belong to, and answers false for a command
 * that is no harness's at all. It was one GLOBAL list consulted before classification,
 * which meant Claude Code's `bg-pty-host` was tried against every process on the machine -
 * fine with two harnesses, and the way one vendor's exclusion starts hiding another
 * vendor's sessions with three. What it decides for a real Claude line is unchanged, and
 * `process-background-filter.test.ts` pins that against verbatim `ps` output.
 *
 * Decided over TOKENS against the declared roles, never by searching the raw string. A
 * dispatched session's argv carries a state-dir path (`--mcp-config
 * <MISSION_HOME>/ask-channel/mcp.json`) and the entire ~1.2KB inline redirect prompt
 * (`ask-channel.ts`), so any substring test hands the decision to text we do not control:
 * an operator whose `MISSION_HOME` is `~/daemon-state`, or one edit putting the word
 * "daemon" into that prompt's prose, would make every dispatched agent undetectable. It
 * would never bind to a session and would simply vanish.
 *
 * Only argv[1] and argv[2] are ever looked at, because that is where every real form
 * declares its role and it is the one position no argument VALUE can occupy. Scanning
 * further would reopen the hole one rung up: a `claude -p '<prompt>'` whose prompt merely
 * quotes the token `--bg-pty-host` is prose, not a pty host, and was observed matching a
 * whole-argv token scan.
 */
export function isBackgroundAgent(command: string): boolean {
  const found = harnessOf(command);
  return found ? !isSession(found.harness, command) : false;
}

/** The role check itself, against one harness's declared vocabulary. */
function isSession(h: Harness, command: string): boolean {
  const { subcommands, flags } = h.detect.background;
  const [, one, two] = command.split(/\s+/).filter(Boolean);
  if (one === undefined) return true;
  if (flags.includes(one) || subcommands.includes(one)) return false;
  return !(two !== undefined && subcommands.includes(`${one} ${two}`));
}

function parseStart(raw: string): number {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Every pid in the daemon's own subtree - the processes we spawned, which are therefore
 * nobody's session.
 *
 * A session is somebody ELSE's agent that we found. An agent we started ourselves is an
 * implementation detail of a card that already exists, and carding it a second time is a
 * duplicate of that card wearing whatever name its surroundings happen to supply. The
 * embedded (Agent SDK) runtime is where this bites: the vendor's `query()` owns the spawn,
 * so the CLI child inherits the daemon's controlling terminal, and a daemon started from a
 * terminal (`npm run dev`) hands its tty to every embedded session it launches. They then
 * all land on that one tty, collapse into a single phantom via `chooseAgentRoot`, and it is
 * named after whatever tab the daemon was started in.
 *
 * Both neighbouring spawn paths already defend the same ground from their own side, and
 * neither could cover this one: `claude-cli.ts` spawns headless runs `detached: true`
 * precisely "so the session poller never discovers this headless run as a phantom session",
 * and `sdk-deps.ts` strips `TMUX_PANE`/`WEZTERM_PANE`/`TERM_PROGRAM` so the daemon's pane is
 * not inherited by the subprocess's HOOKS. This is the third way in - the process table -
 * and it is answered here, once, for every current and future thing the daemon spawns.
 *
 * ANCESTRY, deliberately, rather than the two cheaper keys that would also have worked on
 * the machine this was found on. Not argv (`--output-format stream-json`): flag order and
 * spelling belong to the vendor, and `isBackgroundAgent` documents at length why deciding
 * this from a command line we do not control is how sessions silently vanish. Not "shares
 * the daemon's tty": that is a coincidence of dev mode, and it would hide a real operator
 * session that merely landed on the same tty. Descent is the fact we actually mean, and it
 * is one we own.
 *
 * Dispatched sessions are NOT in this set, which is what makes the rule safe: every backend
 * hands the launch to a mux server or a GUI (`tmux new-session -d`, `wezterm cli spawn`), so
 * a dispatched agent reparents away from us and is somebody else's child by the time it
 * matters. The daemon's siblings under a dev supervisor (the Electron shell, the Foreman
 * worker) are likewise untouched: they are not descendants.
 *
 * Walks DOWN from the daemon rather than up from each agent, so it is one pass over the
 * table regardless of how deep the tree is, and a parent cycle terminates on the visited set
 * instead of needing a hop cap.
 */
export function daemonOwnedPids(procs: Proc[], daemonPid: number = process.pid): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue; // a self-parented row would loop below
    const kids = children.get(p.ppid);
    if (kids) kids.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }

  const owned = new Set<number>();
  const stack = [daemonPid];
  while (stack.length > 0) {
    for (const kid of children.get(stack.pop()!) ?? []) {
      if (kid === daemonPid || owned.has(kid)) continue;
      owned.add(kid);
      stack.push(kid);
    }
  }
  return owned;
}

/**
 * Snapshot every process on the system with pid/ppid/tty/start and full argv.
 *
 * Two `ps` passes because macOS `ps` has no field delimiter: pass A puts the
 * multi-token `lstart` at the tail (pid ppid tty are single tokens before it);
 * pass B puts the multi-token `command` at the tail. We join on pid.
 */
export interface ProcessSnapshot {
  processes: Proc[];
  /** Non-null when either system-wide ps read did not produce a complete answer. */
  unknownReason: string | null;
}

/**
 * The process snapshot plus the health of the two underlying reads. Discovery may use the
 * partial rows, but destructive worktree decisions must treat `unknownReason` as a refusal.
 */
export async function listProcessesSnapshot(): Promise<ProcessSnapshot> {
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
    const match = matchAgent(command);
    procs.push({
      pid,
      ppid: Number(m[2]),
      tty: normTty(m[3] ?? ""),
      startRaw: (m[4] ?? "").trim(),
      startMs: parseStart((m[4] ?? "").trim()),
      command,
      agent: match?.agent ?? null,
      agentNative: match?.native ?? false,
    });
  }
  const failed = [a, b].find(
    (result) => result.code !== 0 || result.outcomeUnknown || result.overflowed,
  );
  return {
    processes: procs,
    unknownReason: failed
      ? `process listing failed: ${failed.stderr.trim() || `exit ${failed.code}`}`
      : null,
  };
}

export async function listProcesses(): Promise<Proc[]> {
  return (await listProcessesSnapshot()).processes;
}
