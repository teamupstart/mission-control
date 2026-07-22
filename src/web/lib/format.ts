import { activePaneDialog, runInFlight } from "@shared/session.ts";
import type { AgentType, NmRunSummary, PermissionMode, Session, SessionState } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { canWriteTo, type PaneHandles } from "@shared/pane.ts";

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

/**
 * Compact token count: 1499 -> "1k", 128000 -> "128k", 21_400_000 -> "21.4M".
 *
 * The decimal survives to 100M rather than to 10M because the fleet's daily total lives
 * up there and moves all day: dropped at 10M it would tick 21M -> 22M in steps of a
 * million, which reads as a figure that has stopped responding. Above 100M the decimal is
 * past the precision anyone acts on.
 */
export function compactTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

/**
 * A dollar figure for a chip: `$0.42`, `$12.40`, `$1,204`.
 *
 * Cents are dropped past three figures because they stop being information there - the
 * estimate's own error bar is wider than a cent by then, and the extra glyphs cost room
 * on the tightest surfaces. Below a cent reads as `<$0.01` rather than `$0.00`, since a
 * session that has spent SOMETHING and one that has spent nothing are different states
 * and the second one renders no chip at all.
 */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "-";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  if (usd >= 1000) return "$" + Math.round(usd).toLocaleString("en-US");
  return "$" + usd.toFixed(2);
}

/**
 * When a rate-limit window rolls over, as a short "in 2h 40m".
 *
 * The reset time is the actionable half of a rate limit - "83% used" means something
 * different an hour before the window turns over than five minutes before - so the meter
 * says both. Epoch SECONDS in, because that is the unit Claude sends.
 */
