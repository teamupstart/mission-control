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
