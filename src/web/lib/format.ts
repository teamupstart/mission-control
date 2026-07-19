import { runInFlight } from "@shared/session.ts";
import type { NmRunSummary, PermissionMode, Session, SessionState } from "@shared/types.ts";

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

/**
 * A span of time for a ticking clock: "42s", "3m 07s", "2h 09m". Always carries
 * two units once past a minute, and zero-pads the smaller one, so the text neither
 * changes width nor stalls between ticks the way a rounded "3m" would.
 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
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
 *
 * Mirrors reportBucket's precedence (see src/shared/session.ts): a session whose
 * agent backgrounded a no-mistakes run and ended its turn reads "validating"
 * rather than "idle", both because it isn't idle and because the badge would
 * otherwise contradict the run's live progress in the strip right below it. The
 * strip already brands itself "no-mistakes", so the badge names the agent's own
 * state instead of repeating it.
 */
export function stateDisplay(session: Session): StateDisplay {
  if (session.state === "exited") return { label: "exited", tone: "exited" };
  // A pending review always needs you, regardless of the agent's own state.
  if (session.pendingReviews > 0) {
    return { label: session.pendingReviews > 1 ? `${session.pendingReviews} to review` : "to review", tone: "attention" };
  }
  const validating: StateDisplay = { label: "validating", tone: "working" };
  if (!session.instrumented) {
    return runInFlight(session) ? validating : { label: "running", tone: "neutral" };
  }
  const map: Record<SessionState, StateDisplay> = {
    starting: { label: "starting", tone: "working" },
    working: { label: "working", tone: "working" },
    idle: runInFlight(session) ? validating : { label: "idle", tone: "idle" },
    awaiting_input: { label: "needs input", tone: "attention" },
    awaiting_review: { label: "needs review", tone: "attention" },
    exited: { label: "exited", tone: "exited" },
  };
  return map[session.state];
}

export interface GateStepView {
  /** The step to name above the tile's hairline, e.g. "review" - or the outcome once landed. */
  label: string;
  /** 1-based position of that step in the pipeline, or null when it can't be placed. */
  pos: number | null;
  /** How many steps the pipeline has. */
  total: number;
  /** Tone for the label - the same scale the hairline segment carries. */
  tone: "working" | "attention" | "idle" | "danger";
  /** True once the run has finished cleanly (label is the outcome, not a step). */
  done: boolean;
}

/**
 * The one step worth naming above the board tile's gate hairline.
 *
 * The hairline colours every step but names none, so "which stage is it at" is
 * unreadable without knowing the pipeline's order by heart. This picks the step a
 * glance should land on and dresses it in the same tone the segment carries, so the
 * word and the bar can't disagree. Precedence mirrors what you'd triage by: a failure
 * first, then a gate parked on your decision, then whatever is running, then - with
 * nothing in flight - the outcome if the run has landed, else the next step up.
 *
 * Pure, so the rule is tested without a DOM (see gate-step-view.test.ts).
 */
export function gateStepView(nm: NmRunSummary): GateStepView {
  const total = nm.steps.length;
  const at = (i: number, tone: GateStepView["tone"]): GateStepView => ({
    label: nm.steps[i]!.step,
    pos: i + 1,
    total,
    tone,
    done: false,
  });

  const failed = nm.steps.findIndex((s) => s.status === "failed");
  if (failed >= 0) return at(failed, "danger");

  // Parked on a decision: trust no-mistakes' own gateStep, falling back to the parked status.
  const gated = nm.gateStep
    ? nm.steps.findIndex((s) => s.step === nm.gateStep)
    : nm.steps.findIndex((s) => s.status === "awaiting_approval" || s.status === "fix_review");
  if (gated >= 0) return at(gated, "attention");

  const running = nm.steps.findIndex((s) => s.status === "running");
  if (running >= 0) return at(running, "working");

  // Nothing in flight: the run has either landed, or is between steps.
  if (nm.outcome) return { label: nm.outcome, pos: total || null, total, tone: "idle", done: true };
  const settled = nm.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  const next = nm.steps[settled];
  return next
    ? { label: next.step, pos: settled + 1, total, tone: "working", done: false }
    : { label: nm.status, pos: null, total, tone: "working", done: false };
}

/** Card presentation for a Claude permission mode: chip label, tone, tooltip. */
export interface PermissionModeDisplay {
  label: string;
  /** Suffix for the chip's tone class (`.mode-<tone>`). */
  tone: "default" | "accept" | "plan" | "bypass";
  title: string;
}

const MODE_DISPLAY: Record<PermissionMode, PermissionModeDisplay> = {
  default: { label: "manual", tone: "default", title: "Manual - Claude asks before edits and commands" },
  acceptEdits: { label: "accept edits", tone: "accept", title: "Accept edits - file edits apply without asking" },
  plan: { label: "plan", tone: "plan", title: "Plan mode - read-only; Claude plans before acting" },
  auto: { label: "auto", tone: "accept", title: "Auto - Claude proceeds autonomously" },
  dontAsk: { label: "don't ask", tone: "accept", title: "Don't ask - runs without prompting" },
  bypassPermissions: { label: "bypass", tone: "bypass", title: "Bypass permissions - all permission checks skipped" },
};

/** How to render a session's permission mode, or null when it's unknown. */
export function permissionModeDisplay(mode: PermissionMode | null): PermissionModeDisplay | null {
  return mode ? MODE_DISPLAY[mode] : null;
}

/**
 * The modes the picker offers, in Claude's own Shift+Tab cycle order - the list
 * reads in the same order as the keystroke it replaces.
 *
 * `dontAsk` is deliberately absent: it's settable only at startup and Shift+Tab
 * never reaches it, so offering it would promise a walk that can't arrive. It
 * still renders on the chip when a session was started in it.
 *
 * `bypassPermissions` and `auto` are listed but aren't available everywhere -
 * they enter the cycle only behind a launch flag / account support the daemon
 * can't see. Picking one the session lacks is harmless: the walk goes all the way
 * around, lands back where it started, and says so.
 */
export const PICKABLE_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
];

/**
 * True when a session can be renamed: renaming drives its tmux session / wezterm
 * tab, so it needs one of those handles, and a dead session has nothing to rename.
 * Shared by the clickable card title, the command bar's keycap, and the hotkey gate
 * so the rule can't drift between them.
 */
export function canRenameSession(s: Pick<Session, "state" | "tmux" | "wezterm">): boolean {
  return s.state !== "exited" && Boolean(s.tmux || s.wezterm);
}
