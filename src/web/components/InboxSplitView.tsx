import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReportItem } from "@shared/reports.ts";
import { relativeTime } from "../lib/format.ts";
import {
  INBOX_SPLIT_KIND_LABELS,
  INBOX_SPLIT_TAB_LABELS,
  INBOX_SPLIT_TABS,
  entriesForTab,
  entryReport,
  inboxSplitTabCounts,
  nextSplitSelection,
  reportSyncKey,
  reportToToggle,
  stepKey,
  type InboxSplitEntry,
  type InboxSplitTab,
  type SplitSelection,
} from "../lib/inbox-split.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The attention inbox as one list and a detail pane (`inbox-split` preview flag).
 *
 * Every row the stacked inbox draws is an entry here, grouped the same way, and the selected one
 * is drawn in the pane by the same card the stacked inbox uses (`renderEntry`), so this view adds
 * no second answer surface for any kind. What it adds is selection: J and K step through the list,
 * the tabs filter it, and when the selected entry leaves because it was settled (answered,
 * accepted, marked read, dismissed), the one after it opens on its own.
 *
 * A report is the one entry whose openness the dashboard also holds (`openReportId` in App, which
 * voice binds to), so selecting a report opens it there and selecting anything else closes it. It
 * runs the other way too: when the dashboard opens a report the list holds (a notification click,
 * or a notification's report that has just loaded), that report's row is selected; and when the
 * selected report is replaced, the replacement is the one opened.
 * Below about 800 px the list and the pane stack, and the pane gains a back button.
 */
export function InboxSplitView({
  entries,
  initialKey,
  openReportId,
  onToggleReport,
  renderEntry,
  renderSubject,
  headingFor,
  reportsHeadAction,
  emptyText,
}: {
  entries: readonly InboxSplitEntry[];
  initialKey: string | null;
  /** The report open on screen (App's `openReportId`). */
  openReportId: string | null;
  /** Open the report if it is closed, close it if it is open (the report card's `toggle`). */
  onToggleReport: (report: ReportItem) => void;
  /** The pane's content for an entry: the card the stacked inbox draws for it. */
  renderEntry: (entry: InboxSplitEntry) => ReactNode;
  renderSubject: (entry: InboxSplitEntry) => ReactNode;
  headingFor: (entry: InboxSplitEntry) => string;
  /** Drawn beside the Reports heading: Mark all read and its refusal. */
  reportsHeadAction: ReactNode;
  emptyText: string;
}): React.JSX.Element {
  const [tab, setTab] = useState<InboxSplitTab>("all");
  const [selection, setSelection] = useState<SplitSelection>({ selected: initialKey, seenOpenReportId: openReportId });
  const { selected } = selection;
  const setSelected = (key: string | null) => setSelection((now) => ({ ...now, selected: key }));
  // Set when the selection moved because the entry it held was settled, not by a click.
  const [movedOn, setMovedOn] = useState(false);
  // Below the stacking width: whether the pane, not the list, fills the inbox.
  const [detail, setDetail] = useState(initialKey !== null);
  const counts = inboxSplitTabCounts(entries);
  const visible = entriesForTab(entries, tab);
  const keys = visible.map((entry) => entry.key);
  // The list as it was last drawn, so a settled entry's successor is the one that followed it.
  const drawn = useRef<readonly string[]>(keys);

  // Adjusted while rendering rather than in an effect, so the pane never draws a frame holding
  // nothing between an entry leaving and its successor opening, or the wrong report after the
  // dashboard opened another one.
  // The open report as last listed, so it can still be closed once its row has been settled away,
  // and so an earlier version of a listed chain still finds the row holding the latest.
  const lastOpen = useRef<ReportItem | null>(null);
  const listedOpen = openReportId === null ? undefined : entries.map(entryReport).find((report) => report?.id === openReportId);
  if (listedOpen) lastOpen.current = listedOpen;
  const openRootId = lastOpen.current?.id === openReportId ? lastOpen.current.rootId : null;
  const change = nextSplitSelection(selection, visible, entries, drawn.current, openReportId, openRootId);
  if (change) {
    setSelection(change.selection);
    if (change.selection.selected !== selected) {
      setMovedOn(change.movedOn);
      if (!change.movedOn) setDetail(true);
    }
    if (change.showAll) setTab("all");
  }
  useEffect(() => {
    drawn.current = keys;
  });

  const current = visible.find((entry) => entry.key === selected);
  const currentReport = entryReport(current);

  // Keep the dashboard's open report in step with the selected row and the report it holds, once
  // per change of either, so a report the operator collapses on purpose stays collapsed, and a
  // replacement of the selected report is opened in its place.
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = reportSyncKey(selected, currentReport, openReportId);
    if (syncedFor.current === key) return;
    syncedFor.current = key;
    const toggle = reportToToggle(currentReport, openReportId, entries, lastOpen.current);
    if (toggle) onToggleReport(toggle);
  }, [selected, currentReport, openReportId, entries, onToggleReport]);

  // A settled entry's button is gone, so focus would fall to the page: hand it to the pane.
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    if (movedOn) pane.current?.focus({ preventScroll: true });
  }, [movedOn, selected]);

  const select = (key: string) => {
    setSelected(key);
    setMovedOn(false);
    setDetail(true);
  };
  const step = (delta: number) => {
    const next = stepKey(keys, selected, delta);
    if (next !== null) select(next);
  };
  const chooseTab = (next: InboxSplitTab) => {
    const listed = entriesForTab(entries, next);
    setTab(next);
    setSelected(listed.some((entry) => entry.key === selected) ? selected : listed[0]?.key ?? null);
    setMovedOn(false);
  };
  // J and K step through the list from anywhere in the inbox but a text field. Bound on the element
  // rather than as a JSX handler: the split is a layout box, not a control of its own.
  const root = useRef<HTMLDivElement>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => onKeyDown(event, (delta) => stepRef.current(delta));
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, []);
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
    }
  };
  // Keyboard focus follows the selection inside the list.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>("[role='option'][aria-selected='true']");
    if (row && list.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const groups: { heading: string; entries: InboxSplitEntry[] }[] = [];
  for (const entry of visible) {
    const heading = headingFor(entry);
    const last = groups[groups.length - 1];
    if (last?.heading === heading) last.entries.push(entry);
    else groups.push({ heading, entries: [entry] });
  }
  const at = current ? keys.indexOf(current.key) : -1;
  const upNext = at < 0 ? [] : visible.slice(at + 1, at + 3);

  return (
    <>
      <div className="modal-bleed inbox-split-tabs" role="tablist" aria-label="Inbox filter">
        {INBOX_SPLIT_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`inbox-split-tab${tab === id ? " is-on" : ""}`}
            onClick={() => chooseTab(id)}
          >
            {INBOX_SPLIT_TAB_LABELS[id]}
            <span className="inbox-split-count">{counts[id]}</span>
          </button>
        ))}
      </div>
      <div ref={root} className={`modal-bleed inbox-split${detail && current ? " is-detail" : ""}`}>
        <div ref={list} className="inbox-split-list" role="listbox" aria-label="Inbox items" tabIndex={-1} onKeyDown={onListKeyDown}>
          {groups.length === 0 && <p className="inbox-empty">{emptyText}</p>}
          {groups.map((group) => (
            <div key={group.heading} role="group" aria-label={group.heading}>
              <div className="inbox-split-heading">
                <span aria-hidden>{group.heading}</span>
                {group.entries[0]?.group === "read"
                  ? reportsHeadAction
                  : <span className="inbox-split-count" aria-hidden>{group.entries.length}</span>}
              </div>
              {group.entries.map((entry) => (
                <SplitRow
                  key={entry.key}
                  entry={entry}
                  selected={entry.key === selected}
                  subject={renderSubject(entry)}
                  onSelect={() => select(entry.key)}
                />
              ))}
            </div>
          ))}
        </div>
        <section ref={pane} className="inbox-split-pane" aria-label="Selected item" tabIndex={-1}>
          <div className="inbox-split-toolbar">
            <button type="button" className="btn btn-ghost inbox-split-back" onClick={() => setDetail(false)}>
              ‹ Inbox
            </button>
            {current && (
              <span className="inbox-split-kind">
                {INBOX_SPLIT_KIND_LABELS[current.type === "item" ? current.item.kind : current.type]}
                {current.type === "item" && current.position && ` ${current.position}`}
              </span>
            )}
            <span className="inbox-spacer" />
            <Tooltip label="Open the item above this one (K)">
              <button type="button" className="btn btn-ghost" disabled={at <= 0} onClick={() => step(-1)}>
                ‹ Previous
              </button>
            </Tooltip>
            <Tooltip label="Open the item below this one (J)">
              <button type="button" className="btn btn-ghost" disabled={at < 0 || at >= keys.length - 1} onClick={() => step(1)}>
                Next ›
              </button>
            </Tooltip>
          </div>
          {movedOn && current && (
            <p className="inbox-split-moved" role="status">Done. Moved on to the next item.</p>
          )}
          {current ? (
            <div key={current.key} className="inbox-split-body">{renderEntry(current)}</div>
          ) : (
            <p className="inbox-empty">{emptyText}</p>
          )}
          {upNext.length > 0 && (
            <div className="inbox-split-upnext">
              <h5>Up next</h5>
              {upNext.map((entry) => (
                <button key={entry.key} type="button" className="inbox-split-upnext-row" onClick={() => select(entry.key)}>
                  <span className="inbox-split-kind">{INBOX_SPLIT_KIND_LABELS[entry.type === "item" ? entry.item.kind : entry.type]}</span>
                  <span className="inbox-split-upnext-title">{entry.title}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/** J steps down the list and K up, unless the key is typed into a field or carries a modifier. */
function onKeyDown(event: KeyboardEvent, step: (delta: number) => void): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "j" || event.key === "J") {
    event.preventDefault();
    step(1);
  } else if (event.key === "k" || event.key === "K") {
    event.preventDefault();
    step(-1);
  }
}

function SplitRow({
  entry,
  selected,
  subject,
  onSelect,
}: {
  entry: InboxSplitEntry;
  selected: boolean;
  subject: ReactNode;
  onSelect: () => void;
}): React.JSX.Element {
  const unread = entry.type === "pinned" ? entry.report.readAt === null : entry.type === "item" && entry.unread;
  const quiet = entry.group === "elsewhere" || entry.group === "snoozed";
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={`inbox-split-row${selected ? " is-selected" : ""}${quiet ? " is-quiet" : ""}${unread ? " is-unread" : ""}`}
      data-entry-key={entry.key}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="inbox-split-row-title">
        {unread && <span className="inbox-split-unread" role="img" aria-label="Unread" />}
        {entry.title}
      </span>
      <span className="inbox-split-row-age">{relativeTime(entry.at)}</span>
      <span className="inbox-split-row-meta">
        {subject}
        <span className="dim"> · {INBOX_SPLIT_KIND_LABELS[entry.type === "item" ? entry.item.kind : entry.type]}</span>
        {entry.type === "item" && entry.position && <span className="dim"> · {entry.position}</span>}
        {entry.group === "elsewhere" && <span className="dim"> ↗</span>}
      </span>
    </div>
  );
}
