// Does this Bash command OPEN a pull request?
//
// Its own module because of who asks and what they do with the answer. The hook asks
// (`hooks/harness-hook.mjs`, bare node, no bundler at edit time) and reports a single
// boolean; the Inspector treats that boolean as proof it may write review comments on
// the pull request under the operator's GitHub identity. A predicate that decides
// something that public should not be an unexported regex inside a file nothing can
// import.
//
// The asymmetry is the whole design. A false negative costs one uninspected PR. A false
// positive writes to a stranger's. So this reads the COMMAND, never the output - `gh pr
// view` prints exactly the URL `gh pr create` does - and any future loosening has to
// walk past the table in `test/inspector-adoption.test.ts`.

/**
 * `gh pr create`, anywhere in a command line - after a `&&`, inside `$(...)`, and with
 * VALUELESS flags in front of the subcommand (`gh pr --draft create`).
 *
 * A flag that takes a separate value (`gh --repo o/r pr create`) does NOT match, and is
 * left that way deliberately: widening this to "skip any token" would start matching
 * `gh some-alias pr create`, and the whole point of reading the command is that it is
 * the strict end of the two provenance signals. The cost is one uninspected PR.
 *
 * It reads the command as TEXT, so prose that quotes the command can match too -
 * `echo 'run gh pr create when ready'`. That is harmless because the boolean is only
 * half the signal: adoption needs a PR URL in the same tool response as well
 * (`registry.ts`, `evt.prCreated && evt.prUrl`), and a sentence about the command has
 * none.
 */
export const PR_CREATE_RE =
  /(?:^|[\s;&|(`])gh\s+(?:-{1,2}\S+\s+)*pr\s+(?:-{1,2}\S+\s+)*create(?:\s|$)/;

/** Whether `command` opens a pull request. Non-strings are never a match. */
export function opensPullRequest(command) {
  return typeof command === "string" && PR_CREATE_RE.test(command);
}
