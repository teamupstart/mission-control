import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "../config.ts";
import { HEADLESS_CWD } from "../claude-cli.ts";
import { unref } from "../util/timers.ts";

// Every headless `claude -p` mints a session id and writes a real transcript, exactly as an
// interactive session does. Nothing ever reads them and nothing ever deletes them: 153 of 250
// transcripts sampled on this machine were already Foreman's, before the goal refiner started
// adding one per card per refresh.
//
// Claude derives a transcript's directory from the spawning process's cwd, and `runClaudeText`
// always spawns in `tmpdir()`, so every headless run lands in ONE directory - which this
// prunes by age.
//
// That directory is not exclusively ours, though, and the distinction is worth stating
// honestly rather than trusting later: a human who runs `claude` interactively from `$TMPDIR`
// gets a transcript in the same encoded project dir, and this sweep does not distinguish whose
// a `.jsonl` is. What bounds the risk is circumstance, not construction - `$TMPDIR` is
// normally unset for an interactive shell, so a real session's cwd is a repo; the sweep only
// ever touches `*.jsonl`; and the 24h mtime floor means even that human's transcript survives
// until a day after they last touched it. Deliberately accepted, not overlooked.
//
// Rejected: pointing CLAUDE_CONFIG_DIR at a throwaway dir, which would isolate these
// perfectly. It relocates auth along with everything else, so the runs could silently fail to
// authenticate - trading a disk-space problem for an "intent never reconciles and nobody
// knows why" problem.

/** How often to sweep. Hourly: this is disk hygiene, not a deadline. */
const PRUNE_INTERVAL_MS = Number(envVar("HEADLESS_PRUNE_INTERVAL_MS") ?? 60 * 60 * 1000);
/**
 * How old a headless transcript must be before it goes.
 *
 * A day, not an hour, because these are the only record of what a headless run actually did -
 * the one thing to read when Foreman answers oddly or a goal comes out wrong. Long enough to
 * still be there when someone asks "why did it say that?", short enough that the directory
 * never becomes a problem.
 */
const PRUNE_AGE_MS = Number(envVar("HEADLESS_PRUNE_AGE_MS") ?? 24 * 60 * 60 * 1000);

/**
 * The directory Claude writes a headless run's transcript to.
 *
 * Mirrors Claude's own encoding of a project dir - every `/` and `.` in the cwd replaced by
 * `-` - applied to `HEADLESS_CWD`, the exact cwd `runClaudeText` spawns with. Derived from
 * that constant rather than from `tmpdir()` again so the two cannot drift apart.
 *
 * The `realpathSync` is load-bearing and was found the hard way. Claude resolves the cwd
 * through symlinks BEFORE encoding it, and on macOS `os.tmpdir()` is `/var/folders/…/T`,
 * which is really `/private/var/folders/…/T`. Without this the derived name is
 * `-var-folders-…-T` while the transcripts pile up in `-private-var-folders-…-T` - so the
 * sweep finds no such directory, removes nothing, reports nothing, and looks like it works.
 * Verified against a real `claude -p`, which wrote to the `-private-` form.
 *
 * Falls back to the unresolved path if realpath fails (the directory is gone), which can only
 * make the sweep a no-op - never point it somewhere else.
 */
export function headlessTranscriptDir(projectsDir = join(homedir(), ".claude", "projects")): string {
  let cwd = HEADLESS_CWD;
  try {
    cwd = realpathSync(HEADLESS_CWD);
  } catch {
    // unresolvable - use it as given; a wrong-but-absent dir prunes nothing
  }
  return join(projectsDir, cwd.replace(/[/.]/g, "-"));
}

/**
 * Delete headless transcripts older than `maxAgeMs`. Returns how many were removed.
 *
 * Never throws: a missing directory is the normal case on a machine that has never run one,
 * and a file that vanishes mid-sweep (a concurrent prune, a user tidying up) is not an error
 * either. Exported for tests and for a one-off call.
 */
export function pruneHeadlessTranscripts(
  dir = headlessTranscriptDir(),
  maxAgeMs = PRUNE_AGE_MS,
  now = Date.now(),
): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no headless run has ever happened here
  }
  let removed = 0;
  for (const name of names) {
    // Only ever the transcripts. Claude puts other things under a project dir, and this
    // module's promise is "the JSONL our own runs wrote", not "whatever is in here".
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      // mtime, not birthtime: a run appends as it streams, so mtime is when it FINISHED.
      // birthtime would start the clock at spawn and could delete a long run still writing.
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path);
      removed++;
    } catch {
      // vanished or unreadable - nothing to do, and nothing worth failing the sweep over
    }
  }
  return removed;
}

/** Sweep the headless transcript dir hourly. Returns a stop function. */
export function startHeadlessPruner(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      const n = pruneHeadlessTranscripts();
      if (n > 0) console.log(`[prune] removed ${n} headless transcript(s)`);
    } catch (err) {
      console.error("[prune] sweep failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, PRUNE_INTERVAL_MS));
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
