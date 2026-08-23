import { useState } from "react";
import { LLM_JOB_IDS, LLM_JOB_SPECS } from "@shared/llm-jobs.ts";
import type { LlmJobId } from "@shared/llm-jobs.ts";
import { isLlmRunnerId, LLM_RUNNER_ENV_VAR } from "@shared/llm.ts";
import type { LlmState } from "../useLlm.ts";
import { modelSlotRow, SettingsMatrix } from "./SettingsMatrix.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Models category: which provider does the app's OWN offline work, and on which model.
//
// Two questions, and the panel keeps them apart because the code does. A runner answers
// "how is a model called" and is app-wide; a job answers "which model" and is per call.
// Folding them into one control would mean you could not run titling on a cheap local
// provider while reviewing with Claude, which is the whole reason the axes are separate
// (`@shared/llm.ts`).
//
// It deliberately does NOT edit Foreman's four models or the Inspector's one. Those live
// with their subsystems - in the blob that panel owns - and a second surface writing the
// same blob would turn a per-key merge into a lost update. The copy below says where they
// are rather than pretending this is every model in the app.

/** Where the value in a box came from, when it is not the box's own. See `modelSourceNote`. */
function runnerNote(state: LlmState): string | null {
  const runner = state.status?.runner;
  if (!runner) return null;
  if (runner.unknown) {
    // Said out loud rather than swallowed. A stored id this build cannot resolve looks
    // identical to an unset one once it has been replaced, and the operator would read the
    // selected row as their own choice rather than as a fallback from what they asked for.
    return `"${runner.unknown}" is not a provider this build has, so it fell back to the default.`;
  }
  if (runner.source === "config") return null;
  return runner.source === "env"
    ? `From ${LLM_RUNNER_ENV_VAR} in the daemon's environment, which outranks this picker.`
    : "Shipped default.";
}

