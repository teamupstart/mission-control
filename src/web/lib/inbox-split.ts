import type { ReportItem } from "@shared/reports.ts";
import type { AttentionFold, AttentionItem } from "./attention.ts";
import type { SnoozedQuestion } from "./review-snooze.ts";
import { STUCK_RULE_LABELS } from "./stall-actions.ts";

/**
 * The unified split inbox (`inbox-split` preview flag): every row the inbox holds as one entry in
 * one list, so a detail pane can show the one that is selected and move on to the next when it
 * leaves. Pure: the component owns selection; this module owns what the list is and in what order.
 *
 * A row of several questions becomes one entry per question, and an author's reports one entry per
 * report, so each can be selected, answered and left on its own. The entry carries the item
 * narrowed to that one question or report, which is what the pane draws: the same card the stacked
 * inbox draws, holding one thing. Narrowing a row of questions also narrows its Dismiss to that
 * question, because a row's dismissal keys are one per question (`attentionDismissalKeys`).
 */

export const INBOX_SPLIT_TABS = ["all", "answer", "read", "snoozed"] as const;
export type InboxSplitTab = (typeof INBOX_SPLIT_TABS)[number];

export const INBOX_SPLIT_TAB_LABELS: Record<InboxSplitTab, string> = {
  all: "All",
  answer: "To answer",
  read: "To read",
  snoozed: "Snoozed",
};

/**
 * Where an entry sits in the list. `answer` is settled from the pane; `elsewhere` is a row whose
 * answer lives on another page (a dossier, a run, the session itself), so the pane summarises it
 * and links there; `pinned` is a report a notification opened that the inbox does not list.
 */
export type InboxSplitGroup = "pinned" | "answer" | "elsewhere" | "read" | "snoozed";

/** Rows the pane can only summarise: each is settled on the page its button opens. */
export const ELSEWHERE_KINDS: ReadonlySet<AttentionItem["kind"]> = new Set([
  "ensemble_decision",
  "pipeline_commission",
  "session_blocked",
  "parked_finalization",
]);

export const INBOX_SPLIT_KIND_LABELS: Record<AttentionItem["kind"] | "snoozed" | "pinned", string> = {
  ensemble_decision: "Decision",
  session_reviews: "Question",
  session_control_request: "Permission",
  session_dialog: "Parked on a menu",
  pipeline_commission: "Pipeline",
  pipeline_halt: "Pipeline halt",
  session_blocked: "Waiting on you",
  session_stuck: "Stuck",
  parked_finalization: "Stuck finalization",
  agent_reports: "Report",
  snoozed: "Snoozed",
  pinned: "Report",
};

interface EntryBase {
  /** Stable across updates of the same thing, so the selection survives a re-fold. */
  key: string;
  group: InboxSplitGroup;
  title: string;
  /** When it arrived, for the age column; null when the row carries no time. */
  at: number | null;
}

export type InboxSplitEntry =
  | (EntryBase & {
      type: "item";
      group: "answer" | "elsewhere" | "read";
      /** The fold's row narrowed to this one question or report. */
      item: AttentionItem;
      /** "1 of 2" for a session's questions, null otherwise. */
      position: string | null;
      unread: boolean;
      /**
       * Other report ids this row stands for: an earlier version of its chain that a notification
       * opened, which the row (holding the latest) shows in its place.
       */
      aliases: readonly string[];
    })
  | (EntryBase & { type: "snoozed"; group: "snoozed"; snoozed: SnoozedQuestion })
  | (EntryBase & { type: "pinned"; group: "pinned"; report: ReportItem });

function itemTitle(item: AttentionItem): string {
  switch (item.kind) {
    case "ensemble_decision":
      return "Every candidate has settled";
    case "session_reviews":
      return item.reviews[0]?.title ?? "Question";
    case "session_control_request":
      return "Asks to control your other sessions";
    case "session_dialog":
      return item.prompt ?? "Parked on a menu in its terminal";
    case "pipeline_commission":
      return item.attention.title;
    case "pipeline_halt":
      return item.reason;
    case "session_blocked":
      return item.activity ?? "Reported that it is waiting on you";
    case "session_stuck":
      return STUCK_RULE_LABELS[item.stall.kind];
    case "parked_finalization":
      return item.error;
    case "agent_reports":
      return item.reports[0]?.title ?? "Report";
  }
}

/**
 * Every entry, in list order: a notification's report first, then what can be settled from the
 * pane in the fold's own section order, then what opens elsewhere, then reports, then snoozed.
 */
