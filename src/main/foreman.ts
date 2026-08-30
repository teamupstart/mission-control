import { loginShellPath } from "../server/util/path-env.ts";
import { superviseUtilityProcess } from "./utility-supervisor.ts";
import type { UtilityProcessController } from "./utility-supervisor.ts";

export type ForemanController = UtilityProcessController;

export interface StartForemanOptions {
  /** Absolute path to the bundled worker entry. */
  workerEntry: string;
  /** Stable working directory for agent subprocess discovery. */
  cwd: string;
  /** Where to append supervisor lifecycle events. */
  logPath: string;
}

/**
 * Start one app-owned Foreman worker.
 *
 * A separately started worker may already hold the daemon lease. Starting a packaged worker
 * anyway is intentional: it idles as the supported standby and takes over if that leader exits.
 * The lease remains the single source of truth for which process may act.
 */
export function startForeman(opts: StartForemanOptions): ForemanController {
  return superviseUtilityProcess({
    entry: opts.workerEntry,
    serviceName: "mission-control-foreman",
    logPath: opts.logPath,
    cwd: opts.cwd,
    captureChildOutput: false,
    includeFailureDetails: false,
    env: {
      ...process.env,
      PATH: loginShellPath(),
    },
  });
}
