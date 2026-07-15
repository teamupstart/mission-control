import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, SessionQueue, WorkItem, WorkItemState } from "@shared/types.ts";
import { api, fetchQueue } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";

// The work-queue panel inside an expanded card: the batch of work queued for this
// session, in the order you authored it. Items are drag-reorderable, editable, and
// removable while they wait; the in-flight one shows what Foreman is doing to it.
// Stops click propagation so interacting with it never selects/collapses the card.

/** Labels for what Foreman is doing to the in-flight item. */
const STATE_LABEL: Record<WorkItemState, string> = {
  queued: "waiting",
  proposed: "drafted - needs your OK",
  sending: "delivering…",
  awaiting_pickup: "delivered, waiting for the agent",
  in_progress: "working",
  verifying: "checking the work",
  verified: "done",
  escalated: "needs you",
  cancelled: "cancelled",
};

/** True while an item can still be edited/removed - i.e. Foreman hasn't typed it. */
function isWaiting(state: WorkItemState): boolean {
  return state === "queued" || state === "proposed";
}

function isTerminal(state: WorkItemState): boolean {
  return state === "verified" || state === "escalated" || state === "cancelled";
}

export function WorkQueue({
  session,
  foremanMode,
  foremanEnabled,
  allowlisted,
}: {
  session: Session;
  /** Current Foreman mode, so a dry-run queue explains why it isn't sending. */
  foremanMode: string;
  /**
   * Whether Foreman is on at all. The worker short-circuits its whole loop when it
   * isn't, so this outranks the mode when explaining a queue that isn't moving.
   */
  foremanEnabled: boolean;
  /** Whether this session's repo is cleared for live sends (see the panel note). */
  allowlisted: boolean;
}): React.JSX.Element | null {
  const [queue, setQueue] = useState<SessionQueue | null>(null);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when the GET itself failed, so an unreadable queue never reads as an empty one. */
  const [loadFailed, setLoadFailed] = useState(false);

  const sessionId = session.id;
  const summary = session.queue;

  /**
   * Re-fetch the full queue, discarding a response that has been superseded.
   *
   * The sequence token is what makes that last part true: every action awaits its
   * own refresh while the SSE effect independently fires one, and nothing else
   * orders them - so a slow earlier response landing last reverts the panel to a
   * state the server left minutes ago, offering an Approve on an item already
   * delivered. Only the newest request in flight may write.
   *
   * A FAILED fetch leaves the last-known queue on screen and raises the banner
   * instead of blanking it, because "we couldn't read it" is not "it's empty".
   */
  const seqRef = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seqRef.current;
    const res = await fetchQueue(sessionId);
    if (mine !== seqRef.current) return;
    setLoadFailed(!res.ok);
    if (res.ok) setQueue(res.queue);
  }, [sessionId]);

  // The card's compact summary rides the existing session_upsert, so re-fetching
  // the full queue whenever it changes keeps this in step with the live stream
  // without inventing a second event type.
  useEffect(() => {
    void refresh();
  }, [refresh, summary?.updatedAt, summary?.openCount, summary?.inFlightState]);

  /**
   * The queue can't work at all for some sessions, and offering it anyway would
   * just rack up escalations on arrival. Say why instead.
   */
  const blocked = queueBlockedReason(session);

  // The card's summary says there IS a queue but we couldn't read it. Say so, and
  // show nothing else - an add box under a wrong "0 to do" is the one response that
  // makes this worse. The Retry is not a nicety: the effect above only re-fires when
  // the summary MOVES, so on an idle session (Foreman off is the shipped default)
  // nothing would ever heal this on its own.
  if (loadFailed && (summary?.totalCount ?? 0) > 0) {
    return (
      <section className="work-queue" onClick={(e) => e.stopPropagation()}>
        <Header count={summary?.openCount ?? 0} />
        <p className="wq-error">
          Couldn&apos;t load this queue. Its {summary?.totalCount}{" "}
          {summary?.totalCount === 1 ? "item is" : "items are"} still there - don&apos;t re-add them.
        </p>
        <div className="wq-actions">
          <button className="btn" disabled={busy} onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!queue && !blocked && (summary?.totalCount ?? 0) === 0) {
    // Nothing queued and nothing to explain: the add box, and the re-attach hint if
    // a queue here was orphaned.
    //
    // The hint MUST render here, because this branch IS the orphaned state: a
    // `/clear` mints a new agent session id, which is the queue's key, so the new
    // session has no queue row and no items of its own and lands in exactly this
    // "nothing queued" case. Dropping the hint here stranded the batch behind a bare
    // add box - and left the hint visible only where the session HAS its own items,
    // which is precisely where re-attaching is refused. It was shown only when it
    // would fail, and hidden whenever it would work.
    return (
      <section className="work-queue" onClick={(e) => e.stopPropagation()}>
        <Header count={0} />
        {session.orphanedQueue && <ReattachHint session={session} onDone={() => void refresh()} />}
        <AddBox
          value={adding}
          onChange={setAdding}
          disabled={busy}
          onAdd={() => void add()}
          placeholder="Queue work for this session…"
        />
        {error && <p className="wq-error">{error}</p>}
      </section>
    );
  }

  async function add(): Promise<void> {
    const intent = adding.trim();
    if (!intent || busy) return;
    setBusy(true);
    const r = await api.addWorkItem(sessionId, intent);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "could not add that item");
    setAdding("");
    setError(null);
    await refresh();
  }

  async function saveEdit(item: WorkItem): Promise<void> {
    const intent = editText.trim();
    if (!intent || busy) return;
    setBusy(true);
    const r = await api.editWorkItem(sessionId, item.id, intent, item.revision);
    setBusy(false);
    if (!r.ok) {
      // Surface a CAS conflict honestly rather than pretending the edit landed:
      // the item may already be typed into the pane.
      setError(
        r.status === 409
          ? "Foreman just sent this item - your edit didn't apply."
          : r.error ?? "could not edit that item",
      );
      await refresh();
      return;
    }
    setEditing(null);
    setError(null);
    await refresh();
  }

  async function remove(item: WorkItem): Promise<void> {
    setBusy(true);
    const r = await api.removeWorkItem(sessionId, item.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 409 ? "Foreman already started this item." : r.error ?? "could not remove it");
      await refresh();
      return;
    }
    setError(null);
    await refresh();
  }

  async function approve(item: WorkItem): Promise<void> {
    setBusy(true);
    const r = await api.approveWorkItem(sessionId, item.id);
    setBusy(false);
    // Clear on success as well as set on failure. A stale error pinned under a
    // successful Approve reads as "the send failed" about a send that is underway.
    setError(r.ok ? null : r.error ?? "could not approve it");
    await refresh();
  }

  /**
   * Optimistic reorder, then persist. Hand-rolled HTML5 DnD - no library.
   *
   * Only WAITING items may be dragged or dropped onto. The server accepts any known
   * id, so nothing stops a waiting item being renumbered above the completed work
   * and rendering there - which doesn't change delivery order (`nextSendable` skips
   * terminal items) but does break the "in the order you authored it" contract this
   * panel is built on, and makes the done/waiting split unreadable.
   */
  async function drop(targetId: string): Promise<void> {
    if (!queue || !dragId || dragId === targetId) return setDragId(null);
    const target = queue.items.find((i) => i.id === targetId);
    if (!target || !isWaiting(target.state)) return setDragId(null);
    const ids = queue.items.map((i) => i.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return setDragId(null);
    ids.splice(to, 0, ...ids.splice(from, 1));
    setQueue({ ...queue, items: ids.map((id) => queue.items.find((i) => i.id === id)!) });
    setDragId(null);
    const r = await api.reorderQueue(sessionId, ids);
    setError(r.ok ? null : r.error ?? "could not reorder");
    await refresh();
  }

  const items = queue?.items ?? [];
  const open = items.filter((i) => !isTerminal(i.state));

  /*
    A blocked panel makes exactly ONE claim about why this queue is or isn't
    running, and it is `blocked`. Everything else here is computed from the fetched
    queue, which being blocked does not empty - so rendering the count, the hint,
    the re-attach offer and the wrap-up ask outside this branch had the panel assert
    four contradictory things at once ("5 to do", "re-attach?", "no hooks - install
    the integrations", "dry-run will draft each item") while hiding the items those
    sentences were about. The list itself stays, read-only: they are the human's
    items, they aren't going to run, and the only thing worse than showing them is
    stranding them somewhere with no way to clear them out by hand.
  */
  if (blocked) {
    return (
      <section className="work-queue" onClick={(e) => e.stopPropagation()}>
        <Header count={0} />
        <p className="wq-blocked">{blocked}</p>
        {items.length > 0 && (
          <>
            <p className="wq-hint dim">
              {items.length} {items.length === 1 ? "item is" : "items are"} queued here and won&apos;t
              run. You can remove them.
            </p>
            <ol className="wq-items">
              {items.map((item) => (
                <li key={item.id} className={`wq-item wq-${item.state}`}>
                  <div className="wq-body">
                    <p className="wq-intent">{item.intent}</p>
                    <ItemStatus item={item} />
                  </div>
                  {/* Same gate as the live list: never offer a Remove that can only 409. */}
                  {(isWaiting(item.state) || isTerminal(item.state)) && (
                    <div className="wq-controls">
                      <button
                        className="icon-btn"
                        aria-label="Remove this item"
                        title="Remove"
                        disabled={busy}
                        onClick={() => void remove(item)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        {error && <p className="wq-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="work-queue" onClick={(e) => e.stopPropagation()}>
      <Header count={open.length} />

      {session.orphanedQueue && (
        <ReattachHint session={session} onDone={() => void refresh()} />
      )}

      <ol className="wq-items">
        {items.map((item) => (
          <li
            key={item.id}
            className={`wq-item wq-${item.state}${dragId === item.id ? " dragging" : ""}`}
            draggable={isWaiting(item.state)}
            onDragStart={() => setDragId(item.id)}
            /*
              Drop targets are waiting items only, matching `draggable`. Allowing a
              drop onto a done or in-flight row let a waiting item be renumbered in
              among the completed work - harmless to delivery order, wrong on screen.
            */
            onDragOver={(e) => {
              if (isWaiting(item.state)) e.preventDefault();
            }}
            onDrop={() => void drop(item.id)}
            onDragEnd={() => setDragId(null)}
          >
            {isWaiting(item.state) && (
              <span className="wq-grip" aria-hidden title="Drag to reorder">
                ⠿
              </span>
            )}

            {/*
              The editor closes as soon as the item leaves the states an edit can
              land in. Keeping it open on an item Foreman has already picked up
              offers a Save that CAN only 409, and it hides the state the item just
              moved to behind the textarea that replaced it.
            */}
            {editing === item.id && isWaiting(item.state) ? (
              <div className="wq-edit">
                <textarea
                  className="field-input"
                  rows={3}
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveEdit(item);
                  }}
                />
                <div className="wq-actions">
                  <button className="btn btn-send" disabled={busy} onClick={() => void saveEdit(item)}>
                    Save
                  </button>
                  <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="wq-body">
                <p className="wq-intent">{item.intent}</p>
                <ItemStatus item={item} />
                <ProposedPayload item={item} />
              </div>
            )}

            {!(editing === item.id && isWaiting(item.state)) && (
              <div className="wq-controls">
                {/*
                  No draft, no Approve. The button is consent to a SPECIFIC
                  prompt, so offering it before `proposedPayload` exists would ask
                  for consent to text that isn't on screen - and from round 1 on
                  that text is the fix prompt, not the intent shown above. The
                  server refuses this too; the button just shouldn't be there.
                */}
                {item.state === "proposed" && item.proposedPayload && !item.approvedAt && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => void approve(item)}>
                    Approve
                  </button>
                )}
                {isWaiting(item.state) && (
                  <button
                    className="icon-btn"
                    aria-label="Edit this item"
                    title="Edit"
                    onClick={() => {
                      setEditing(item.id);
                      setEditText(item.intent);
                    }}
                  >
                    ✎
                  </button>
                )}
                {(isWaiting(item.state) || isTerminal(item.state)) && (
                  <button
                    className="icon-btn"
                    aria-label="Remove this item"
                    title="Remove"
                    disabled={busy}
                    onClick={() => void remove(item)}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      <AddBox
        value={adding}
        onChange={setAdding}
        disabled={busy}
        onAdd={() => void add()}
        placeholder="Queue more work…"
      />

      {/*
        What will happen to the items that are waiting - or why nothing will. Only
        when something IS waiting: with nothing pending there's nothing to explain.
      */}
      {open.length > 0 && (
        <QueueHint enabled={foremanEnabled} mode={foremanMode} allowlisted={allowlisted} cwd={session.cwd} />
      )}

      {queue && queue.wrapupAskedAt !== null && (
        <Wrapup sessionId={sessionId} queue={queue} onDone={() => void refresh()} />
      )}

      {error && <p className="wq-error">{error}</p>}
    </section>
  );
}

/**
 * The one line explaining what Foreman will do with the waiting items.
 *
 * Ordered by what actually stops the queue FIRST. Foreman being off short-circuits
 * the worker's entire loop before it ever reads a queue, so it outranks whatever
 * the mode and the allowlist would say: "it will draft each item and wait for your
 * Approve" describes a draft that is never coming, and an item sitting `queued`
 * forever under that sentence reads as a bug in the queue rather than a switch the
 * human hasn't flipped. Queueing first and enabling after is a perfectly natural
 * order of work - the panel just has to be honest about which one you're in.
 */
function QueueHint({
  enabled,
  mode,
  allowlisted,
  cwd,
}: {
  enabled: boolean;
  mode: string;
  allowlisted: boolean;
  cwd: string | null;
}): React.JSX.Element | null {
  if (!enabled) {
    return (
      <p className="wq-hint dim">
        Foreman is off, so nothing here will be drafted or sent. These items keep their order and
        wait - turn Foreman on from the toolbar to start working through them.
      </p>
    );
  }
  // Allowlist honesty. foremanMayActLive's prefix match doesn't cover
  // dispatched-task worktrees (they aren't under the repo root), so a queue on a
  // dispatched agent would silently never go live and every item would sit
  // `proposed` - reading as a bug. Say so, and say where to fix it.
  if (mode === "live" && !allowlisted && cwd) {
    return (
      <p className="wq-hint dim">
        This repo isn&apos;t allowlisted for live sends, so items will be drafted for your OK. Add{" "}
        <code>{cwd}</code> to Foreman&apos;s allowlist to let it send here.
      </p>
    );
  }
  if (mode !== "live") {
    return (
      <p className="wq-hint dim">
        Foreman is in {mode} - it will draft each item and wait for your Approve.
      </p>
    );
  }
  // Live, enabled, allowlisted: it does what the panel already shows. Nothing to say.
  return null;
}

function Header({ count }: { count: number }): React.JSX.Element {
  return (
    <header className="wq-head">
      <span className="wq-badge">Work queue</span>
      {count > 0 && <span className="wq-count">{count} to do</span>}
    </header>
  );
}

/** The in-flight/terminal status line for one item: state, round, gaps, audit. */
function ItemStatus({ item }: { item: WorkItem }): React.JSX.Element | null {
  const blocking = item.gaps.filter((g) => g.severity === "blocking");
  const advisory = item.gaps.filter((g) => g.severity === "advisory");
  const showState = item.state !== "queued";
  if (!showState && item.gaps.length === 0) return null;
  return (
    <div className="wq-status">
      {showState && <span className={`wq-state wq-state-${item.state}`}>{STATE_LABEL[item.state]}</span>}
      {item.round > 0 && !isTerminal(item.state) && (
        <span className="wq-round" title="Fix rounds spent on this item">
          fix {item.round}
        </span>
      )}
      {item.escalationReason && <span className="wq-escalation">{item.escalationReason}</span>}
      {blocking.length > 0 && (
        <ul className="wq-gaps">
          {blocking.map((g) => (
            <li key={g.id} className="wq-gap wq-gap-blocking">
              <span className="wq-gap-kind">{g.kind}</span>
              {g.detail}
              {g.strikes > 0 && (
                <span className="wq-strikes" title="How many rounds this gap has survived">
                  ×{g.strikes + 1}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Advisory gaps are shown but never drive a round - they stop here. */}
      {advisory.length > 0 && (
        <ul className="wq-gaps">
          {advisory.map((g) => (
            <li key={g.id} className="wq-gap wq-gap-advisory">
              <span className="wq-gap-kind">note</span>
              {g.detail}
            </li>
          ))}
        </ul>
      )}
      {item.state === "verified" && item.lastVerdict && (
        <p className="wq-verdict">✓ {item.lastVerdict}</p>
      )}
      {item.completedAt && <span className="dim">{relativeTime(item.completedAt)}</span>}
    </div>
  );
}

/**
 * The exact text Foreman would type into the pane, on a drafted item.
 *
 * Approve is consent to a SPECIFIC prompt, so the human has to be able to read it.
 * From round 1 on the payload is the rendered fix prompt rather than `item.intent`
 * above it, so without this the card would show the original request while Approve
 * sent something else entirely. Round 0's payload IS the intent, so showing it
 * again would just be the same paragraph twice - skip it there.
 */
function ProposedPayload({ item }: { item: WorkItem }): React.JSX.Element | null {
  if (item.state !== "proposed" || !item.proposedPayload) return null;
  if (item.proposedPayload.trim() === item.intent.trim()) return null;
  return (
    <details className="wq-payload">
      <summary>Foreman would send:</summary>
      <pre className="wq-payload-text">{item.proposedPayload}</pre>
    </details>
  );
}

function AddBox({
  value,
  onChange,
  onAdd,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  disabled: boolean;
  placeholder: string;
}): React.JSX.Element {
  return (
    <div className="wq-add">
      <textarea
        className="field-input"
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter adds, so a multi-line intent can contain newlines.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onAdd();
        }}
      />
      <button className="btn btn-send" disabled={disabled || !value.trim()} onClick={onAdd}>
        Add
      </button>
    </div>
  );
}

/**
 * The drain-time wrap-up: ask whether to ship this batch. Foreman ALWAYS asks -
 * it never launches these itself.
 */
function Wrapup({
  sessionId,
  queue,
  onDone,
}: {
  sessionId: string;
  queue: SessionQueue;
  onDone: () => void;
}): React.JSX.Element | null {
  const [pr, setPr] = useState(true);
  const [nm, setNm] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  /** The instruction reached the pane. One ask, one send - whatever happens after. */
  const [sent, setSent] = useState(false);

  // Recompose the prefill as the checkboxes change, until the human edits it.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(composeWrapup(pr, nm));
  }, [pr, nm, touched]);

  if (dismissed || queue.wrapupAnswer !== null) return null;

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    // The human's "yes" arrives long after the drain, so this goes through the
    // same delivery path a queue item does - and the daemon's inject fails loudly
    // rather than silently dropping a multi-line instruction.
    const r = await api.injectPrompt(sessionId, body);
    if (!r.ok) {
      setBusy(false);
      setErr(r.error ?? "could not send that");
      return;
    }
    // The instruction is now in the pane, so this must never offer to send it again -
    // and recording the answer is the only thing that retires the ask. `api.request`
    // turns every failure into a returned `{ok:false}` rather than a throw, so an
    // unchecked write here fails silently and leaves "Ship it?" on screen with a live
    // Send button next to an agent that already got the instruction; a second click
    // injects `/no-mistakes` twice. Latch on the SEND, not on the write, so the
    // button dies even when the write is what failed.
    setSent(true);
    const saved = await api.setWrapupAnswer(sessionId, body);
    setBusy(false);
    if (!saved.ok) {
      setErr(`Sent - but this card couldn't record it (${saved.error ?? "the write failed"}).`);
      return;
    }
    onDone();
  }

  /**
   * Retire the ask without sending anything. The write is what actually retires it -
   * `dismissed` is only local state, so a failure here means the ask returns the
   * moment the card is collapsed and re-expanded (which remounts this) and the human
   * is left dismissing the same thing forever. Same reason `send()` checks its write.
   */
  async function dismiss(): Promise<void> {
    setBusy(true);
    const saved = await api.setWrapupAnswer(sessionId, "");
    setBusy(false);
    if (!saved.ok) {
      setErr(saved.error ?? "could not dismiss this - it'll come back");
      return;
    }
    setDismissed(true);
    onDone();
  }

  return (
    <div className="wq-wrapup">
      <p className="wq-wrapup-title">The queue is drained. Ship it?</p>
      <label className="alert-row">
        <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} />
        Create a PR
      </label>
      <label className="alert-row">
        <input type="checkbox" checked={nm} onChange={(e) => setNm(e.target.checked)} />
        Run no-mistakes
      </label>
      <textarea
        className="field-input"
        rows={3}
        value={text}
        onChange={(e) => {
          setTouched(true);
          setText(e.target.value);
        }}
      />
      <div className="wq-actions">
        <button className="btn btn-primary" disabled={busy || sent || !text.trim()} onClick={() => void send()}>
          Send
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
      </div>
      {err && <p className="wq-error">{err}</p>}
    </div>
  );
}

/**
 * The composed wrap-up instruction. A guess, which is exactly why the textarea is
 * editable. Both ticked prefills `/no-mistakes` alone, because that pipeline
 * pushes and opens the PR itself - asking for both would double up.
 */
function composeWrapup(pr: boolean, nm: boolean): string {
  if (nm) return "/no-mistakes";
  if (pr) return "Please commit this work, push the branch, and open a PR.";
  return "";
}

/** The re-attach affordance for a queue left behind by a previous session here. */
function ReattachHint({
  session,
  onDone,
}: {
  session: Session;
  onDone: () => void;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = session.orphanedQueue;
  if (!hint) return null;

  async function reattach(): Promise<void> {
    setBusy(true);
    const r = await api.reattachQueue(session.id, hint!.noteKey);
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "could not re-attach that queue");
    else onDone();
  }

  return (
    <div className="wq-orphan">
      <p>
        {hint.itemCount} queued {hint.itemCount === 1 ? "item" : "items"} from a previous session here
        {hint.branch ? ` (${hint.branch})` : ""} - re-attach?
      </p>
      <div className="wq-actions">
        <button className="btn" disabled={busy} onClick={() => void reattach()}>
          Re-attach
        </button>
      </div>
      {err && <p className="wq-error">{err}</p>}
    </div>
  );
}

/**
 * Why this session can't hold a work queue, or null when it can. Letting someone
 * queue work that escalates on arrival is a worse answer than not offering it.
 *
 * Both reasons are PERMANENT incapacities, and that is the bar. `hooksSeen` rather
 * than `instrumented`: the latter is a 30-minute freshness window on the hook
 * overlay, so gating on it declared "install the Claude integrations" over a
 * perfectly instrumented session that had merely been quiet for half an hour - and
 * then hid its whole queue behind that sentence, leaving the items unreachable. A
 * session that has ever reported a hook has the integrations; whether it reported
 * one recently is not this question.
 */
function queueBlockedReason(s: Session): string | null {
  if (s.agent !== "claude") {
    return "Work queues are Claude-only for now - Foreman reads transcripts to check the work, and there's no transcript for a Codex session.";
  }
  if (!s.hooksSeen) {
    return "This session has no hooks reporting, so Foreman can't tell when it picks work up or finishes it. Install the Claude integrations to queue work here.";
  }
  return null;
}
