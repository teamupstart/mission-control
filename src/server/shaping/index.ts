import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  applyShapingIntent as applyIntent,
  SHAPING_CONFIG_DEFAULTS,
  ShapingConfigSchema,
  sameShapingConfig,
  type DiscoveredShaper,
  type ShapingConfig,
  type ShapingIntent,
  type ShapingIntentResult,
} from "@shared/shaping.ts";
import { getAppConfig, hasAppConfigRow, openDb, setAppConfig } from "../db.ts";
import { advanceShapingGeneration, noteShapingEntriesChanged, shapingReviser } from "./revisions.ts";

/**
 * The daemon's one owner of `app_config.shaping`, built the way the feature-flag store is: a
 * cache per SQLite connection, listeners notified in commit order, and a reload a settings
 * restore calls. Nothing here reads the config until something asks for it, so with the
 * `task-shaping` flag off - every route answers 404 and dispatch never calls the engine - the
 * stored value is never touched.
 */

type Listener = (config: ShapingConfig) => void;
interface Store {
  config: ShapingConfig;
  /**
   * False when the stored value does not parse, for instance one written by a build with larger
   * bounds. Reads then see the defaults, and every write is refused rather than replacing
   * shapers this build could not read.
   */
  readable: boolean;
  listeners: Set<Listener>;
  pending: Array<{ config: ShapingConfig; listeners: Listener[] }>;
  publishing: boolean;
}

const stores = new WeakMap<ReturnType<typeof openDb>, Store>();

function freeze(config: ShapingConfig): ShapingConfig {
  return deepFreeze(config);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function readConfig(): { config: ShapingConfig; readable: boolean } {
  const stored = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  // `getAppConfig` answers undefined both for a missing row and for one whose JSON does not
  // parse. Only a missing row means "never configured"; a row that cannot be decoded is
  // unreadable, so no write replaces the shapers it may hold.
  // Only an absent row means "never configured". A row that holds JSON `null`, or JSON that does
  // not decode, is a value this build cannot read, and takes the same refusing path.
  if (stored === undefined && !hasAppConfigRow(APP_CONFIG_ENTRIES.shaping)) {
    return { config: freeze(structuredClone(SHAPING_CONFIG_DEFAULTS)), readable: true };
  }
  if (stored === undefined || stored === null) {
    console.warn("[shaping] stored config is not a readable value; using defaults and refusing writes");
    return { config: freeze(structuredClone(SHAPING_CONFIG_DEFAULTS)), readable: false };
  }
  let parsed: ReturnType<typeof ShapingConfigSchema.safeParse>;
  try {
    parsed = ShapingConfigSchema.safeParse(stored);
  } catch (error) {
    // The schema refuses deep nesting before it recurses; this is the second line, so nothing a
    // stored value holds can throw out of a read.
    console.warn("[shaping] stored config could not be read; using defaults and refusing writes:", error instanceof Error ? error.message : String(error));
    return { config: freeze(structuredClone(SHAPING_CONFIG_DEFAULTS)), readable: false };
  }
  if (parsed.success) return { config: freeze(parsed.data), readable: true };
  console.warn("[shaping] stored config does not parse; using defaults and refusing writes:", parsed.error.issues[0]?.message);
  return { config: freeze(structuredClone(SHAPING_CONFIG_DEFAULTS)), readable: false };
}

function store(): Store {
  const db = openDb();
  let state = stores.get(db);
  if (!state) {
    const { config, readable } = readConfig();
    state = { config, readable, listeners: new Set(), pending: [], publishing: false };
    stores.set(db, state);
  }
  return state;
}

function publish(state: Store, config: ShapingConfig): ShapingConfig {
  const changed = !sameShapingConfig(state.config, config);
  // Before any listener derives a view: every revision it carries is of the new generation.
  noteShapingEntriesChanged(state.config, config);
  state.config = freeze(config);
  // Capture the committed value and the membership, and finish delivering one config to every
  // listener before the next, even when a listener writes again.
  if (changed) state.pending.push({ config: state.config, listeners: [...state.listeners] });
  if (state.publishing) return state.config;
  state.publishing = true;
  try {
    for (let next = state.pending.shift(); next; next = state.pending.shift()) {
      for (const listener of next.listeners) {
        try { listener(next.config); }
        catch (error) { console.warn("[shaping] change listener failed:", error); }
      }
    }
  } finally {
    state.publishing = false;
  }
  return state.config;
}

/** The immutable stored config, or the defaults when nothing is stored. */
export function getShapingConfig(): ShapingConfig {
  return store().config;
}

/**
 * Re-read after a settings restore. A connection that never read the config has nothing cached,
 * so it reads nothing now either; the next reader loads the restored value.
 */
export function reloadShaping(): void {
  const state = stores.get(openDb());
  if (!state) return;
  const { config, readable } = readConfig();
  state.readable = readable;
  publish(state, config);
}

export function onShapingConfigChanged(listener: Listener): () => void {
  const listeners = store().listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type ShapingStoreResult = ShapingIntentResult | { ok: false; error: "unreadable_config"; reason: string };

/** Apply one intent, persist it, and notify listeners. `discovered` names the folder's shapers. */
export function applyShapingIntent(intent: ShapingIntent, discovered: readonly DiscoveredShaper[] = []): ShapingStoreResult {
  const state = store();
  if (!state.readable) {
    return {
      ok: false,
      error: "unreadable_config",
      reason: "The stored task shaping config cannot be read by this build, so it is not overwritten.",
    };
  }
  const result = applyIntent(state.config, intent, discovered, { revise: shapingReviser });
  if (!result.ok) return result;
  // Enforce the stored bounds on the whole record, not only the intent.
  const config = ShapingConfigSchema.parse(result.config);
  setAppConfig(APP_CONFIG_ENTRIES.shaping, config);
  // An import or removal starts a new generation of its id even when the stored content is the
  // same as before, so a write held from before it can never pass afterwards.
  if (intent.kind === "upsert") advanceShapingGeneration(intent.shaper.id);
  if (intent.kind === "remove") advanceShapingGeneration(intent.id);
  return { ok: true, config: publish(state, config) };
}
