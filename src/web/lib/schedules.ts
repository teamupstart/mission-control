import {
  cronFieldCount,
  normalizeCronExpression,
  type MissionSchedule,
  type ScheduleHealth,
  type ScheduleMissedPolicy,
  type ScheduleOccurrence,
  type ScheduleOccurrenceStatus,
  type ScheduleOverlapPolicy,
  type ScheduleTriggerKind,
} from "@shared/schedules.ts";

/**
 * Presentation-only helpers for the Scheduled Catalog.
 *
 * The hard line this module holds: it does NO date math and NO policy. Cron enumeration,
 * DST calculation, missed-run policy, and health thresholds are ALL server-owned
 * (`src/server/schedules/*`), and the daemon hands the browser finished answers -
 * `schedule.health`, `schedule.nextRunAt`, a preview's instants, an occurrence's
 * `decisionKind`. What lives here is the other half: turning those answers into the words
 * and CSS tones the catalog paints, plus the deterministic preset <-> cron-string mapping
 * the editor uses so a human never has to type `0 8 * * 1`.
 *
 * Formatting a returned epoch for display (`Intl.DateTimeFormat`) is not date math - the
 * instant was computed on the server; the browser only decides how to spell it. Building a
 * cron STRING from a preset is not recurrence enumeration either: it produces the same
 * `expression` the save route validates, and every semantic judgement about it still comes
 * back from `previewSchedule`. Nothing here decides WHEN anything runs.
 */

// ---- health / status tones ----

/** The catalog's status-pill class for a schedule's server-derived health. */
export function scheduleHealthTone(health: ScheduleHealth): string {
  return health;
}

/** A short, human sentence for each health reason, for the detail panel. */
export const SCHEDULE_HEALTH_REASON_LABELS: Record<string, string> = {
  "config-unreadable": "Its stored configuration cannot be read by this build",
  "no-next-run": "No next occurrence could be scheduled",
  overdue: "The next run is overdue beyond the grace window",
  "last-run-failed": "The most recent run failed",
  "stale-claim": "A reservation has been sitting unfinished long enough to mean a crash",
};

// ---- occurrence status vocabulary ----

interface OccurrenceStatusView {
  label: string;
  /** The status-pill tone class this occurrence paints with. */
  tone: "healthy" | "attention" | "paused" | "neutral";
}

/**
 * How each terminal (and the one non-terminal) occurrence status reads in history.
 *
 * `null` is a real input - a status this build has never heard of, written by a newer
 * daemon - and it reads as an explicit "unknown", never as a nearest match, the same
 * fail-closed rule the persisted enums hold on the server.
 */
export function occurrenceStatusView(
  status: ScheduleOccurrenceStatus | null,
): OccurrenceStatusView {
  switch (status) {
    case "created":
      return { label: "Created", tone: "healthy" };
    case "coalesced":
      return { label: "Coalesced", tone: "neutral" };
    case "skipped_overlap":
      return { label: "Skipped (active)", tone: "paused" };
    case "skipped_policy":
      return { label: "Skipped (policy)", tone: "paused" };
    case "failed":
      return { label: "Failed", tone: "attention" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "claimed":
      return { label: "Claimed", tone: "attention" };
    case null:
      return { label: "Unknown", tone: "attention" };
  }
}

/** History labels a run `scheduled` or `manual`; a value this build cannot read is "-". */
export function triggerKindLabel(kind: ScheduleTriggerKind | null): string {
  if (kind === "manual") return "Run now";
  if (kind === "scheduled") return "Scheduled";
  return "-";
}

export function overlapPolicyLabel(policy: ScheduleOverlapPolicy | null): string {
  if (policy === "skip-active") return "Skip if an earlier generated task is still active";
  if (policy === "allow") return "Create another backlog task regardless";
  return "Unreadable policy";
}

export function missedPolicyLabel(policy: ScheduleMissedPolicy | null): string {
  if (policy === "coalesce-latest") return "Coalesce to one task when Mission Control resumes";
  if (policy === "create-all") return "Create every missed task (newest 50 per catch-up)";
  if (policy === "skip") return "Skip every missed task";
  return "Unreadable policy";
}

// ---- time and delay formatting ----

/**
 * Format a UTC epoch in a schedule's own time zone.
 *
 * `Intl.DateTimeFormat` does the zone math for a KNOWN instant; the browser is not
 * enumerating anything. An unknown/invalid zone falls back to the runtime default rather
 * than throwing, because a schedule whose zone this build cannot resolve must still render.
 */
export function formatInstant(
  at: number,
  timezone: string | null,
  opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...opts,
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(at);
  }
}

