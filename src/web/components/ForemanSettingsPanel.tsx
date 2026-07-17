import { useEffect, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";

// Foreman's set-once configuration, as a settings category. The topbar popover keeps the
// in-the-moment knobs (enable, mode, work queues, on-drain); the durable posture lives
// here: the cheap-tier stance, and the list of repos Foreman is trusted to send in live.

const TIER_LABEL: Record<"off" | "shadow" | "on", string> = {
  off: "Off - full review for every prompt",
  shadow: "Shadow - run the cheap tier alongside, measure it",
  on: "On - cheap tier answers the easy ones",
};

/** Repos worth offering in the picker: known repos, minus the ones already trusted. */
export function candidateRepos(repos: string[], allowlist: string[]): string[] {
  return repos.filter((r) => !allowlist.includes(r));
}

export function ForemanSettingsPanel({ state }: { state: ForemanState }): React.JSX.Element {
  const { config, update, error } = state;
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // The workspace's git repos, for the picker. `/api/repos` scans the workspace roots,
  // so it offers repos that have no live session yet - exactly the ones you'd want to
  // trust before dispatching into them, which a session-derived list would miss.
  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const allowlist = config?.repoAllowlist ?? [];
  const triage = config?.triage ?? "shadow";
  // Don't offer a repo that's already trusted.
  const candidates = candidateRepos(repos, allowlist);

  async function add(): Promise<void> {
    const path = draft.trim();
    if (!path || adding || !config) return;
    setAdding(true);
    setAddError(null);
    // Validate + canonicalize server-side so the stored path is the realpath the daemon
    // gates on, and a typo is refused here instead of sitting inert on the list.
    const res = await resolveRepo(path);
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    setDraft("");
    if (allowlist.includes(res.repoRoot)) return; // already trusted - nothing to add
    await update({ repoAllowlist: [...allowlist, res.repoRoot] });
  }

  function remove(path: string): void {
    void update({ repoAllowlist: allowlist.filter((p) => p !== path) });
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Foreman</h3>
      </div>

      <p className="settings-hint foreman-settings-blurb">
        Foreman's set-once configuration. Turning it on, its mode, the work queues, and the
        on-drain action stay in the topbar Foreman control - the things you reach for while
        watching the fleet.
      </p>

      <fieldset className="foreman-modes">
        <legend>Cheap tier</legend>
        {(["off", "shadow", "on"] as const).map((t) => (
          <label className="alert-row" key={t}>
            <input
              type="radio"
              name="foreman-triage-settings"
              checked={triage === t}
              disabled={!config}
              onChange={() => void update({ triage: t })}
            />
            {TIER_LABEL[t]}
          </label>
        ))}
      </fieldset>

      <div className="foreman-repos">
        <p className="settings-group-label">Live repositories</p>
        {/* Worktrees of these repos count too - the same thing the old popover textarea
            said, kept because "I set it live and it still asks me" reads as a bug otherwise. */}
        <p className="settings-hint foreman-repos-hint">
          When Foreman is Live it only sends on your behalf in these repos - their worktrees
          count too, wherever they live on disk. Add the ones you trust.
        </p>

        {allowlist.length === 0 ? (
          <p className="settings-hint foreman-repos-empty">
            No repos yet - Foreman won't act live anywhere.
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
                  title="Remove from the trusted list"
                  aria-label={`Stop trusting ${path}`}
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

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
