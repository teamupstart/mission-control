import { useCallback, useEffect, useRef, useState } from "react";
import type { NmFixDetail, NmFixSummary } from "@shared/types.ts";
import { fetchNomistakesFix } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";

/**
 * What no-mistakes changed on this session's branch, and why.
 *
 * Read from git rather than from a run, so it outlives the run that made it - a
 * finished run stops being interesting to watch at exactly the moment it starts
 * being interesting to review. It empties when the session is reset, because the
 * reset destroys the commits it's derived from.
 *
 * Collapsed to a single rollup row by default. Open, the list is a bounded scroll
 * region: the card's height is a constant whether the branch carries three fixes
 * or forty, and opening one fix expands INSIDE the scroller rather than pushing
 * the footer down. Detail is fetched per fix on first open (a 22-finding fix runs
 * ~20KB of description text, which has no business on every card).
 */
export function NomistakesFixLog({
  sessionId,
  fixes,
  onOpenDiff,
}: {
  sessionId: string;
  fixes: NmFixSummary[];
  onOpenDiff: (sha: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  const syncFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }, []);

  // The fade is a lie if it lingers at the end of the list, and the list's height
  // changes when a fix opens - so re-measure on both.
  useEffect(() => syncFade(), [open, openSha, fixes, syncFade]);

  return (
    <div className={`nm-log${open ? " nm-log-open" : ""}`}>
      <button
        className="nm-rollup"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nm-log-brand">◇ fixed by no-mistakes</span>
        <span className="nm-log-split">{byStep(fixes)}</span>
        <span className="nm-log-count">{fixes.length}</span>
        <span className="nm-log-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className={`nm-scrollwrap${atEnd ? " nm-at-end" : ""}`}>
            <div className="nm-scroll" ref={scrollRef} onScroll={syncFade}>
              <ul className="nm-fixrows">
                {fixes.map((f) => (
                  <FixRow
                    key={f.sha}
                    sessionId={sessionId}
                    fix={f}
                    open={openSha === f.sha}
                    onToggle={() => setOpenSha((s) => (s === f.sha ? null : f.sha))}
                    onOpenDiff={onOpenDiff}
                  />
                ))}
              </ul>
            </div>
          </div>
          <div className="nm-log-foot">
            <span>Clears when you reset this session</span>
            <span className="spacer" />
            <span className="mono">origin..HEAD</span>
          </div>
        </>
      )}
    </div>
  );
}

/** "review 5 · document 3", in the order the steps actually ran. */
function byStep(fixes: NmFixSummary[]): string {
  const counts = new Map<string, number>();
  for (const f of fixes) counts.set(f.step, (counts.get(f.step) ?? 0) + 1);
  return [...counts].map(([step, n]) => `${step} ${n}`).join(" · ");
}

