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
