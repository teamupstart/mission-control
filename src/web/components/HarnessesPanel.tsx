import { useEffect, useState } from "react";
import {
  AGENT_TYPES,
  type AdvisorChoice,
  type AgentType,
  type SessionRuntime,
  type ThinkingLevel,
} from "@shared/types.ts";
import {
  ADVISOR_CHOICE_LABELS,
  advisorOverrideKey,
  advisorStatus,
  resolveLaunchAdvisor,
} from "@shared/advisor.ts";
import type {
  AdvisorEnvironment,
  HarnessAdvisorDefaults,
  HarnessAdvisorEnvironments,
  HarnessesConfigPatch,
} from "@shared/protocol.ts";
import { emptyHarnessAdvisorDefaults } from "@shared/protocol.ts";
import { modelLabel } from "@shared/model.ts";
import { fetchHarnessAdvisorEnvironments } from "../lib/api.ts";
import { AGENT_IDENTITY, agentList } from "@shared/agent.ts";
import {
  autoModeAgents,
  autoModeUnsupportedWhy,
  capabilitiesFor,
  resolveSessionRuntime,
  sdkRuntimeUnsupportedWhy,
} from "@shared/harness-capabilities.ts";
import { piManagedRuntimeReady } from "@shared/pi-managed-runtime.ts";
import { resolveTerminalBackend, type TerminalBackendId } from "@shared/terminal.ts";
import type { SetupChecksView } from "@shared/setup-catalog.ts";
import { permissionModeDisplay } from "../lib/format.ts";
import {
  ModelCatalogNotice,
  ModelCatalogOptions,
  useHarnessModelCatalogs,
} from "../model-catalog.tsx";
import type { HarnessesState } from "../useHarnesses.ts";
import { AgentDot, agentAccentStyle } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";
import {
  dispatchTerminalCopy,
  TerminalPreferencePicker,
} from "./TerminalPreferencePicker.tsx";

// The Harnesses settings section: defaults the app applies to the sessions IT
// launches - the auto-mode master toggle, then ONE CARD PER HARNESS carrying that
// harness's model and effort together, its accent, a capability-derived badge, and a
// sentence restating what a dispatch will actually do.
//
// Cards, not two parallel per-setting lists: a harness's model and its effort are one
// harness's defaults, and the old layout drew each harness twice - once under "Default
// model", once under "Default effort" - so reading "what will a dispatched Codex do"
// meant scanning two lists and joining them by eye. A card is that join, drawn. The
// master-toggle shape above them stays the skills/Foreman pattern - an `.alert-row`
// checkbox styled as a switch - because that is what it is: a durable on/off that
// changes what happens to every future dispatch.

/**
 * One card per harness, derived from the union rather than listed here.
 *
 * A hand-kept list is how a harness ends up dispatchable but missing its settings card,
 * with nothing failing to compile to say so. Order is `AGENT_TYPES`' order, which is
 * the order this section has always shown.
 */
const HARNESS_CARDS: { agent: AgentType; label: string }[] = AGENT_TYPES.map((agent) => ({
  agent,
  label: AGENT_IDENTITY[agent].label,
}));

/**
 * Who the auto-mode switch reaches, and who it does not - read off the declared
 * `permissionModes.onDispatch` posture plus either an argv renderer or an SDK runtime,
 * rather than off a harness name.
 *
 * Every sentence on that row named an agent, and each was its own literal ("claude
 * only", "Every Claude session…", "Codex support comes later"). Pi would have left all
 * three describing a grid that no longer matched, with nothing failing to compile to say
 * so - and "Codex support comes later" is a promise this panel is in no position to make
 * on the harness's behalf.
 */
const AUTO_AGENTS = autoModeAgents();
const AUTO_LABEL = agentList(AUTO_AGENTS, "and");
const AUTO_EXCLUDED = AGENT_TYPES.filter((a) => !AUTO_AGENTS.includes(a));
const AUTO_SDK_ONLY = AUTO_AGENTS.filter((agent) => {
  const capabilities = capabilitiesFor(agent);
  return !capabilities.permissionModes?.launchArgs && capabilities.runtimes.includes("sdk");
});

/**
 * What "auto mode" is called, when every harness it reaches calls it the same thing.
 *
 * Null when they disagree, and the sentence then falls back to the declared posture
 * rather than naming one harness's spelling over another's - the alternative being a
 * settings row that promises a mode half the grid does not have.
 */
