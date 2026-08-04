import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";

// The pieces a settings panel with a LEDGER is drawn from - Inspector, Shipping and
// Foreman today.
//
// The shape, not the subject matter, is what these panels share: a posture line saying
// what the subsystem is doing right now, a handful of set-once knobs, and an append-only
// record of what it has decided. What changed when this module appeared is which half
// leads. The ledger used to be a 12px list at the bottom of a vertical form, and it is
// the thing an operator opens the panel to READ - "what did the Inspector say", "why has
// nothing merged", "what did the cheap tier decide" - while the knobs above it are set
// once and then never touched. So the pane splits: controls in a narrow column, ledger in
// a wide one, with a count strip over it that doubles as the filter.
//
// This module was `outbound-console.tsx` and its classes were `oc-`, justified as "the two
// categories whose writes leave this machine". That framing stopped being true the moment
// a `machine`-scoped panel adopted the shape: Foreman's ledger is a record of local
// decisions and nothing in it leaves the laptop. The name now describes what is actually
// common, which is the layout - see `docs/plans/settings-ops-console/plan.md` D1.
//
// Sharing the leaves is the same argument `session-bits.tsx` makes for the four session
// drawings. Panels that look alike because they ARE alike must not drift into looking
// alike by coincidence: a chip restyled on one side and not the other says the two
// subsystems work differently, which is exactly the thing this app cannot afford to imply
// about "posts a comment" versus "lands a commit". Test: `settings-console.test.ts`.
//
// Sharing the leaves turned out not to be enough, and `ConsoleTable` is what that cost.
// The first cut handed out `.sc-row`, `.sc-when` and the rest, and left each panel to
// assemble its own table around them - so the three tables drifted in the one dimension a
// shared class name says nothing about, which is how much of a list they are willing to
// put on screen. Foreman's grew a height budget when its ledger reached 100 rows; the
// other two reached 50 and grew nothing, running the settings page on for two screens of
// pull requests beside a control column a quarter of their height. Nobody edited the
// "wrong" file; there was no file in which the answer lived. Now the heading, the column
// names, the bounded scroller, the pager and the caption are ONE component, and a panel
// supplies its rows, its columns and its copy. There is no prop with which to render an
// unbounded list. See `docs/agent-guides/change-contracts.md`, "Ledger tables".
//
// One thing that is NOT shared: the danger tone. The Inspector's live mode publishes a
// comment; YOLO mode writes to a default branch and nothing here can take it back. The
// switch and the posture line take a `tone` per panel rather than inheriting one.
//
// The shape is also SEPARABLE, and Workflows is the panel that proves it. Three pieces live
// here - the leaves (`ConsoleCard` / `ConsoleSwitch` / `ConsoleState` and the `sc-`
// vocabulary), the count strip, and the two-column split - and a panel takes the ones it
// has the data to be honest about. A ledger earns the wide column; Workflows has no ledger
// to put there, because `WorkflowRuns.tsx` already owns the run list, so it keeps its single
// column and takes `ConsoleLinkStrip` instead of `ConsoleStrip`. A panel given a wide empty
// half to match its neighbours would be the layout imitating a shape rather than expressing
// one.

/** How loud a posture line is. `danger` is reserved for "this is acting on GitHub now". */
export type ConsoleTone = "danger" | "attention" | "ok" | "off" | "unknown";

/**
 * One card in the control column.
 *
 * The title is a `<h3>` rather than a styled `<p>` because these are the panel's real
 * sections and a settings page is a document: the rail names the category, the cards name
 * what is in it, and a screen reader gets the same outline the eye does.
 */
export function ConsoleCard({
  title,
  anchor,
  action,
  children,
}: {
  title: string;
  /** The `<category>/<slug>` settings anchor this card is search's target for, if any. */
  anchor?: string;
  /** Rendered at the head's trailing edge - the master switch, usually. */
  action?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="sc-card" data-anchor={anchor}>
      <div className="sc-card-head">
        <h3 className="sc-card-title">{title}</h3>
        {action}
      </div>
      <div className="sc-card-body">{children}</div>
    </section>
  );
}

