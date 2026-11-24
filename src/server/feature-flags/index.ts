import type { Context, MiddlewareHandler } from "hono";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  applyFeatureFlagIntent as applyIntent, FEATURE_FLAGS_DEFAULTS, FeatureFlagsConfigSchema,
  resolveFeatureFlags, sameFeatureFlagsConfig,
  type FeatureFlagId, type FeatureFlagIntent,
  type FeatureFlagIntentResult, type FeatureFlagsConfig,
} from "@shared/feature-flags.ts";
import { getAppConfig, openDb, setAppConfig } from "../db.ts";

// A connection owns its cached config and listeners. Closing/reopening a database cannot
// inherit either, and isolated test workers never share an operator's settings.
const stores = new WeakMap<ReturnType<typeof openDb>, {
  config: FeatureFlagsConfig;
  resolved: Record<string, boolean>;
  listeners: Set<(config: FeatureFlagsConfig) => void>;
  pending: Array<{ config: FeatureFlagsConfig; listeners: Array<(config: FeatureFlagsConfig) => void> }>;
  publishing: boolean;
}>();
function immutable(config: FeatureFlagsConfig): FeatureFlagsConfig {
  Object.freeze(config.overrides);
  return Object.freeze(config);
}
function readConfig(): FeatureFlagsConfig {
  const parsed = FeatureFlagsConfigSchema.safeParse(getAppConfig(APP_CONFIG_ENTRIES.featureFlags) ?? {});
  return immutable(parsed.success ? parsed.data : { ...FEATURE_FLAGS_DEFAULTS });
}
function store() {
  const db = openDb();
  let state = stores.get(db);
  if (!state) {
    const config = readConfig();
    state = { config, resolved: resolveFeatureFlags(config), listeners: new Set(), pending: [], publishing: false };
    stores.set(db, state);
  }
  return state;
}
function publish(config: FeatureFlagsConfig): FeatureFlagsConfig {
  const state = store();
  const changed = !sameFeatureFlagsConfig(state.config, config);
  state.config = immutable(config);
  state.resolved = resolveFeatureFlags(state.config);
  // Capture both the committed value and membership. A listener may write again, including
  // during Registry's broadcast to windows. Finish delivering A everywhere before B;
  // recursive delivery would let a later window receive B followed by stale A.
  if (changed) state.pending.push({ config: state.config, listeners: [...state.listeners] });
  if (state.publishing) return state.config;
  state.publishing = true;
  try {
    for (let next = state.pending.shift(); next; next = state.pending.shift()) {
      for (const listener of next.listeners) {
        try { listener(next.config); }
        catch (error) { console.warn("[feature-flags] change listener failed:", error); }
      }
    }
  } finally {
    state.publishing = false;
  }
  return state.config;
}
export function getFeatureFlagsConfig(): FeatureFlagsConfig { return store().config; }
export function reloadFeatureFlags(): FeatureFlagsConfig { return publish(readConfig()); }
export function featureEnabled(id: FeatureFlagId): boolean {
  const resolved = store().resolved;
  return Object.hasOwn(resolved, id) && resolved[id] === true;
}
export function onFeatureFlagsChanged(listener: (config: FeatureFlagsConfig) => void): () => void {
  const listeners = store().listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function applyFeatureFlagIntent(intent: FeatureFlagIntent): FeatureFlagIntentResult {
  const result = applyIntent(getFeatureFlagsConfig(), intent);
  if (!result.ok) return result;
  // Enforce the stored bound too: a single new choice can grow a full overrides record.
  const config = FeatureFlagsConfigSchema.parse(result.config);
  setAppConfig(APP_CONFIG_ENTRIES.featureFlags, config);
  return { ok: true, config: publish(config) };
}
export function disabledFeatureResponse(c: Context, id: FeatureFlagId) {
  if (!featureEnabled(id)) return c.json({ error: "This feature is disabled.", feature: id }, 404);
}

export function requireFeature(id: FeatureFlagId): MiddlewareHandler {
  return async (c, next) => disabledFeatureResponse(c, id) ?? next();
}