export function untilReset(resetsAtSeconds: number): string {
  const ms = resetsAtSeconds * 1000 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/**
 * A projected runway as "~41 min" / "~2h 10m".
 *
 * The tilde is part of the string rather than markup around it because the approximation
 * is a property of the figure, not of where it is drawn: this is an average extrapolated
 * forward (see `projectRunway`), and every surface that prints it owes the reader that.
 * Under a minute reads as "<1 min" - a runway that short is "stop now", and rounding it
 * to "0 min" would look like a bug rather than an alarm.
 */
export function fmtRunway(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "spent";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
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
 * Map a session to a badge label + tone. Sessions without a fresh lifecycle reading
 * render as a neutral "running" rather than pretending to know whether the agent is
 * busy or idle. A reading may come from hooks or from an explicit lifecycle marker in
 * the harness transcript (Codex rollout files provide the latter).
 *
 * Mirrors reportBucket's precedence (see src/shared/session.ts): a session whose
 * agent backgrounded a no-mistakes run and ended its turn reads "validating"
 * rather than "idle", both because it isn't idle and because the badge would
 * otherwise contradict the run's live progress in the strip right below it. The
 * strip already brands itself "no-mistakes", so the badge names the agent's own
 * state instead of repeating it.
 */
export function stateDisplay(session: Session, gateNeedsYou: boolean): StateDisplay {
  if (session.state === "exited") return { label: "exited", tone: "exited" };
  // A pending review always needs you, regardless of the agent's own state.
  if (session.pendingReviews > 0) {
    return { label: session.pendingReviews > 1 ? `${session.pendingReviews} to review` : "to review", tone: "attention" };
  }
  // Above the state-confidence split on purpose. A menu on the screen is something we can
  // SEE, not something a hook has to tell us, and it means the session has stopped dead -
  // so an uninstrumented session parked on a permission prompt belongs in "needs you"
  // rather than in "unconfirmed", where it read as merely unknown while being the most
  // definitively blocked session on the board. Mirrors `reportBucket`.
  if (activePaneDialog(session)) {
    return { label: "needs an answer", tone: "attention" };
  }
  // A parked no-mistakes gate is a cross-session decision: another session carrying
  // the same run may still be driving it. App computes that once with `gateParked` and
  // every layout passes the answer here. Keeping the boolean required makes a new
  // status surface choose deliberately instead of silently filing the gate as idle.
  if (gateNeedsYou) {
    return { label: "needs decision", tone: "attention" };
  }
  const validating: StateDisplay = { label: "validating", tone: "working" };
  if (!session.stateConfirmed) {
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

/** Outcomes that mean the run landed badly - the calm idle tone would misreport these. */
const FAILED_OUTCOMES = new Set(["failed", "cancelled", "canceled"]);

/**
 * The one step worth naming above the board tile's gate hairline.
 *
 * The hairline colours every step but names none, so "which stage is it at" is
 * unreadable without knowing the pipeline's order by heart. This picks the step a
 * glance should land on and dresses it in the same tone the segment carries, so the
 * word and the bar can't disagree. Precedence mirrors what you'd triage by: a failure
 * first, then a gate parked on your decision, then whatever is running, then - with
 * nothing in flight - the outcome if the run has landed, else the next step up. A run
 * that landed failed or cancelled keeps the danger tone; only a clean landing reads calm.
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

  // Parked on a decision: trust no-mistakes' own gateStep, but fall back to the parked
  // status when it names no step we hold. gateStep and steps[] are parsed from separate
  // blocks, so a name that doesn't place must not cost the tile its attention tone.
  const named = nm.gateStep ? nm.steps.findIndex((s) => s.step === nm.gateStep) : -1;
  const gated =
    named >= 0
      ? named
      : nm.steps.findIndex((s) => s.status === "awaiting_approval" || s.status === "fix_review");
  if (gated >= 0) return at(gated, "attention");

  const running = nm.steps.findIndex((s) => s.status === "running");
  if (running >= 0) return at(running, "working");

  // Nothing in flight: the run has either landed, or is between steps.
  if (nm.outcome) {
    const tone = FAILED_OUTCOMES.has(nm.outcome.toLowerCase()) ? "danger" : "idle";
    return { label: nm.outcome, pos: total || null, total, tone, done: true };
  }
  // The frontier is the first step still owing work. Counting settled steps would assume
  // they form a prefix, which `--step <name> --action skip` can break.
  const next = nm.steps.findIndex((s) => s.status !== "completed" && s.status !== "skipped");
  return next >= 0
    ? { label: nm.steps[next]!.step, pos: next + 1, total, tone: "working", done: false }
    : { label: nm.status || "queued", pos: null, total, tone: "working", done: false };
}

/** Card presentation for a permission mode: chip label, tone, tooltip. */
export interface PermissionModeDisplay {
  label: string;
  /** Suffix for the chip's tone class (`.mode-<tone>`). */
  tone: "default" | "accept" | "plan" | "bypass";
  title: string;
}

const MODE_DISPLAY: Record<PermissionMode, PermissionModeDisplay> = {
  default: { label: "manual", tone: "default", title: "Manual - the agent asks before edits and commands" },
  acceptEdits: { label: "accept edits", tone: "accept", title: "Accept edits - file edits apply without asking" },
  plan: { label: "plan", tone: "plan", title: "Plan mode - read-only; the agent plans before acting" },
  auto: { label: "auto", tone: "accept", title: "Auto - the agent proceeds autonomously" },
  dontAsk: { label: "don't ask", tone: "accept", title: "Don't ask - runs without prompting" },
  bypassPermissions: { label: "bypass", tone: "bypass", title: "Bypass permissions - all permission checks skipped" },
};

/** How to render a session's permission mode, or null when it's unknown. */
export function permissionModeDisplay(mode: PermissionMode | null): PermissionModeDisplay | null {
  return mode ? MODE_DISPLAY[mode] : null;
}

/**
 * The modes the picker offers for an agent, in that harness's own Shift+Tab cycle order -
 * the list reads in the same order as the keystroke it replaces.
 *
 * Empty for a harness with no `permissionModes` capability, which is also what makes the
 * picker draw nothing: one declaration (`@shared/harness-capabilities.ts`) answers both
 * "may this session's mode be driven at all" and "with which options", instead of a list
 * here and an `agent === "claude"` at every surface that renders it.
 */
export function pickableModes(agent: AgentType): readonly PermissionMode[] {
  return capabilitiesFor(agent).permissionModes?.pickable ?? [];
}

/**
 * True when a session can be renamed: renaming drives the terminal a session lives in, so
 * it needs a handle on one, and a dead session has nothing to rename. Shared by the
 * clickable card title, the command bar's keycap, and the hotkey gate so the rule can't
 * drift between them.
 */
export function canRenameSession(s: PaneHandles & Pick<Session, "state">): boolean {
  return s.state !== "exited" && canWriteTo(s);
}