/**
 * The master switch, as a real checkbox.
 *
 * It LOOKS like a track-and-knob toggle and it IS an `<input type="checkbox">` with
 * `appearance: none` - the label text lives in an `.sr-only` span, and the Tooltip's
 * hidden copy describes it for anyone who cannot see the posture line under it. A `<div>`
 * with an onClick would have been fewer lines and unreachable from the keyboard, on the
 * one control in this app that arms an unattended merge.
 */
export function ConsoleSwitch({
  label,
  tooltip,
  checked,
  disabled,
  tone = "danger",
  onChange,
}: {
  /** The accessible name. Never rendered visibly - the card's title carries that. */
  label: string;
  tooltip: string;
  checked: boolean;
  /** True before the daemon has answered. A disabled switch is not a claim about state. */
  disabled: boolean;
  /** `danger` for the two switches that act on GitHub; `ok` for a local consequence. */
  tone?: "danger" | "ok";
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <label className={`sc-switch sc-switch-${tone}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="sc-switch-track" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </label>
    </Tooltip>
  );
}

/**
 * The one-line answer to "what is this doing right now", directly under the switch.
 *
 * Always rendered, in every posture, because the states it distinguishes are exactly the
 * ones a checkbox cannot: off, computing-but-publishing-nothing, publishing, and "the
 * daemon has not answered so this is a default and not a reading".
 */
export function ConsoleState({
  tone,
  children,
}: {
  tone: ConsoleTone;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <p className={`sc-state sc-state-${tone}`}>
      <span className={`sc-dot sc-dot-${tone}`} aria-hidden="true" />
      {children}
    </p>
  );
}

/** One tile in the count strip: a tally that is also the filter that selects it. */
export interface ConsoleStat {
  id: string;
  count: number;
  label: string;
  tone?: "attention" | "danger" | "ok" | "merged" | "plain";
  /** What clicking it filters the ledger to, in words. Read out on hover and by AT. */
  hint: string;
}

/**
 * The count strip over the ledger, where every tile is a filter.
 *
 * Tiles are buttons rather than a legend beside a separate filter bar, because the two
 * would be the same list twice: the number IS the reason you want the subset. Clicking
 * the active tile clears back to everything, so there is no state the strip cannot leave.
 */
export function ConsoleStrip({
  stats,
  active,
  onPick,
}: {
  stats: readonly ConsoleStat[];
  /** The active filter id, or `null` for "everything". */
  active: string | null;
  onPick: (id: string | null) => void;
}): React.JSX.Element {
  return (
    <div className="sc-strip">
      {stats.map((s) => (
        <Tooltip key={s.id} label={s.hint}>
          <button
            type="button"
            className={`sc-stat sc-stat-${s.tone ?? "plain"}${active === s.id ? " is-active" : ""}`}
            aria-pressed={active === s.id}
            onClick={() => onPick(active === s.id ? null : s.id)}
          >
            <b>{s.count}</b>
            <span>{s.label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/** One tile in a strip that NAVIGATES: a fleet-wide count and where reading it continues. */
export interface ConsoleLink {
  id: string;
  count: number;
  label: string;
  tone?: "attention" | "danger" | "ok" | "merged" | "plain";
  /** What clicking it OPENS. Never "what it filters" - it filters nothing on this screen. */
  hint: string;
  /** The real destination, so the tile is a link and not a button wearing one. */
  href: string;
}

/**
 * A count strip whose tiles LEAVE the panel, for a panel that has no rows to filter.
 *
 * A sibling of `ConsoleStrip`, not a mode on it, and the difference is a claim about the
 * numbers rather than about the markup. `ConsoleStrip`'s tiles are a fold over the ledger
 * beside them: every row lands in exactly one bucket, so the tiles SUM to the rows and
 * clicking one shows you precisely the rows it counted. `settings-console.test.ts` pins
 * that, after the first cut shipped a strip that ignored 49 rows out of 50.
 *
 * These tiles sum to nothing, and must not be made to look as though they should. They are
 * independent fleet-wide SQL scalars over different populations - runs in one, deliveries
 * in another, and delivered rows among retained run families in a third. Compaction keeps
 * their state, while deleting a run family removes its deliveries from this count, so adding
 * the tiles up is not a smaller number of anything.
 * There is also no ledger on the screen for them to be a filter over: the Workflows panel
 * deliberately has no run list, because `WorkflowRuns.tsx` already is one, with paging, SSE
 * reconciliation and per-run actions. A second, worse copy of it here would disagree with
 * the real one the first time either changed.
 *
 * So a tile navigates to the nearest corresponding view in that real list, using a status
 * filter where one exists, and its `hint` says what it opens rather than what it selects.
 * Two things follow for anyone editing this later. **Do not add a total**, and do not "fix"
 * the missing one - the absence is the honest reading. And **do not add `active` /
 * `aria-pressed`**: a pressed state would promise that the panel now shows a subset, on a
 * panel with nothing to subset.
 *
 * Tiles are real `<a href>` elements. The hash is a genuine deep link - copyable,
 * middle-clickable, and the same URL the Workflows page's own filter chips produce - while
 * the click handler routes through the app's `navigate`, so the dirty-draft gate and the
 * history entry behave exactly as they do everywhere else.
 *
 * The `href` is the load-bearing half of that pair and the handler is the enhancement, which
 * is why a strip mounted without one does NOT swallow the click: it lets the browser follow
 * the hash, which the router's own `hashchange` listener picks up (dirty gate included). A
 * `preventDefault` that ran before an absent handler would turn every tile into a link that
 * looks live and does nothing.
 */
export function ConsoleLinkStrip({
  stats,
  onOpen,
}: {
  stats: readonly ConsoleLink[];
  /**
   * Follow a tile through the app's router. Receives the tile's id, never its href.
   * Omit it and the tiles navigate as plain links instead.
   */
  onOpen?: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="sc-strip sc-strip-links">
      {stats.map((s) => (
        <Tooltip key={s.id} label={s.hint}>
          <a
            className={`sc-stat sc-stat-link sc-stat-${s.tone ?? "plain"}`}
            href={s.href}
            onClick={(e) => {
              // Left click with no modifier only: ⌘/ctrl/shift/middle keep their browser
              // meanings, which is the whole reason this is an anchor.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              if (!onOpen) return;
              e.preventDefault();
              onOpen(s.id);
            }}
          >
            <b>{s.count}</b>
            <span>{s.label}</span>
          </a>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * How many ledger rows one page holds. ONE number, for every console table.
 *
 * 25 rather than "as many as fit", because the two bounds this table has answer different
 * questions and neither replaces the other. The scroller bounds HEIGHT - it is a share of
 * the viewport, so the panel below the fold stays reachable at any window size. The page
 * bounds the LIST - it is a fixed count, so the table says how far through the record you
 * are ("26-50 of 50") in a figure that does not move when the window does.
 *
 * The three ledgers are capped at 50 (Inspector, Shipping) and 100 (Foreman) rows by their
 * reads, so this is two pages and four. That is the size worth having: a pager that never
 * has a second page is chrome, and one with fifteen pages is a scrollbar with extra steps.
 */
export const CONSOLE_PAGE_SIZE = 25;

/** One page of a ledger, and everything the pager has to say about where it sits. */
export interface ConsolePage<Row> {
  /** The rows on this page. */
  rows: readonly Row[];
  /** The page actually shown, CLAMPED into range - never the number that was asked for. */
  page: number;
  pages: number;
  /** 1-based position of the first row on this page; 0 when there are no rows at all. */
  from: number;
  to: number;
  total: number;
}

/**
 * Cut a ledger into one page, and clamp the page number rather than trusting it.
 *
 * The clamp is the whole reason this is a named fold and not a `slice` at three call sites.
 * Every one of these ledgers is POLLED - four seconds for Foreman's, the same for the two
 * Inspector reads - and the strip above it is a filter. So the row count moves underneath
 * an operator who is sitting on page 3: a merge sweep retires rows, a filter is clicked, a
 * daemon restarts and answers with nothing. An unclamped page renders an empty table with
 * rows in it, which reads exactly like the ledger having broken.
 *
 * Exported for `settings-console.test.ts`, which pins the clamp and the 1-based readout -
 * the two things a component test rendering one page cannot see.
 */
export function consolePage<Row>(
  rows: readonly Row[],
  page: number,
  size: number = CONSOLE_PAGE_SIZE,
): ConsolePage<Row> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: current,
    pages,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
    total,
  };
}

/** One column name in a ledger's header row. `className` is the cell class it labels. */
export interface ConsoleColumn {
  label: string;
  /** Matches the class on the cells below it, so the header tracks their alignment. */
  className?: string;
}

/**
 * The ledger table itself: heading, column names, a bounded scroller of rows, a pager, and
 * the caption under it. Every console panel's wide column is drawn by this and nothing else.
 *
 * **It owns the paging rather than accepting a page**, and that is the point of the
 * component. Two of these three tables shipped without a height budget and all three
 * without a pager, which is precisely the drift a shared vocabulary of leaf elements does
 * not prevent: `settings-console.tsx` handed out `.sc-row` and `.sc-when` and left each
 * panel to assemble its own table, so Foreman grew a scroller when its ledger reached 100
 * rows and the other two grew nothing when theirs reached 50. A panel cannot make that
 * mistake through this component, because there is no prop with which to render an unpaged,
 * unbounded list. See `docs/agent-guides/change-contracts.md`, "Ledger tables".
 *
 * The rows are handed in FILTERED (the strip is the panel's, since only the panel knows its
 * buckets) and newest-first, which is what lets the pager say "newer" and "older" rather
 * than "previous" and "next" - a direction the reader can check against the timestamps in
 * the last column.
 */
export function ConsoleTable<Row>({
  title,
  variant,
  modifier,
  columns,
  rows,
  rowKey,
  renderRow,
  filter,
  empty,
  foot,
}: {
  /** The heading over the table - "Inspections", "Merge queue", "Decisions". */
  title: string;
  /** Which ledger this is, as the `sc-table-<variant>` class its grid tracks are keyed on. */
  variant: "inspector" | "shipping" | "foreman";
  /** An extra class on the table, for a variant whose columns change - Foreman's shadow. */
  modifier?: string;
  columns: readonly ConsoleColumn[];
  /** The rows to show, already filtered by the strip and ordered newest first. */
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  renderRow: (row: Row) => ReactNode;
  /** The strip's active tile, so the head can offer the way back. Null shows everything. */
  filter: { label: string; hint: string; onClear: () => void } | null;
  /** What an empty list says. The panel writes it, because only it knows why it is empty. */
  empty: ReactNode;
  /** The caption under the table - what this ledger is, and how far back it reaches. */
  foot: ReactNode;
}): React.JSX.Element {
  const [page, setPage] = useState(1);
  // Changing the filter starts a new list, so it starts at its first page. Reconciled during
  // render (React's documented "adjust state when a prop changes" pattern) rather than in an
  // effect: an effect would paint page 4 of a two-page filter for one frame first.
  const key = filter?.label ?? "";
  const [pagedKey, setPagedKey] = useState(key);
  if (pagedKey !== key) {
    setPagedKey(key);
    setPage(1);
  }
  const view = consolePage(rows, page);
  const scroller = useRef<HTMLDivElement>(null);
  const newerRef = useRef<HTMLButtonElement>(null);
  const olderRef = useRef<HTMLButtonElement>(null);
  /** Which button was pressed, so the effect below can tell whether it just went dead. */
  const pressed = useRef<"newer" | "older" | null>(null);
  const go = (next: number): void => {
    pressed.current = next < view.page ? "newer" : "older";
    setPage(next);
    // The scroller keeps its offset across a re-render, so without this the next page opens
    // wherever the last one was left - which on the older page is its middle, and reads as
    // rows having been skipped.
    scroller.current?.scrollTo({ top: 0 });
  };

  // Focus survives reaching the end of the list.
  //
  // On a two-page ledger - which the Inspector's and Shipping's 50 rows make the ordinary
  // case - pressing Older lands on the last page and disables Older in the same commit. A
  // browser blurs a control that becomes disabled, so a keyboard reader who pressed it is
  // returned to the top of the document, on the one screen whose whole point is that you
  // do not lose your place in a long list. Hand the focus to the button that can still act.
  //
  // After the commit rather than in the handler: the button is still enabled while the
  // handler runs, so focus moved there would simply be dropped a moment later.
  useEffect(() => {
    const which = pressed.current;
    pressed.current = null;
    if (which === null) return;
    const used = which === "newer" ? newerRef.current : olderRef.current;
    // It kept the focus, or the press came from a pointer and never held it. Either way
    // there is nothing to rescue, and stealing focus would be worse than leaving it.
    if (!used || !used.disabled || document.activeElement !== document.body) return;
    (which === "newer" ? olderRef : newerRef).current?.focus();
  }, [view.page]);

  return (
    <>
      <div className={`sc-table sc-table-${variant}${modifier ? ` ${modifier}` : ""}`}>
        <div className="sc-head">
          <h3>{title}</h3>
          {filter && (
            <Tooltip label={filter.hint}>
              <button type="button" className="sc-clear" onClick={filter.onClear}>
                {filter.label} only - show all
              </button>
            </Tooltip>
          )}
        </div>
        <div className="sc-row sc-row-head" aria-hidden="true">
          {columns.map((c) => (
            <span key={c.label} className={c.className}>
              {c.label}
            </span>
          ))}
        </div>
        {/* The rows scroll INSIDE the table, and the heading, the column names and the
            pager do not. See `.sc-scroll` for the height budget and what it is a share of. */}
        <div className="sc-scroll" ref={scroller}>
          {view.rows.length === 0 ? (
            <p className="settings-hint sc-empty">{empty}</p>
          ) : (
            // A keyed `Fragment`, so a panel may return SEVERAL elements for one row without
            // a wrapper that would break the grid. Foreman's rows do exactly that: the row
            // is a button, and an opened one is followed by a detail card that is its
            // sibling rather than its child, because a card carrying a whole terminal
            // screen cannot live inside a grid cell.
            view.rows.map((row) => <Fragment key={rowKey(row)}>{renderRow(row)}</Fragment>)
          )}
        </div>
        {/* Absent on a single page, rather than present with both buttons dead. There is
            nothing to page and nothing the reader has not already been shown, so a range
            that can only ever read "1-6 of 6" is a control that has never done anything. */}
        {view.pages > 1 && (
          <div className="sc-pager">
            {/* Announced, because the number is the only thing that changes when you page:
                the rows above it are the same shape and, to a screen reader moving by
                landmark, the same table. */}
            <span className="sc-pager-range" aria-live="polite">
              {view.from}-{view.to} of {view.total}
            </span>
            <div className="sc-pager-nav">
              <Tooltip label="Show the page of more recent rows">
                <button
                  type="button"
                  ref={newerRef}
                  className="sc-pager-btn"
                  disabled={view.page === 1}
                  onClick={() => go(view.page - 1)}
                >
                  Newer
                </button>
              </Tooltip>
              <Tooltip label="Show the page of older rows">
                <button
                  type="button"
                  ref={olderRef}
                  className="sc-pager-btn"
                  disabled={view.page === view.pages}
                  onClick={() => go(view.page + 1)}
                >
                  Older
                </button>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
      <p className="settings-hint sc-foot">{foot}</p>
    </>
  );
}

/**
 * A pull request's identity in the ledger, and the link out to it.
 *
 * `owner/repo#number` by default, which is the only name every row is guaranteed to have.
 *
 * `label` overrides that text where the surface has a better one to show, and the ledger
 * now has one: `InspectorPr.title` is written by the Inspector's poll, so a row can be
 * named the way GitHub names it. That is a widening of what this leaf may be TOLD, not of
 * what it may work out - it still invents nothing. Deciding what a row is called, including
 * the fall back to the branch when the poll has not run, belongs to `prLabel` in
 * `lib/pr-standing.ts`, where every surface reads the same answer.
 *
 * (This comment used to say an `InspectorPr` carries no title. It did not, and now it does;
 * the rule that outlived the field is the one above - a leaf renders what it is handed.)
 */
export function PrLink({
  repo,
  number,
  url,
  tooltip,
  label,
}: {
  repo: string;
  number: number;
  url: string;
  tooltip: string;
  /** What to show instead of `owner/repo#number`. Never derived here - see `prLabel`. */
  label?: string;
}): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <a className="sc-pr" href={url} target="_blank" rel="noreferrer">
        {label ?? `${repo}#${number}`}
      </a>
    </Tooltip>
  );
}

/**
 * Which session a ledger row happened on, as a short handle.
 *
 * A sibling of `PrLink` rather than a widening of it: a pull request has a canonical
 * name and a URL, and an episode has neither. Giving `PrLink` a discriminated union
 * would make one leaf answer two questions that share only their position in a row.
 *
 * It is a handle and NOT a link, because there is nowhere honest to send the click.
 * The episode's `sessionId` is synthetic (tty + pid + start) and re-mints on restart,
 * so most rows in a fleet-wide ledger name a session that no longer exists - and a
 * link that silently does nothing on the majority of rows is worse than plain text.
 * The full key rides along in the tooltip for anyone correlating with a drawer.
 */
export function SessionRef({ handle, tooltip }: { handle: string; tooltip: string }): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <span className="sc-ref">{handle}</span>
    </Tooltip>
  );
}

