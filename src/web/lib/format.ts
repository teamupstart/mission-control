import type { Session, SessionState } from "@shared/types.ts";

export function relativeTime(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact elapsed-since duration, e.g. "up 2h", "up 3m", "up 12s". */
export function uptime(startedAt: number | null): string {
  if (!startedAt) return "";
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (s < 60) return `up ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `up ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `up ${h}h`;
  return `up ${Math.floor(h / 24)}d`;
}

export type ContextTone = "ok" | "warn" | "high";

/**
 * Meter tone as the context window fills: calm until 70%, amber approaching the
 * auto-compact zone, red once nearly full - so a card telegraphs context pressure
 * before the agent has to compact.
 */
export function contextTone(pct: number | null | undefined): ContextTone {
  if (pct == null) return "ok";
  if (pct >= 90) return "high";
  if (pct >= 70) return "warn";
  return "ok";
}

/** Compact token count for the context tooltip: 1499 -> "1k", 128000 -> "128k". */
export function compactTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

export function shortenCwd(cwd: string | null): string {
  if (!cwd) return "-";
  const home = "/Users/";
  let p = cwd;
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/").slice(1).join("/");
    p = "~/" + rest;
  }
  return p;
}

export type Tone = "working" | "idle" | "attention" | "exited" | "neutral";

export interface StateDisplay {
  label: string;
  tone: Tone;
}

/**
 * Map a session to a badge label + tone. Non-instrumented sessions can't report
 * precise state, so they render as a neutral "running" rather than pretending to
 * know whether the agent is busy or idle.
 */
export function stateDisplay(session: Session): StateDisplay {
  if (session.state === "exited") return { label: "exited", tone: "exited" };
  // A pending review always needs you, regardless of the agent's own state.
  if (session.pendingReviews > 0) {
    return { label: session.pendingReviews > 1 ? `${session.pendingReviews} to review` : "to review", tone: "attention" };
  }
  if (!session.instrumented) return { label: "running", tone: "neutral" };
  const map: Record<SessionState, StateDisplay> = {
    starting: { label: "starting", tone: "working" },
    working: { label: "working", tone: "working" },
    idle: { label: "idle", tone: "idle" },
    awaiting_input: { label: "needs input", tone: "attention" },
    awaiting_review: { label: "needs review", tone: "attention" },
    exited: { label: "exited", tone: "exited" },
  };
  return map[session.state];
}
