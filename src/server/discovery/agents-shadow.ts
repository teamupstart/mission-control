import type { Session, SessionState } from "../../shared/types.ts";
import { envVar } from "../config.ts";
import { unref } from "../util/timers.ts";
import type { Registry } from "../registry.ts";
import { agentsJsonState, readAgentsJson, type AgentsJsonRecord } from "./agents-json.ts";

// Run `claude agents --json` beside the real discovery sweep and record where the two
// disagree. Nothing here feeds the registry - this is measurement, not a second source of
// truth, and it is off unless someone turns it on.
//
// The point is to answer a question we cannot answer from the diff: a one-off sample on a
// developer machine joined 11 of 11 sessions by `sessionId` but agreed on state for only
// 7 of them. The join rate says the identity plumbing in correlate.ts is redundant; the
// agreement rate says the state is NOT a drop-in replacement. Some of that gap is sampling
// (the two readings are milliseconds apart and sessions transition), and some of it is
// probably our bugs - the first time this codebase has had a second opinion to check
// against. Logging it over days is how those get separated.

/**
 * How often to take a shadow reading. `0` (the default) disables it entirely.
 *
 * Off by default because a reading spawns the full `claude` binary, and this earns a
 * subprocess for nobody who is not actively investigating. Anything under 5s is clamped
 * up: `claude agents --json` measured 334-421ms per call, and a tighter loop would spend
 * a meaningful fraction of a core producing a log line nobody is reading.
 */
export const AGENTS_SHADOW_INTERVAL_MS = (() => {
  const raw = Number(envVar("AGENTS_SHADOW_MS") ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(raw, 5_000);
})();

/** One session the two views describe differently. */
export interface ShadowDisagreement {
  sessionId: string;
  pid: number | null;
  /** What Mission Control's own discovery believes. */
  mission: SessionState;
  /** What `claude agents --json` reports, mapped onto our vocabulary. */
  claude: SessionState;
  /** Claude's raw `waitingFor`, when it had one - the reason behind `awaiting_input`. */
  waitingFor: string | null;
}

export interface ShadowSummary {
  /** Sessions Mission Control is tracking, Claude-only (Codex has no equivalent CLI). */
  missionCount: number;
  /** Records `claude agents --json` returned. */
  claudeCount: number;
  /** Mission sessions matched to a Claude record by `agentSessionId`. */
  joined: number;
  /** Mission sessions with no matching Claude record. */
  unjoined: number;
  agree: number;
  disagree: number;
  /**
   * Joined, but not comparable: either Claude reported no `status`, or our state is one
   * Claude has no analogue for (`starting`, `awaiting_review`, `exited`). Counted rather
   * than hidden so `agree + disagree` is never mistaken for the whole population.
   */
  skipped: number;
  /** Claude records with no Mission Control session - sessions we are blind to. */
  claudeOnly: number;
  disagreements: ShadowDisagreement[];
}

/** States that exist only on our side, so a mismatch against them says nothing. */
const OUR_ONLY: ReadonlySet<SessionState> = new Set<SessionState>([
  "starting",
  "awaiting_review",
  "exited",
]);

/**
 * Compare the two views. Pure, so the interesting logic is testable without spawning a
 * binary or standing up a registry.
 *
 * Codex sessions are excluded up front: `claude agents --json` cannot see them, so
 * counting them as unjoined would report a permanent, meaningless deficit.
 */
export function compareAgents(
  sessions: readonly Session[],
  records: readonly AgentsJsonRecord[],
): ShadowSummary {
  const claudeSessions = sessions.filter((s) => s.agent === "claude");
  const byId = new Map<string, AgentsJsonRecord>();
  for (const rec of records) {
    if (rec.sessionId) byId.set(rec.sessionId, rec);
  }

  const summary: ShadowSummary = {
    missionCount: claudeSessions.length,
    claudeCount: records.length,
    joined: 0,
    unjoined: 0,
    agree: 0,
    disagree: 0,
    skipped: 0,
    claudeOnly: 0,
    disagreements: [],
  };

  const matched = new Set<string>();
  for (const s of claudeSessions) {
    const rec = s.agentSessionId ? byId.get(s.agentSessionId) : undefined;
    if (!rec) {
      summary.unjoined++;
      continue;
    }
    summary.joined++;
    matched.add(rec.sessionId!);
    const theirs = agentsJsonState(rec.status);
    if (theirs === null || OUR_ONLY.has(s.state)) {
      summary.skipped++;
      continue;
    }
    if (theirs === s.state) {
      summary.agree++;
      continue;
    }
    summary.disagree++;
    summary.disagreements.push({
      sessionId: s.agentSessionId!,
      pid: s.pid ?? null,
      mission: s.state,
      claude: theirs,
      waitingFor: rec.waitingFor ?? null,
    });
  }

  for (const rec of records) {
    if (!rec.sessionId || !matched.has(rec.sessionId)) summary.claudeOnly++;
  }

  return summary;
}

/** One line of summary, plus one per disagreement. */
export function formatShadowSummary(s: ShadowSummary): string[] {
  const lines = [
    `[agents-shadow] mission=${s.missionCount} claude=${s.claudeCount} ` +
      `joined=${s.joined} unjoined=${s.unjoined} ` +
      `agree=${s.agree} disagree=${s.disagree} skipped=${s.skipped} ` +
      `claude-only=${s.claudeOnly}`,
  ];
  for (const d of s.disagreements) {
    const why = d.waitingFor ? ` waitingFor=${JSON.stringify(d.waitingFor)}` : "";
    lines.push(
      `[agents-shadow]   sid=${d.sessionId.slice(0, 8)} pid=${d.pid ?? "-"} ` +
        `mission=${d.mission} claude=${d.claude}${why}`,
    );
  }
  return lines;
}

/**
 * Start the shadow reader. A no-op returning a no-op when the interval is 0, so the
 * daemon's start-up path does not need to know whether the feature is on.
 */
export function startAgentsShadow(registry: Registry): () => void {
  if (AGENTS_SHADOW_INTERVAL_MS <= 0) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const records = await readAgentsJson();
      // null is "could not read", which must not be reported as "every session vanished".
      if (records) {
        for (const line of formatShadowSummary(compareAgents(registry.snapshot().sessions, records))) {
          console.log(line);
        }
      }
    } catch (err) {
      console.error("[agents-shadow] reading failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, AGENTS_SHADOW_INTERVAL_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