/**
 * A short, stable handle for the session a ledger row happened on.
 *
 * Neither form is readable at full length, and a fleet-wide historical ledger names
 * sessions that mostly no longer exist, so there is nothing to resolve most rows against
 * anyway. Each form is truncated where it actually carries its identity, which beats
 * printing 36 characters of UUID in a table cell.
 *
 * Three shapes reach here, from two id spaces. The Foreman ledger stores a `noteKey`: an
 * `agentSessionId` (a bare UUID) or `proc:<tty>:<pid>:<start>`. The adoption ledger stores
 * a REGISTRY session id, which is `proc:…` for a discovered terminal and `sdk:<uuid>` for
 * one the supervisor drives.
 *
 * The `sdk:` prefix is stripped before truncating rather than counted into the eight
 * characters, and that is the whole reason it has a branch: a bare slice spends three of
 * them on a prefix every dispatched session shares, leaving `sdk:9f2a` - four hex digits
 * to tell apart the sessions that open most of the pull requests on this ledger.
 *
 * Beside `SessionRef` rather than in the panel it was written for, since the Ship log
 * names sessions the same way: the abbreviation and the leaf that renders it are one
 * decision, and two copies of it would print one session under two names on two screens.
 */
export function sessionHandle(noteKey: string): string {
  if (noteKey.startsWith("proc:")) {
    const [, tty, pid] = noteKey.split(":");
    const dev = tty?.split("/").pop() ?? "";
    if (dev && pid) return `${dev}:${pid}`;
  }
  if (noteKey.startsWith("sdk:")) {
    const uuid = noteKey.slice("sdk:".length);
    if (uuid) return uuid.slice(0, 8);
  }
  return noteKey.slice(0, 8) || "unknown";
}
