// Disposable worktree state written by ai-conductor. Keep this list narrow: .pipeline/
// can also contain operator-authored work. The reader's layout is documented in state.ts.
const SCRATCH_FILES = new Set([
  ".pipeline/.memory-count-at-start",
  ".pipeline/conduct-state.json",
  ".pipeline/engineer-run.json",
  ".pipeline/HALT",
  ".pipeline/HALT.class",
  ".pipeline/DONE",
  ".pipeline/events.jsonl",
]);

/** A root-relative Git path, not proof that the entry is untracked or a regular file. */
export function isConductorScratchPath(path: string): boolean {
  return SCRATCH_FILES.has(path) || /^\.pipeline\/gates\/[a-zA-Z0-9_-]+\.json$/.test(path);
}
