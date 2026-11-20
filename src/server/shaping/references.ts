import type { ShapingConfig, ShapingReferenceStatus } from "@shared/shaping.ts";

/**
 * Whether each `{env:NAME}` a shaper references is set in the daemon's environment, never its
 * value. Resolution arrives with the remote transports; until then nothing is reported, and
 * `GET /api/shaping` already carries the field.
 */
export function referenceStatus(_config: ShapingConfig): ShapingReferenceStatus {
  return {};
}
