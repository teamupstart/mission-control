import { repoAllowlisted } from "./allowlist.ts";
import type { InspectorConfig } from "./protocol.ts";

// "Would the Inspector actually act on this pull request?" - asked once, here.
//
// The Inspector's consent is three independent switches (`enabled`, `mode`, its own
// `repoAllowlist`), and until this module existed only ONE caller read all three: the
// worker's `mayPost`, deciding whether to publish a comment. YOLO mode asked a different
// and weaker question - "did a review happen?" - which a review that posts nothing
// answers yes.
//
// That gap merged commits. `reviewRound` runs whether or not we may post (findings are
// recorded `drafted` instead), so it advances `headSha` and `round` in dry run exactly as
// it does live. A clean dry-run review therefore has a reviewed head matching the PR and
// zero open findings, which satisfied every gate the merge predicate had - and the merge
// is the one action here nobody can undo. "Dry run" has to mean dry for the whole app,
// not just for the half of it that posts comments.
//
// So the three switches are collapsed into one value with a REASON attached, and both
// callers read it: the worker to decide whether to post, YOLO mode to decide whether the
// review it is about to act on was ever worth anything. Pure - no config reads, no clock,
// no `node:` import - so the dashboard can call it too.

/**
 * What the Inspector is currently able to do about one pull request.
 *
 * `live` is the only value that means "this review is real": it was published under the
 * operator's GitHub identity, in a repo they trusted, with the feature switched on.
 * Every other value names which switch is withholding that.
 */
export type InspectorPosture = "live" | "off" | "dry-run" | "not-allowlisted";

/**
 * Which posture the Inspector holds for this checkout.
 *
 * Order matters only for which reason is reported, and it runs outermost-switch first:
 * an operator whose Inspector is off is not helped by being told their repo is untrusted.
 *
 * Takes a structural type rather than the whole `InspectorConfig` so the dashboard can
 * ask with whatever it holds, and so adding a field to the config cannot silently change
 * what consent means.
 */
export function inspectorPosture(
  cfg: Pick<InspectorConfig, "enabled" | "mode" | "repoAllowlist">,
  cwd: string | null,
  repoRoot: string | null,
): InspectorPosture {
  if (!cfg.enabled) return "off";
  if (cfg.mode !== "live") return "dry-run";
  if (!repoAllowlisted(cwd, repoRoot, cfg.repoAllowlist)) return "not-allowlisted";
  return "live";
}