export function inboxSplitEntries(
  fold: AttentionFold,
  snoozed: readonly SnoozedQuestion[],
  pinned: ReportItem | null,
): InboxSplitEntry[] {
  const answer: InboxSplitEntry[] = [];
  const elsewhere: InboxSplitEntry[] = [];
  const read: InboxSplitEntry[] = [];
  for (const item of fold.items) {
    if (item.kind === "session_reviews") {
      item.reviews.forEach((review, index) => {
        const narrowed: AttentionItem = { ...item, reviews: [review] };
        answer.push({
          type: "item",
          key: `review:${review.id}`,
          group: "answer",
          item: narrowed,
          title: review.title,
          at: review.createdAt,
          position: item.reviews.length > 1 ? `${index + 1} of ${item.reviews.length}` : null,
          unread: false,
          aliases: [],
        });
      });
      continue;
    }
    if (item.kind === "agent_reports") {
      for (const report of item.reports) {
        // Keyed by chain, so a report replaced under the operator keeps its place and selection.
        read.push({
          type: "item",
          key: `report:${report.rootId}`,
          group: "read",
          item: { ...item, reports: [report] },
          title: report.title,
          at: report.createdAt,
          position: null,
          unread: report.readAt === null,
          aliases: [],
        });
      }
      continue;
    }
    const group = ELSEWHERE_KINDS.has(item.kind) ? "elsewhere" : "answer";
    (group === "elsewhere" ? elsewhere : answer).push({
      type: "item",
      key: item.id,
      group,
      item,
      title: itemTitle(item),
      at: item.kind === "session_stuck" ? item.stall.since ?? null : null,
      position: null,
      unread: false,
      aliases: [],
    });
  }
  const later: InboxSplitEntry[] = snoozed.map((entry) => ({
    type: "snoozed",
    key: `snoozed:${entry.review.id}`,
    group: "snoozed",
    snoozed: entry,
    title: entry.review.title,
    at: entry.review.createdAt,
  }));
  // One row per report: a notification's report the Reports rows already hold (its chain is
  // listed) is that row, never a second one above it. The row answers to the notification's
  // report id too, so opening an earlier version selects the row holding the latest.
  const chainRow = pinned
    ? read.findIndex((entry) => entry.type === "item" && entry.item.kind === "agent_reports" && entry.item.reports[0]?.rootId === pinned.rootId)
    : -1;
  if (pinned && chainRow >= 0) {
    const row = read[chainRow]!;
    if (row.type === "item" && entryReport(row)?.id !== pinned.id) read[chainRow] = { ...row, aliases: [...row.aliases, pinned.id] };
  }
  const top: InboxSplitEntry[] = pinned && chainRow < 0
    ? [{ type: "pinned", key: `pinned:${pinned.id}`, group: "pinned", report: pinned, title: pinned.title, at: pinned.createdAt }]
    : [];
  return [...top, ...answer, ...elsewhere, ...read, ...later];
}

/** The entries a tab lists. A notification's report is listed on every tab but Snoozed. */
export function entriesForTab(entries: readonly InboxSplitEntry[], tab: InboxSplitTab): InboxSplitEntry[] {
  switch (tab) {
    case "all":
      return [...entries];
    case "answer":
      return entries.filter((entry) => entry.group === "pinned" || entry.group === "answer" || entry.group === "elsewhere");
    case "read":
      return entries.filter((entry) => entry.group === "pinned" || entry.group === "read");
    case "snoozed":
      return entries.filter((entry) => entry.group === "snoozed");
  }
}

/** How many entries each tab lists, not counting a notification's report. */
export function inboxSplitTabCounts(entries: readonly InboxSplitEntry[]): Record<InboxSplitTab, number> {
  const listed = entries.filter((entry) => entry.group !== "pinned");
  return {
    all: listed.length,
    answer: listed.filter((entry) => entry.group === "answer" || entry.group === "elsewhere").length,
    read: listed.filter((entry) => entry.group === "read").length,
    snoozed: listed.filter((entry) => entry.group === "snoozed").length,
  };
}

/**
 * The entry to select once `gone` has left the list: the one that followed it, or failing that
 * the one before it, or null when nothing is left. `previous` is the list as it was before `gone`
 * left, and `present` the list now. Followers are tried in their old order, so answering several
 * things that leave together still lands on the first one still there.
 */
export function successorKey(previous: readonly string[], gone: string, present: readonly string[]): string | null {
  const still = new Set(present);
  const at = previous.indexOf(gone);
  if (at < 0) return present[0] ?? null;
  for (let i = at + 1; i < previous.length; i += 1) if (still.has(previous[i]!)) return previous[i]!;
  for (let i = at - 1; i >= 0; i -= 1) if (still.has(previous[i]!)) return previous[i]!;
  return present[0] ?? null;
}

/** The key `delta` places from `current` in `order`, held at either end; the first when none is selected. */
export function stepKey(order: readonly string[], current: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[0]!;
  return order[Math.min(order.length - 1, Math.max(0, at + delta))]!;
}

/**
 * The entry to open first: a notification's report, then the focused session's first question,
 * then the report already open on screen, then the top of the list.
 */
