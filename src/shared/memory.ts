// The `.agents/memory/` repository memory convention.
//
// A repository's agent memory is committed INTO that repository, never into Mission
// Control: the ask is memory shared by every session and every operator, and MC's own
// stores are instance-local (`app_config`) or per-session (`session_notes`). A file in
// the tree is shared by construction - clone the repo, get the memory - and it travels
// to agents MC never launched.
//
// The shape is an index plus topic files: `.agents/memory/MEMORY.md` is a short index,
// one line per memory with a link, and each memory is its own file beside it. Sessions
// pay the index in context and read a topic file only when it bears on their work.
//
// These constants are a CONTRACT, not configuration. Their values become paths committed
// into repositories Mission Control does not own, so changing one orphans every memory
// already written under the old name. Add, never rename.
//
// Browser-safe on purpose (`src/shared/` may not import `node:`): the dashboard reads
// these to talk about memory, the daemon reads them to find it.

/** Directory holding a repository's committed agent memory, relative to the repo root. */
export const MEMORY_DIR = ".agents/memory";

/**
 * The index every consumer reads, relative to the repo root.
 *
 * Posix-separated because it is a repo-relative path in a committed convention, the same
 * way `AGENTS.md` is - `join(root, MEMORY_INDEX_PATH)` is how it becomes a filesystem
 * path.
 */
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/MEMORY.md`;

/**
 * The stable substring that says a repo's root doc already points at its memory.
 *
 * The retro writes the reference line into AGENTS.md exactly once, and finds out whether
 * it has to by looking for THIS string rather than for a whole sentence - so the sentence
 * can be reworded, translated or wrapped by a formatter without a later retro concluding
 * the line is missing and adding a second one. Exported separately from
 * `MEMORY_INDEX_PATH` (though equal to it today) so the marker and the path can diverge
 * later without breaking that idempotence check.
 */
export const MEMORY_REFERENCE_MARKER = MEMORY_INDEX_PATH;

/**
 * The one line handed to an agent whose harness has no file-loading channel of its own.
 *
 * Claude and Codex read the repository's root doc natively, so the committed reference
 * line reaches them; Pi's only channel is turn one, so it is told here instead. It names
 * the index AND the links in it, because the index alone is a table of contents - an
 * agent that reads it and stops has the titles of the traps but not the traps.
 */
export const MEMORY_POINTER_LINE =
  `Before starting, read ${MEMORY_INDEX_PATH} (this repository's agent memory) and any entry`
  + ` it links that bears on this task.`;

/**
 * Prefix an agent's opening prompt with the memory pointer.
 *
 * A blank line between, so the pointer reads as a preamble rather than as the first
 * sentence of the task.
 */
export function withMemoryPointer(prompt: string): string {
  return `${MEMORY_POINTER_LINE}\n\n${prompt}`;
}
