import type { AgentType, SessionRuntime } from "@shared/types.ts";
import { standingInstructionsChannel } from "@shared/harness-capabilities.ts";
import {
  resolveStandingInstructions,
  type ResolvedStandingInstructions,
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
  const contributing = resolved.filter((entry) => entry.parts.length > 0);
  const sources = contributing.map((entry) => ({
    repoPath: entry.repoPath,
    matchedKey: entry.matchedKey,
  }));

  if (contributing.length === 0) {
    return { text: "", mechanism: "none", sources: [] };
  }

  // Resolution owns which contributions apply and their order. Group those parts without
  // re-reading configuration or rebuilding that policy. Keep default and repository parts
  // distinct even when their words match, since their scopes can differ.
  const groups: (ResolvedStandingInstructions["parts"][number] & { repoPaths: string[] })[] = [];
  for (const entry of contributing) {
    for (const part of entry.parts) {
      const existing = groups.find((group) => group.source === part.source && group.text === part.text);
      if (existing) existing.repoPaths.push(entry.repoPath);
      else groups.push({ ...part, repoPaths: [entry.repoPath] });
    }
  }

  // A rule's scope is relative to the whole launch, including checkouts with no text.
  const heading = resolved.length === 1
    ? STANDING_INSTRUCTIONS_HEADING
    : STANDING_INSTRUCTIONS_MULTI_HEADING;
  const parts: string[] = [heading];
  for (const group of groups) {
    const coversAll = group.repoPaths.length === resolved.length;
    parts.push(coversAll ? group.text : `### ${group.repoPaths.join(", ")}\n\n${group.text}`);
  }
  const text = parts.join("\n\n");

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
