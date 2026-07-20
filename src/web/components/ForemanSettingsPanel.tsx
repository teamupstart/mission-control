import { useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import {
  FOREMAN_MODEL_ROLES,
  FOREMAN_MODEL_SPECS,
  FOREMAN_MODEL_SUGGESTIONS,
} from "@shared/foreman-models.ts";
import type { ForemanModelRole, ResolvedForemanModel } from "@shared/foreman-models.ts";
import type { ForemanConfigPatch } from "@shared/protocol.ts";

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

/**
 * The line under a model field saying WHERE the value in the box came from.
 *
 * Deliberately does not name the model: the id is already sitting in the input directly
 * above (as the placeholder, when the box is empty), and printing it twice inside 60px
 * reads as two facts when it is one. What an empty greyed box genuinely cannot tell you
 * is which of two very different things it means - a shipped default, or an env var set
 * outside the app that silently outranks anything you type here. That is this line's
 * whole job.
 *
 * Silent for `config`, where the box shows your own value and there is nothing to explain.
 */
export function modelSourceNote(
  resolved: ResolvedForemanModel | undefined,
  envVar: string,
): string | null {
  if (!resolved || resolved.source === "config") return null;
  return resolved.source === "env"
    ? `From ${envVar} in the daemon's environment.`
    : "Shipped default.";
}

/**
 * One model field.
 *
 * Uncontrolled-with-a-draft rather than bound straight to config, because `useForeman`
 * re-polls every 4s: an input driven by that would drop a character every time a poll
 * landed mid-word. The draft is the truth while you are typing, and re-syncs from config
 * only when the box is not focused - so an edit made in another tab still shows up here
 * without ever fighting the keyboard.
 *
 * Commit is on blur and on Enter, and only when the value actually changed, so tabbing
 * through the four fields doesn't write four times.
 */
function ModelField({
  role,
  value,
  resolved,
  disabled,
  onCommit,
}: {
  role: ForemanModelRole;
  value: string;
  resolved: ResolvedForemanModel | undefined;
  disabled: boolean;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  const spec = FOREMAN_MODEL_SPECS[role];
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // Whether this box has been TYPED IN since it was focused. Without it, blurring a box
  // you only clicked into would write its stale draft back: the poll can't refresh a
  // focused field, so a value changed elsewhere (another tab, the env, a direct PUT)
  // would be silently reverted by a click-in-click-out that changed nothing. Commit is
  // for edits, and "I put the cursor here" is not one.
  const dirty = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    const next = draft.trim();
    setDraft(next);
    if (dirty.current && next !== value) onCommit(next);
    dirty.current = false;
  };

  const note = modelSourceNote(resolved, spec.envVar);
  return (
    <div className="foreman-model-row">
      <label className="foreman-model-label" htmlFor={`foreman-model-${role}`}>
        {spec.label}
      </label>
      <input
        id={`foreman-model-${role}`}
        className="field-input mono foreman-model-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        // The resolved id, not the shipped fallback: an empty box under a set env var
        // must not advertise a default that env var is overriding.
        placeholder={resolved?.id ?? spec.fallback}
        value={draft}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          // Escape abandons the edit rather than committing it, matching every other
          // compose box in the app.
          if (e.key === "Escape") {
            setDraft(value);
            dirty.current = false;
            focused.current = false;
            e.currentTarget.blur();
          }
        }}
      />
      <p className="settings-hint foreman-model-blurb">{spec.blurb}</p>
      {note && <p className="foreman-model-source">{note}</p>}
    </div>
  );
}

export function ForemanSettingsPanel({ state }: { state: ForemanState }): React.JSX.Element {
  const { config, status, update, error } = state;
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
        <p className="settings-hint foreman-models-hint">
          Foreman spawns a fresh, tool-less <code>claude -p</code> for each of these. Leave a
          field empty to accept the value shown in it. Review and Verify are the expensive
          calls; Triage and Backlog are deliberately cheaper.
        </p>
        {/* Named in prose rather than offered in a picker: a native <datalist> is
            browser chrome this theme can't touch (which is why `RepoCombobox` exists),
            and a combobox is a lot of widget for three ids. Any id the CLI accepts works. */}
        <p className="settings-hint foreman-models-hint">
          Common ids:{" "}
          {FOREMAN_MODEL_SUGGESTIONS.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <code>{id}</code>
            </span>
          ))}
          . Any model your <code>claude</code> CLI accepts will do.
        </p>
        {FOREMAN_MODEL_ROLES.map((role) => (
          <ModelField
            key={role}
            role={role}
            value={config?.[FOREMAN_MODEL_SPECS[role].configKey] ?? ""}
            resolved={status?.models?.[role]}
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
