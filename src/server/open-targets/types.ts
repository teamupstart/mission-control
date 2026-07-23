import type { OpenTargetInfo } from "@shared/open-targets.ts";
import type { run } from "../util/exec.ts";

/**
 * What the daemon lends a target. Narrow on purpose - no registry, no DB, no session:
 * a target answers "which application, and what argv opens a file with it", and knows
 * nothing about whose checkout the file came from.
 *
 * It is a dep bag rather than direct imports for the `PaneDeps` reason: every branch here
 * is platform-specific, and a test must be able to drive the REAL implementation on a
 * machine that is not the one the branch is about. Nothing else makes the macOS resolution
 * testable from Linux CI, or the reverse.
 */
export interface OpenDeps {
  run: typeof run;
  /** `process.platform` on the daemon. */
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether a bare command name resolves on PATH. `onPath` in production. */
  installed: (bin: string, env: NodeJS.ProcessEnv) => boolean;
}

/** The command that opens one file. argv, never a shell string. */
export interface OpenCommand {
  bin: string;
  args: string[];
}

/**
 * A resolved way to open files, and the reason `resolve` answers this instead of just
 * launching.
 *
 * Which application will run is a question about the MACHINE and is asked once, when the
 * menu is drawn; which file to hand it is a question about the click. Splitting them is
 * what lets the menu grey out a row it could never launch - the same thing a task source's
 * `preflight` buys over discovering the breakage inside `sweep` - and it leaves `command`
 * a PURE function, so a test can assert the exact argv for a platform without spawning
 * anything.
 */
export interface OpenLauncher {
  /**
   * The application, when this resolution can name it ("Google Chrome"). Null when it
   * goes through a handler that names nothing (`xdg-open`) - not the same as unavailable.
   */
  detail: string | null;
  command(file: string): OpenCommand;
}

export type OpenResolution =
  | { ok: true; launcher: OpenLauncher }
  /** A sentence for the human, naming the fix where there is one. See `OpenTargetView`. */
  | { ok: false; reason: string };

/**
 * One target's implementation, registered in `src/server/open-targets/index.ts`.
 *
 * Extends the pure half rather than restating it, so an implementation is one object a
 * call site reads every slot off - the shape `Harness extends HarnessCapabilities` and
 * `TaskSourceImpl extends TaskSourceKindInfo` both have.
 */
export interface OpenTargetImpl extends OpenTargetInfo {
  /** Never throws: an unexpected failure is a refusal with a reason, like every branch. */
  resolve(deps: OpenDeps): Promise<OpenResolution>;
}