const AUTO_MODE_LABEL = ((): string | null => {
  const labels = new Set(
    AUTO_AGENTS.map((a) => permissionModeDisplay(capabilitiesFor(a).permissionModes!.onDispatch)?.label),
  );
  return labels.size === 1 ? ([...labels][0] ?? null) : null;
})();

/**
 * The badge on a harness's card, capability-derived and never a literal harness name.
 *
 * Two mutually exclusive launch-flag states, both read off the same permission-mode
 * capability:
 *  - a harness this projection REACHES wears "auto mode on" only while the switch is on,
 *    so the card says what a dispatch will do right now rather than what it could;
 *  - a harness this projection DOES NOT REACH wears "no auto mode", carrying
 *    `autoModeUnsupportedWhy` as its title - the sentence saying which of the two
 *    absences this is - so the reason is on the card, not just in the master row.
 */
function CardBadge({
  agent,
  label,
  autoMode,
}: {
  agent: AgentType;
  label: string;
  autoMode: boolean;
}): React.JSX.Element | null {
  const why = autoModeUnsupportedWhy(agent);
  const capabilities = capabilitiesFor(agent);
  const modeLabel =
    permissionModeDisplay(capabilities.permissionModes?.onDispatch ?? null)?.label ??
    "its auto-mode posture";
  if (why) {
    return (
      <Tooltip label={why}>
        <span className="skill-badge skill-badge-agent">no auto mode</span>
      </Tooltip>
    );
  }
  if (!autoMode) return null;
  const tooltip = capabilities.permissionModes?.launchArgs
    ? `Dispatched ${label} sessions launch in ${modeLabel} permission mode via a launch flag, even while a folder-trust dialog hides the mode footer.`
    : `Embedded ${label} dispatches start in ${modeLabel} through their driver; terminal dispatches use the harness's own launch treatment instead.`;
  return (
    <Tooltip label={tooltip}>
      <span className="skill-badge skill-badge-always-on">auto mode on</span>
    </Tooltip>
  );
}

/** What the advisor rows show before the config has loaded: Inherit, no overrides. */
const EMPTY_ADVISOR = emptyHarnessAdvisorDefaults();

/** One harness's advisor patch, as the card sends it. */
type AdvisorPatch = NonNullable<NonNullable<HarnessesConfigPatch["advisor"]>[AgentType]>;

/**
 * The advisor rows of a harness card that declares one: a default for every launch model,
 * the per-model overrides beneath it, and a status line saying whether a dispatched session
 * will actually consult an advisor - which, on Harness default, depends on the harness's
 * own settings, so that is what the line reads.
 *
 * Rendered as two pieces because the default sits in the card's label/control grid beside
 * Model and Effort, while the overrides are a list of their own under it.
 */
function AdvisorDefaultField({
  agent,
  label,
  model,
  advisor,
  environment,
  disabled,
  onPatch,
}: {
  agent: AgentType;
  label: string;
  model: string | null;
  advisor: HarnessAdvisorDefaults;
  environment: AdvisorEnvironment | null;
  disabled: boolean;
  onPatch: (patch: AdvisorPatch) => void;
}): React.JSX.Element {
  const spec = capabilitiesFor(agent).advisor!;
  const id = `harness-advisor-${agent}`;
  // Narrowed like every stored advisor value: one this build cannot pin reads as the default.
  const choice = spec.values.find((value) => value === advisor.default) ?? null;
  // The status describes what a launch on the card's default model actually gets, through
  // the same resolver the dispatcher uses - so when that model has an override, the override
  // is what the line reports, not the default beside it.
  const launch = resolveLaunchAdvisor({ advisor: { ...EMPTY_ADVISOR, [agent]: advisor } }, agent, model);
  const resolved = advisorStatus(agent, launch.choice, model, environment);
  const status = launch.source === "override" && model
    ? { ...resolved, text: `${modelLabel(model) ?? model} uses its override. ${resolved.text}` }
    : resolved;
  return (
    <>
      <label className="harness-card-field-label harness-card-field-label--top" htmlFor={id}>
        Advisor
      </label>
      <div className="harness-advisor-default">
        <Tooltip label={`Which stronger model every dispatched ${label} session may consult, unless its model has an override below`}>
          <select
            id={id}
            className="harnesses-select"
            value={choice ?? ""}
            disabled={disabled}
            onChange={(e) => onPatch({ default: (e.target.value || null) as AdvisorChoice | null })}
            aria-label={`Default advisor for dispatched ${label} sessions`}
          >
            <option value="">Harness default</option>
            {spec.values.map((value) => (
              <option key={value} value={value}>
                {ADVISOR_CHOICE_LABELS[value]}
              </option>
            ))}
          </select>
        </Tooltip>
        <span
          className={`harness-advisor-status${status.on ? " harness-advisor-status--on" : ""}`}
          role="status"
          aria-label={`${label} advisor status`}
        >
          {status.text}
        </span>
        {status.warning && <span className="harness-advisor-warning">{status.warning}</span>}
      </div>
    </>
  );
}

