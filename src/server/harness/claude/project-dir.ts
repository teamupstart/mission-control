import { homedir } from "node:os";
import { join } from "node:path";

/** Root of Claude's per-project transcript store. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Claude's cap on an encoded name before it truncates and appends a hash. */
const MAX_NAME = 200;

/**
 * The directory Claude Code keeps a cwd's transcripts in: `<projectsDir>/<encoded cwd>`.
 *
 * Every character outside `[a-zA-Z0-9]` becomes `-`. A name longer than 200 characters is cut
 * to 200 and suffixed with `-` and a base-36 hash of the unencoded cwd. That mirrors Claude
 * byte for byte, read from `@anthropic-ai/claude-agent-sdk` 0.3.283 (`vc`, shared with the
 * bundled CLI).
 *
 * The rule used here before was "every `/` and `.`". That is the same thing for a path of
 * letters, digits, `-`, `.` and `/`, which is why it held for most checkouts. A cwd with `_`,
 * `+` or a space was the case it missed: the derived directory was one Claude never writes,
 * so the transcript was not found and the headless sweep removed nothing.
 *
 * `cwd` is encoded as given. Claude first resolves its own cwd through `realpathSync`, so a
 * caller holding a path that may not be physical resolves it first, the way the callers here
 * already do.
 */
export function claudeProjectDir(cwd: string, projectsDir: string = CLAUDE_PROJECTS_DIR): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return join(projectsDir, name);
  return join(projectsDir, `${name.slice(0, MAX_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`);
}

/** Claude's 32-bit string hash (`h * 31 + c`, over UTF-16 code units). */
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