function FixRow({
  sessionId,
  fix,
  open,
  onToggle,
  onOpenDiff,
}: {
  sessionId: string;
  fix: NmFixSummary;
  open: boolean;
  onToggle: () => void;
  onOpenDiff: (sha: string) => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<NmFixDetail | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetch on first open and keep it: the context of a commit that already landed
  // can't change, so there's nothing to invalidate.
  useEffect(() => {
    if (!open || detail || failed) return;
    let alive = true;
    void fetchNomistakesFix(sessionId, fix.sha).then((d) => {
      if (!alive) return;
      if (d) setDetail(d);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [open, detail, failed, sessionId, fix.sha]);

  return (
    <li className={`nm-fixrow${open ? " nm-fixrow-open" : ""}`}>
      <button className="nm-fixbtn" type="button" aria-expanded={open} onClick={onToggle}>
        <span className={`nm-steptag nm-step-${fix.step}`}>{fix.step}</span>
        <span className="nm-fixsum">{fix.summary}</span>
        <span className="nm-fixwhen">{relativeTime(fix.committedAt)}</span>
      </button>

      {open && (
        <div className="nm-fixdetail">
          {!detail && !failed && <p className="nm-ctx-empty">Loading…</p>}
          {failed && <p className="nm-ctx-empty">Couldn&apos;t load this fix&apos;s context.</p>}
          {detail && <FixContext detail={detail} onOpenDiff={onOpenDiff} />}
        </div>
      )}
    </li>
  );
}

/**
 * The narrative behind one fix: what no-mistakes found, what authorized the fix,
 * and what changed. Sections that have no data are dropped rather than shown
 * empty - a fix whose round records are gone still deserves to list.
 */
function FixContext({
  detail,
  onOpenDiff,
}: {
  detail: NmFixDetail;
  onOpenDiff: (sha: string) => void;
}): React.JSX.Element {
  const [allFindings, setAllFindings] = useState(false);
  const [fullReply, setFullReply] = useState(false);
  const shown = allFindings ? detail.findings : detail.findings.slice(0, 2);
  const hidden = detail.findings.length - shown.length;
  // The server caps how many findings it carries but still reports how many there
  // were, so the count here is the real one - and when the list is short of it,
  // the gap is stated rather than left to look like the whole set.
  const capped = detail.findingCount - detail.findings.length;

  return (
    <>
      {detail.findings.length > 0 && (
        <section className="nm-ctx">
          <h4 className="nm-ctx-label">
            <span>no-mistakes found</span>
            <span className="nm-ctx-meta">
              · {detail.findingCount} finding{detail.findingCount === 1 ? "" : "s"}
            </span>
          </h4>
          {/* Keyed by position: an id is not guaranteed (the server admits a
              finding with an empty id as long as it has a description), so two
              findings in one file can share `id || file`. The list is static
              once fetched, and the shown slice is taken from the front. */}
          {shown.map((f, i) => (
            <div className="nm-find" key={`${f.id}:${f.file}:${i}`}>
              <div className="nm-find-top">
                {f.severity && <span className={`nm-sev nm-sev-${f.severity}`}>{f.severity}</span>}
                <span className="nm-find-loc mono">
                  {f.file}
                  {f.line !== null ? `:${f.line}` : ""}
                </span>
              </div>
              {/* Descriptions really do run ~900 chars; clamped in CSS, full on hover. */}
              <p className="nm-find-why" title={f.description}>
                {f.description}
              </p>
            </div>
          ))}
          {hidden > 0 && (
            <button className="nm-more" type="button" onClick={() => setAllFindings(true)}>
              + {hidden} more finding{hidden === 1 ? "" : "s"}
            </button>
          )}
          {allFindings && capped > 0 && (
            <p className="nm-capped">
              Showing {detail.findings.length} of {detail.findingCount}; the rest aren&apos;t kept.
            </p>
          )}
        </section>
      )}

      {/* Three lanes, and `decision` picks them - not `reply`. Answering a gate by
          selecting findings and typing nothing is the common case (the Fix box
          sends its instructions as `trim() || undefined`), which yields
          replied-with-no-text. Reading that off `reply` put the auto lane's copy
          under a "replied" label, claiming the opposite of what happened. There
          is nothing to quote there, so nothing is quoted. */}
      {detail.decision && (
        <section className="nm-ctx">
          <h4 className="nm-ctx-label">
            <span className={detail.decision === "replied" ? "nm-who-you" : "nm-who-auto"}>
              {detail.decision === "replied" ? "replied" : "auto-fixed"}
            </span>
            {detail.decision === "auto" ? (
              <span className="nm-ctx-meta">· nobody was asked</span>
            ) : detail.reply ? null : (
              <span className="nm-ctx-meta">· no guidance given</span>
            )}
          </h4>
          {detail.reply ? (
            <>
              <p className={`nm-reply${fullReply ? " nm-reply-full" : ""}`}>{detail.reply}</p>
              {!fullReply && detail.reply.length > 180 && (
                <button className="nm-more" type="button" onClick={() => setFullReply(true)}>
                  Show full reply
                </button>
              )}
            </>
          ) : detail.decision === "auto" ? (
            <p className="nm-reply nm-reply-auto">
              The pipeline fixed this under its own round limit.
            </p>
          ) : null}
        </section>
      )}

      <section className="nm-ctx">
        <h4 className="nm-ctx-label">
          <span>changed</span>
        </h4>
        <div className="nm-stat mono">
          <span className="nm-stat-sha">{detail.sha}</span>
          {/* filesChanged, not files.length: the list is capped and would otherwise
              disagree with the count on the row above for the same commit. */}
          <span>
            {detail.filesChanged} file{detail.filesChanged === 1 ? "" : "s"}
          </span>
          <span className="nm-add">+{detail.added}</span>
          <span className="nm-del">-{detail.removed}</span>
        </div>
        <ul className="nm-fixfiles">
          {detail.files.slice(0, 4).map((f) => (
            <li key={f.path}>
              <span className="nm-fname mono" title={f.path}>
                {f.path}
              </span>
              <span className="nm-fstat mono">
                +{f.added} -{f.removed}
              </span>
            </li>
          ))}
          {detail.filesChanged > 4 && (
            <li className="dim">
              <span className="nm-fname">+{detail.filesChanged - 4} more files</span>
            </li>
          )}
        </ul>
        <button className="btn nm-viewdiff" type="button" onClick={() => onOpenDiff(detail.sha)}>
          View diff
        </button>
      </section>
    </>
  );
}
