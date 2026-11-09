import { useState } from "react";
import type { Session, SessionBlocker } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { BLOCKER_KIND_LABELS, blockerAge, blockerFlaggedBy, blockerHref } from "../lib/blocker.ts";
import { relativeTime } from "../lib/format.ts";
import { Markdown } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The red band at the top of the Conversation tab for a session standing on a blocker.
 *
 * It always shows every field, unlike the card: this is where the operator reads the whole
 * blocker and clears it, so nothing here is a Display item. Flag reply marks a likely answer
 * without clearing anything; Clear blocker ends the hold.
 */
export function SessionBlockerBand({ session }: { session: Session }): React.JSX.Element | null {
  const blocker = session.blocker ?? null;
  if (!blocker) return null;
  return <BlockerBand key={blocker.startedAt} sessionId={session.id} blocker={blocker} />;
}

function BlockerBand({ sessionId, blocker }: { sessionId: string; blocker: SessionBlocker }): React.JSX.Element {
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = blockerHref(blocker.referenceUrl);
  const replyHref = blockerHref(blocker.reply?.referenceUrl ?? null);

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
    <section className="blocker-band" aria-label="Session blocker">
      <header className="blocker-band-head">
        <span className="blocker-band-flag">Blocked</span>
        <span className="blocker-band-kind">{BLOCKER_KIND_LABELS[blocker.kind]}</span>
        <Tooltip label={`Blocked since ${new Date(blocker.startedAt).toLocaleString()}`}>
          <span className="blocker-band-since">since {blockerAge(blocker.startedAt)}</span>
        </Tooltip>
      </header>
      <p className="blocker-band-reason">{blocker.reason}</p>
      <dl className="blocker-band-facts">
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
      {blocker.reply && (
        <p className="blocker-band-reply" role="status">
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
          className="blocker-band-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api.flagBlockerReply(sessionId, {
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
      {error && <p className="blocker-band-error" role="alert">{error}</p>}
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
              onClick={() => void run(() => api.clearBlocker(sessionId))}
            >
              Clear blocker
            </button>
          </Tooltip>
        </div>
      )}
    </section>
  );
}
