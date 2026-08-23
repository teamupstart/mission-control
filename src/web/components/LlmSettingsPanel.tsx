import { useState } from "react";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import type { ForemanModelRole } from "@shared/foreman-models.ts";
import { INSPECTOR_MODEL_SPEC } from "@shared/inspector.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS } from "@shared/llm-jobs.ts";
import type { LlmJobId } from "@shared/llm-jobs.ts";
import { isLlmRunnerId, LLM_RUNNER_ENV_VAR } from "@shared/llm.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "@shared/llm.ts";
import type { ForemanConfigPatch, InspectorConfigPatch } from "@shared/protocol.ts";
import type { ForemanState } from "../useForeman.ts";
import type { InspectorState } from "../useInspector.ts";
import type { LlmProviderView } from "@shared/types.ts";
import type { LlmState } from "../useLlm.ts";
import type { HarnessesState } from "../useHarnesses.ts";
import { TaskKindDefaultsGroup } from "./TaskKindDefaults.tsx";
import { modelSlotRow, ProviderSelect, SettingsMatrix } from "./SettingsMatrix.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Models category: which provider does the app's OWN offline work, and on which model.
//
// Two questions, and the panel keeps them apart because the code does. A runner answers
// "how is a model called" and is app-wide; a job answers "which model" and is per call.
// Folding them into one control would mean you could not run titling on a cheap local
// provider while reviewing with Claude, which is the whole reason the axes are separate
// (`@shared/llm.ts`).
//
// It edits three blobs - `llm`, `foreman` and `inspector` - and that is a deliberate
// reversal. The rule it used to follow was "each panel owns the config it writes", which
// bought a clean writer boundary and cost the operator the only question worth bringing to
// this page: what is this app spending, and on whose account? Answering it meant visiting
// three panels and holding three inherit rules in your head. So the page moved to follow the
// QUESTION, and the writer boundary is preserved a level down instead: each group commits
// through the hook that owns its blob (`llm.update`, `foreman.update`, `inspector.update`),
// every patch carries only the keys it is changing, and every server merge is per key. Two
// tabs editing different groups still commute.
//
// What is NOT here, and is not a gap in that claim: a Persona's model and an Ensemble
// judge's. Those are a field on a row in an unbounded list, one per Persona - not an app
// setting with a fixed place on a settings page. Foreman's per-harness BACKLOG DISPATCH
// models are absent for a different reason: they choose what a launched agent runs as, which
// is the dispatch ladder, not a call this app makes on its own account. They stay on
// Foreman's Launches tab.

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

export function LlmSettingsPanel({
  state,
  harnesses,
  foreman,
  inspector,
}: {
  state: LlmState;
  /**
   * The harnesses config, SHARED with the rest of Settings rather than polled again here.
   *
   * `SettingsPage` already holds one instance for the Harnesses panel, and a second poller
   * over the same blob would be two optimistic writers racing each other's reads - the exact
   * lost update `useHarnesses`'s edit counter exists to prevent, reintroduced one component
   * over.
   */
  harnesses: HarnessesState;
  /**
   * Foreman's own state, passed down for the same reason.
   *
   * A second poller would be a second idea of the truth on one screen: this panel and the
   * Foreman panel would answer "what is Review running as?" from two reads taken seconds
   * apart, and the write path would have two optimistic caches to reconcile.
   */
  foreman: ForemanState;
  /** The Inspector's, for the same reason again. */
  inspector: InspectorState;
}): React.JSX.Element {
  const { config, status, update, error } = state;
  const runners = status?.runners ?? [];
  /**
   * Move the app-wide provider, then make the two groups that INHERIT it say so.
   *
   * Foreman's four roles and the Inspector's review resolve through this picker whenever they
   * have chosen nothing themselves, but they live in their own blobs behind their own hooks -
   * so this write changes what they will spawn with while nothing tells them to look again.
   * Without the two refreshes their rows go on naming the old provider, and printing the old
   * provider's default model id, for up to a poll interval. On the one page whose whole claim
   * is that it says what each call will actually spawn, that is the failure to avoid.
   */
  const changeAppWide = async (id: LlmRunnerId): Promise<void> => {
    await update({ runner: id });
    await Promise.all([foreman.refresh(), inspector.refresh()]);
  };
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
        Mission Control does a good deal of model work of its own - naming an untitled task,
        rewriting a prompt into the sentence on a card, judging a stuck session, reviewing a
        pull request. Every one of those calls is on your account, and every one this app keeps
        a fixed slot for is on this page: the provider it goes through, the model it spawns
        with, and which of them it inherited rather than chose. It has nothing to do with the
        agent in a card - which harness a session runs and which model judges it are
        independent choices, so the cheap jobs can run somewhere cheaper than whatever is in
        your cards. What is deliberately not a slot here is named at the bottom.
      </p>
      <p className="settings-hint">
        The <strong>Task kinds</strong> grid further down is the other half of the page, and it
        is about exactly the opposite: the agent in a card, and what a dispatched task of each
        kind launches on.
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
                  onChange={() => void changeAppWide(r.id)}
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

      {/* The rest of what this app spends on its own account, in the order the page's copy
          names them: the background jobs above, then Foreman's four roles, then the
          Inspector's one review. */}
      <ForemanModelsGroup foreman={foreman} providers={runners} appWide={status?.runner} />

      <InspectorModelGroup inspector={inspector} providers={runners} appWide={status?.runner} />

      {/* Not the app's own calls at all - the harness in a CARD, per task kind. It sits on this
          page because the question a person arrives with is "which model runs my planning", and
          being told that Mission Control's own titling calls live under Models while a plan
          task's model lives somewhere else answers a question nobody asked. The groups stay
          visibly separate, and the copy in each says which calls it is about. */}
      <TaskKindDefaultsGroup state={harnesses} />

      <p className="settings-hint llm-elsewhere">
        A Persona's model, and an Ensemble judge's, stay on the Persona - there is one per row
        rather than a fixed slot, so they live in <strong>Workflows</strong>. The models Foreman
        launches a backlog <em>task</em> with are a dispatch choice rather than a call this app
        makes on its own account, and stay under <strong>Foreman</strong>.
      </p>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}

