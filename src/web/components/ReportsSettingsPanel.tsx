import { useEffect, useState } from "react";
import type { ReportGuidanceView } from "@shared/protocol.ts";
import { REPORT_GUIDANCE_RULES, type ReportMute } from "@shared/reports.ts";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Settings > Reports (`inbox` flag): the two noise controls that are settings rather than inbox
 * actions.
 *
 * **Report guidance** is the text that tells agents when to post a report. It is the editable
 * half of `post_report`'s description; the other half (progress goes to `report_status`, and
 * decisions are questions) is fixed and shown beneath the box. A session's MCP child reads the
 * guidance once when it starts, so a save reaches sessions started afterwards and a running
 * session keeps the guidance it started with. Reset to default saves "no guidance", which is
 * the shipped text.
 *
 * **Muted agents** lists every muted author with Unmute. A muted author's reports leave the
 * inbox, so this is the one place to unmute; Mute itself is on the report card. The list is the
 * event stream's (`report_mutes`), so an Unmute here and a Mute in the inbox show everywhere.
 */
export function ReportsSettingsPanel({
  mutes,
  initialGuidance = null,
  now,
}: {
  mutes: readonly ReportMute[];
  /** The guidance already read, for a render test; a live panel reads it when it mounts. */
  initialGuidance?: ReportGuidanceView | null;
  /** Injectable so a render test can own the clock. */
  now?: number;
}): React.JSX.Element {
  return (
    <section className="settings-section reports-settings" aria-label="Reports">
      <p className="settings-hint settings-blurb">
        For when agent reports get chatty. Change when agents are told to post a report, and mute
        an agent whose reports you do not want to hear about. A muted agent can still post: its
        reports raise no notification and are not listed in the inbox or the to read figure, and
        they stay in its conversation.
      </p>
      <GuidanceEditor initial={initialGuidance} />
      <MutedAgents mutes={mutes} now={now} />
    </section>
  );
}

function GuidanceEditor({ initial }: { initial: ReportGuidanceView | null }): React.JSX.Element {
  const [view, setView] = useState<ReportGuidanceView | null>(initial);
  const [draft, setDraft] = useState(initial?.effective ?? "");
  const [unreadable, setUnreadable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    void api.reportGuidance().then((read) => {
      if (!alive) return;
      if (!read.ok) {
        setUnreadable(true);
        return;
      }
      setView(read.value);
      setDraft(read.value.effective);
    });
    return () => {
      alive = false;
    };
  }, [initial]);

  const save = (guidance: string | null, done: string) => {
    setSaving(true);
    setError(null);
    setSaved(null);
    void api.saveReportGuidance(guidance).then((result) => {
      setSaving(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setView(result.view);
      setDraft(result.view.effective);
      setSaved(done);
    });
  };

  const limit = view?.limit ?? 0;
  const over = view !== null && draft.length > limit;
  const dirty = view !== null && draft !== view.effective;
  const isDefault = view !== null && view.guidance === null;

  return (
    <section className="reports-settings-group" data-anchor="reports/guidance">
      <div className="settings-section-head">
        <div>
          <h4>Report guidance</h4>
          <p className="settings-hint">
            What agents are told about when to post a report. Sessions started after you save use
            it; a session already running keeps the guidance it started with.
          </p>
        </div>
      </div>
      {view === null ? (
        <p className={unreadable ? "settings-error" : "settings-hint"}>
          {unreadable ? "The report guidance could not be read." : "Reading the report guidance..."}
        </p>
      ) : (
        <>
          <textarea
            className="si-textarea reports-guidance-text"
            aria-label="Report guidance"
            rows={5}
            value={draft}
            disabled={saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(null);
            }}
          />
          <div className="si-card-meta">
            <span className={over ? "si-counter si-counter-over" : "si-counter"}>
              {`${draft.length.toLocaleString()} / ${limit.toLocaleString()}`}
            </span>
            <span className="si-format">{isDefault ? "default" : "your own"}</span>
          </div>
          <p className="settings-hint">
            Always added after it, and not editable: {REPORT_GUIDANCE_RULES}
          </p>
          {error && <p className="settings-error" role="alert">{error}</p>}
          {saved && <p className="settings-hint" role="status">{saved}</p>}
          <div className="si-actions">
            <Tooltip label="Save this guidance. Sessions started from now on are told it">
              <button
                type="button"
                className="btn"
                disabled={!dirty || over || saving}
                onClick={() => save(draft, "Saved. Sessions started from now on use this guidance.")}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </Tooltip>
            <Tooltip label="Put the shipped guidance back. Sessions started from now on are told it">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving || (isDefault && !dirty)}
                onClick={() => save(null, "Reset. Sessions started from now on use the default guidance.")}
              >
                Reset to default
              </button>
            </Tooltip>
          </div>
        </>
      )}
    </section>
  );
}

function MutedAgents({ mutes, now }: { mutes: readonly ReportMute[]; now?: number }): React.JSX.Element {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const unmute = (mute: ReportMute) => {
    setError(null);
    setBusy((current) => new Set(current).add(mute.authorKey));
    void api.unmuteReports(mute.authorKey).then((result) => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(mute.authorKey);
        return next;
      });
      // A mute already gone (another window unmuted it) is the outcome asked for.
      if (!result.ok && result.status !== 404) setError(result.error ?? `Could not unmute ${mute.authorName}`);
    });
  };
  return (
    <section className="reports-settings-group" data-anchor="reports/muted">
      <div className="settings-section-head">
        <div>
          <h4>Muted agents</h4>
          <p className="settings-hint">
            Their reports raise no notification and are not listed in the inbox. Nothing is marked
            read, so unmuting lists every report still waiting. A notification that arrived before
            the mute still opens its report.
          </p>
        </div>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {mutes.length === 0 ? (
        <p className="settings-hint">No agent is muted. Mute one from its report card in the inbox.</p>
      ) : (
        <ul className="reports-muted-list" aria-label="Muted agents">
          {mutes.map((mute) => (
            <li key={mute.authorKey} className="reports-muted-row">
              <strong>{mute.authorName}</strong>
              <span className="dim"> · muted {relativeTime(mute.mutedAt, now)}</span>
              <Tooltip label={`List ${mute.authorName}'s reports in the inbox again, and notify you about its new ones`}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Unmute ${mute.authorName}`}
                  disabled={busy.has(mute.authorKey)}
                  onClick={() => unmute(mute)}
                >
                  Unmute
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