export function initialSplitKey(
  entries: readonly InboxSplitEntry[],
  focusSessionId: string | null,
  openReportId: string | null,
): string | null {
  const pinned = entries.find((entry) => entry.type === "pinned");
  if (pinned) return pinned.key;
  if (focusSessionId) {
    const question = entries.find((entry) =>
      entry.type === "item" && entry.item.kind === "session_reviews" && entry.item.session.id === focusSessionId);
    if (question) return question.key;
  }
  if (openReportId) {
    const report = entries.find((entry) =>
      entry.type === "item" && entry.item.kind === "agent_reports" && entry.item.reports[0]?.id === openReportId);
    if (report) return report.key;
  }
  return entries[0]?.key ?? null;
}

/** Whether an entry shows the report `id`: the one it holds, or an earlier version it stands for. */
export function entryHoldsReport(entry: InboxSplitEntry, id: string): boolean {
  return entryReport(entry)?.id === id || (entry.type === "item" && entry.aliases.includes(id));
}

export function entryReport(entry: InboxSplitEntry | undefined): ReportItem | null {
  if (!entry) return null;
  if (entry.type === "pinned") return entry.report;
  if (entry.type === "item" && entry.item.kind === "agent_reports") return entry.item.reports[0] ?? null;
  return null;
}

/**
 * What the split view's selection follows from one render to the next: the row selected, and the
 * report the dashboard had open (App's `openReportId`) when the view last looked.
 */
export interface SplitSelection {
  selected: string | null;
  seenOpenReportId: string | null;
}

export interface SplitSelectionChange {
  selection: SplitSelection;
  /** True when the selection moved on from a settled row; false when it moved for another reason. */
  movedOn: boolean;
  /** The row now selected is not on the current tab, so the view should show All. */
  showAll: boolean;
}

/**
 * The selection after the list or the open report changed, or null when it stands.
 *
 * The dashboard opening a report the list holds, by a notification click or because a
 * notification's report has just loaded, selects that report's row, so the pane shows what was
 * asked for. Then a selected row that has left (settled) hands over to its successor in `drawn`,
 * the list as last drawn; and an empty selection takes the first row.
 */
export function nextSplitSelection(
  current: SplitSelection,
  visible: readonly InboxSplitEntry[],
  all: readonly InboxSplitEntry[],
  drawn: readonly string[],
  openReportId: string | null,
  /** The chain of the open report, when known; an earlier version of a listed chain finds its row. */
  openRootId: string | null = null,
): SplitSelectionChange | null {
  let { selected } = current;
  let changed = false;
  let movedOn = false;
  let showAll = false;
  let listed = visible;
  if (openReportId !== current.seenOpenReportId) {
    changed = true;
    const target = openReportId === null
      ? undefined
      : all.find((entry) => entryHoldsReport(entry, openReportId))
        ?? (openRootId === null ? undefined : all.find((entry) => entryReport(entry)?.rootId === openRootId));
    if (target && target.key !== selected) {
      selected = target.key;
      if (!visible.some((entry) => entry.key === target.key)) {
        showAll = true;
        listed = all;
      }
    }
  }
  const keys = listed.map((entry) => entry.key);
  if (selected !== null && !keys.includes(selected)) {
    selected = successorKey(drawn, selected, keys);
    movedOn = selected !== null;
    changed = true;
  } else if (selected === null && keys.length > 0) {
    selected = keys[0]!;
    changed = true;
  }
  return changed ? { selection: { selected, seenOpenReportId: openReportId }, movedOn, showAll } : null;
}

/**
 * What the dashboard's open report is kept in step with: the selected row, the report it holds now,
 * and any other report the dashboard has opened instead.
 *
 * A report replaced under the operator keeps its row's key but not its id, so the key changes and
 * the replacement is opened in its place. A notification that opens an earlier version while the
 * row holding its replacement is selected changes only the open report, and that is part of the key
 * too, so the replacement is opened then as well. Closing the card on purpose leaves no report open,
 * which is not part of the key, so a collapsed card stays collapsed.
 */
export function reportSyncKey(selected: string | null, report: ReportItem | null, openReportId: string | null = null): string {
  const elsewhere = openReportId !== null && openReportId !== report?.id ? openReportId : "";
  return `${selected ?? ""}|${report?.id ?? ""}|${elsewhere}`;
}

/**
 * The report to toggle so the dashboard's open report matches the selection: the selected row's
 * report when it is not the one open, or the open report when the selected row holds none (so it
 * closes), or null when they already agree.
 *
 * The open report is looked up in the list, or failing that in `lastOpen`, the report the view last
 * saw open while it was listed. A row settled by a mute or a Mark read has already left the list
 * by the time the selection moves on, and it is still closed.
 */
export function reportToToggle(
  current: ReportItem | null,
  openReportId: string | null,
  all: readonly InboxSplitEntry[],
  lastOpen: ReportItem | null = null,
): ReportItem | null {
  if (current) return openReportId === current.id ? null : current;
  if (openReportId === null) return null;
  const listed = all.map(entryReport).find((report) => report?.id === openReportId);
  if (listed) return listed;
  return lastOpen?.id === openReportId ? lastOpen : null;
}
