import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { SHAPER_SIGN_IN_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { PORT } from "@shared/harness-runtime.mjs";
import {
  classifyShapers, shaperSignInTarget, ShapingSignInConfigSchema,
  type DiscoveredShaper, type ShapingConfig, type ShapingSignInClient, type SignInTarget,
} from "@shared/shaping.ts";
import { getAppConfig, setAppConfig } from "../../db.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../../feature-flags/index.ts";
import { discoverShapers } from "../discovery.ts";
import { getShapingConfig, onShapingConfigChanged } from "../index.ts";
import { connectionId } from "./connection.ts";
import { begin, discover, exchange, refresh, revoke } from "./flow.ts";
import { createShaperSignInService, type SignInRegistrations, type SignInUse } from "./service.ts";
import { createSignInStore } from "./store.ts";

/** The route the authorization server sends the browser back to. Served by the daemon (Phase 6). */
export const SIGN_IN_CALLBACK_PATH = "/api/shaping/sign-in/callback";

/** The loopback redirect URI every registration names. A changed port is a new redirect URI. */
export function signInRedirectUri(port: number = PORT): string {
  return `http://127.0.0.1:${port}${SIGN_IN_CALLBACK_PATH}`;
}

/** Shaper sign-in runs only while `task-shaping` and `shaper-sign-in` are both on. */
export function shaperSignInEnabled(): boolean {
  return featureEnabled("task-shaping") && featureEnabled(SHAPER_SIGN_IN_FLAG_ID);
}

/**
 * The client registrations in `app_config` key `shaping.signIn`. A value this build cannot read
 * is taken as none: it holds no token, and losing it costs only reuse, so the next sign-in
 * registers again and its write replaces it.
 */
export const appConfigSignInRegistrations: SignInRegistrations = {
  read(): ShapingSignInClient[] {
    const parsed = ShapingSignInConfigSchema.safeParse(getAppConfig(APP_CONFIG_ENTRIES.shapingSignIn) ?? {});
    return parsed.success ? parsed.data.clients : [];
  },
  write(clients) {
    setAppConfig(APP_CONFIG_ENTRIES.shapingSignIn, ShapingSignInConfigSchema.parse({ clients }));
  },
};

/** The daemon's one sign-in service. Phase 5's transports and Phase 6's routes reach it here. */
export const shaperSignIns = createShaperSignInService({
  store: () => createSignInStore({ warn: (message) => console.warn(`[shaping] ${message}`) }),
  flow: { discover, begin, exchange, refresh, revoke },
  registrations: appConfigSignInRegistrations,
  redirectUri: signInRedirectUri(),
  enabled: shaperSignInEnabled,
  onEnabledChanged: (listener) => onFeatureFlagsChanged(() => listener()),
});

/**
 * The connections the known shapers name: every registered shaper this build knows and every
 * runnable manifest the folder holds, whether switched on or not, grouped by connection.
 */
export function signInUses(config: ShapingConfig, discovered: readonly DiscoveredShaper[]): SignInUse[] {
  const uses = new Map<string, { target: SignInTarget; shapers: string[] }>();
  const add = (id: string, target: SignInTarget | null) => {
    if (!target) return;
    const key = connectionId(target);
    const entry = uses.get(key) ?? { target, shapers: [] };
    if (!entry.shapers.includes(id)) entry.shapers.push(id);
    uses.set(key, entry);
  };
  const registered = new Set<string>();
  for (const entry of classifyShapers(config)) {
    registered.add(entry.stored.id);
    if (entry.kind === "known") add(entry.shaper.id, shaperSignInTarget(entry.shaper));
  }
  for (const entry of discovered) {
    if (entry.state !== "ok" || !entry.shaper || registered.has(entry.id)) continue;
    add(entry.id, shaperSignInTarget(entry.shaper));
  }
  return [...uses.values()];
}

let lastScan: readonly DiscoveredShaper[] = [];

/**
 * Tells the service what a scan of the shapers folder found. The daemon scans once at start;
 * Settings' own reads of the folder (Phase 6) report here too, so a config change later is
 * combined with the folder's latest scan.
 */
export function noteShaperFolderScan(discovered: readonly DiscoveredShaper[]): void {
  lastScan = discovered;
  if (shaperSignInEnabled()) shaperSignIns.setInUse(signInUses(getShapingConfig(), lastScan));
}

/**
 * Starts the service and keeps its connections in use current while both flags are on: from
 * the stored config and one scan of the shapers folder, and again on every config change with
 * the folder's last scan. While either flag is off nothing is read. Returns the stop the
 * daemon awaits at shutdown.
 */
export function startShaperSignIns(): () => Promise<void> {
  let stopConfig: (() => void) | null = null;
  let scanned = false;
  const reconcile = (): void => {
    if (!shaperSignInEnabled()) {
      stopConfig?.();
      stopConfig = null;
      return;
    }
    if (stopConfig) return;
    stopConfig = onShapingConfigChanged((config) => shaperSignIns.setInUse(signInUses(config, lastScan)));
    shaperSignIns.setInUse(signInUses(getShapingConfig(), lastScan));
    if (scanned) return;
    scanned = true;
    discoverShapers().then(noteShaperFolderScan, (error: unknown) => {
      console.warn("[shaping] sign-in could not read the shapers folder:", error instanceof Error ? error.message : String(error));
    });
  };
  const stopFlags = onFeatureFlagsChanged(reconcile);
  reconcile();
  shaperSignIns.start();
  return async () => {
    stopFlags();
    stopConfig?.();
    stopConfig = null;
    await shaperSignIns.stop();
  };
}
