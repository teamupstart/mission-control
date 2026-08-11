// Hand-written types for pr-command.mjs, so the TypeScript side (its test) can import
// the same predicate the bare-node hook runs. Same arrangement as harness-runtime.d.mts.

export const PR_CREATE_RE: RegExp;

/** Whether `command` opens a pull request. Deliberately accepts unknown - the hook feeds
 *  it a field off a JSON payload, and a non-string is never a match. */
export function opensPullRequest(command: unknown): boolean;

export const PR_URL_RE: RegExp;

/** Every distinct PR URL in `text`, in order. Accepts unknown for the same reason as above. */
export function pullRequestUrlsIn(text: unknown): string[];

/** The first PR URL in `text`, or null. Accepts unknown for the same reason as above. */
export function pullRequestUrlIn(text: unknown): string | null;
