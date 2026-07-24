import type { InspectorInspection } from "@shared/types.ts";
import type { InspectorState } from "../useInspector.ts";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";
import { INSPECTOR_MODEL_SPEC } from "@shared/inspector.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

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

/**
 * What one ledger row says about itself, in one phrase.
 *
 * The RETIRED branch is the one to keep: a row whose PR has closed is out of the sweep
 * for good (`loadOpenInspectorPrs` selects `state = 'open'`), and `processPr` clears
 * `lastError` on the way out, so without this it lands on `round === 0` and reads
 * "queued" - forever, for something that will never be looked at again. Two dozen merged
 * PRs said "queued / not yet reviewed" on this panel, which is not a slow queue being
 * reported honestly, it is a finished one being reported wrongly.
 *
 * A retired row that WAS reviewed keeps its findings instead: that is the record of what
 * the Inspector said about a PR that has since landed, and it is the more useful fact.
 */
export function inspectionSummary(row: InspectorInspection): string {
  if (row.lastError) return "failed";
  if (row.state === "closed" && row.round === 0) return row.mergedAt ? "merged" : "closed";
  if (row.round === 0) return "queued";
  if (row.openFindings === 0) return "clean";
  return `${row.openFindings} finding${row.openFindings === 1 ? "" : "s"}`;
}

export function InspectorSettingsPanel({
  state,
  onNavigate,
}: {
  state: InspectorState;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, inspections, model, update, error } = state;
  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const allowlist = config?.repoAllowlist ?? [];
  const now = Date.now();

  return (
    <section className="settings-section">
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

      <Tooltip label="Review the pull requests Mission Control opened, and comment on them">
        <label className="alert-row inspector-toggle" data-anchor="inspector/enabled">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!config}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          <span>Run the Inspector</span>
        </label>
      </Tooltip>

      <fieldset className="inspector-modes" data-anchor="inspector/mode">
        <legend>Mode</legend>
        {(["dry-run", "live"] as const).map((m) => (
          <Tooltip
            key={m}
            label={
              m === "live"
                ? "Post the Inspector's findings to GitHub as review comments"
                : "Compute findings and show them here, but post nothing to GitHub"
            }
          >
            <label className="alert-row">
              <input
                type="radio"
                name="inspector-mode"
                checked={mode === m}
                disabled={!config}
                onChange={() => void update({ mode: m })}
              />
              <span>{MODE_LABEL[m]}</span>
            </label>
          </Tooltip>
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

      {/* Reusing Foreman's `foreman-model*` classes rather than minting `inspector-`
          copies of the same six rules: the markup is the shared `ModelField`, so a second
          class vocabulary would be two selectors to keep in step for one widget. */}
      <div className="foreman-models">
        <p className="settings-group-label">Model</p>
        <label
          className="foreman-model-row"
          htmlFor="inspector-provider"
          data-anchor="inspector/provider"
        >
          <span className="foreman-model-label">Provider</span>
          <Tooltip label="Which model provider the Inspector's review call is spawned with">
          <select
            id="inspector-provider"
            className="field-input foreman-model-input"
            value={config?.runner ?? "claude"}
            disabled={!config}
            onChange={(e) =>
              void update({
                runner: e.target.value as (typeof LLM_RUNNER_IDS)[number],
                model: "",
              })
            }
          >
            {LLM_RUNNER_IDS.map((runner) => (
              <option key={runner} value={runner}>{AGENT_IDENTITY[runner].label}</option>
            ))}
          </select>
          </Tooltip>
          <span className="settings-hint foreman-model-blurb">Runs reviews and follow-up replies through this provider.</span>
        </label>
        <p className="settings-hint foreman-models-hint">
          The Inspector starts an isolated call per review. Claude receives read-only tools
          scoped to the worktree; Codex reviews the supplied diff without repository tools.
        </p>
        <ModelSuggestions providerLabel={AGENT_IDENTITY[config?.runner ?? "claude"].label} />
        <ModelField
          anchor="inspector/model"
          id="inspector-model"
          spec={INSPECTOR_MODEL_SPEC}
          value={config?.model ?? ""}
          resolved={model ?? undefined}
          runner={config?.runner ?? "claude"}
          disabled={!config}
          onCommit={(next) =>
            // Empty is STORED as empty, same rule as Foreman's fields: it means "clear my
            // override and go back to the ladder", and dropping it from the patch would
            // leave the old id in place while the box looks cleared.
            void update({ model: next })
          }
        />
      </div>

      <div className="foreman-repos" data-anchor="inspector/reviewed-repos">
        <p className="settings-group-label">Reviewed repositories</p>
        {/* The consent copy stays with the count: it is about the grant, not the editor. */}
        <p className="settings-hint foreman-repos-hint">
          The Inspector only posts in these repos - their worktrees count too, wherever they
          live on disk. It still reviews everywhere while in dry run.
        </p>
        <TrustGrantSummary
          configured={Boolean(config)}
          count={allowlist.length}
          subject="The Inspector may post reviews in"
          onNavigate={onNavigate}
        />
      </div>

      {/* Without this, dry run is indistinguishable from broken: it reviews, finds things,
          posts nothing, and says nothing anywhere. This is where you read what it WOULD
          have said before you let it speak. */}
      <div className="inspector-log" data-anchor="inspector/recent">
        <p className="settings-group-label">Recent inspections</p>
        {inspections.length === 0 ? (
          <p className="settings-hint">
            Nothing yet. A pull request appears here once Mission Control opens one.
          </p>
        ) : (
          <ul className="inspector-log-list">
            {inspections.map((row) => (
              <li
                className={`inspector-log-row${row.state === "closed" ? " is-retired" : ""}`}
                key={row.key}
              >
                <Tooltip label={row.lastError ?? `Open ${row.repo}#${row.number} on GitHub`}>
                  <a
                    className="inspector-log-pr"
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.repo}#{row.number}
                  </a>
                </Tooltip>
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
