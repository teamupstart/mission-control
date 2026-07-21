import { useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import type { ForemanConfigPatch } from "@shared/protocol.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

// Foreman's set-once configuration, as a settings category. The topbar popover keeps the
// in-the-moment knobs (enable, mode, work queues, on-drain); the durable posture lives
// here: the cheap-tier stance, which model each call runs as, and the list of repos
// Foreman is trusted to send in live.

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
  const { config, status, update, error } = state;
  // The provider actually in force, not `config.runner ?? "claude"`. An unset `runner`
  // falls to the app-wide ladder, whose env layer the browser cannot see - so the daemon
  // reports the resolution and this renders it. See `ForemanStatus.runner`.
  const runner = config?.runner ?? status?.runner ?? "claude";
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
  // `add` resolves the path server-side before it writes, and the config polls every 4s
  // underneath that round-trip. Reading the list from a ref rather than the render closure
  // means the write extends whatever is in force when it lands, not what was on screen
  // when the button was clicked.
  const allowlistRef = useRef(allowlist);
  allowlistRef.current = allowlist;
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
    const current = allowlistRef.current;
    // A subdirectory of a trusted repo resolves back to that repo's root, so this is
    // reachable from a typed path even though the picker hides trusted repos. Say so
    // against the input the human typed, rather than clearing it like a success.
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

      <div className="foreman-models">
        <p className="settings-group-label">Models</p>
        <label className="foreman-model-row" htmlFor="foreman-provider">
          <span className="foreman-model-label">Provider</span>
          <select
            id="foreman-provider"
            className="field-input foreman-model-input"
            value={runner}
            disabled={!config}
            onChange={(e) => {
              const runner = e.target.value as (typeof LLM_RUNNER_IDS)[number];
              void update({
                runner,
                reviewModel: "",
                verifyModel: "",
                triageModel: "",
                backlogModel: "",
              });
            }}
          >
            {LLM_RUNNER_IDS.map((runner) => (
              <option key={runner} value={runner}>{AGENT_IDENTITY[runner].label}</option>
            ))}
          </select>
          <span className="settings-hint foreman-model-blurb">Runs every Foreman model role through this provider.</span>
        </label>
        <p className="settings-hint foreman-models-hint">
          Foreman spawns a fresh, isolated model call for each of these. Choose Default to
          use the provider-compatible value shown. Review and Verify are the expensive
          calls; Triage and Backlog are deliberately cheaper.
        </p>
        <ModelSuggestions runner={runner} />
        {FOREMAN_MODEL_ROLES.map((role) => (
          <ModelField
            key={role}
            id={`foreman-model-${role}`}
            spec={FOREMAN_MODEL_SPECS[role]}
            value={config?.[FOREMAN_MODEL_SPECS[role].configKey] ?? ""}
            resolved={status?.models?.[role]}
            runner={runner}
            disabled={!config}
            onCommit={(next) =>
              // An empty box is a cleared override, and must be STORED as empty so the
              // env/default ladder takes over again - not dropped from the patch, which
              // would leave the old value in place and look like the edit didn't stick.
              void update({ [FOREMAN_MODEL_SPECS[role].configKey]: next } as ForemanConfigPatch)
            }
          />
        ))}
      </div>

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
