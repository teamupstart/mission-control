import type { AgentType, SessionRuntime } from "@shared/types.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import { resolveRepoPath } from "../repos.ts";
import { composeStandingInstructions } from "./compose.ts";
import { standingInstructionsConfig } from "./config.ts";

// The one door every path into this feature goes through.
//
// A surface that skips canonicalization does not fail loudly; it reports that nothing
// applies - which is the one answer an operator does not go on to check. Sessions normally
// run in pooled worktrees (`~/.treehouse/<pool>/16/mono/packages/api`), and keys are rooted
// on the MAIN checkout, so a raw path matches nothing while the launch from that same slot
// delivers a block. Hence `resolveRepoPath` here, and `.path` rather than `.repoRoot`:
// resolving to a repository is lossy in exactly the direction that breaks this feature -
// `/repo/packages/web` collapses to `/repo`, which makes a package-level key unreachable.

/**
 * The canonical repo-rooted path for a checkout, or null when it is not in a repository.
 *
 * Exported because the PUT that stores a key and the route that previews one owe the same
 * canonicalization the launch performs, and the invariant is easier to keep when there is
 * one function to point at.
 */
export async function canonicalRepoPath(p: string): Promise<string | null> {
  const resolved = await resolveRepoPath(p);
  return resolved ? resolved.path : null;
}

/**
 * What a launch into these checkouts will be sent, and by which channel.
 *
 * `checkouts` is every attached repository's working directory, in the launch manifest's
 * order, primary first.
 *
 * The empty document short-circuits before any canonicalization runs. That is not only an
 * optimization: `resolveRepoPath` shells out to git twice per checkout, and an installation
 * that has never opened the settings panel - which is every installation on the day this
 * merges - must not acquire two subprocesses per dispatch to be told that nothing applies.
 */
export async function standingInstructionsForLaunch(
  checkouts: readonly string[],
  agent: AgentType,
  runtime: SessionRuntime,
): Promise<StandingInstructionsDelivery> {
  const config = standingInstructionsConfig();
  if (config.default.length === 0 && Object.keys(config.repositories).length === 0) {
    return { text: "", mechanism: "none", sources: [] };
  }
  const candidates: { repoPath: string }[] = [];
  for (const checkout of checkouts) {
    // An unresolvable checkout contributes nothing rather than matching on its raw string.
    // Matching the raw string is how a pool path would acquire somebody else's rule.
    const repoPath = await canonicalRepoPath(checkout);
    if (repoPath) candidates.push({ repoPath });
  }
  return composeStandingInstructions(config, candidates, agent, runtime);
}
