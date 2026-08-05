import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRepoDoc, realpathOr } from "../util/repo-doc.ts";

// The reviewer's brief: what the reviewed repo's INSPECTOR.md says, or a built-in default
// when the repo hasn't written one.

/** Cap on the brief, so an enormous INSPECTOR.md can't crowd the diff out of the prompt. */
const MAX_BRIEF_BYTES = 24 * 1024;

/**
 * Where a repo may keep its brief, in the order they are consulted. First non-empty wins.
 *
 * Two locations rather than one because this path resolves against the REVIEWED repository,
 * not this one. Mission Control keeps its own brief in `personas/` beside the rest of its
 * persona documents, and that is the tidier convention to lead with - but a root
 * `INSPECTOR.md` is what every repo configured before that move has, and demoting them to
 * the default brief would be a silent downgrade of their reviews. So the root name stays a
 * supported location, not a deprecated one. A repo with both gets `personas/INSPECTOR.md`.
 */
export const BRIEF_PATHS = ["personas/INSPECTOR.md", "INSPECTOR.md"] as const;

export interface Brief {
  text: string;
  /** Where it came from, so the prompt can tell the model the repo shipped no brief. */
  source: "repo" | "default";
  truncated: boolean;
}

/**
 * The default brief, used when a repo ships no INSPECTOR.md in either location.
 *
 * Kept deliberately short. Its job is to be a defensible reviewer on a repo nobody has
 * configured, and the biggest risk there is not missing an issue - it is a bot that
 * leaves nine style opinions on a three-line change and gets muted. So the noise floor
 * is stated as firmly as the substance.
 */
export const DEFAULT_BRIEF = `# Inspector

You are reviewing a pull request. No INSPECTOR.md was found in this repository, at
personas/INSPECTOR.md or at the root, so apply general engineering judgement.

## Care about

- **Correctness.** Logic that is wrong on a real input: off-by-one, an unhandled null,
  an await that was forgotten, a promise nobody catches, a race between two writers.
- **Interfaces.** Code that reaches through an abstraction into a concrete type, or
  duplicates a rule that already exists somewhere authoritative. A second copy of a
  rule is a future disagreement.
- **Error handling.** Failures that are swallowed, logged and continued past, or
  reported as success. Say what the caller will see when it goes wrong.
- **Boundaries.** Untrusted input reaching a query, a path, a shell, or a template
  without validation. Secrets in code or logs.
- **Resource lifetime.** Handles, timers, subscriptions and locks that are acquired on
  one path and released on only some of them.
- **Tests.** A behaviour change with no test that would have failed before it.

## Do not comment on

- Formatting, import order, or anything a formatter owns.
- Naming, unless the name is actively misleading about what the code does.
- Preferences with no defect behind them ("I would have used a map here").
- Code the diff did not change, except to explain why a change breaks it.
- The same point twice in one review.

## How to write it

One issue per comment, on the line it is about. Lead with the consequence, not the
category. Say what would go wrong and under what input. If you are not sure it is
wrong, say so plainly or leave it out - a confident wrong comment costs more than a
missed one.`;

/**
 * Read a repo's INSPECTOR.md from the first `BRIEF_PATHS` entry that has one, falling back
 * to the default.
 *
 * A candidate that is missing, unreadable, or blank is not a brief, so the search continues
 * past it: an empty `personas/INSPECTOR.md` left behind by a half-finished move must not
 * shadow a root file that still says something. Only a repo with nothing at either name is
 * reviewed against the default.
 *
 * Every candidate goes through the same reader `standards.ts` uses, which resolves symlinks
 * BEFORE checking containment. That ordering matters more here than almost anywhere: a repo
 * shipping INSPECTOR.md as a symlink to `~/.ssh/id_rsa` would otherwise have that file
 * read by the daemon (full user access) and pasted into a prompt whose output is a
 * PUBLIC pull request comment. Adding a candidate in a subdirectory does not weaken that -
 * `realpathSync` resolves the whole path, so a `personas` symlink pointing out of the repo
 * is caught by the same containment check as a linked file.
 */
export function readBrief(repoRoot: string | null): Brief {
  if (!repoRoot || !existsSync(repoRoot)) {
    return { text: DEFAULT_BRIEF, source: "default", truncated: false };
  }
  const root = resolve(repoRoot);
  // Resolved once for the whole search rather than per candidate: containment is judged
  // against the repo's own real path, which cannot differ between two names inside it.
  const realRoot = realpathOr(root);
  for (const candidate of BRIEF_PATHS) {
    const doc = readRepoDoc(root, realRoot, join(root, candidate), MAX_BRIEF_BYTES);
    if (doc && doc.text.trim()) {
      return { text: doc.text, source: "repo", truncated: doc.truncated };
    }
  }
  return { text: DEFAULT_BRIEF, source: "default", truncated: false };
}
