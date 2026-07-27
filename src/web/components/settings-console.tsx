import type { ReactNode } from "react";
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
 * A pull request's identity in the ledger, and the link out to it.
 *
 * `owner/repo#number` and nothing else: an `InspectorPr` carries no title (the row is
 * keyed on the pull request, not on a snapshot of its prose), and inventing one here from
 * a branch name would be the panel answering a question from data it does not have -
 * which is the exact failure both of this feature's shipped bugs were.
 */
export function PrLink({
  repo,
  number,
  url,
  tooltip,
}: {
  repo: string;
  number: number;
  url: string;
  tooltip: string;
}): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <a className="sc-pr" href={url} target="_blank" rel="noreferrer">
        {repo}#{number}
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
