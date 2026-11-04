import type { RunResult } from "../util/exec.ts";

/**
 * The operator's sentence for a source whose checkout has gone, or null.
 *
 * Every CLI a source runs is started in that source's repository. When the directory has
 * been moved or deleted, Node refuses the spawn with the same ENOENT a missing binary
 * produces, and each classifier used to read it as "not installed" - telling an operator
 * who has the CLI to go and install it. `run` names the missing directory as a fact, and
 * this is the one place that fact is turned into the repair, so the three classifiers
 * cannot drift into three wordings.
 */
export function repoRootGone(res: Pick<RunResult, "missingCwd">): string | null {
  if (res.missingCwd === undefined) return null;
  return `this source files tasks against ${res.missingCwd}, which no longer exists - choose its current checkout under "Files tasks against" and run Check it works again`;
}
