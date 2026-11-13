import { useId, useState } from "react";
import type { Session, SessionBlocker } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { BLOCKER_KIND_LABELS, blockerAge, blockerFlaggedBy, blockerHref } from "../lib/blocker.ts";
import { relativeTime } from "../lib/format.ts";
import { Markdown } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The red band at the top of the Conversation tab for a session standing on a blocker.
 *
 * It is one row that always shows the kind, the reason, the age and both controls, and it
 * expands in place to every other field. The row's reason stays one truncated line even when
 * expanded, and the full reason is the first expanded fact: a reason allowed to wrap inside
 * the sticky row could grow it past the band's height cap and carry the controls with it.
 * The row never gives up height to the transcript below, so the controls cannot be squeezed
 * out of view by a long conversation. A flagged reply, the flag form and an error print under
 * the row whether or not it is expanded, because each is the answer to something the
 * operator just did or should do next.
 *
 * Unlike the card, nothing here is a Display item: this is where the operator reads the
 * whole blocker and clears it. Flag reply marks a likely answer without clearing anything;
 * Clear blocker ends the hold.
 */
export function SessionBlockerBand({ session }: { session: Session }): React.JSX.Element | null {
  const blocker = session.blocker ?? null;
  if (!blocker) return null;
  return <BlockerBand key={blocker.id} sessionId={session.id} blocker={blocker} />;
}

function BlockerBand({ sessionId, blocker }: { sessionId: string; blocker: SessionBlocker }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = blockerHref(blocker.referenceUrl);
  const replyHref = blockerHref(blocker.reply?.referenceUrl ?? null);
  const factsId = useId();

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      if (!r.ok) setError(r.error ?? "Mission Control refused the change");
      else after?.();
    } catch (err) {
      // A dropped connection or a restarting daemon must not leave the controls disabled.
      setError(err instanceof Error ? err.message : "Mission Control could not be reached");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={open ? "blocker-band is-open" : "blocker-band"} aria-label="Session blocker">
      <div className="blocker-band-row">
        <Tooltip label={open ? "Hide what this blocker waits on" : "Show what this blocker waits on and when it resumes"}>
          <button
            type="button"
            className="blocker-band-toggle"
            aria-expanded={open}
            aria-controls={factsId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="blocker-band-flag">Blocked</span>
            <span className="blocker-band-kind">{BLOCKER_KIND_LABELS[blocker.kind]}</span>
            <span className="blocker-band-reason">{blocker.reason}</span>
            <span className="blocker-band-chevron" aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={`Blocked since ${new Date(blocker.startedAt).toLocaleString()}`}>
          <span className="blocker-band-since">{blockerAge(blocker.startedAt)}</span>
        </Tooltip>
        {!flagging && (
          <div className="blocker-band-actions">
            <Tooltip label="Flag a likely answer without clearing the blocker">
              <button type="button" className="btn" disabled={busy} onClick={() => setFlagging(true)}>
                Flag reply
              </button>
            </Tooltip>
            <Tooltip label="End the hold so automation can pick this session up again">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void run(() => api.clearBlocker(sessionId, blocker.id))}
              >
                Clear blocker
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <div id={factsId} className="blocker-band-more blocker-band-facts-wrap" hidden={!open}>
        <dl className="blocker-band-facts">
          <dt>Reason</dt>
          <dd>{blocker.reason}</dd>
          <dt>Waiting on</dt>
          <dd>{blocker.waitingOn}</dd>
          <dt>Resumes when</dt>
          <dd>{blocker.resumeWhen}</dd>
          {href && (
            <>
              <dt>Reference</dt>
              <dd>
                <Tooltip label="Open where the question lives">
                  <a href={href} target="_blank" rel="noreferrer">{href}</a>
                </Tooltip>
              </dd>
            </>
          )}
          {blocker.checkedAt && (
            <>
              <dt>Last checked</dt>
              <dd>{relativeTime(blocker.checkedAt)}</dd>
            </>
          )}
        </dl>
        {blocker.details && (
          <details className="blocker-band-details">
            <Tooltip label="Show or hide the session's notes on this blocker">
              <summary>Details</summary>
            </Tooltip>
            <Markdown>{blocker.details}</Markdown>
          </details>
        )}
      </div>
      {blocker.reply && (
        <p className="blocker-band-more blocker-band-reply" role="status">
          <span className="blocker-band-reply-pill">Reply flagged</span>{" "}
          by {blockerFlaggedBy(blocker.reply.flaggedBy)} {relativeTime(blocker.reply.flaggedAt)}
          {blocker.reply.note && <>: {blocker.reply.note}</>}
          {replyHref && (
            <>
              {" "}
              <Tooltip label="Open the flagged reply">
                <a href={replyHref} target="_blank" rel="noreferrer">Open reply</a>
              </Tooltip>
            </>
          )}
        </p>
      )}
      {flagging && (
        <form
          className="blocker-band-more blocker-band-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api.flagBlockerReply(sessionId, {
                blockerId: blocker.id,
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(link.trim() ? { referenceUrl: link.trim() } : {}),
              }),
              () => {
                setFlagging(false);
                setNote("");
                setLink("");
              },
            );
          }}
        >
          <label>
            <span>Note</span>
            <input
              type="text"
              value={note}
              maxLength={500}
              placeholder="Dana answered at 14:02"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label>
            <span>Reply link</span>
            <input
              type="url"
              value={link}
              placeholder="https://"
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          <div className="blocker-band-actions">
            <Tooltip label="Mark a likely answer. The blocker stays and nothing is sent to the session">
              <button type="submit" className="btn" disabled={busy}>Flag</button>
            </Tooltip>
            <Tooltip label="Close without flagging">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setFlagging(false)}>
                Cancel
              </button>
            </Tooltip>
          </div>
        </form>
      )}
      {error && <p className="blocker-band-more blocker-band-error" role="alert">{error}</p>}
    </section>
  );
}
