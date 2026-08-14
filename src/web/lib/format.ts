import { activePaneDialog } from "@shared/session.ts";
import type { AgentType, PermissionMode, Session, SessionState } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { canRename, type PaneHandles } from "@shared/pane.ts";

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * `relativeTime`'s forward-facing twin: how long until an instant that has not happened.
 *
 * A separate function rather than a sign branch inside `relativeTime`, because that one
 * clamps at zero and therefore reads every future stamp as "just now" - which is not a
 * rounding error but the exact wrong word for a mission due in three hours. Injectable
 * `now` for the same reason `relativeTime` has one: a render test cannot own the clock.
 * An instant already passed reads as "due", which is what a schedule the runner has not
 * picked up yet actually is.
 */
export function untilTime(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return "due";
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

/**
 * A conversation turn's compact local timestamp: the clock time alone.
 *
 * The transcript stores an instant, not a display zone. Mission Control is local software,
 * so the browser's locale and timezone are the useful default: the operator reads the time
 * in the same clock as the terminal beside it. Locale and zone stay injectable for tests.
 *
 * The date is deliberately absent. A transcript is read as one session's vertical run of
 * work, where the calendar date is the same on row after row and the clock is the only
 * part that separates them - so repeating "Jul 31" down the whole log spends width on the
 * one field that never distinguishes anything. The complete instant is never lost: the
 * long form below carries weekday, date, seconds, and zone, and it is what every row
 * exposes on hover and to assistive technology.
 */
const CONVERSATION_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
};

const CONVERSATION_TIMESTAMP_LONG_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
};

// The defaults are the production path and a transcript may hold hundreds of turns.
// Construct these once rather than rebuilding two ICU formatters for every row and frame.
const conversationTimestampFormatter = new Intl.DateTimeFormat(
  undefined,
  CONVERSATION_TIMESTAMP_OPTIONS,
);
const conversationTimestampLongFormatter = new Intl.DateTimeFormat(
  undefined,
  CONVERSATION_TIMESTAMP_LONG_OPTIONS,
);

export function formatConversationTimestamp(
  at: number,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  const formatter =
    locales === undefined && timeZone === undefined
      ? conversationTimestampFormatter
      : new Intl.DateTimeFormat(locales, {
          ...CONVERSATION_TIMESTAMP_OPTIONS,
          ...(timeZone ? { timeZone } : {}),
        });
  return formatter.format(at);
}

