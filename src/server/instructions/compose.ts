import type { AgentType, SessionRuntime } from "@shared/types.ts";
import { standingInstructionsChannel } from "@shared/harness-capabilities.ts";
import {
  resolveStandingInstructions,
  type StandingInstructionsConfig,
  type StandingInstructionsDelivery,
} from "@shared/standing-instructions.ts";

// Turning resolved text into the block an agent actually reads, and into the one record of
// what was sent.
//
// ONE composer, used by the launch, by the resolved route's preview, and by the snapshot,
// so "what will be sent", "what was sent" and "what the agent read" cannot become three
// answers. A preview that re-derived the labelled blocks would be free to drift from the
// delivery, and a marker that says "nothing" when a block was in fact sent is the failure
// that costs an operator the most - because a marker saying nothing is the reason they stop
// looking.

/** The heading a single repository's block carries. */
export const STANDING_INSTRUCTIONS_HEADING = "## Standing instructions for this repository";

/** The heading a multi-repository dispatch's block carries, above its labelled parts. */
export const STANDING_INSTRUCTIONS_MULTI_HEADING =
  "## Standing instructions for these repositories";

/** One checkout entering the composer, in the launch manifest's order. */
export interface StandingInstructionsCandidate {
  /** The CANONICAL repo-rooted path - `resolveRepoPath(cwd).path`, never `.repoRoot`. */
  repoPath: string;
}

/**
 * Compose the block for a launch, and say which channel will carry it.
 *
 * `candidates` is every attached repository, in the manifest's order - not just the
 * primary. A multi-repo dispatch hands the agent write access to all of them, and sending
 * only the primary's rules would be the same laundering `taskReposAllowlisted` refuses for
 * consent: the operator's rule for the secondary repository would silently not apply inside
 * it.
 *
 * A repository that resolves to empty text contributes NOTHING - not an empty heading, not
 * a label. That is what makes the decisive regression guard hold: a checkout with no
 * standing instructions produces `text: ""`, every caller renders nothing at all, and the
 * prompt and argv are byte-identical to what they were before this feature existed.
 */
export function composeStandingInstructions(
  config: StandingInstructionsConfig,
  candidates: readonly StandingInstructionsCandidate[],
  agent: AgentType,
  runtime: SessionRuntime,
): StandingInstructionsDelivery {
  const resolved = candidates.map((candidate) => ({
    repoPath: candidate.repoPath,
    ...resolveStandingInstructions(config, candidate.repoPath),
  }));
  const contributing = resolved.filter((entry) => entry.text.length > 0);
  const sources = contributing.map((entry) => ({
    repoPath: entry.repoPath,
    matchedKey: entry.matchedKey,
  }));

  if (contributing.length === 0) {
    return { text: "", mechanism: "none", sources: [] };
  }

  // Grouped by the TEXT that was resolved, in manifest order, because several checkouts
  // very often resolve to the same words - the machine-wide default is the ordinary case,
  // and so is one key covering a monorepo's packages. Rendering one labelled part per
  // CHECKOUT would then repeat a rule the operator wrote once, which is the same failure
  // exactly-once delivery exists to prevent: a prohibition stated three times invites being
  // read as emphasis about something that was said once. Grouping is on the resolved text
  // rather than on the matched key, so two different keys that happen to carry identical
  // words also collapse - the agent reads words, not keys.
  //
  // `sources` is deliberately NOT grouped: provenance stays one entry per contributing
  // repository, so a marker can still say which stored key each checkout inherited.
  const groups: { text: string; repoPaths: string[] }[] = [];
  for (const entry of contributing) {
    const existing = groups.find((group) => group.text === entry.text);
    if (existing) existing.repoPaths.push(entry.repoPath);
    else groups.push({ text: entry.text, repoPaths: [entry.repoPath] });
  }

  // One group is ONE rule, however many checkouts it covers, so it carries no labels - a
  // label would imply a distinction that is not there. The heading still says which case it
  // is, so a single repository reads "this repository" exactly as it did before this
  // grouping existed. Several groups keep the labelled parts, and a label names every
  // checkout its part governs, so an agent holding three worktrees can still tell which
  // prohibition belongs to which tree.
  const text =
    groups.length === 1
      ? `${contributing.length === 1 ? STANDING_INSTRUCTIONS_HEADING : STANDING_INSTRUCTIONS_MULTI_HEADING}\n\n${groups[0]!.text}`
      : [
          STANDING_INSTRUCTIONS_MULTI_HEADING,
          ...groups.map((group) => `### ${group.repoPaths.join(", ")}\n\n${group.text}`),
        ].join("\n\n");

  return {
    text,
    // `prompt-prefix` is the answer for a pair with no channel of its own, read from the
    // harness registry rather than derived from an agent name here. Two readings of that
    // question are how a pair ends up double-delivered or silently undelivered.
    mechanism: standingInstructionsChannel(agent, runtime) ?? "prompt-prefix",
    sources,
  };
}

/**
 * Put a composed block in front of an intent, in the position the repo manifest already
 * occupies and for the same reason.
 *
 * `task-contract.ts` states the rule this follows: the operator's own words stay the exact
 * prefix and server-owned material follows them. This text IS the operator's words, so it
 * rides in front of the request - after the manifest, which names the checkouts these rules
 * are ABOUT, and before the intent they govern.
 *
 * An empty block returns the intent unchanged, by identity. That is the regression guard in
 * one line.
 */
export function withStandingInstructions(block: string, intent: string): string {
  if (!block) return intent;
  return `${block}\n\n---\n\n${intent}`;
}
