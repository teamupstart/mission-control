import type { ForemanState } from "../useForeman.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import type { ForemanConfigPatch } from "@shared/protocol.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import type { ModelChoiceSpec } from "@shared/model-choice.ts";

// Foreman's set-once configuration, as a settings category. The topbar popover keeps the
// in-the-moment knobs (enable, mode, work queues, on-drain); the durable posture lives
// here: the cheap-tier stance, which model each call runs as, and the list of repos
// Foreman is trusted to send in live.

const TIER_LABEL: Record<"off" | "shadow" | "on", string> = {
  off: "Off - full review for every prompt",
  shadow: "Shadow - run the cheap tier alongside, measure it",
  on: "On - cheap tier answers the easy ones",
};

// Unlike Foreman's own model calls, a backlog launch runs the task's chosen harness.
// Keep one field per harness: a Claude id cannot be a meaningful Codex default.
const BACKLOG_TASK_MODEL_SPECS: Record<(typeof AGENT_TYPES)[number], ModelChoiceSpec> = {
  claude: {
    label: "Claude backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Claude task from the backlog.",
  },
  codex: {
    label: "Codex backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Codex task from the backlog.",
  },
  pi: {
    label: "Pi backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Pi task from the backlog.",
  },
};

export function ForemanSettingsPanel({
  state,
  onNavigate,
}: {
  state: ForemanState;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, status, update, error } = state;
  // The provider actually in force, not `config.runner ?? "claude"`. An unset `runner`
  // falls to the app-wide ladder, whose env layer the browser cannot see - so the daemon
  // reports the resolution and this renders it. See `ForemanStatus.runner`.
  const runner = config?.runner ?? status?.runner ?? "claude";
  const allowlist = config?.repoAllowlist ?? [];
  const triage = config?.triage ?? "shadow";

  return (
    <section className="settings-section">
      <p className="settings-hint foreman-settings-blurb">
        Foreman's set-once configuration. Turning it on, its mode, the work queues, and the
        on-drain action stay in the topbar Foreman control - the things you reach for while
        watching the fleet.
      </p>

      <fieldset className="foreman-modes" data-anchor="foreman/cheap-tier">
        <legend>Cheap tier</legend>
        {(["off", "shadow", "on"] as const).map((t) => (
          <Tooltip label={TIER_LABEL[t]} key={t}>
            <label className="alert-row">
              <input
                type="radio"
                name="foreman-triage-settings"
                checked={triage === t}
                disabled={!config}
                onChange={() => void update({ triage: t })}
              />
              {TIER_LABEL[t]}
            </label>
          </Tooltip>
        ))}
      </fieldset>

      <div className="foreman-models">
        <p className="settings-group-label">Models</p>
        <label
          className="foreman-model-row"
          htmlFor="foreman-provider"
          data-anchor="foreman/provider"
        >
          <span className="foreman-model-label">Provider</span>
          <Tooltip label="Which model provider Foreman's own calls are spawned with">
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
          </Tooltip>
          <span className="settings-hint foreman-model-blurb">Runs every Foreman model role through this provider.</span>
        </label>
        <p className="settings-hint foreman-models-hint">
          Foreman spawns a fresh, isolated model call for each of these. Choose Default to
          use the provider-compatible value shown. Review and Verify are the expensive
          calls; Triage and Backlog are deliberately cheaper.
        </p>
        <ModelSuggestions providerLabel={AGENT_IDENTITY[runner].label} />
        {FOREMAN_MODEL_ROLES.map((role) => (
          <ModelField
            key={role}
            anchor={`foreman/model-${role}`}
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

      <div className="foreman-models">
        <p className="settings-group-label">Backlog launch models</p>
        <p className="settings-hint foreman-models-hint">
          When Foreman starts a fresh backlog task, this selects its model unless the task
          already names one. Handing work to an existing session leaves that session's model
          unchanged.
        </p>
        {AGENT_TYPES.map((agent) => (
          <ModelField
            key={agent}
            anchor={`foreman/backlog-model-${agent}`}
            id={`foreman-backlog-task-model-${agent}`}
            spec={BACKLOG_TASK_MODEL_SPECS[agent]}
            value={config?.backlogDefaultModel?.[agent] ?? ""}
            resolved={undefined}
            runner={agent}
            disabled={!config}
            onCommit={(next) =>
              void update({ backlogDefaultModel: { [agent]: next || null } })
            }
          />
        ))}
      </div>

      <div className="foreman-repos" data-anchor="foreman/live-repos">
        <p className="settings-group-label">Live repositories</p>
        {/* The scope-of-consent sentence stays here beside the count even though editing
            moved to Trust: it is about the grant, not the editor. "I set it live and it
            still asks me" reads as a bug without it. */}
        <p className="settings-hint foreman-repos-hint">
          When Foreman is Live it only sends on your behalf in these repos - their worktrees
          count too, wherever they live on disk.
        </p>
        <TrustGrantSummary
          configured={Boolean(config)}
          count={allowlist.length}
          subject="Foreman may send live in"
          onNavigate={onNavigate}
        />
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
