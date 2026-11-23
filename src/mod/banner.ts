import { dispatchBannerPlain } from "@shared/home-dispatch-banner.ts";
import type { HomeSessionRegistrationAnswer } from "@shared/home-dispatch.ts";
import { MOD_VERSION } from "./constants.ts";

/**
 * The start-up banner (spec 7.21). The daemon writes it into a `startup` registration answer
 * through the one builder; for a `resume`, `clear` or `compact` start it sends none, and the mod
 * builds the same three lines from the same function, so the text never lives in two places.
 */
export function bannerLines(answer: HomeSessionRegistrationAnswer): readonly string[] {
  if (answer.banner && answer.banner.length > 0) return answer.banner;
  return dispatchBannerPlain({
    harness: "claude",
    counts: answer.counts,
    menuOffered: answer.offerLauncher,
    versionMismatch: answer.daemonVersion !== MOD_VERSION,
  });
}
