import type { SessionState } from "../../shared/types.ts";
import { resolveAgentBin } from "../config.ts";
import { run } from "../util/exec.ts";

// `claude agents --json` is Claude Code's own answer to the question this whole
// discovery directory exists to answer: which agents are alive, where, and what is each
// one doing right now. It reports `pid`, `sessionId`, `cwd`, `status` and `waitingFor`
// for every live session - background AND interactive, including ones a human started by
// hand in a terminal.
//
// That overlaps three things we derive the hard way: the `ps`/tty/pane correlation in
// correlate.ts, the footer-glyph parse in pane-mode.ts, and the `waiting for your input`
// notification heuristic in registry.ts. It is not wired into discovery, and this module
// does not wire it in. It exists so `agents-shadow.ts` can run it BESIDE the real sweep
// and record where the two disagree, because a measurement taken on this machine put
// state agreement at 7 of 11 - a straight swap would change behaviour in ways nobody has
// characterised yet.
//
// `claude agents --help` states the flag "does not require a TTY", which is what makes it
// callable from a daemon at all. It is not in the published CLI reference, so treat it as
// observable rather than promised: every failure path here degrades to "no reading", never
// to a wrong reading.

/**
 * One record from `claude agents --json`.
 *
 * Only `id` is treated as structurally required; everything else is optional because
 * this is an unpublished shape and a record missing a field must not poison the batch.
 * `status` is absent on records the daemon has not heard from recently, which is a real
 * and frequent case - not an error.
 */
export interface AgentsJsonRecord {
  /** Short id, the first segment of `sessionId`. */
  id: string;
  /** Full session UUID - the join key against `Session.agentSessionId`. */
  sessionId?: string;
  cwd?: string;
  /** `background` for `claude --bg`, `interactive` for a session with a terminal. */
  kind?: string;
  pid?: number;
  name?: string;
  /** `idle` | `busy` | `waiting`, or absent. */
  status?: string;
  /** e.g. `permission prompt`, `input needed`. Only present alongside `waiting`. */
  waitingFor?: string;
  startedAt?: number;
}

/**
 * Map Claude's `status` onto our `SessionState`.
 *
 * Returns null for anything we cannot map, which is the honest answer for a record with
 * no `status` at all. Note the asymmetry: `starting`, `awaiting_review` and `exited` are
 * OURS - `awaiting_review` is a Foreman concept Claude has no way to know about - so this
 * mapping is deliberately one-directional and the comparison treats our-only states as
 * incomparable rather than as disagreements.
 */
export function agentsJsonState(status: string | undefined): SessionState | null {
  switch (status) {
    case "idle":
      return "idle";
    case "busy":
      return "working";
    case "waiting":
      return "awaiting_input";
    default:
      return null;
  }
}

/**
 * Parse the command's stdout.
 *
 * Never throws: a malformed payload yields `null` ("could not read"), which the caller
 * must not confuse with `[]` ("read fine, nothing running"). Collapsing those two would
 * make a broken CLI look like every session having vanished at once.
 */
export function parseAgentsJson(stdout: string): AgentsJsonRecord[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: AgentsJsonRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : undefined;
    // A record with neither id nor sessionId cannot be joined or reported on, so it is
    // noise rather than data. Keep one that has only sessionId by deriving the short id,
    // since sessionId is the field that actually matters here.
    if (!id && !sessionId) continue;
    out.push({
      id: id ?? sessionId!.slice(0, 8),
      sessionId,
      cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
      kind: typeof rec.kind === "string" ? rec.kind : undefined,
      pid: typeof rec.pid === "number" ? rec.pid : undefined,
      name: typeof rec.name === "string" ? rec.name : undefined,
      status: typeof rec.status === "string" ? rec.status : undefined,
      waitingFor: typeof rec.waitingFor === "string" ? rec.waitingFor : undefined,
      startedAt: typeof rec.startedAt === "number" ? rec.startedAt : undefined,
    });
  }
  return out;
}

/**
 * Run `claude agents --json` and parse it. `null` on any failure.
 *
 * The timeout is generous relative to the ~340ms measured on a warm machine because this
 * runs on its own slow interval, never on the 1.5s discovery tick: a slow reading is
 * worth waiting for, and a missed one costs only a gap in the shadow log.
 */
export async function readAgentsJson(
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<AgentsJsonRecord[] | null> {
  const bin = opts.bin ?? resolveAgentBin("claude");
  const res = await run(bin, ["agents", "--json"], { timeoutMs: opts.timeoutMs ?? 10_000 });
  if (res.code !== 0) return null;
  return parseAgentsJson(res.stdout);
}