export function LlmSettingsPanel({ state }: { state: LlmState }): React.JSX.Element {
  const { config, status, update, error } = state;
  const runners = status?.runners ?? [];
  // The operator's OWN stored choice first, then what the daemon resolved.
  //
  // Not `status.runner.id` alone, which is what this was: the status is re-read from the
  // daemon after every write, so a radio driven by it does not move on the click that changed
  // it - it moves a round trip later. The model boxes beside it were already optimistic, so
  // the one control on the page that lagged was the one being clicked.
  //
  // Reading config first cannot disagree with the daemon, because the config value is the TOP
  // rung of `resolveLlmRunner`: whenever it names a provider this build has, the resolved
  // answer is that same provider. An env-pinned installation is exactly the case where the
  // config value is empty, so it falls through here and the daemon's answer shows.
  const stored = config?.runner.trim() ?? "";
  const active = (stored && isLlmRunnerId(stored) ? stored : null) ?? status?.runner.id ?? null;
  const note = runnerNote(state);
  /**
   * What a row's own provider change just reset, per job.
   *
   * Held here rather than derived, because after the write there is nothing left to derive
   * from - the model is simply empty again, which is indistinguishable from never having set
   * one. Dropping a configured id with no explanation is the failure this exists to avoid;
   * the next edit to that row clears the line.
   */
  const [reset, setReset] = useState<Partial<Record<LlmJobId, string>>>({});
  // An env var outranks anything typed here, so the picker must not pretend otherwise -
  // a control that silently loses to the environment is worse than a disabled one.
  const runnerPinned = status?.runner.source === "env";

  return (
    <section className="settings-section">
      {/* Names no harness, deliberately. The point being made is that the two axes are
          independent, and an illustration spelled "review a Codex session with Claude" makes
          that point by enumerating two harnesses - wording Pi would silently have made stale.
          The dashboard's rule is that copy naming which agents a
          feature reaches is COMPUTED (`agentList`); copy that needs no enumeration to be
          true should not acquire one. */}
      <p className="settings-hint">
        Mission Control does a little model work of its own - naming an untitled task,
        rewriting a prompt into the sentence on a card, narrating what happened while you were
        away. This is the provider those calls go through, and which model each of them uses.
        It has nothing to do with the agent in a card: which harness a session runs and which
        model judges it are independent choices, so the cheap jobs can run somewhere cheaper
        than whatever is in your cards.
      </p>

      {/* The daemon has not answered. Said out loud, because everything below falls back to
          the shipped defaults, and presenting those as the daemon's answer tells the operator
          the app is running as something it may well not be. */}
      {!config && (
        <p className="settings-warn inspector-unknown">
          Can't reach the daemon, so what these calls actually run as is unknown. The controls
          below are showing defaults, not its current state.
        </p>
      )}

      <fieldset className="settings-radios llm-runners" data-anchor="models/provider">
        <legend>Provider</legend>
        {runners.length === 0 ? (
          <p className="settings-hint">
            {config
              ? "This build has no providers installed."
              : "Unknown - the daemon hasn't said which providers it has."}
          </p>
        ) : (
          runners.map((r) => (
            <Tooltip
              key={r.id}
              label={
                runnerPinned
                  ? "Pinned by an environment variable - unset it to choose here"
                  : `Run the app's own background jobs through ${r.label}`
              }
            >
              <label className="alert-row">
                <input
                  type="radio"
                  name="llm-runner"
                  checked={active === r.id}
                  disabled={!config || runnerPinned}
                  // Nothing is cleared. This picker says which provider a job runs on when
                  // the job has not said for itself, so it has no business disturbing one
                  // that has: a model set in a row below is a pinned pair, and the write
                  // path records the outgoing provider onto any legacy row that has a model
                  // but no provider yet. Only Inherit rows re-resolve.
                  onChange={() => void update({ runner: r.id })}
                />
                <span>{r.label}</span>
              </label>
            </Tooltip>
          ))
        )}
        {note && <p className="foreman-model-source">{note}</p>}
        {runners.length === 1 && (
          // Stated rather than hidden: one row is the honest picture of a build with one
          // provider, and a control that appears only once there is a choice leaves nobody
          // able to see what the app is running as today.
          <p className="settings-hint">
            Only one provider is available. Every offline call below goes through it.
          </p>
        )}
      </fieldset>

      <div className="foreman-models" data-anchor="models/jobs">
        <p className="settings-group-label">Background jobs</p>
        <p className="settings-hint foreman-models-hint">
          Most are a single cheap call with a deterministic fallback behind them - if the model
          can't be reached, you get a rougher title or a terser digest, never an error. The
          ensemble comparison is a review instead: if it can't produce a valid ranking, it fails
          the comparison rather than guessing a winner. Leave a row on Inherit to accept the
          value shown in it.
        </p>
        <p className="settings-hint foreman-models-hint">
          Each job can run on its own provider - name a task with Claude while compacting
          Workflow context with Codex. Pinning a model pins its provider, literally: choosing a
          model on an Inherit row records the provider it belongs to, so the app-wide picker
          above leaves that row alone and only re-resolves the rows still on Inherit. Changing a
          row's OWN provider works the other way and sends that row's model back to Inherit,
          unless the new provider offers the same id.
        </p>
        <SettingsMatrix
          caption="Background jobs, and what each one runs on"
          columns={[
            { key: "provider", label: "Provider" },
            { key: "model", label: "Model" },
          ]}
          rows={LLM_JOB_IDS.map((job) =>
            modelSlotRow({
              key: `llm-${job}`,
              anchor: `models/job-${job}`,
              spec: LLM_JOB_SPECS[job],
              providers: runners,
              runnerValue: config?.runners[job] ?? "",
              runnerResolved: status?.jobRunners[job],
              // The app-wide resolution, which is exactly what `llmJobRunner` falls back to
              // when a job has no override - so it is what this row's Inherit option means.
              inheritedRunner: status?.runner,
              modelValue: config?.models[job] ?? "",
              modelResolved: status?.models[job],
              disabled: !config,
              reset: reset[job] ?? null,
              onCommit: (patch) => {
                const dropped =
                  patch.model === "" && patch.runner !== undefined
                    ? (config?.models[job] ?? "")
                    : "";
                setReset((prev) => ({
                  ...prev,
                  [job]: dropped
                    ? `${dropped} isn't offered by this provider, so this job is back on Inherit.`
                    : undefined,
                }));
                // Empty is STORED as empty, the same rule Foreman's and the Inspector's
                // fields follow: it means "clear my override and go back to the ladder", and
                // dropping it from the patch would leave the old id in place while the box
                // looks cleared. Both halves go in ONE write, so a provider change and the
                // model reset it forces can never land as two states an operator sees.
                void update({
                  ...(patch.runner !== undefined ? { runners: { [job]: patch.runner } } : {}),
                  ...(patch.model !== undefined ? { models: { [job]: patch.model } } : {}),
                });
              },
            }),
          )}
        />
        <p className="settings-hint foreman-models-hint">
          Model choices come from the provider selected in each row.
        </p>
      </div>

      <p className="settings-hint llm-elsewhere">
        Foreman's four models are under <strong>Foreman</strong>, and GitHub Inspector's review
        model is under <strong>GitHub Inspector</strong> - each with the subsystem that spends it.
      </p>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