/**
 * Foreman's four roles: a group-level provider, and a row per role that may override it.
 *
 * Three rungs rather than the background jobs' two, and the extra one is why this group
 * leads with a row of its own: "Inherit" on a role row means Foreman's value, not the
 * app-wide one, and a grid that did not show what was being inherited would make the word
 * unreadable. That first row is editable - it is a real setting, not a readout - which is
 * why it is not marked `inherited`; that flag is for a muted, uneditable line.
 */
function ForemanModelsGroup({
  foreman,
  providers,
  appWide,
}: {
  foreman: ForemanState;
  providers: LlmProviderView[];
  /** What the app-wide picker above resolved to - what Foreman's OWN Inherit option means. */
  appWide: ResolvedLlmRunner | undefined;
}): React.JSX.Element {
  const { config, status, update } = foreman;
  const [reset, setReset] = useState<Partial<Record<ForemanModelRole, string>>>({});
  /**
   * What a role's Inherit option resolves to: Foreman's group-level answer.
   *
   * Taken WHOLE from the daemon, which resolved it through every layer the browser cannot
   * see. It used to be rebuilt here as `{ id: status.runner, source: "config", unknown: null }`
   * from the bare id, and that discarded the one case the id cannot carry: a stored provider
   * this build does not have. Such a value inherits the app-wide answer, so the reconstructed
   * object drew that inherited provider as Foreman's own deliberate choice, with nothing on
   * screen saying which saved id had been dropped - on the one row that has no `unknown` line
   * of its own to fall back on.
   */
  const groupRunner: ResolvedLlmRunner | undefined = status?.groupRunner ?? appWide;
  /** The stored group provider, when this build cannot resolve it. Said out loud, below. */
  const unreadableGroup = status?.groupRunner?.unknown ?? null;

  return (
    <div className="foreman-models" data-anchor="models/foreman">
      <p className="settings-group-label">Foreman</p>
      <p className="settings-hint foreman-models-hint">
        Foreman spawns a fresh, isolated call for each of these. Review and Verify read a
        transcript, a diff and a policy and judge them, so they are the expensive pair; Triage
        is the cheap router that keeps most sessions away from Review at all, and Backlog reads
        the task list once per change. Each row may run somewhere different - keep the deep pair
        on one account and the cheap pair on another - or leave it on Inherit and follow the row
        above it.
      </p>
      <SettingsMatrix
        caption="Foreman's four model roles, and what each one runs on"
        columns={[
          { key: "provider", label: "Provider" },
          { key: "model", label: "Model" },
        ]}
        rows={[
          {
            key: "foreman-group",
            label: "All roles",
            blurb: "What every role below runs on unless it has chosen for itself.",
            cells: {
              provider: (
                <ProviderSelect
                  id="foreman-provider"
                  name="Foreman provider"
                  tooltip="Which provider Foreman's model roles run through when they have not chosen their own. Inherit follows the app-wide picker."
                  value={config?.runner ?? ""}
                  inherited={appWide}
                  providers={providers}
                  disabled={!config}
                  // Nothing is cleared here. A role that has pinned a model has had its
                  // provider recorded beside it - either because it was pinned through this
                  // panel, or because `setForemanConfig` materialised the outgoing one on the
                  // way past - so this select disturbs only the roles still inheriting. The
                  // old control wiped all four model boxes on every change, which was the
                  // only way to keep a pair valid when there was one provider for all of
                  // them, and is now a deletion of choices nobody asked to lose.
                  onCommit={(next) => void update({ runner: next })}
                />
              ),
              model: <span className="settings-hint">Per role below.</span>,
            },
            // The same sentence `modelSlotRow` gives a role whose own override cannot be
            // read, in the same place, because it is the same failure one rung up.
            note: unreadableGroup
              ? (
                <span className="settings-matrix-reset">
                  {`"${unreadableGroup}" is not a provider this build has, so Foreman's roles are inheriting the app-wide one instead.`}
                </span>
              )
              : undefined,
          },
          ...FOREMAN_MODEL_ROLES.map((role) => {
            const spec = FOREMAN_MODEL_SPECS[role];
            return modelSlotRow({
              key: `foreman-${role}`,
              anchor: null,
              spec,
              // "Review" is Foreman's here and the Inspector's further down the same page.
              nameScope: "Foreman",
              providers,
              runnerValue: config?.[spec.runnerKey] ?? "",
              runnerResolved: status?.roleRunners?.[role],
              // Foreman's group-level answer, NOT the app-wide one: that is the rung
              // directly under a role, and it is what selecting Inherit here actually gives.
              inheritedRunner: groupRunner,
              modelValue: config?.[spec.configKey] ?? "",
              modelResolved: status?.models?.[role],
              disabled: !config,
              reset: reset[role] ?? null,
              onCommit: (patch) => {
                const dropped =
                  patch.model === "" && patch.runner !== undefined
                    ? (config?.[spec.configKey] ?? "")
                    : "";
                setReset((prev) => ({
                  ...prev,
                  [role]: dropped
                    ? `${dropped} isn't offered by this provider, so this role is back on Inherit.`
                    : undefined,
                }));
                // Only the keys being changed, never a round-trip of the whole blob:
                // `setForemanConfig` spreads a patch at the top level, so a stale sibling
                // read from an earlier poll would be written back over a newer value.
                void update({
                  ...(patch.runner !== undefined ? { [spec.runnerKey]: patch.runner } : {}),
                  ...(patch.model !== undefined ? { [spec.configKey]: patch.model } : {}),
                } as ForemanConfigPatch);
              },
            });
          }),
        ]}
      />
    </div>
  );
}

