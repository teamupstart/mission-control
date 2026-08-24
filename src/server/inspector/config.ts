import { getAppConfig, setAppConfig } from "../db.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { INSPECTOR_MODEL_ENV, resolveInspectorModel } from "@shared/inspector.ts";
import type { ResolvedInspectorModel } from "@shared/inspector.ts";
import { providerOwningModel } from "@shared/model.ts";
import { isLlmRunnerId } from "@shared/llm.ts";
import type { ResolvedLlmRunner } from "@shared/llm.ts";
import { InspectorConfigSchema } from "@shared/protocol.ts";
import type { InspectorConfig, InspectorConfigPatch } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { llmRunnerChoice } from "../llm/config.ts";

// The Inspector's config: a schema-validated blob over the `app_config` KV, so a new
// key needs no migration - Zod's defaults are applied on every read, and a blob written
// by an older build gains new fields for free.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.inspector;

/** The current config, with schema defaults applied over whatever was stored. */
export function getInspectorConfig(): InspectorConfig {
  return InspectorConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** Merge a patch over the current config, persist, and return the result. */
export function setInspectorConfig(patch: InspectorConfigPatch): InspectorConfig {
  const cur = getInspectorConfig();
  const next = InspectorConfigSchema.parse({ ...cur, ...patch, ...pinInspectorProvider(cur, patch) });
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}

/**
 * Record a provider when a model is saved with none of its own - the `foreman` blob's
 * `pinRoleProviders` rule, for the one slot this blob owns.
 *
 * Without it the Inspector is the asymmetric case: a Claude model chosen while its provider
 * was inherited stores only half a pair, and the missing half is then whatever the app-wide
 * ladder resolves to later. Move the app-wide radio to Codex and the review call is a Codex
 * provider holding a Claude model id - and this is the call that writes where other people
 * read. Resolution refuses that pair, so nothing incompatible is ever spawned; pinning is
 * what stops the operator's actual choice from being the thing thrown away.
 *
 * Only writes that TOUCH the model pin, so an unrelated `enabled` or `mode` change never
 * converts an inheriting slot into a pinned one - the same restriction, for the same reason,
 * that `pinRoleProviders` applies.
 */
function pinInspectorProvider(
  before: InspectorConfig,
  patch: InspectorConfigPatch,
): Partial<InspectorConfig> {
  if (!Object.prototype.hasOwnProperty.call(patch, "model")) return {};
  const merged = { ...before, ...patch };
  const model = merged.model?.trim() ?? "";
  if (!model) return {};
  // An explicit provider always wins: one already stored, or one this same patch names.
  if (merged.runner?.trim()) return {};
  // The provider the model POSITIVELY belongs to, else the one in force before this write -
  // a custom or newly released id belongs to nobody the catalog knows, and the provider the
  // operator was looking at when they picked it is the only evidence there is.
  return { runner: providerOwningModel(model) ?? inspectorRunner(before).id };
}

/**
 * What the Inspector will spawn with, and which layer chose it.
 *
 * Here rather than in the worker because the ROUTE needs it too - the settings panel
 * cannot resolve the env layer itself - and a status route reaching into the worker to
 * ask would make the review loop a dependency of rendering a text box. The env lookup is
 * this side of the shared/server line for the usual reason: `envVar` reads `node:os`.
 *
 * Resolved per call, never captured: the config is editable at runtime through
 * `PUT /api/inspector/config`, and a value read at module load would need a restart.
 */
export function inspectorModel(cfg: InspectorConfig = getInspectorConfig()): ResolvedInspectorModel {
  return resolveInspectorModel(cfg, envVar(INSPECTOR_MODEL_ENV), inspectorRunner(cfg).id);
}

/**
 * Which provider the Inspector spawns through, and which layer chose it.
 *
 * Two rungs: the Inspector's own choice, then the app-wide ladder. This used to bottom out
 * at a literal `"claude"`, which is not the same thing at all - it made the Inspector the one
 * subsystem in the app that ignored `MISSION_LLM_RUNNER` and the app-wide setting whenever
 * its own provider was unset. An operator who had pinned the whole app to a provider got a
 * Claude review anyway, with nothing on screen saying so.
 *
 * An unreadable stored id is reported through `unknown` and then inherits, exactly as
 * `llmJobRunner` and `resolveForemanRunner` do: a silent replacement reads back as the
 * operator's own pick.
 *
 * Resolved per call, never captured - the config is editable at runtime through
 * `PUT /api/inspector/config`, and a value read at module load would need a restart.
 */
export function inspectorRunner(cfg: InspectorConfig = getInspectorConfig()): ResolvedLlmRunner {
  const asked = cfg.runner?.trim() ?? "";
  if (!asked) return llmRunnerChoice();
  if (isLlmRunnerId(asked)) return { id: asked, source: "config", unknown: null };
  return { ...llmRunnerChoice(), unknown: asked };
}
