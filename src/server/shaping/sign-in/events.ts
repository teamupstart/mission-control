import type { ShapingSignInView } from "@shared/shaping.ts";
import { onFeatureFlagsChanged } from "../../feature-flags/index.ts";
import { shaperSignInEnabled, shaperSignIns } from "./index.ts";
import type { ShaperSignInService } from "./service.ts";

/**
 * The one bridge from the sign-in service to open windows, wired once at daemon start, as
 * `wireShapingConfigEvents` is for the config.
 *
 * It follows both flags. While `task-shaping` and `shaper-sign-in` are both on it listens to the
 * service and sends the list now and on every change, so a window shows a sign-in finishing in
 * another tab with no reload. When either goes off it stops listening and sends an empty list,
 * which clears every window. The list is the service's view, which never holds a token, a code,
 * the OAuth `state` parameter, a verifier or an authorization URL. The emitter drops a frame that
 * restates the last one, so a change to some other flag sends nothing.
 *
 * Returns the unsubscribe the daemon calls at shutdown.
 */
export function wireShapingSignInEvents(
  emit: (signIns: ShapingSignInView[]) => void,
  deps: { service: ShaperSignInService; enabled: () => boolean; onFlagsChanged: (listener: () => void) => () => void } = {
    service: shaperSignIns, enabled: shaperSignInEnabled, onFlagsChanged: onFeatureFlagsChanged,
  },
): () => void {
  let stopChanges: (() => void) | null = null;
  const reconcile = (): void => {
    if (deps.enabled()) {
      stopChanges ??= deps.service.onChanged(emit);
      emit(deps.service.view());
      return;
    }
    stopChanges?.();
    stopChanges = null;
    emit([]);
  };
  const stopFlags = deps.onFlagsChanged(reconcile);
  reconcile();
  return () => {
    stopFlags();
    stopChanges?.();
    stopChanges = null;
  };
}
