import { useCallback, useEffect, useRef, useState } from "react";
import type { NmFixDetail, NmFixSummary } from "@shared/types.ts";
import { fetchNomistakesFix } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * What no-mistakes changed on this session's branch, and why.
 *
 * Read from git rather than from a run, so it outlives the run that made it - a
 * finished run stops being interesting to watch at exactly the moment it starts
 * being interesting to review. It empties when the session is reset, because the
 * reset destroys the commits it's derived from.
 *
 * Collapsed to a single rollup row by default. Open, the list is a bounded scroll
 * region: grid cards keep a constant height, while Console and Board detail views
 * give the scroller a viewport-responsive cap without consuming the transcript's
 * minimum height. Opening one fix expands INSIDE that scroller rather than pushing
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
  const contentRef = useRef<HTMLUListElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  const syncFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }, []);

  // Measure the CONTENT, not this component's own state. The scroller's height is
  // pinned by CSS, so what changes is what's inside it - and most of that is
  // invisible from here: a fix's detail arrives from a fetch held in FixRow's own
  // state, "+ N more findings" and "Show full reply" unclamp inside FixContext.
  // Re-measuring on [open, openSha] alone measured the "Loading…" placeholder and
  // never looked again, so the fade was absent exactly when the scroller had the
  // most hidden content. Observing the list covers every growth path at once,
  // including ones added later. Fires on observe, so it measures the first paint too.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, syncFade]);

  return (
    <div className={`nm-log${open ? " nm-log-open" : ""}`}>
      <Tooltip label={open ? "Fold the fix log away" : "Show every fix no-mistakes made in this session"}>
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
      </Tooltip>

      {open && (
        <>
          <div className={`nm-scrollwrap${atEnd ? " nm-at-end" : ""}`}>
            <div className="nm-scroll" ref={scrollRef} onScroll={syncFade}>
              <ul className="nm-fixrows" ref={contentRef}>
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

/**
 * How the reply lane is coloured: the foreman gets Claude's own tone, a human
 * (named or not) keeps the amber the lane has always used.
 *
 * The point of the colour is the distinction the whole feature exists for - a bot
 * changed your branch while you were away vs. you decided this - so it turns on
 * the foreman and nothing else.
 */
function whoClass(detail: NmFixDetail): string {
  return detail.attribution?.source === "foreman" ? "nm-who-foreman" : "nm-who-you";
}

/**
 * The lane's byline, or "" when we can't name an author.
 *
 * Silence is the honest common case, not a gap to fill: most gates are answered by
 * the agent driving itself, which no-mistakes records identically to a human reply
 * and which we never saw. "by someone" would be noise, and any guess would be the
 * exact overclaim this feature was built to remove.
 */
function byline(detail: NmFixDetail): string {
  const source = detail.attribution?.source;
  if (source === "you") return "by you, in the dashboard";
  // Not "by the foreman": it didn't write the reply above, the agent did, after
  // being nudged. The wording has to survive the case where the agent ignored the
  // nudge and answered something else entirely - which the data cannot rule out.
  if (source === "foreman") return "after a nudge from the foreman";
  return "";
}

/**
 * The foreman's own words about this gate, or null when there are none to show.
 *
 * One function because two places have to agree about it: the block that quotes the
 * nudge, and the "no guidance given" meta above it. Answered separately they
 * contradicted each other on the same card - the lane said nothing was said, while
 * the foreman's sentence sat two lines below it.
 */
function foremanSaid(detail: NmFixDetail): string | null {
  if (detail.attribution?.source !== "foreman") return null;
  return detail.attribution.text || null;
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
      {/* The foreman byline used to carry its own `title`. It sits INSIDE this button, so
          giving it a Tooltip of its own would put two bubbles on one hover - the row's
          handlers fire for the child too. The fact belongs in one sentence instead. */}
      <Tooltip
        label={
          (open ? "Fold this fix away" : "Show what this fix changed and why") +
          (fix.repliedBy === "foreman" ? " · the foreman nudged this gate" : "")
        }
      >
      <button className="nm-fixbtn" type="button" aria-expanded={open} onClick={onToggle}>
        <span className={`nm-steptag nm-step-${fix.step}`}>{fix.step}</span>
        <span className="nm-fixsum">{fix.summary}</span>
        {/* Only the foreman gets a chip on the collapsed row. Not a shortage of
            colours - a byline on every row is a byline nobody reads, and "you"
            is the row you already expect. The whole reason to scan this list is
            to catch the fix an autonomous actor caused while you were away, so
            that is the only one worth a mark from here. */}
        {fix.repliedBy === "foreman" && (
          <span className="nm-byline nm-byline-foreman">foreman</span>
        )}
        <span className="nm-fixwhen">{relativeTime(fix.committedAt)}</span>
      </button>
      </Tooltip>

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
 *
 * Exported for tests. The attribution lane below is a claim about who changed
 * your branch, so what it does and doesn't say is worth pinning directly - and
 * from outside it sits behind FixRow's fetch, reachable only by faking the API.
 */
export function FixContext({
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
  const said = foremanSaid(detail);

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
              <Tooltip label={f.description}>
                <p className="nm-find-why">{f.description}</p>
              </Tooltip>
            </div>
          ))}
          {hidden > 0 && (
            <Tooltip label="Show the findings this row is hiding">
              <button className="nm-more" type="button" onClick={() => setAllFindings(true)}>
                + {hidden} more finding{hidden === 1 ? "" : "s"}
              </button>
            </Tooltip>
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
          is nothing to quote there, so nothing is quoted.

          The byline is a SECOND axis over the same lane, off `attribution`, and
          only ever adds: an unattributed reply reads exactly as it did before
          (the agent drove its own gate, and nothing witnessed it). */}
      {detail.decision && (
        <section className="nm-ctx">
          <h4 className="nm-ctx-label">
            <span className={detail.decision === "replied" ? whoClass(detail) : "nm-who-auto"}>
              {detail.decision === "replied" ? "replied" : "auto-fixed"}
            </span>
            {detail.decision === "auto" ? (
              <span className="nm-ctx-meta">· nobody was asked</span>
            ) : (
              <>
                {byline(detail) && <span className="nm-ctx-meta">· {byline(detail)}</span>}
                {/* Only when there is nothing on the card to contradict it. The
                    statement is about the REPLY - the agent relayed a nudge with no
                    `--instructions`, so no guidance reached the fix - but a reader
                    sees the foreman's guidance quoted below and reads the two as
                    disagreeing. The block already shows that something was said, so
                    the block wins and the meta stands down. */}
                {!detail.reply && !said && <span className="nm-ctx-meta">· no guidance given</span>}
              </>
            )}
          </h4>
          {detail.reply ? (
            <>
              <p className={`nm-reply${fullReply ? " nm-reply-full" : ""}`}>{detail.reply}</p>
              {!fullReply && detail.reply.length > 180 && (
                <Tooltip label="Show the reply in full rather than its first lines">
                  <button className="nm-more" type="button" onClick={() => setFullReply(true)}>
                    Show full reply
                  </button>
                </Tooltip>
              )}
            </>
          ) : detail.decision === "auto" ? (
            <p className="nm-reply nm-reply-auto">
              The pipeline fixed this under its own round limit.
            </p>
          ) : null}

          {/* The foreman's own words, as their own block below the reply.
              Deliberately NOT merged with it: they are two sentences by two
              authors, and the foreman's is not the reply. It never calls `axi
              respond` - it types into the session's pane, and the AGENT decides
              what to answer, and is free to ignore the nudge entirely. So the
              heading claims only what the data supports: this was said about this
              gate, before this fix. Only for the foreman; the "you" lane's text
              IS the reply already quoted above, so repeating it would say the
              same sentence twice under two labels. */}
          {said && (
            <div className="nm-foreman-said">
              <span className="nm-foreman-tag">the foreman said this about this gate</span>
              {/* Clamped in CSS and full on hover, like the findings above rather
                  than like the reply, which earns its own expander by being the
                  thing you came to read. This is context for it. */}
              <Tooltip label={said}>
                <p className="nm-reply nm-reply-foreman">{said}</p>
              </Tooltip>
            </div>
          )}
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
              <Tooltip label={f.path}>
                <span className="nm-fname mono">{f.path}</span>
              </Tooltip>
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
        <Tooltip label="Open the diff for this fix's commit">
          <button className="btn nm-viewdiff" type="button" onClick={() => onOpenDiff(detail.sha)}>
            View diff
          </button>
        </Tooltip>
      </section>
    </>
  );
}
