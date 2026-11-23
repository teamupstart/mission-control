/**
 * The one free-text rule every card search uses: every whitespace-separated word of the
 * query must appear, case-insensitively, somewhere in the card's searchable fields.
 *
 * Every word rather than the whole phrase, so "auth codex" finds a Codex card titled
 * "Rotate auth token" as a person would expect, and so a word can match one field while
 * the next word matches another. Fields are joined by a newline, which no query word can
 * contain, so a single word never matches across the seam between two fields.
 */
export function matchesEveryWord(
  fields: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The last path segment of a repository or checkout root, which is the name a person knows it by. */
export function pathLeaf(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
}
