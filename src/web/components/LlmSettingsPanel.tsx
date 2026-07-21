import { LLM_JOB_IDS, LLM_JOB_SPECS } from "@shared/llm-jobs.ts";
import { LLM_RUNNER_ENV_VAR } from "@shared/llm.ts";
import type { LlmState } from "../useLlm.ts";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";

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
  const active = status?.runner.id ?? null;
  const note = runnerNote(state);
  // An env var outranks anything typed here, so the picker must not pretend otherwise -
  // a control that silently loses to the environment is worse than a disabled one.
  const runnerPinned = status?.runner.source === "env";

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Models</h3>
      </div>

      {/* Names no harness, deliberately. The point being made is that the two axes are
          independent, and an illustration spelled "review a Codex session with Claude" makes
          that point by enumerating today's two - which is the sentence a third harness
          silently makes stale. The dashboard's rule is that copy naming which agents a
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

      <fieldset className="inspector-modes llm-runners">
        <legend>Provider</legend>
        {runners.length === 0 ? (
          <p className="settings-hint">
            {config
              ? "This build has no providers installed."
              : "Unknown - the daemon hasn't said which providers it has."}
          </p>
        ) : (
          runners.map((r) => (
            <label className="alert-row" key={r.id}>
              <input
                type="radio"
                name="llm-runner"
                checked={active === r.id}
                disabled={!config || runnerPinned}
                onChange={() => void update({ runner: r.id })}
              />
              <span>{r.label}</span>
            </label>
          ))
        )}
        {note && <p className="foreman-model-source">{note}</p>}
        {runners.length === 1 && (
          // Stated rather than hidden: one row is the honest picture of a build with one
          // provider, and a control that appears only once there is a choice leaves nobody
          // able to see what the app is running as today.
          <p className="settings-hint">
            Only one provider ships today. Every offline call below goes through it.
          </p>
        )}
      </fieldset>

      <div className="foreman-models">
        <p className="settings-group-label">Background jobs</p>
        <p className="settings-hint foreman-models-hint">
          Each is a single cheap call with a deterministic fallback behind it - if the model
          can't be reached, you get a rougher title or a terser digest, never an error. Leave a
          field empty to accept the value shown in it.
        </p>
        <ModelSuggestions />
        {LLM_JOB_IDS.map((job) => (
          <ModelField
            key={job}
            id={`llm-model-${job}`}
            spec={LLM_JOB_SPECS[job]}
            value={config?.models[job] ?? ""}
            resolved={status?.models[job]}
            disabled={!config}
            onCommit={(next) =>
              // Empty is STORED as empty, the same rule Foreman's and the Inspector's fields
              // follow: it means "clear my override and go back to the ladder", and dropping
              // it from the patch would leave the old id in place while the box looks cleared.
              void update({ models: { [job]: next } })
            }
          />
        ))}
      </div>

      <p className="settings-hint llm-elsewhere">
        Foreman's four models are under <strong>Foreman</strong>, and the Inspector's review
        model is under <strong>Inspector</strong> - each with the subsystem that spends it.
      </p>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