/** A fuller "Monday, July 27 · 8:00 AM EDT" line for the detail panel's next occurrence. */
export function formatInstantLong(at: number, timezone: string | null): string {
  return formatInstant(at, timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** The UTC spelling of an instant, for the preview's UTC column. */
export function formatInstantUtc(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(at);
}

/** Compact local time for a generated task's provenance chip (browser zone). */
export function formatScheduledFor(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/**
 * How late a run was, in the catalog's own words.
 *
 * The delay is server-computed (`claimedAt - scheduledFor`); this only spells it. The
 * one-minute display band only keeps near-immediate claims from reading as late in history.
 * It is not the daemon's five-minute overdue health grace and does not decide health.
 */
export function formatDelay(delayMs: number): string {
  if (delayMs <= 60_000) return "on time";
  const totalMinutes = Math.round(delayMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return `${parts.join(" ") || "1m"} late`;
}

/** True when history should apply its display-only late tone. */
export function delayIsLate(delayMs: number): boolean {
  return delayMs > 60_000;
}

// ---- cadence labels ----

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** "8:00 AM" from a cron minute/hour pair. Falls back to the raw fields it cannot read. */
function clockLabel(minuteField: string, hourField: string): string | null {
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  const suffix = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * A human cadence for a five-field cron, best-effort.
 *
 * This is a LABEL, not a parser: it recognises the shapes the presets produce (daily,
 * weekdays, a single weekday, a day of the month) and hands anything else back its raw
 * expression rather than guessing. The server remains the only thing that VALIDATES or
 * ENUMERATES a cadence - a wrong label here is cosmetic, and the schedule still runs on
 * exactly what the daemon computed.
 */
export function cadenceLabel(expression: string): string {
  const normalized = normalizeCronExpression(expression);
  if (cronFieldCount(normalized) !== 5) return normalized || "-";
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = normalized.split(" ");
  const time = clockLabel(minute, hour);
  const anyDom = dom === "*";
  const anyDow = dow === "*";
  const anyMonth = month === "*";

  if (time && anyMonth) {
    if (anyDom && anyDow) return `Daily · ${time}`;
    if (anyDom && (dow === "1-5" || dow === "1,2,3,4,5")) return `Weekdays · ${time}`;
    if (anyDom && (dow === "0,6" || dow === "6,0" || dow === "0" || dow === "6")) {
      if (dow === "0") return `${WEEKDAY_PLURALS[0]} · ${time}`;
      if (dow === "6") return `${WEEKDAY_PLURALS[6]} · ${time}`;
      return `Weekends · ${time}`;
    }
    if (anyDom && /^[0-6]$/.test(dow)) return `${WEEKDAY_PLURALS[Number(dow)]} · ${time}`;
    if (anyDow && /^([1-9]|[12][0-9]|3[01])$/.test(dom)) {
      const ordinal = ordinalDay(Number(dom));
      return `Monthly on the ${ordinal} · ${time}`;
    }
  }
  return normalized;
}

function ordinalDay(day: number): string {
  const rem10 = day % 10;
  const rem100 = day % 100;
  if (rem10 === 1 && rem100 !== 11) return `${day}st`;
  if (rem10 === 2 && rem100 !== 12) return `${day}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${day}rd`;
  return `${day}th`;
}

// ---- search and filter ----

export type ScheduleCatalogFilter = "all" | "healthy" | "paused" | "attention";

/** Shorten a repo root to its last path segment for the catalog's tight columns. */
export function shortRepo(repoRoot: string | null | undefined): string {
  if (!repoRoot) return "-";
  const trimmed = repoRoot.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop();
  return seg && seg.length > 0 ? seg : trimmed;
}

/**
 * Does this schedule match the operator's free-text query?
 *
 * Name, task title, repo, agent, and labels - the fields the plan names - lower-cased and
 * substring-matched. A schedule whose template this build cannot read still matches on its
 * name so it can be found and fixed.
 */
export function scheduleMatchesQuery(schedule: MissionSchedule, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [
    schedule.name,
    schedule.template?.title,
    schedule.template?.repoRoot,
    schedule.template?.agent,
    ...(schedule.template?.labels ?? []),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function scheduleMatchesFilter(
  schedule: MissionSchedule,
  filter: ScheduleCatalogFilter,
): boolean {
  return filter === "all" || schedule.health === filter;
}

/** The catalog's ordering: attention first, then healthy, then paused; name breaks ties. */
export function sortSchedulesForCatalog(schedules: MissionSchedule[]): MissionSchedule[] {
  const rank: Record<ScheduleHealth, number> = { attention: 0, healthy: 1, paused: 2 };
  return [...schedules].sort((a, b) => {
    const byHealth = rank[a.health] - rank[b.health];
    if (byHealth !== 0) return byHealth;
    return a.name.localeCompare(b.name);
  });
}

// ---- editor presets ----

export type CadencePreset = "daily" | "weekdays" | "weekly" | "monthly" | "advanced";

export const CADENCE_PRESET_LABELS: Record<CadencePreset, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  advanced: "Advanced cron",
};

export interface CadenceForm {
  preset: CadencePreset;
  /** 0-6, Sunday..Saturday. Used by the weekly preset. */
  weekday: number;
  /** 1-31. Used by the monthly preset. */
  monthday: number;
  /** "HH:MM" wall-clock, used by every preset but advanced. */
  time: string;
  /** The raw five-field expression, used by (and kept in sync with) advanced. */
  expression: string;
}

function splitTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Build the five-field expression a preset stands for.
 *
 * Deterministic string assembly, nothing more: the same `expression` the save and preview
 * routes accept, so the daemon still gets the final say on whether it is valid and what it
 * enumerates. `advanced` passes the operator's raw string straight through.
 */
export function presetToExpression(form: CadenceForm): string {
  if (form.preset === "advanced") return normalizeCronExpression(form.expression);
  const time = splitTime(form.time);
  if (!time) return "";
  const { hour, minute } = time;
  switch (form.preset) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${form.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${form.monthday} * *`;
  }
}

/**
 * Best-effort inverse: recognise which preset an existing expression came from so the
 * editor can open on the right controls. Anything it does not recognise opens in Advanced
 * with the raw expression, which always round-trips.
 */
export function expressionToForm(expression: string): CadenceForm {
  const normalized = normalizeCronExpression(expression);
  const base: CadenceForm = {
    preset: "advanced",
    weekday: 1,
    monthday: 1,
    time: "08:00",
    expression: normalized,
  };
  if (cronFieldCount(normalized) !== 5) return base;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = normalized.split(" ");
  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || month !== "*") return base;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { ...base, preset: "daily", time };
  if (dom === "*" && (dow === "1-5" || dow === "1,2,3,4,5")) {
    return { ...base, preset: "weekdays", time };
  }
  if (dom === "*" && /^[0-6]$/.test(dow)) {
    return { ...base, preset: "weekly", weekday: Number(dow), time };
  }
  if (dow === "*" && /^([1-9]|[12][0-9]|3[01])$/.test(dom)) {
    return { ...base, preset: "monthly", monthday: Number(dom), time };
  }
  return base;
}

export function weekdayName(index: number): string {
  return WEEKDAY_NAMES[index] ?? String(index);
}

// ---- time zones ----

/** The browser's own IANA zone, used as the editor's default. */
export function browserTimezone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The IANA zones this browser knows, for the editor's picker.
 *
 * This is a NAME list, not recurrence math: the daemon still resolves and validates the
 * chosen zone. Falls back to a small common set where `Intl.supportedValuesOf` is absent.
 */
export function availableTimezones(): string[] {
  const withValues = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    const zones = withValues.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    // fall through to the common set
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
}

// ---- occurrence helpers ----

/**
 * A stable fingerprint of a schedule definition, so Save & enable can prove the preview
 * it is trusting describes the definition being saved.
 *
 * The plan's rule: a definition edit after a preview invalidates that preview, and Save &
 * enable must first obtain a SUCCESSFUL preview for the CURRENT definition. Comparing this
 * fingerprint is how "the preview I saw is the schedule I am enabling" becomes checkable
 * rather than assumed - a stale preview cannot approve changed data.
 */
export function scheduleDefinitionFingerprint(def: {
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: string;
  missedPolicy: string;
  template: {
    title: string;
    intent: string;
    repoRoot: string;
    kind: string;
    agent: string;
    priority: string | null;
    labels: string[];
    model: string | null;
    effort: string | null;
  };
}): string {
  return JSON.stringify([
    def.name,
    normalizeCronExpression(def.expression),
    def.timezone,
    def.overlapPolicy,
    def.missedPolicy,
    def.template.repoRoot.trim(),
    def.template.title.trim(),
    def.template.intent.trim(),
    def.template.kind,
    def.template.agent,
    def.template.priority,
    def.template.labels.join("\u0000"),
    def.template.model,
    def.template.effort,
  ]);
}

/** A generated task's short label for history, e.g. its id truncated. */
export function shortTaskId(taskId: string | null): string {
  if (!taskId) return "-";
  return taskId.length > 10 ? `${taskId.slice(0, 8)}…` : taskId;
}

/** True when an occurrence points at a live/created backlog task worth deep-linking. */
export function occurrenceHasTask(occ: ScheduleOccurrence): boolean {
  return occ.taskId !== null;
}
