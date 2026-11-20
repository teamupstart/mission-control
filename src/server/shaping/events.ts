import { shapingConfigView, type ShapingConfigView } from "@shared/shaping.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../feature-flags/index.ts";
import { getShapingConfig, onShapingConfigChanged } from "./index.ts";

/**
 * The one bridge from task shaping's store to open windows, wired once at daemon start.
 *
 * It follows the `task-shaping` flag, as the routes do. While the flag is off it holds no
 * subscription to the store, so nothing reads the stored shapers, and it sends no config.
 * Turning the flag on subscribes and sends the current config, so an open window fills its
 * panel with no reload; turning it off unsubscribes and sends `null`, which clears it. Every
 * frame carries the config view, so an unsupported entry leaves the daemon only as its id,
 * label and reason. The emitter drops frames that restate the last one, so a change to some
 * other flag sends nothing.
 *
 * Returns the unsubscribe the daemon calls at shutdown.
 */
export function wireShapingConfigEvents(emit: (config: ShapingConfigView | null) => void): () => void {
  let stopConfig: (() => void) | null = null;
  const reconcile = (): void => {
    if (featureEnabled("task-shaping")) {
      stopConfig ??= onShapingConfigChanged((config) => emit(shapingConfigView(config)));
      emit(shapingConfigView(getShapingConfig()));
      return;
    }
    stopConfig?.();
    stopConfig = null;
    emit(null);
  };
  const stopFlags = onFeatureFlagsChanged(reconcile);
  reconcile();
  return () => {
    stopFlags();
    stopConfig?.();
    stopConfig = null;
  };
}
