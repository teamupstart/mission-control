import { AGENT_IDENTITY } from "./agent.ts";
import { capabilitiesFor, supportsAdvisor } from "./harness-capabilities.ts";
import { coreModelId } from "./model.ts";
import type { AdvisorEnvironment, HarnessesConfig, HarnessesConfigPatch } from "./protocol.ts";
import { AGENT_TYPES, type AdvisorChoice, type AgentType } from "./types.ts";

// The advisor a dispatched session launches with: one resolution, read by the dispatcher
// that renders it, the resume path that re-renders it, the dispatch form that previews it,
// and the Harnesses panel that describes it. Browser-safe, so all four answer from the same
// rule rather than from copies of it.

/** Which setting answered. `task` is a pin stored before the advisor moved to Settings. */
export type AdvisorSource = "task" | "override" | "default";

export interface AdvisorResolution {
  /** The choice to render, or null for Inherit: render nothing, the harness's settings decide. */
  choice: AdvisorChoice | null;
  /** What supplied `choice`. `default` also answers an Inherit nobody overrode. */
  source: AdvisorSource;
}

/** The key an override is stored under for a launch model: the bare id, no `[1m]` marker. */
export function advisorOverrideKey(model: string): string {
  return coreModelId(model);
}

/**
 * The advisor for one launch.
 *
 * A legacy task pin first, then the override for the model this launch resolved, then the
 * harness's default. Every stored value is narrowed through `supportsAdvisor`, so a choice a
 * newer build wrote, or one left on a harness that has no advisor, resolves to Inherit rather
 * than reaching an argv the CLI would reject.
 *
 * `model` is the RESOLVED launch model (`resolveLaunchModel`), not the task's pin: on the
 * common path the task names no model and the kind or harness default supplies it, and the
 * override for that model is the one the operator expects to apply. Null means the launch
 * passes no `--model`, so only the default can answer.
 */
export function resolveLaunchAdvisor(
  config: Pick<HarnessesConfig, "advisor">,
  agent: AgentType,
  model: string | null,
  taskPin: AdvisorChoice | null = null,
): AdvisorResolution {
  const narrow = (value: string | null | undefined): AdvisorChoice | null =>
    value && supportsAdvisor(agent, value as AdvisorChoice) ? (value as AdvisorChoice) : null;
  const pinned = narrow(taskPin);
  if (pinned) return { choice: pinned, source: "task" };
  const stored = config.advisor[agent];
  const override = model ? narrow(stored.overrides[advisorOverrideKey(model)]) : null;
  if (override) return { choice: override, source: "override" };
  return { choice: narrow(stored.default), source: "default" };
}

/**
 * The advisor maps, merged by harness and then by model, so setting the Claude default
 * cannot drop the overrides beside it and one override row cannot replace the others. A
 * `null` override removes that model's row rather than storing Inherit under it: an absent
 * row already falls through to the default, and a stored null would be a second spelling.
 *
 * Shared so the daemon's `setHarnessesConfig` and the panel's optimistic
 * `mergeHarnessesPatch` cannot disagree about what a patch leaves behind.
 */
export function mergeAdvisor(
  cur: HarnessesConfig["advisor"],
  patch: HarnessesConfigPatch["advisor"],
): HarnessesConfig["advisor"] {
  if (!patch) return cur;
  const next = { ...cur };
  for (const agent of AGENT_TYPES) {
    const row = patch[agent];
    if (!row) continue;
    const overrides = { ...next[agent].overrides };
    for (const [model, choice] of Object.entries(row.overrides ?? {})) {
      const key = advisorOverrideKey(model);
      if (choice === null) delete overrides[key];
      else overrides[key] = choice;
    }
    next[agent] = {
      default: row.default === undefined ? next[agent].default : row.default,
      overrides,
    };
  }
  return next;
}

/** How an advisor choice reads on the dashboard. Inherit is the null, not a value. */
export const ADVISOR_CHOICE_LABELS: Record<AdvisorChoice, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  off: "Off",
};

/** An advisor named by a settings file - an alias or a full id - as one short label. */
export function advisorLabel(value: string): string {
  const alias = ADVISOR_CHOICE_LABELS[value.toLowerCase() as AdvisorChoice];
  if (alias) return alias;
  const m = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/i.exec(coreModelId(value));
  if (!m) return value;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}

/**
 * Whether a session on `model` will be offered `choice`, as one verdict and one sentence.
 *
 * `on` is about what Mission Control can know: a pin, an inherited setting, and the switches
 * that turn the advisor off for every session. Account eligibility is a server-side flag
 * nothing local can read, so `on` still means "configured and not ruled out".
 */
export interface AdvisorStatus {
  on: boolean;
  /** The advisor that would be consulted, as a label, when `on`. */
  advisor: string | null;
  /** One sentence for the operator. */
  text: string;
  /** A pairing the CLI says it will not consult on the main conversation, or null. */
  warning: string | null;
}

export function advisorStatus(
  agent: AgentType,
  choice: AdvisorChoice | null,
  model: string | null,
  environment: AdvisorEnvironment | null,
): AdvisorStatus {
  if (choice === "off") {
    return { on: false, advisor: null, text: "Off: dispatched sessions launch with the advisor tool disabled.", warning: null };
  }
  const named = choice ?? environment?.inherited ?? null;
  if (choice === null && !environment) {
    return { on: false, advisor: null, text: "Inherits your own settings; still reading them.", warning: null };
  }
  // Ahead of "names no advisor": the switch would also block an advisor chosen later, so it
  // is the reason the operator needs to see.
  if (environment?.blocked) {
    return { on: false, advisor: null, text: `Off: ${environment.blocked}`, warning: null };
  }
  if (!named) {
    return {
      on: false,
      advisor: null,
      text: `Off: ${environment!.source} names no advisor, so only a project's own settings could add one.`,
      warning: null,
    };
  }
  const label = advisorLabel(named);
  const text = choice
    ? `On: sessions may consult ${label}.`
    : `On: inherits ${label} from ${environment!.source}.`;
  const spec = capabilitiesFor(agent).advisor;
  const weaker = Boolean(model && spec?.weakerThan(named, model));
  return {
    on: true,
    advisor: label,
    text,
    warning: weaker && model
      ? `${label} is less capable than the session model, so ${AGENT_IDENTITY[agent].label} will not consult it on the main conversation.`
      : null,
  };
}