function AdvisorOverrides({
  agent,
  label,
  advisor,
  disabled,
  onPatch,
}: {
  agent: AgentType;
  label: string;
  advisor: HarnessAdvisorDefaults;
  disabled: boolean;
  onPatch: (patch: AdvisorPatch) => void;
}): React.JSX.Element {
  const { resolve: resolveModels } = useHarnessModelCatalogs();
  const spec = capabilitiesFor(agent).advisor!;
  const rows = Object.entries(advisor.overrides).filter(
    (entry): entry is [string, AdvisorChoice] => spec.values.includes(entry[1] as AdvisorChoice),
  );
  const used = new Set(rows.map(([model]) => model));
  const catalog = resolveModels(agent, null).choices;
  const unused = catalog.filter((choice) => !used.has(advisorOverrideKey(choice.id)));
  /** A new row's choice: Opus, unless Opus would be weaker than that model. */
  const firstChoice = (model: string): AdvisorChoice =>
    spec.values.find((value) => value !== "off" && !spec.weakerThan(value, model)) ?? "off";
  return (
    <div className="harness-advisor-overrides" role="group" aria-label={`${label} advisor overrides`}>
      <div className="harness-advisor-subhead">Advisor Overrides</div>
      {rows.length === 0 && (
        <p className="harness-advisor-empty">Every model uses the advisor above.</p>
      )}
      {rows.map(([model, choice]) => {
        const name = modelLabel(model) ?? model;
        const options = resolveModels(agent, model).choices;
        const weaker = choice !== "off" && spec.weakerThan(choice, model);
        return (
          <div key={model} className="harness-advisor-row">
            <Tooltip label={`Which ${label} model this override applies to`}>
              <select
                className="harnesses-select"
                value={model}
                disabled={disabled}
                aria-label={`Model for the ${name} advisor override`}
                onChange={(e) => onPatch({ overrides: { [model]: null, [e.target.value]: choice } })}
              >
                {options.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={option.id !== model && used.has(advisorOverrideKey(option.id))}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </Tooltip>
            <span className="harness-advisor-arrow" aria-hidden>
              →
            </span>
            <Tooltip label={`Which advisor dispatched ${name} sessions may consult`}>
              <select
                className="harnesses-select"
                value={choice}
                disabled={disabled}
                aria-label={`Advisor for ${name} sessions`}
                onChange={(e) => onPatch({ overrides: { [model]: e.target.value as AdvisorChoice } })}
              >
                {spec.values.map((value) => (
                  <option key={value} value={value}>
                    {ADVISOR_CHOICE_LABELS[value]}
                  </option>
                ))}
              </select>
            </Tooltip>
            <Tooltip label={`Remove the ${name} override, so ${name} sessions use the advisor above`}>
              <button
                type="button"
                className="harness-advisor-remove"
                disabled={disabled}
                aria-label={`Remove the ${name} advisor override`}
                onClick={() => onPatch({ overrides: { [model]: null } })}
              >
                ×
              </button>
            </Tooltip>
            {weaker && (
              <span className="harness-advisor-warning harness-advisor-row-warning">
                {ADVISOR_CHOICE_LABELS[choice]} is less capable than {name}, so {label} will not
                consult it on the main conversation.
              </span>
            )}
          </div>
        );
      })}
      {unused.length > 0 && (
        <Tooltip label={`Give one ${label} model a different advisor from the one above`}>
          <button
            type="button"
            className="harness-advisor-add"
            disabled={disabled}
            onClick={() => {
              const model = unused[0]!.id;
              onPatch({ overrides: { [model]: firstChoice(model) } });
            }}
          >
            + Add model override
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * One harness's card: its default model and effort together, and a sentence composed
 * from the current values restating what a dispatch will do.
 *
 * The empty model value is a real choice, not a placeholder: it means Mission Control
 * passes no `--model` at all, leaving the CLI on whatever the operator configured in the
 * harness itself - so the card can always be put back to "don't interfere", which is how
 * it ships. Same for effort: blank keeps whatever the harness has.
 */
function HarnessCard({
  agent,
  label,
  model,
  effort,
  runtime,
  terminalBackend,
  autoMode,
  disabled,
  onModel,
  onEffort,
  onRuntime,
  onTerminalBackend,
  piSdkReady,
  advisor,
  advisorEnvironment,
  onAdvisor,
}: {
  agent: AgentType;
  label: string;
  model: string | null;
  effort: ThinkingLevel | null;
  advisor: HarnessAdvisorDefaults;
  advisorEnvironment: AdvisorEnvironment | null;
  onAdvisor: (patch: AdvisorPatch) => void;
  runtime: string | null;
  terminalBackend: string | null;
  autoMode: boolean;
  disabled: boolean;
  onModel: (id: string | null) => void;
  onEffort: (level: ThinkingLevel | null) => void;
  onRuntime: (runtime: SessionRuntime) => void;
  onTerminalBackend: (backend: TerminalBackendId | null) => void;
  piSdkReady: boolean;
}): React.JSX.Element {
  const { resolve: resolveModels } = useHarnessModelCatalogs();
  const models = resolveModels(agent, model);
  const modelId = `harness-model-${agent}`;
  const effortId = `harness-effort-${agent}`;
  const runtimeId = `harness-runtime-${agent}`;
  const terminalId = `harness-terminal-${agent}`;
  // Do not guess a runtime while the config is in flight. A new install will resolve to the
  // Agent SDK, but an upgraded installation can still have a legacy Terminal default. Once
  // loaded, the shared gate makes the panel and dispatcher agree about unknown or unsupported
  // stored values too.
  const resolved = runtime === null ? null : resolveSessionRuntime(agent, runtime);
  const resolvedTerminal = resolveTerminalBackend(terminalBackend);
  const sdkWhy = sdkRuntimeUnsupportedWhy(agent);
  const piSdkBlocked = agent === "pi" && !piSdkReady;
  const hasAdvisor = capabilitiesFor(agent).advisor !== null;
  const runtimeNote =
    runtime === null
      ? `Loading saved runtime default for ${label}.`
      : (sdkWhy ??
        (resolved?.runtime === "sdk"
          ? "They run inside Mission Control on the Agent SDK - no terminal pane, questions answered from the card, and Continue in terminal when you want to take over."
          : resolvedTerminal.backend
            ? "They run in a terminal pane using the terminal selected above."
            : "They run in a terminal pane, selecting an available multiplexer or terminal app automatically."));
  return (
    <div className="harness-card" data-anchor={`harnesses/${agent}`} style={agentAccentStyle(agent)}>
      <div className="harness-card-head">
        <AgentDot agent={agent} />
        <b className="harness-card-name">{label}</b>
        <span className="harness-card-spacer" />
        <CardBadge agent={agent} label={label} autoMode={autoMode} />
      </div>
      <div className="harness-card-grid">
        <label className="harness-card-field-label" htmlFor={modelId}>
          Model
        </label>
        <Tooltip label={`Which model every dispatched ${label} session launches with`}>
          <select
            id={modelId}
            className="harnesses-select"
            value={model ?? ""}
            disabled={disabled}
            onChange={(e) => onModel(e.target.value || null)}
            aria-label={`Default model for dispatched ${label} sessions`}
          >
            <option value="">Harness default</option>
            {/* No hints here. A harness card is a 250px column, and Codex's hints are whole
                sentences off its own model list, so composing `label - hint` printed the
                option straight through the chevron. The roomier pickers - Dispatch, the
                schedule editor, the task-kind defaults - still show them. A retained model
                keeps its own hint regardless, because "not currently reported" is the only
                thing explaining why that row is there. */}
            <ModelCatalogOptions catalog={models} includeHints={false} />
          </select>
        </Tooltip>
        <label className="harness-card-field-label" htmlFor={effortId}>
          Effort
        </label>
        <Tooltip label={`How much reasoning effort every dispatched ${label} session starts with`}>
          <select
            id={effortId}
            className="harnesses-select"
            value={effort ?? ""}
            disabled={disabled}
            onChange={(e) => onEffort((e.target.value || null) as ThinkingLevel | null)}
            aria-label={`Default effort for dispatched ${label} sessions`}
          >
            <option value="">Harness default</option>
            {capabilitiesFor(agent).effort?.levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Tooltip>
        {/* Read off the capability, so a harness gains this row by declaring an advisor. */}
        {hasAdvisor && (
          <AdvisorDefaultField
            agent={agent}
            label={label}
            model={model}
            advisor={advisor}
            environment={advisorEnvironment}
            disabled={disabled}
            onPatch={onAdvisor}
          />
        )}
        {/* Rendered only for a harness that DECLARES the runtime, never for one we hope
            will get a driver later: the row would be a toggle that changes nothing. The
            absence is stated in the card's note below, composed from the capability. */}
        {!sdkWhy && resolved && (
          <>
            <label className="harness-card-field-label" htmlFor={runtimeId}>
              Runtime
            </label>
            <Tooltip label={`How a dispatched ${label} session is driven`}>
              <select
                id={runtimeId}
                className="harnesses-select"
                value={resolved.runtime}
                disabled={disabled}
                onChange={(e) => onRuntime(e.target.value as SessionRuntime)}
                aria-label={`Session runtime for dispatched ${label} sessions`}
              >
                <option value="terminal">Terminal pane</option>
                {/* The shipped default, and the runtime every in-app affordance is built
                    for. Named as recommended in the option itself because the card note is
                    only read AFTER a choice, so it cannot influence the one being made. */}
                <option value="sdk" disabled={piSdkBlocked}>Agent SDK (recommended)</option>
              </select>
            </Tooltip>
          </>
        )}
        {resolved?.runtime === "terminal" && (
          <>
            <label className="harness-card-field-label" htmlFor={terminalId}>
              Terminal
            </label>
            <TerminalPreferencePicker
              id={terminalId}
              copy={dispatchTerminalCopy(label)}
              value={terminalBackend}
              disabled={disabled}
              onChange={onTerminalBackend}
            />
          </>
        )}
      </div>
      {hasAdvisor && (
        <AdvisorOverrides
          agent={agent}
          label={label}
          advisor={advisor}
          disabled={disabled}
          onPatch={onAdvisor}
        />
      )}
      <ModelCatalogNotice agent={agent} />
      <p className="harness-card-note">
        {model
          ? `Dispatched ${label} sessions are launched with --model ${model}.`
          : `Dispatched ${label} sessions are launched with no --model flag, so ${label} uses its own configured model.`}{" "}
        {effort
          ? `They start with ${effort} reasoning effort.`
          : `Effort stays whatever ${label} has configured.`}{" "}
        {runtimeNote}
        {resolved?.unknown && (
          <>
            {" "}
            <strong>
              A stored runtime this build doesn&apos;t know ({resolved.unknown}) was ignored.
            </strong>
          </>
        )}
        {resolved?.unsupported && (
          <>
            {" "}
            <strong>
              This harness is set to the {resolved.unsupported} runtime, which this build has no
              driver for.
            </strong>
          </>
        )}
        {resolved?.runtime === "terminal" && resolvedTerminal.unknown && (
          <>
            {" "}
            <strong>
              A stored terminal backend this build doesn&apos;t know (
              {resolvedTerminal.unknown}) was ignored.
            </strong>
          </>
        )}
        {piSdkBlocked && (
          <>
            {" "}
            <strong>
              Install Pi and the Mission Control Pi extension in{" "}
              <Tooltip label="Open Setup to install the Pi Agent SDK prerequisites">
                <a href="#/settings/setup">Setup</a>
              </Tooltip>
              , then re-check before enabling Agent SDK.
            </strong>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * What each harness's own settings say about its advisor. Re-read when the window regains
 * focus, because the operator changes those files outside Mission Control - typing
 * `/advisor` in any Claude session rewrites the user settings file.
 */
function useAdvisorEnvironments(): HarnessAdvisorEnvironments | null {
  const [environments, setEnvironments] = useState<HarnessAdvisorEnvironments | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void fetchHarnessAdvisorEnvironments().then((next) => {
        if (alive && next) setEnvironments(next);
      });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return environments;
}

export function HarnessesPanel({
  state,
  setup = null,
}: {
  state: HarnessesState;
  setup?: SetupChecksView | null;
}): React.JSX.Element {
  const { config, update, error } = state;
  const piSdkReady = piManagedRuntimeReady({
    piCliInstalled: setup?.piCliReady === true,
    piExtensionInstalled: setup?.piExtensionReady === true,
  });
  // `config` is null only in the pre-poll instant; the switch reads on (its shipped
  // default) and disables until the first read lands, so a toggle can't race the fetch.
  const autoMode = config?.autoModeOnDispatch ?? true;
  const advisorEnvironments = useAdvisorEnvironments();

  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        Defaults for the agents Mission Control <strong>dispatches</strong>. These never touch
        sessions you started yourself and the app merely discovered - only the ones it launches.
      </p>

      {error && <p className="settings-error">{error}</p>}

      <div className="kb-row harnesses-row" data-anchor="harnesses/auto-mode">
        <div className="kb-row-text">
          <span className="kb-row-label">
            Auto mode on dispatch
            {AUTO_EXCLUDED.length > 0 && (
              <Tooltip label={AUTO_EXCLUDED.map((a) => autoModeUnsupportedWhy(a)).join(" ")}>
                <span className="skill-badge skill-badge-agent">
                  {AUTO_AGENTS.join(" / ")} only
                </span>
              </Tooltip>
            )}
          </span>
          <span className="kb-row-desc">
            When enabled, every {AUTO_LABEL} session dispatched from Mission Control starts in{" "}
            <strong>
              {AUTO_MODE_LABEL
                ? `${AUTO_MODE_LABEL} permission mode`
                : "its harness's declared auto-mode posture"}
            </strong>
            .{" "}
            {AUTO_SDK_ONLY.map((agent) => (
              <span key={agent}>
                For {AGENT_IDENTITY[agent].label}, embedded dispatches apply that posture through
                the driver; terminal dispatches use the harness's own launch treatment instead.{" "}
              </span>
            ))}
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip
            label={`Start every dispatched ${AUTO_LABEL} session with its harness's declared auto-mode posture`}
          >
            <label className="skill-switch">
              <input
                type="checkbox"
                checked={autoMode}
                disabled={!config}
                onChange={(e) => void update({ autoModeOnDispatch: e.target.checked })}
                aria-label={`Start every dispatched ${AUTO_LABEL} session with its harness's declared auto-mode posture`}
              />
            </label>
          </Tooltip>
        </div>
      </div>

      <div className="settings-section-head harnesses-subhead">
        <h4>Per harness</h4>
      </div>
      <div className="harness-cards">
        {HARNESS_CARDS.map((card) => (
          <HarnessCard
            key={card.agent}
            agent={card.agent}
            label={card.label}
            model={config?.defaultModel[card.agent] ?? null}
            effort={config?.defaultEffort[card.agent] ?? null}
            runtime={config?.sessionRuntime[card.agent] ?? null}
            terminalBackend={config?.terminalBackend[card.agent] ?? null}
            autoMode={autoMode}
            disabled={!config}
            piSdkReady={piSdkReady}
            advisor={config?.advisor[card.agent] ?? EMPTY_ADVISOR[card.agent]}
            advisorEnvironment={advisorEnvironments?.[card.agent] ?? null}
            onAdvisor={(patch) => void update({ advisor: { [card.agent]: patch } })}
            onModel={(id) => void update({ defaultModel: { [card.agent]: id } })}
            onEffort={(level) => void update({ defaultEffort: { [card.agent]: level } })}
            onRuntime={(runtime) => void update({ sessionRuntime: { [card.agent]: runtime } })}
            onTerminalBackend={(backend) =>
              void update({ terminalBackend: { [card.agent]: backend } })
            }
          />
        ))}
      </div>
      <p className="settings-hint harnesses-cards-hint">
        The dispatch form starts on these values and lets you pick a different model and
        effort per task, so a one-off that needs more (or less) horsepower doesn't mean
        changing the default. The advisor is not a per-task choice: a dispatched session
        gets the one set here for the model it launches on.
      </p>
    </section>
  );
}