/** The complete local instant exposed when a compact conversation timestamp is inspected. */
export function formatConversationTimestampLong(
  at: number,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  const formatter =
    locales === undefined && timeZone === undefined
      ? conversationTimestampLongFormatter
      : new Intl.DateTimeFormat(locales, {
          ...CONVERSATION_TIMESTAMP_LONG_OPTIONS,
          ...(timeZone ? { timeZone } : {}),
        });
  return formatter.format(at);
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

/**
 * A byte count for a reader, in BINARY units.
 *
 * KiB/MiB/GiB rather than KB/MB/GB, because the only place these numbers are compared
 * against anything is the scout archive's limits, and those are specified and enforced in
 * binary units - 32 MiB for a report, 512 MiB for a whole bundle. Printing a 536,870,912
 * byte bundle as "537 MB" beside a "512 MiB" limit reads as a bundle comfortably under a
 * cap it has in fact exactly hit.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 so "1.2 MiB" keeps its precision, none above it so a rail of
  // sizes stays a column rather than a ragged edge.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
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
 * Lives in `@shared/cost.ts` and is re-exported here, unchanged, so the ~20 call sites that
 * already import it from this module keep working. It moved because the daemon now words a
 * sentence with money in it (the Line's Shipped stage) and there must be exactly one answer
 * to how a dollar is spelled.
 */
export { fmtUsd } from "@shared/cost.ts";

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

/**
 * The last path segment of a repo root, for its compact display name.
 *
 * One definition because every read-only repository label uses the directory name while the
 * full path stays in a tooltip or the accessible name of the surrounding control. Two repos
 * can share a basename (`~/a/api` and `~/b/api`), so the short form is presentation only and
 * never becomes repository identity.
 */
export function repoLeaf(repoRoot: string | null | undefined): string {
  if (!repoRoot) return "-";
  const trimmed = repoRoot.replace(/\/+$/, "");
  const leaf = trimmed.split("/").pop();
  return leaf && leaf.length > 0 ? leaf : trimmed;
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

/**
 * The complete name behind a session title that was shortened from its generated task title.
 *
 * A task's `fullTitle` must not replace a name the operator chose later, so the detail only
 * wins when the current session name still matches the task title (or the shortened stem the
 * task title starts with). Shared by Cards and Board so every title tooltip reveals the same
 * text while the visible heading remains bounded.
 */
export function sessionTitleDetail(session: Pick<Session, "name" | "task">): string {
  const taskTitle = session.task?.title;
  const fullTaskTitle = session.task?.fullTitle;
  const shortenedStem = session.name.endsWith("…") ? session.name.slice(0, -1) : null;
  return shortenedStem &&
      fullTaskTitle &&
      fullTaskTitle.length > session.name.length &&
      (taskTitle === session.name || taskTitle?.startsWith(shortenedStem))
    ? fullTaskTitle
    : session.name;
}

/**
 * The working directory as a shell prompt writes it: `~/leaf`, or bare `~` when the
 * session has no checkout at all.
 *
 * Returns the WHOLE displayed string rather than a leaf for a caller to prefix. That split
 * is what produced `~/~` on a session with no checkout - the fallback was already a `~` and
 * the renderer added another - and the only way to make that unrepresentable is for one
 * function to own the entire value.
 *
 * The leaf rather than the path `shortenCwd` gives, because this sits inline in a prompt
 * line the reader scans for the words after it: a worktree path is sixty characters of pool
 * bookkeeping, and the conversation's launcher strip already prints it in full.
 */
export function promptPath(cwd: string | null): string {
  const leaf = cwd ? (cwd.split("/").filter(Boolean).pop() ?? "") : "";
  return leaf ? `~/${leaf}` : "~";
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
 * Mirrors reportBucket's precedence (see src/shared/session.ts).
 */
export function stateDisplay(session: Session, interrupting = false): StateDisplay {
  if (session.state === "exited") return { label: "exited", tone: "exited" };
  if (session.state === "stopping") return { label: "stopping", tone: "working" };
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
  // The one label here that is not a reading: the operator's own stop, in flight. Held
  // client-side (`lib/interrupting.ts`) and retired by the next real reading or by its own
  // timeout, which is why it can sit here without a `SessionState` member behind it.
  //
  // Below everything above it on purpose - those all outrank it, and each for its own
  // reason. A session already exiting is past being interrupted; a review or a menu on the
  // screen is a thing needing a HUMAN, which is more urgent than the progress of a request
  // that human just made. Above the state map, because that is what it is a transient
  // stand-in for. And it keeps the `working` tone: the agent has not stopped yet, and
  // colouring it otherwise would claim a result that has not arrived.
  if (interrupting) return { label: "interrupting", tone: "working" };
  if (!session.stateConfirmed) {
    return { label: "running", tone: "neutral" };
  }
  const map: Record<SessionState, StateDisplay> = {
    starting: { label: "starting", tone: "working" },
    working: { label: "working", tone: "working" },
    idle: { label: "idle", tone: "idle" },
    awaiting_input: { label: "needs input", tone: "attention" },
    awaiting_review: { label: "needs review", tone: "attention" },
    stopping: { label: "stopping", tone: "working" },
    exited: { label: "exited", tone: "exited" },
  };
  return map[session.state];
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
  askForApproval: { label: "ask", tone: "default", title: "Ask for approval - Codex asks before leaving the workspace boundary" },
  approveForMe: { label: "approve", tone: "accept", title: "Approve for me - Codex auto-reviews potentially unsafe actions" },
  fullAccess: { label: "full access", tone: "bypass", title: "Full Access - Codex can edit outside the workspace and use the network" },
  readOnly: { label: "read only", tone: "plan", title: "Read Only - Codex can read the workspace but must ask before edits" },
};

/** How to render a session's permission mode, or null when it's unknown. */
export function permissionModeDisplay(mode: PermissionMode | null): PermissionModeDisplay | null {
  return mode ? MODE_DISPLAY[mode] : null;
}

/**
 * The modes the picker offers for an agent, in that harness's native control order: the
 * Shift+Tab cycle for Claude or the `/permissions` menu for Codex.
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
 * True when a session can be renamed: it needs somewhere a name can live (`canRename` - a
 * terminal handle, or the durable row behind an SDK session), and a session on its way out
 * has nothing left to name. Shared by the clickable card title, the command bar's keycap,
 * and the hotkey gate so the rule can't drift between them.
 *
 * The liveness half stays HERE rather than in `canRename` because it is a question about the
 * affordance, not about the name: the server refuses a rename it cannot land either way, and
 * offering a text box on a card that is already leaving is the part only the UI can be wrong
 * about.
 */
export function canRenameSession(
  s: PaneHandles & Pick<Session, "state" | "runtime">,
): boolean {
  return s.state !== "exited" && s.state !== "stopping" && canRename(s);
}
