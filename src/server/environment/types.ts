import type { EnvironmentCheckInfo } from "@shared/environment-checks.ts";

/**
 * The outcome of one bounded read. Three cases, not two, because a check has to tell
 * "there is no such file" from "there is a file I could not read": the first is the
 * ordinary state of a machine that does not use the tooling, and the second is a broken
 * install that cannot be shown to be healthy. Collapsing them would either silence a real
 * problem or warn every operator on earth.
 */
export type FileRead =
  | { ok: true; text: string }
  | { ok: false; missing: boolean; reason: string };

/**
 * What the daemon lends a check. Narrow on purpose - no registry, no DB, no session: a
 * check answers "what does this machine's install of some third-party tooling look like",
 * and knows nothing about the dispatch that asked.
 *
 * A dep bag rather than direct imports for `OpenDeps`' reason: every branch here is about
 * a filesystem the test process must not have, and nothing else lets a test drive the REAL
 * check against an arranged home. `test/` must never read the developer's own `~/.claude`.
 */
export interface EnvironmentDeps {
  /**
   * The operator's home directory.
   *
   * `homedir()` in production, never `env.HOME` - the same distinction `operatorSkillsDirs`
   * (`src/server/skills/reconcile.ts`) draws: the question is "what is this machine's live
   * install?", not "where has this process been redirected?". Node's `homedir()` follows
   * `$HOME` on POSIX, which is how the e2e daemon isolates its home.
   */
  homeDir: string;
  /** Read the head of a file as UTF-8, bounded. Never throws; see `FileRead`. */
  readText(path: string): Promise<FileRead>;
  /**
   * The names of the directories directly inside `path`.
   *
   * `[]` for a directory that is missing OR unreadable, deliberately: both answers mean
   * "nothing found here" to a presence probe, and a machine with no `~/.claude/plugins` at
   * all - the common case - must produce silence rather than an error a check would have to
   * turn into a warning.
   */
  subdirectories(path: string): Promise<string[]>;
}

/** What a check found. `warning: null` is the silent answer, and the common one. */
export interface EnvironmentCheckResult {
  warning: string | null;
  detail: string | null;
}

/**
 * One check's implementation, registered in `src/server/environment/index.ts`.
 *
 * Extends the pure half rather than restating it, so an implementation is one object a call
 * site reads every slot off - the shape `OpenTargetImpl extends OpenTargetInfo` and
 * `TaskSourceImpl extends TaskSourceKindInfo` both have.
 */
export interface EnvironmentCheckImpl extends EnvironmentCheckInfo {
  /**
   * Look at the machine and say what is wrong, if anything.
   *
   * Should not throw - every filesystem outcome is a result, not an exception - but
   * `environmentCheckViews` maps a throw into this check's own warning anyway, so a bug
   * here can never take the list down or fail the route.
   */
  check(deps: EnvironmentDeps): Promise<EnvironmentCheckResult>;
}
