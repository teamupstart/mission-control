import { useEffect, useRef, useState } from "react";
import type { InspectorInspection } from "@shared/types.ts";
import type { InspectorState } from "../useInspector.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { candidateRepos } from "./ForemanSettingsPanel.tsx";

// The Inspector's settings category.
//
// This panel has one job the other panels don't: it is the only place that says, in
// plain words, that turning this on causes something to be PUBLISHED under the operator's
// GitHub account. Every other control in the app is local. So the copy here is part of
// the feature, not decoration around it.

const MODE_LABEL: Record<"dry-run" | "live", string> = {
  "dry-run": "Dry run - review and record findings, post nothing",
  live: "Live - post review comments on GitHub",
};

/** Relative time for the inspections list. Coarse on purpose - this is an at-a-glance list. */
export function ago(then: number | null, now: number): string {
  if (then === null) return "not yet reviewed";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** What one ledger row says about itself, in one phrase. */
export function inspectionSummary(row: InspectorInspection): string {
  if (row.lastError) return "failed";
  if (row.round === 0) return "queued";
  if (row.openFindings === 0) return "clean";
  return `${row.openFindings} finding${row.openFindings === 1 ? "" : "s"}`;
}

export function InspectorSettingsPanel({ state }: { state: InspectorState }): React.JSX.Element {
  const { config, inspections, update, error } = state;
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const allowlist = config?.repoAllowlist ?? [];
  // Same stale-closure guard as the Foreman panel: `add` does a server round-trip while
  // the config polls underneath it, so the write must extend whatever is in force when it
  // lands rather than what was on screen when the button was clicked.
  const allowlistRef = useRef(allowlist);
  allowlistRef.current = allowlist;
  const candidates = candidateRepos(repos, allowlist);
  const now = Date.now();

  async function add(): Promise<void> {
    const path = draft.trim();
    if (!path || adding || !config) return;
    setAdding(true);
    setAddError(null);
    const res = await resolveRepo(path);
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    const current = allowlistRef.current;
    if (current.includes(res.repoRoot)) {
      setAddError(`${res.repoRoot} is already trusted`);
      return;
    }
    setDraft("");
    await update({ repoAllowlist: [...current, res.repoRoot] });
  }

  function remove(path: string): void {
    void update({ repoAllowlist: allowlist.filter((p) => p !== path) });
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Inspector</h3>
      </div>

      <p className="settings-hint">
        Reviews the pull requests Mission Control opened - and only those - against the
        repository's <code>INSPECTOR.md</code>. It comments on what it finds, answers replies in
        its own threads, re-reviews on every push, and closes its own threads once a push
        fixes them.
      </p>

      {/* The daemon has not answered. Said out loud, because the fallbacks below are
          `off` / `dry run` / `no repos` - the safe posture - and presenting schema
          defaults as the daemon's answer tells the operator the Inspector is quiet when
          the stored config may well be enabled and live. Disabled inputs are not a
          statement about what is running. */}
      {!config && (
        <p className="settings-warn inspector-unknown">
          Can't reach the daemon, so what the Inspector is actually set to is unknown. The
          controls below are showing defaults, not its current state.
        </p>
      )}

      <label className="alert-row inspector-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!config}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
        <span>Run the Inspector</span>
      </label>

      <fieldset className="inspector-modes">
        <legend>Mode</legend>
        {(["dry-run", "live"] as const).map((m) => (
          <label className="alert-row" key={m}>
            <input
              type="radio"
              name="inspector-mode"
              checked={mode === m}
              disabled={!config}
              onChange={() => void update({ mode: m })}
            />
            <span>{MODE_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>

      {/* The one warning in this app about something leaving the machine. It is shown
          whenever live is selected, not only on the click that selects it, because the
          risk is ongoing rather than momentary. */}
      {mode === "live" && enabled && (
        <p className="settings-warn inspector-live-warn">
          Comments are posted to GitHub under your account, and are public on a public
          repository. The Inspector can read files in the reviewed worktree to do its job.
        </p>
      )}

      <div className="foreman-repos">
        <p className="settings-group-label">Reviewed repositories</p>
        <p className="settings-hint foreman-repos-hint">
          The Inspector only posts in these repos - their worktrees count too, wherever they
          live on disk. It still reviews everywhere while in dry run.
        </p>

        {allowlist.length === 0 ? (
          <p className="settings-hint foreman-repos-empty">
            {config
              ? "No repos yet - the Inspector won't post anywhere."
              : "Unknown - the daemon hasn't said which repos are trusted."}
          </p>
        ) : (
          <ul className="foreman-repo-list">
            {allowlist.map((path) => (
              <li className="foreman-repo-row" key={path}>
                <span className="foreman-repo-path" title={path}>
                  {path}
                </span>
                <button
                  className="foreman-repo-remove"
                  onClick={() => remove(path)}
                  title="Stop reviewing this repo"
                  aria-label={`Stop reviewing ${path}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="foreman-repo-add">
          <RepoCombobox
            repos={candidates}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setAddError(null);
            }}
          />
          <button
            className="btn"
            disabled={!config || !draft.trim() || adding}
            onClick={() => void add()}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {addError && <p className="settings-error">{addError}</p>}
      </div>

      {/* Without this, dry run is indistinguishable from broken: it reviews, finds things,
          posts nothing, and says nothing anywhere. This is where you read what it WOULD
          have said before you let it speak. */}
      <div className="inspector-log">
        <p className="settings-group-label">Recent inspections</p>
        {inspections.length === 0 ? (
          <p className="settings-hint">
            Nothing yet. A pull request appears here once Mission Control opens one.
          </p>
        ) : (
          <ul className="inspector-log-list">
            {inspections.map((row) => (
              <li className="inspector-log-row" key={row.key}>
                <a
                  className="inspector-log-pr"
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  title={row.lastError ?? row.url}
                >
                  {row.repo}#{row.number}
                </a>
                <span
                  className={`inspector-log-state${row.lastError ? " inspector-log-failed" : ""}`}
                >
                  {inspectionSummary(row)}
                </span>
                <span className="inspector-log-when">{ago(row.lastReviewedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
