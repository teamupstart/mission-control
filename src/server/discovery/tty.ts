/**
 * Sentinel tty values that mean "no controlling terminal". `ps` reports `?`/`??`
 * for a process with no tty and `-` in some column layouts; tmux/wezterm just
 * omit it (empty). Taking the superset keeps one normalizer correct for every
 * discovery source instead of each hand-rolling its own subset.
 */
const NO_TTY = new Set(["", "?", "??", "-"]);

/**
 * Normalize a raw tty string to the `ttysNNN` form (no `/dev/` prefix), or null
 * when there's no real controlling terminal.
 */
export function normTty(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (NO_TTY.has(t)) return null;
  return t.replace(/^\/dev\//, "");
}
