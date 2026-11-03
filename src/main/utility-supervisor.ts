import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import {
  attachUtilityProcessOutput,
  endUtilityProcessLog,
  openPrivateUtilityLog,
  utilityProcessStdio,
} from "./utility-log.ts";
import {
  forkAndInitializeUtilityProcess,
  stopChild,
  UtilityProcessInitializationError,
} from "./utility-process-start.ts";

export interface UtilityProcessController {
  /**
   * Stop supervising and ask the current process to leave (`SIGTERM` on POSIX). Resolves when
   * that process has exited, so an owner can hold the app open until the child's own orderly
   * shutdown has run. Unbounded here on purpose: how long to wait is the owner's decision.
   */
  stop(): Promise<void>;
}

export interface UtilityProcessOptions {
  entry: string;
  serviceName: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onSpawn?: (child: UtilityProcess) => void;
  captureChildOutput?: boolean;
  includeFailureDetails?: boolean;
}

/**
 * Keep one Electron utility process alive until its owner stops it.
 *
 * The daemon and Foreman have different ownership rules, but once either one is ours their
 * restart, logging, and shutdown mechanics are identical. Keeping that loop here prevents a
 * packaging fix in one process from silently leaving the other with different crash behavior.
 */
export function superviseUtilityProcess(opts: UtilityProcessOptions): UtilityProcessController {
  let child: UtilityProcess | null = null;
  // Settles when `child` exits. Created in the same synchronous initialization that assigns
  // `child`, so a stop can never observe a live child paired with an earlier child's promise.
  let childExit: Promise<void> = Promise.resolve();
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let restarts = 0;

  const scheduleRestart = (): void => {
    if (stopped) return;
    restarts += 1;
    const delay = Math.min(500 * restarts, 5000);
    restartTimer = setTimeout(spawn, delay);
  };

  const spawn = (): void => {
    restartTimer = null;
    if (stopped) return;

    let log: ReturnType<typeof openPrivateUtilityLog>;
    try {
      log = openPrivateUtilityLog(opts.logPath);
    } catch {
      scheduleRestart();
      return;
    }
    try {
      child = forkAndInitializeUtilityProcess(
        () =>
          utilityProcess.fork(opts.entry, [], {
            serviceName: opts.serviceName,
            stdio: utilityProcessStdio(opts.captureChildOutput),
            env: opts.env,
            cwd: opts.cwd,
          }),
        (spawned) => {
          child = spawned;
          childExit = new Promise<void>((resolve) => spawned.once("exit", () => resolve()));
          attachUtilityProcessOutput(spawned, log, opts.captureChildOutput);
          spawned.once("exit", (code) => {
            child = null;
            endUtilityProcessLog(
              spawned,
              log,
              stopped
                ? `[mission-control] ${opts.serviceName} stopped\n`
                : `[mission-control] ${opts.serviceName} exited with code ${code}; restarting\n`,
            );
            scheduleRestart();
          });
          opts.onSpawn?.(spawned);
        },
      );
    } catch (err) {
      if (err instanceof UtilityProcessInitializationError) {
        if (child === err.child) {
          const details =
            opts.includeFailureDetails === false ? "" : `: ${String(err.cause)}`;
          log.write(
            `[mission-control] ${opts.serviceName} initialization failed${details}; stopping\n`,
          );
        }
        return;
      }
      child = null;
      const details = opts.includeFailureDetails === false ? "" : `: ${String(err)}`;
      log.end(`[mission-control] ${opts.serviceName} failed to start${details}\n`);
      scheduleRestart();
      return;
    }
  };

  spawn();
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = null;
        stopChild(child);
      }
      return child ? childExit : Promise.resolve();
    },
  };
}