/**
 * The Inspector's single review model - the one call in the app that writes somewhere public.
 *
 * A one-row grid rather than a pair of fields, so it reads as another slot in the same table
 * and inherits the same vocabulary: Inherit means the app-wide picker, pinning a model pins
 * its provider, and a pair that cannot be honoured says so in the row.
 */
function InspectorModelGroup({
  inspector,
  providers,
  appWide,
}: {
  inspector: InspectorState;
  providers: LlmProviderView[];
  appWide: ResolvedLlmRunner | undefined;
}): React.JSX.Element {
  const { config, model, runner, update } = inspector;
  const [reset, setReset] = useState<string | null>(null);
  return (
    <div className="foreman-models" data-anchor="models/inspector">
      <p className="settings-group-label">GitHub Inspector</p>
      <p className="settings-hint foreman-models-hint">
        One call, and the only one on this page that can write somewhere other people read: it
        reviews each push to a pull request we opened and answers the follow-ups in its own
        threads. Whether it posts at all is Dry run versus Live, under{" "}
        <strong>GitHub Inspector</strong>; this is only what it thinks with.
      </p>
      <SettingsMatrix
        caption="GitHub Inspector's review call, and what it runs on"
        columns={[
          { key: "provider", label: "Provider" },
          { key: "model", label: "Model" },
        ]}
        rows={[
          modelSlotRow({
            key: "inspector",
            anchor: null,
            spec: INSPECTOR_MODEL_SPEC,
            nameScope: "Inspector",
            providers,
            runnerValue: config?.runner ?? "",
            runnerResolved: runner ?? undefined,
            inheritedRunner: appWide,
            modelValue: config?.model ?? "",
            modelResolved: model ?? undefined,
            disabled: !config,
            reset,
            onCommit: (patch) => {
              const dropped =
                patch.model === "" && patch.runner !== undefined ? (config?.model ?? "") : "";
              setReset(
                dropped
                  ? `${dropped} isn't offered by this provider, so the review model is back on Inherit.`
                  : null,
              );
              void update({
                ...(patch.runner !== undefined ? { runner: patch.runner } : {}),
                ...(patch.model !== undefined ? { model: patch.model } : {}),
              } as InspectorConfigPatch);
            },
          }),
        ]}
      />
    </div>
  );
}
