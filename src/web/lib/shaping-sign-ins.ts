import type { ShapingSignInView } from "@shared/shaping.ts";
import type { ServerEvent } from "@shared/types.ts";

/** One shared empty list, so a window with no sign-ins keeps the same reference across frames. */
export const NO_SHAPING_SIGN_INS: ShapingSignInView[] = [];

/**
 * The sign-in list a window holds after `msg`, reduced by `useEventStream`. A snapshot replaces
 * it with its `shapingSignIns`, absent while either flag is off and so read as empty; a
 * `shaping_sign_ins` frame replaces it with its list, empty when a flag went off. Any other event
 * leaves it as it was.
 */
export function shapingSignInsAfter(current: ShapingSignInView[], msg: ServerEvent): ShapingSignInView[] {
  const next = msg.type === "snapshot" ? msg.shapingSignIns
    : msg.type === "shaping_sign_ins" ? msg.signIns
      : current;
  return next === undefined || next.length === 0 ? NO_SHAPING_SIGN_INS : next;
}
