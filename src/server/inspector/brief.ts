import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRepoDoc, realpathOr } from "../util/repo-doc.ts";

// The reviewer's brief: what INSPECTOR.md says, or a built-in default when the repo
// hasn't written one.

/** Cap on the brief, so an enormous INSPECTOR.md can't crowd the diff out of the prompt. */
const MAX_BRIEF_BYTES = 24 * 1024;

export const BRIEF_FILENAME = "INSPECTOR.md";

export interface Brief {
  text: string;
  /** Where it came from, so the settings panel can say which is in force. */
  source: "repo" | "default";
  truncated: boolean;
}

/**
 * The default brief, used when a repo ships no INSPECTOR.md.
 *
 * Kept deliberately short. Its job is to be a defensible reviewer on a repo nobody has
 * configured, and the biggest risk there is not missing an issue - it is a bot that
 * leaves nine style opinions on a three-line change and gets muted. So the noise floor
 * is stated as firmly as the substance.
 */
export const DEFAULT_BRIEF = `# Inspector

You are reviewing a pull request. No INSPECTOR.md was found in this repository, so
apply general engineering judgement.

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
 * Read a repo's INSPECTOR.md, falling back to the default.
 *
 * Goes through the same reader `standards.ts` uses, which resolves symlinks BEFORE
 * checking containment. That ordering matters more here than almost anywhere: a repo
 * shipping INSPECTOR.md as a symlink to `~/.ssh/id_rsa` would otherwise have that file
 * read by the daemon (full user access) and pasted into a prompt whose output is a
 * PUBLIC pull request comment.
 */
export function readBrief(repoRoot: string | null): Brief {
  if (!repoRoot || !existsSync(repoRoot)) {
    return { text: DEFAULT_BRIEF, source: "default", truncated: false };
  }
  const root = resolve(repoRoot);
  const doc = readRepoDoc(root, realpathOr(root), join(root, BRIEF_FILENAME), MAX_BRIEF_BYTES);
  if (!doc || !doc.text.trim()) {
    return { text: DEFAULT_BRIEF, source: "default", truncated: false };
  }
  return { text: doc.text, source: "repo", truncated: doc.truncated };
}
